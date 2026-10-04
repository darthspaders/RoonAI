"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { encodeVector, normalizeVector } = require("./sonicEmbeddingStore");

const TASTE_CLUSTER_SCHEMA_VERSION = 1;
const BOOTSTRAP_SOURCE = "metadata-bootstrap";
const BOOTSTRAP_MODEL_VERSION = "metadata-facets-v1";
const CLUSTER_PROFILE_SCHEMA_VERSION = 1;
const DEFAULT_PROFILE_MODEL = "discogs-effnet";
const DEFAULT_PROFILE_MODEL_VERSION = "1";

// These are descriptive metadata facets, not a permanent taxonomy. The
// learned sonic model will be allowed to split, merge, or cross these facets
// once enough embeddings and feedback exist.
const GENERIC_TERMS = new Set([
  "and",
  "audio",
  "club",
  "compilation",
  "dance",
  "electronic",
  "hip",
  "hop",
  "label",
  "music",
  "pop",
  "record",
  "recording",
  "recordings",
  "sound",
  "various"
]);

const TERM_ALIASES = new Map([
  ["drum n bass", "drum and bass"],
  ["drum and bass", "drum and bass"],
  ["drum bass", "drum and bass"],
  ["hip hop", "hip-hop"],
  ["hiphop", "hip-hop"],
  ["psy trance", "psytrance"],
  ["progressive trance", "progressive trance"],
  ["future bass", "future bass"],
  ["future house", "future house"],
  ["bass house", "bass house"],
  ["tech house", "tech house"],
  ["deep house", "deep house"],
  ["progressive house", "progressive house"],
  ["melodic house techno", "melodic house and techno"],
  ["melodic house and techno", "melodic house and techno"],
  ["electro house", "electro house"],
  ["industrial rock", "industrial rock"],
  ["alternative rock", "alternative rock"],
  ["progressive rock", "progressive rock"]
]);

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeText(value) {
  return cleanText(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function canonicalTerm(value) {
  const normalized = normalizeText(value);
  return TERM_ALIASES.get(normalized) || normalized;
}

function splitLabels(value) {
  return cleanText(value)
    .split(/[,;|]+/)
    .flatMap((part) => part.split(/\s+\/\s+/))
    .map((part) => cleanText(part))
    .filter(Boolean);
}

function meaningfulToken(token) {
  return Boolean(token) && !GENERIC_TERMS.has(token) && token.length > 1 && !/^\d+$/.test(token);
}

function termsForLabel(value) {
  const terms = new Set();
  for (const label of splitLabels(value)) {
    const normalized = normalizeText(label);
    if (!normalized) continue;
    const canonical = canonicalTerm(label);
    const tokens = normalized.split(" ").filter(Boolean);
    if (tokens.length > 1 && tokens.every(meaningfulToken)) terms.add(canonical);
    for (const token of tokens) {
      if (meaningfulToken(token)) terms.add(canonicalTerm(token));
    }
    for (let index = 0; index < tokens.length - 1; index += 1) {
      const pair = tokens.slice(index, index + 2);
      if (pair.every(meaningfulToken)) terms.add(canonicalTerm(pair.join(" ")));
    }
  }
  return Array.from(terms);
}

function labelDisplayName(term) {
  const display = {
    "hip-hop": "Hip-Hop",
    "drum and bass": "Drum & Bass",
    psytrance: "Psytrance",
    "melodic house and techno": "Melodic House & Techno"
  }[term];
  if (display) return display;
  return term.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function numeric(value) {
  if (value === null || value === undefined || cleanText(value) === "") return null;
  const result = Number(value);
  return Number.isFinite(result) && result > 0 ? result : null;
}

function jsonParse(value, fallback = null) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function normalizeArtistCredit(value) {
  return Array.from(new Set(cleanText(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(?:feat\.?|featuring|with|vs\.?|versus)\b/g, ",")
    .split(/[,/&+|]+|\s+and\s+/i)
    .map((part) => normalizeText(part))
    .filter((part) => part.length > 1)))
    .sort()
    .join("|");
}

function identityTextKey(track = {}) {
  const artist = normalizeArtistCredit(track.artist);
  const title = normalizeText(track.title);
  return artist && title ? `${artist}|${title}` : "";
}

function artistCreditParts(value) {
  return normalizeArtistCredit(value).split("|").filter(Boolean);
}

function identityTextCompatible(localTrack = {}, identity = {}) {
  const localTitle = normalizeText(localTrack.title);
  const identityTitle = normalizeText(identity.title);
  if (!localTitle || !identityTitle || localTitle !== identityTitle) return false;
  const localArtists = artistCreditParts(localTrack.artist);
  const identityArtists = artistCreditParts(identity.artist);
  if (!localArtists.length || !identityArtists.length) return false;
  // Provider IDs may point to a credit string that adds a harmless credited
  // collaborator (for example Roger Sanchez / Roberto Sánchez), but they may
  // not point to a different artist or title.
  return localArtists.every((artist) => identityArtists.includes(artist))
    || identityArtists.every((artist) => localArtists.includes(artist));
}

function addIndexValue(index, value, identityId) {
  const key = cleanText(value).toLowerCase();
  if (!key) return;
  const values = index.get(key) || new Set();
  values.add(Number(identityId));
  index.set(key, values);
}

function providerIdValues(identity, providerRows = []) {
  const values = [];
  const providerIds = jsonParse(identity.provider_ids, {}) || {};
  for (const [provider, id] of Object.entries(providerIds)) {
    if (cleanText(id)) values.push(`${provider.toLowerCase()}:${cleanText(id)}`);
  }
  if (cleanText(identity.tidal_id)) values.push(`tidal:${cleanText(identity.tidal_id)}`);
  if (cleanText(identity.isrc)) values.push(`isrc:${cleanText(identity.isrc).replace(/[^a-z0-9]/gi, "").toUpperCase()}`);
  if (cleanText(identity.beatport_track_id)) values.push(`beatport:${cleanText(identity.beatport_track_id)}`);
  if (cleanText(identity.beatport_isrc)) values.push(`isrc:${cleanText(identity.beatport_isrc).replace(/[^a-z0-9]/gi, "").toUpperCase()}`);
  for (const row of providerRows) {
    if (Number(row.track_identity_id) !== Number(identity.id)) continue;
    if (cleanText(row.provider_track_id)) values.push(`${cleanText(row.provider).toLowerCase()}:${cleanText(row.provider_track_id)}`);
    if (cleanText(row.isrc)) values.push(`isrc:${cleanText(row.isrc).replace(/[^a-z0-9]/gi, "").toUpperCase()}`);
  }
  return Array.from(new Set(values));
}

function localProviderIdValues(row = {}) {
  const values = [];
  for (const [provider, field] of [
    ["tidal", "tidal_id"],
    ["beatport", "beatport_id"],
    ["musicbrainz", "musicbrainz_id"],
    ["discogs", "discogs_id"]
  ]) {
    if (cleanText(row[field])) values.push(`${provider}:${cleanText(row[field])}`);
  }
  if (cleanText(row.isrc)) values.push(`isrc:${cleanText(row.isrc).replace(/[^a-z0-9]/gi, "").toUpperCase()}`);
  return values;
}

function readIdentityCatalog(db) {
  const identities = db.prepare(`
    SELECT ti.*, be.beatport_track_id, be.isrc AS beatport_isrc
    FROM track_identity ti
    LEFT JOIN beatport_enrichment be ON be.track_identity_id = ti.id
    ORDER BY ti.id ASC
  `).all();
  const providerRows = db.prepare(`
    SELECT track_identity_id, provider, provider_track_id, isrc
    FROM provider_enrichment
    WHERE COALESCE(provider_track_id, '') <> '' OR COALESCE(isrc, '') <> ''
  `).all();
  const providerRowsByIdentity = new Map();
  for (const row of providerRows) {
    const rows = providerRowsByIdentity.get(Number(row.track_identity_id)) || [];
    rows.push(row);
    providerRowsByIdentity.set(Number(row.track_identity_id), rows);
  }
  const providerIndex = new Map();
  const isrcIndex = new Map();
  const textIndex = new Map();
  for (const identity of identities) {
    for (const value of providerIdValues(identity, providerRowsByIdentity.get(Number(identity.id)) || [])) {
      if (value.startsWith("isrc:")) addIndexValue(isrcIndex, value.slice(5), identity.id);
      else addIndexValue(providerIndex, value, identity.id);
    }
    addIndexValue(textIndex, identityTextKey(identity), identity.id);
  }
  return { identities, providerIndex, isrcIndex, textIndex };
}

function preferredIdentityCandidate(row, candidateIds, identityById, catalog) {
  const ids = new Set(candidateIds);
  for (const value of localProviderIdValues(row).filter((item) => item.startsWith("tidal:") || item.startsWith("isrc:"))) {
    const index = value.startsWith("isrc:") ? catalog.isrcIndex : catalog.providerIndex;
    const key = value.startsWith("isrc:") ? value.slice(5) : value;
    const matches = Array.from(index.get(key) || []).filter((id) => ids.has(Number(id)));
    if (matches.length === 1) {
      return {
        id: Number(matches[0]),
        reason: `${value.startsWith("tidal:") ? "TIDAL" : "ISRC"} identity is the unique direct match among equivalent candidates`
      };
    }
  }

  const identities = Array.from(ids).map((id) => identityById.get(Number(id)) || {});
  const textKeys = new Set(identities.map((identity) => identityTextKey(identity)).filter(Boolean));
  if (textKeys.size !== 1) return null;
  const tidalIdentities = identities.filter((identity) => cleanText(identity.tidal_id));
  if (tidalIdentities.length === 1) {
    return {
      id: Number(tidalIdentities[0].id),
      reason: "duplicate equivalent identity collapsed to its sole TIDAL-backed record"
    };
  }
  const isrcIdentities = identities.filter((identity) => cleanText(identity.isrc));
  if (isrcIdentities.length === 1) {
    return {
      id: Number(isrcIdentities[0].id),
      reason: "duplicate equivalent identity collapsed to its sole ISRC-backed record"
    };
  }
  return null;
}

function linkLocalLibraryToTrackIdentities(db, rows = []) {
  const catalog = readIdentityCatalog(db);
  const identityById = new Map(catalog.identities.map((identity) => [Number(identity.id), identity]));
  const links = rows.map((row) => {
    const providerCandidates = new Set();
    const matchedBy = [];
    for (const providerValue of localProviderIdValues(row)) {
      const index = providerValue.startsWith("isrc:") ? catalog.isrcIndex : catalog.providerIndex;
      const key = providerValue.startsWith("isrc:") ? providerValue.slice(5) : providerValue;
      const ids = index.get(key) || new Set();
      for (const id of ids) providerCandidates.add(id);
      if (ids.size) matchedBy.push({ key: providerValue, identityIds: Array.from(ids).sort((a, b) => a - b) });
    }
    const textKey = identityTextKey(row);
    const textCandidates = new Set(catalog.textIndex.get(textKey) || []);
    const providerCompatible = new Set(Array.from(providerCandidates).filter((id) => {
      return identityTextCompatible(row, identityById.get(Number(id)) || {});
    }));
    const providerConflict = providerCandidates.size > 0 && providerCompatible.size === 0;
    const candidatePool = providerCandidates.size ? providerCompatible : textCandidates;
    const canonical = candidatePool.size > 1
      ? preferredIdentityCandidate(row, candidatePool, identityById, catalog)
      : null;
    const candidates = canonical ? new Set([canonical.id]) : candidatePool;
    const candidateDetails = Array.from(candidates).map((id) => {
      const identity = identityById.get(id) || {};
      return {
        trackIdentityId: id,
        identityKey: cleanText(identity.identity_key),
        artist: cleanText(identity.artist),
        title: cleanText(identity.title),
        mixVersion: cleanText(identity.mix_version)
      };
    });
    if (candidates.size === 1) {
      const trackIdentityId = Array.from(candidates)[0];
      const providerMatch = providerCandidates.has(trackIdentityId);
      const isrcMatch = localProviderIdValues(row).some((value) => value.startsWith("isrc:")
        && (catalog.isrcIndex.get(value.slice(5)) || new Set()).has(trackIdentityId));
      return {
        localFileId: Number(row.id),
        trackIdentityId,
        linkStatus: providerMatch || isrcMatch ? "EXACT" : "HIGH_CONFIDENCE",
        confidence: providerMatch || isrcMatch ? 100 : 95,
        matchType: providerMatch ? "PROVIDER_ID" : isrcMatch ? "ISRC" : "TEXT_EXACT",
        evidence: {
          localProviderIds: localProviderIdValues(row),
          providerMatches: matchedBy,
          textKey,
          candidateCount: candidatePool.size,
          ...(canonical ? { canonicalization: canonical.reason } : {}),
          identity: candidateDetails[0]
        }
      };
    }
    if (providerConflict) {
      return {
        localFileId: Number(row.id),
        trackIdentityId: null,
        linkStatus: "AMBIGUOUS",
        confidence: 0,
        matchType: "PROVIDER_ID_CONFLICT",
        evidence: {
          localProviderIds: localProviderIdValues(row),
          providerMatches: matchedBy,
          textKey,
          candidateCount: providerCandidates.size,
          candidates: Array.from(providerCandidates).map((id) => {
            const identity = identityById.get(id) || {};
            return {
              trackIdentityId: id,
              identityKey: cleanText(identity.identity_key),
              artist: cleanText(identity.artist),
              title: cleanText(identity.title),
              mixVersion: cleanText(identity.mix_version),
              reason: "provider ID conflicts with local artist/title"
            };
          })
        }
      };
    }
    if (candidates.size > 1) {
      return {
        localFileId: Number(row.id),
        trackIdentityId: null,
        linkStatus: "AMBIGUOUS",
        confidence: 0,
        matchType: "AMBIGUOUS",
        evidence: {
          localProviderIds: localProviderIdValues(row),
          providerMatches: matchedBy,
          textKey,
          candidateCount: candidatePool.size,
          candidates: candidateDetails
        }
      };
    }
    return {
      localFileId: Number(row.id),
      trackIdentityId: null,
      linkStatus: "UNMATCHED",
      confidence: 0,
      matchType: "UNMATCHED",
      evidence: {
        localProviderIds: localProviderIdValues(row),
        textKey,
        candidateCount: 0
      }
    };
  });
  const summary = {
    rowsScanned: links.length,
    exact: links.filter((link) => link.linkStatus === "EXACT").length,
    highConfidence: links.filter((link) => link.linkStatus === "HIGH_CONFIDENCE").length,
    ambiguous: links.filter((link) => link.linkStatus === "AMBIGUOUS").length,
    unmatched: links.filter((link) => link.linkStatus === "UNMATCHED").length
  };
  return { links, summary };
}

const POSITIVE_FEEDBACK_WEIGHTS = new Map([
  ["love", 5],
  ["like", 3],
  ["good", 3],
  ["up", 3]
]);
const NEGATIVE_FEEDBACK_WEIGHTS = new Map([
  ["dislike", -5],
  ["never", -5],
  ["never_again", -5],
  ["skip", -4]
]);

function buildFeedbackIndex(db) {
  const index = new Map();
  const rows = db.prepare("SELECT track_identity_id, rating, created_at FROM taste_feedback ORDER BY created_at ASC, id ASC").all();
  for (const row of rows) {
    const rating = cleanText(row.rating).toLowerCase().replace(/\s+/g, "_");
    const item = index.get(Number(row.track_identity_id)) || {
      positiveScore: 0,
      negativeScore: 0,
      positiveEvents: 0,
      negativeEvents: 0,
      neutralEvents: 0,
      wrongGenreEvents: 0,
      ratings: {}
    };
    item.ratings[rating] = (item.ratings[rating] || 0) + 1;
    if (POSITIVE_FEEDBACK_WEIGHTS.has(rating)) {
      item.positiveScore += POSITIVE_FEEDBACK_WEIGHTS.get(rating);
      item.positiveEvents += 1;
    } else if (NEGATIVE_FEEDBACK_WEIGHTS.has(rating)) {
      item.negativeScore += NEGATIVE_FEEDBACK_WEIGHTS.get(rating);
      item.negativeEvents += 1;
    } else if (rating === "wrong_genre") {
      // Wrong-genre feedback is a prompt mismatch signal, not proof that the
      // listener dislikes the recording's actual sound.
      item.wrongGenreEvents += 1;
    } else if (rating === "ok" || rating === "okay") {
      item.neutralEvents += 1;
    }
    index.set(Number(row.track_identity_id), item);
  }
  return index;
}

function meanNormalizedVector(vectors = [], weights = null) {
  const compatible = vectors
    .map((vector, index) => ({ vector, weight: Array.isArray(weights) ? Number(weights[index]) : 1 }))
    .filter((item) => Array.isArray(item.vector) && item.vector.length > 0 && Number.isFinite(item.weight) && item.weight > 0);
  if (!compatible.length) return [];
  const dimensions = compatible[0].vector.length;
  if (!compatible.every((item) => item.vector.length === dimensions)) return [];
  const mean = Array.from({ length: dimensions }, () => 0);
  let totalWeight = 0;
  for (const item of compatible) {
    totalWeight += item.weight;
    for (let index = 0; index < dimensions; index += 1) mean[index] += (Number(item.vector[index]) || 0) * item.weight;
  }
  return normalizeVector(mean.map((value) => value / totalWeight));
}

function readExternalFeedbackSeedRows(db, { model, modelVersion, direction = "negative" } = {}) {
  const safeModel = cleanText(model) || DEFAULT_PROFILE_MODEL;
  const safeModelVersion = cleanText(modelVersion) || DEFAULT_PROFILE_MODEL_VERSION;
  const safeDirection = cleanText(direction).toLowerCase() === "positive" ? "positive" : "negative";
  const ratings = safeDirection === "positive"
    ? ["love", "like", "good", "up"]
    : ["dislike", "skip", "never", "never_again", "down"];
  const oppositeRatings = safeDirection === "positive"
    ? ["dislike", "skip", "never", "never_again", "down"]
    : ["love", "like", "good", "up"];
  const selectedPlaceholders = ratings.map(() => "?").join(", ");
  const oppositePlaceholders = oppositeRatings.map(() => "?").join(", ");
  return db.prepare(`
    SELECT ti.id AS track_identity_id, ti.identity_key, ti.artist, ti.title,
      ti.mix_version, ti.album, ti.tidal_id, ti.isrc,
      be.genre, be.subgenre, be.label, be.confidence AS beatport_confidence,
      tsp.id AS embedding_id, tsp.dimensions, tsp.embedding_base64
    FROM track_identity ti
    JOIN beatport_enrichment be ON be.track_identity_id = ti.id
    JOIN track_sonic_profile tsp ON tsp.identity_key = ti.identity_key
      AND tsp.model = ? AND tsp.model_version = ?
    WHERE COALESCE(be.confidence, 0) >= 85
      AND EXISTS (
        SELECT 1
        FROM taste_feedback tf
        WHERE tf.track_identity_id = ti.id
          AND LOWER(REPLACE(tf.rating, ' ', '_')) IN (${selectedPlaceholders})
      )
      AND NOT EXISTS (
        SELECT 1
        FROM taste_feedback opposite
        WHERE opposite.track_identity_id = ti.id
          AND LOWER(REPLACE(opposite.rating, ' ', '_')) IN (${oppositePlaceholders})
      )
    ORDER BY ti.id ASC
  `).all(safeModel, safeModelVersion, ...ratings, ...oppositeRatings).map((row) => ({
    ...row,
    trackIdentityId: Number(row.track_identity_id),
    identityKey: cleanText(row.identity_key),
    artist: cleanText(row.artist),
    title: cleanText(row.title),
    mixVersion: cleanText(row.mix_version),
    album: cleanText(row.album),
    tidalId: cleanText(row.tidal_id),
    isrc: cleanText(row.isrc),
    genre: cleanText(row.genre),
    subgenre: cleanText(row.subgenre),
    label: cleanText(row.label),
    beatportConfidence: Number(row.beatport_confidence || 0),
    embeddingId: Number(row.embedding_id || 0),
    dimensions: Number(row.dimensions || 0),
    vector: jsonParseVector(row.embedding_base64)
  }));
}

function readExternalNegativeSeedRows(db, options = {}) {
  return readExternalFeedbackSeedRows(db, { ...options, direction: "negative" });
}

function buildTasteClusterProfiles(db, {
  model = DEFAULT_PROFILE_MODEL,
  modelVersion = DEFAULT_PROFILE_MODEL_VERSION,
  minEmbeddings = 2,
  links = null,
  includeExternalNegativeSeeds = false,
  includeExternalFeedbackSeeds = false
} = {}) {
  const safeModel = cleanText(model) || DEFAULT_PROFILE_MODEL;
  const safeModelVersion = cleanText(modelVersion) || DEFAULT_PROFILE_MODEL_VERSION;
  const safeMinEmbeddings = Math.max(1, Number(minEmbeddings) || 2);
  const clusterRows = db.prepare(`
    SELECT c.id, c.cluster_key, c.name, c.source, c.model_version,
      m.local_file_id, l.track_identity_id, l.link_status, l.confidence
    FROM taste_cluster c
    JOIN taste_cluster_member m ON m.cluster_id = c.id
    LEFT JOIN local_library_identity_link l ON l.local_file_id = m.local_file_id
    WHERE c.source = ?
    ORDER BY c.id ASC, m.local_file_id ASC
  `).all(BOOTSTRAP_SOURCE);
  const linkMap = new Map((links || []).map((link) => [Number(link.localFileId), link]));
  const feedbackIndex = buildFeedbackIndex(db);
  // Sonic profiles from external sources are keyed directly by track identity,
  // while local-file profiles are intentionally keyed by file hash. Resolve
  // both forms here so a strong local-library identity link can contribute its
  // learned vector to the same taste profile without changing queue identity.
  const embeddingRows = db.prepare(`
    SELECT tsp.*,
      ti.id AS direct_track_identity_id,
      lf.id AS local_file_id,
      persisted_link.track_identity_id AS persisted_link_identity_id,
      persisted_link.link_status AS persisted_link_status,
      persisted_link.confidence AS persisted_link_confidence
    FROM track_sonic_profile tsp
    LEFT JOIN track_identity ti ON ti.identity_key = tsp.identity_key
    LEFT JOIN local_library_file lf
      ON lf.file_hash = tsp.source_sha256
      AND lf.status = 'processed'
    LEFT JOIN local_library_identity_link persisted_link
      ON persisted_link.local_file_id = lf.id
      AND persisted_link.link_status IN ('EXACT', 'HIGH_CONFIDENCE')
    WHERE tsp.model = ? AND tsp.model_version = ?
    ORDER BY tsp.id ASC
  `).all(safeModel, safeModelVersion);
  const embeddingLinkMap = new Map((links || [])
    .filter((link) => link.trackIdentityId && ["EXACT", "HIGH_CONFIDENCE"].includes(link.linkStatus))
    .map((link) => [Number(link.localFileId), link]));
  const embeddings = new Map();
  const embeddingPriorities = new Map();
  for (const row of embeddingRows) {
    const vector = jsonParseVector(row.embedding_base64);
    if (!vector.length) continue;
    const directIdentityId = Number(row.direct_track_identity_id || 0) || null;
    const localLink = embeddingLinkMap.get(Number(row.local_file_id)) || null;
    const linkedIdentityId = localLink?.trackIdentityId
      ? Number(localLink.trackIdentityId)
      : Number(row.persisted_link_identity_id || 0) || null;
    const linkedStatus = localLink?.linkStatus || cleanText(row.persisted_link_status);
    const linkedConfidence = localLink?.confidence || Number(row.persisted_link_confidence || 0);
    const trackIdentityId = directIdentityId || (
      linkedIdentityId && ["EXACT", "HIGH_CONFIDENCE"].includes(linkedStatus)
        ? linkedIdentityId
        : null
    );
    if (!trackIdentityId) continue;
    const mappingSource = directIdentityId ? "track-identity" : "local-file-identity-link";
    const priority = directIdentityId ? 2 : 1;
    if ((embeddingPriorities.get(trackIdentityId) || 0) > priority) continue;
    embeddings.set(trackIdentityId, {
      vector,
      dimensions: Number(row.dimensions || vector.length),
      embeddingId: Number(row.id),
      identityKey: cleanText(row.identity_key),
      sourceSha256: cleanText(row.source_sha256),
      mappingSource,
      linkConfidence: Number(linkedConfidence || 0) || null
    });
    embeddingPriorities.set(trackIdentityId, priority);
  }
  const grouped = new Map();
  for (const row of clusterRows) {
    const cluster = grouped.get(Number(row.id)) || {
      id: Number(row.id),
      clusterKey: cleanText(row.cluster_key),
      name: cleanText(row.name),
      members: new Map()
    };
    const link = linkMap.get(Number(row.local_file_id)) || {
      trackIdentityId: row.track_identity_id ? Number(row.track_identity_id) : null,
      linkStatus: cleanText(row.link_status),
      confidence: Number(row.confidence || 0)
    };
    if (link.trackIdentityId && ["EXACT", "HIGH_CONFIDENCE"].includes(link.linkStatus)) {
      cluster.members.set(Number(link.trackIdentityId), {
        localFileId: Number(row.local_file_id),
        trackIdentityId: Number(link.trackIdentityId),
        linkStatus: link.linkStatus,
        confidence: link.confidence
      });
    }
    grouped.set(Number(row.id), cluster);
  }
  const includeExternalSeeds = includeExternalNegativeSeeds || includeExternalFeedbackSeeds;
  const externalFeedbackSeeds = includeExternalSeeds
    ? {
        positive: readExternalFeedbackSeedRows(db, { model: safeModel, modelVersion: safeModelVersion, direction: "positive" }),
        negative: readExternalFeedbackSeedRows(db, { model: safeModel, modelVersion: safeModelVersion, direction: "negative" })
      }
    : { positive: [], negative: [] };
  const externalFeedbackAssignments = [];
  const externalFeedbackUnassigned = [];
  if (includeExternalSeeds) {
    const clustersByKey = new Map(Array.from(grouped.values()).map((cluster) => [cluster.clusterKey, cluster]));
    for (const [direction, seeds] of Object.entries(externalFeedbackSeeds)) {
      for (const seed of seeds) {
        const feature = rowFeature(seed);
        const clusterKeys = Array.from(feature.terms.keys())
          .map((term) => `metadata:${term}`)
          .filter((clusterKey) => clustersByKey.has(clusterKey));
        const uniqueClusterKeys = Array.from(new Set(clusterKeys));
        if (!uniqueClusterKeys.length || !seed.vector.length) {
          externalFeedbackUnassigned.push({
            direction,
            trackIdentityId: seed.trackIdentityId,
            identityKey: seed.identityKey,
            artist: seed.artist,
            title: seed.title,
            genre: seed.genre,
            subgenre: seed.subgenre,
            reason: !seed.vector.length ? "missing embedding vector" : "no matching provisional metadata facet"
          });
          continue;
        }
        for (const clusterKey of uniqueClusterKeys) {
          const cluster = clustersByKey.get(clusterKey);
          if (cluster.members.has(seed.trackIdentityId)) continue;
          cluster.members.set(seed.trackIdentityId, {
            localFileId: null,
            trackIdentityId: seed.trackIdentityId,
            linkStatus: "EXTERNAL_FEEDBACK_SEED",
            confidence: seed.beatportConfidence,
            external: true,
            externalDirection: direction,
            source: "beatport-preview"
          });
          externalFeedbackAssignments.push({
            direction,
            trackIdentityId: seed.trackIdentityId,
            identityKey: seed.identityKey,
            artist: seed.artist,
            title: seed.title,
            clusterId: cluster.id,
            clusterKey,
            clusterName: cluster.name,
            source: "beatport-preview",
            beatportConfidence: seed.beatportConfidence,
            embeddingId: seed.embeddingId
          });
        }
      }
    }
  }
  const profiles = [];
  for (const cluster of grouped.values()) {
    const localMembers = Array.from(cluster.members.values()).filter((member) => !member.external);
    const directions = ["positive", "negative"];
    for (const direction of directions) {
      const feedbackMembers = [];
      let conflictIdentityCount = 0;
      for (const member of cluster.members.values()) {
        const feedback = feedbackIndex.get(member.trackIdentityId);
        if (!feedback) continue;
        const positive = feedback.positiveEvents > 0;
        const negative = feedback.negativeEvents > 0;
        if (positive && negative) {
          conflictIdentityCount += 1;
          continue;
        }
        if ((direction === "positive" && positive) || (direction === "negative" && negative)) {
          feedbackMembers.push({ member, feedback, embedding: embeddings.get(member.trackIdentityId) || null });
        }
      }
      const embeddingMembers = feedbackMembers.filter((item) => Array.isArray(item.embedding?.vector) && item.embedding.vector.length);
      const vectors = embeddingMembers.map((item) => item.embedding.vector);
      const weights = embeddingMembers.map((item) => {
        const weight = direction === "positive"
          ? Number(item.feedback.positiveScore || 0)
          : Math.abs(Number(item.feedback.negativeScore || 0));
        return Number.isFinite(weight) && weight > 0 ? weight : 1;
      });
      const dimensions = vectors[0]?.length || feedbackMembers.find((item) => item.embedding)?.embedding?.dimensions || null;
      const vector = vectors.length >= safeMinEmbeddings ? meanNormalizedVector(vectors, weights) : [];
      const status = vector.length
        ? "ready"
        : feedbackMembers.length
          ? "insufficient-embedding-support"
          : cluster.members.size
            ? "no-feedback"
            : "no-linked-identities";
      profiles.push({
        clusterId: cluster.id,
        clusterKey: cluster.clusterKey,
        clusterName: cluster.name,
        direction,
        model: safeModel,
        modelVersion: safeModelVersion,
        dimensions,
        vector,
        status,
        linkedIdentityCount: localMembers.length,
        feedbackIdentityCount: feedbackMembers.length,
        embeddingIdentityCount: vectors.length,
        feedbackEventCount: feedbackMembers.reduce((sum, item) => sum + (direction === "positive" ? item.feedback.positiveEvents : item.feedback.negativeEvents), 0),
        conflictIdentityCount,
        metadata: {
          source: BOOTSTRAP_SOURCE,
          profileType: "feedback-weighted-sonic-centroid",
          metadataFacetModelVersion: BOOTSTRAP_MODEL_VERSION,
          minEmbeddings: safeMinEmbeddings,
          metadataOnly: !vector.length,
          excludedWrongGenreFromNegative: true,
          includeExternalNegativeSeeds: Boolean(includeExternalNegativeSeeds),
          externalNegativeSeedCount: feedbackMembers.filter((item) => item.member.external && item.member.externalDirection === direction && direction === "negative").length,
          externalFeedbackSeedCount: feedbackMembers.filter((item) => item.member.external && item.member.externalDirection === direction).length,
          conflictIdentityCount,
          contributingTrackIdentityIds: feedbackMembers.map((item) => item.member.trackIdentityId),
          contributingEmbeddingIds: feedbackMembers.map((item) => item.embedding?.embeddingId).filter(Boolean)
        }
      });
    }
  }
  return {
    schemaVersion: CLUSTER_PROFILE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    model: safeModel,
    modelVersion: safeModelVersion,
    minEmbeddings: safeMinEmbeddings,
    summary: {
      clusterCount: grouped.size,
      profileCount: profiles.length,
      readyCount: profiles.filter((profile) => profile.status === "ready").length,
      pendingCount: profiles.filter((profile) => profile.status !== "ready").length,
      linkedIdentityCount: new Set(Array.from(grouped.values()).flatMap((cluster) => Array.from(cluster.members.values())
        .filter((member) => !member.external)
        .map((member) => member.trackIdentityId))).size,
      feedbackProfileCount: profiles.filter((profile) => profile.feedbackIdentityCount > 0).length,
      embeddingProfileCount: profiles.filter((profile) => profile.embeddingIdentityCount > 0).length,
      externalNegativeSeedCount: externalFeedbackSeeds.negative.length,
      externalNegativeAssignedCount: new Set(externalFeedbackAssignments.filter((item) => item.direction === "negative").map((item) => item.trackIdentityId)).size,
      externalNegativeAssignmentCount: externalFeedbackAssignments.filter((item) => item.direction === "negative").length,
      externalNegativeUnassignedCount: externalFeedbackUnassigned.filter((item) => item.direction === "negative").length,
      externalPositiveSeedCount: externalFeedbackSeeds.positive.length,
      externalPositiveAssignedCount: new Set(externalFeedbackAssignments.filter((item) => item.direction === "positive").map((item) => item.trackIdentityId)).size,
      externalPositiveAssignmentCount: externalFeedbackAssignments.filter((item) => item.direction === "positive").length,
      externalPositiveUnassignedCount: externalFeedbackUnassigned.filter((item) => item.direction === "positive").length
    },
    profiles,
    externalNegativeSeeds: {
      enabled: Boolean(includeExternalSeeds),
      source: "accepted Beatport preview + explicit feedback",
      positive: externalFeedbackSeeds.positive.map((seed) => ({
        trackIdentityId: seed.trackIdentityId,
        identityKey: seed.identityKey,
        artist: seed.artist,
        title: seed.title,
        genre: seed.genre,
        subgenre: seed.subgenre,
        beatportConfidence: seed.beatportConfidence,
        embeddingId: seed.embeddingId,
        dimensions: seed.dimensions
      })),
      negative: externalFeedbackSeeds.negative.map((seed) => ({
        trackIdentityId: seed.trackIdentityId,
        identityKey: seed.identityKey,
        artist: seed.artist,
        title: seed.title,
        genre: seed.genre,
        subgenre: seed.subgenre,
        beatportConfidence: seed.beatportConfidence,
        embeddingId: seed.embeddingId,
        dimensions: seed.dimensions
      })),
      assignments: externalFeedbackAssignments,
      unassigned: externalFeedbackUnassigned
    }
  };
}

function jsonParseVector(value) {
  if (!value) return [];
  try {
    const buffer = Buffer.from(String(value), "base64");
    if (!buffer.length || buffer.length % 4 !== 0) return [];
    return Array.from(new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4));
  } catch {
    return [];
  }
}

function rowFeature(row = {}) {
  const terms = new Map();
  const add = (value, weight, sourceField) => {
    const exactTerms = new Set(splitLabels(value).map(canonicalTerm));
    for (const term of termsForLabel(value)) {
      const tokenCount = term.split(" ").filter(Boolean).length;
      // Preserve parent tokens for overlap, but give complete genre phrases
      // more weight so "Progressive House" wins over the generic "House"
      // facet when a track has enough metadata to support that distinction.
      const termWeight = exactTerms.has(term) ? weight * 1.25 : weight * 0.5;
      const existing = terms.get(term) || { score: 0, fields: new Set() };
      existing.score += termWeight;
      existing.fields.add(sourceField);
      terms.set(term, existing);
    }
  };
  add(row.genre, 4, "genre");
  add(row.subgenre, 5, "subgenre");

  const artist = cleanText(row.artist);
  const title = cleanText(row.title);
  const eligible = Boolean(artist && title && terms.size);
  return {
    row,
    eligible,
    terms,
    metadata: {
      artist: artist || null,
      title: title || null,
      album: cleanText(row.album) || null,
      genre: cleanText(row.genre) || null,
      subgenre: cleanText(row.subgenre) || null,
      label: cleanText(row.label) || null,
      year: numeric(row.year),
      bpm: numeric(row.bpm),
      completenessScore: numeric(row.completeness_score) || 0,
      completenessClass: cleanText(row.completeness_class) || "poor"
    }
  };
}

function bootstrapTasteClusters(rows = [], {
  minSupport = 2,
  maxClusters = 32,
  maxFacetsPerTrack = 3,
  membershipThreshold = 0.35,
  generatedAt = new Date().toISOString()
} = {}) {
  const safeMinSupport = Math.max(1, Number(minSupport) || 2);
  const safeMaxClusters = Math.max(1, Number(maxClusters) || 32);
  const safeMaxFacetsPerTrack = Math.max(1, Number(maxFacetsPerTrack) || 3);
  const safeMembershipThreshold = Math.max(0.05, Math.min(1, Number(membershipThreshold) || 0.35));
  const features = rows.map(rowFeature);
  const support = new Map();
  for (const feature of features) {
    if (!feature.eligible) continue;
    for (const term of feature.terms.keys()) support.set(term, (support.get(term) || 0) + 1);
  }

  const supportedTerms = new Set(Array.from(support.entries())
    .filter(([, count]) => count >= safeMinSupport)
    .sort((left, right) => (right[1] - left[1]) || left[0].localeCompare(right[0]))
    .slice(0, safeMaxClusters)
    .map(([term]) => term));

  const assignments = [];
  const clusterMembers = new Map();
  let eligibleRows = 0;
  let excludedNoIdentity = 0;
  let excludedNoUsefulFacet = 0;

  for (const feature of features) {
    if (!feature.metadata.artist || !feature.metadata.title) {
      excludedNoIdentity += 1;
      continue;
    }
    if (!feature.eligible) {
      excludedNoUsefulFacet += 1;
      continue;
    }
    eligibleRows += 1;
    const candidates = Array.from(feature.terms.entries())
      .filter(([term]) => supportedTerms.has(term))
      .map(([term, data]) => ({ term, score: data.score, fields: Array.from(data.fields).sort() }))
      .sort((left, right) => (right.score - left.score) || left.term.localeCompare(right.term));
    if (!candidates.length) {
      excludedNoUsefulFacet += 1;
      continue;
    }
    const topScore = candidates[0].score;
    const selected = candidates
      .filter((candidate) => candidate.score >= topScore * safeMembershipThreshold)
      .slice(0, safeMaxFacetsPerTrack)
      .map((candidate, index) => ({
        localFileId: Number(feature.row.id),
        clusterKey: `metadata:${candidate.term}`,
        term: candidate.term,
        membershipScore: Number((candidate.score / candidates.reduce((sum, item) => sum + item.score, 0)).toFixed(6)),
        membershipKind: index === 0 ? "primary" : "secondary",
        evidence: {
          source: BOOTSTRAP_SOURCE,
          fields: candidate.fields,
          genre: feature.metadata.genre,
          subgenre: feature.metadata.subgenre,
          label: feature.metadata.label,
          completenessScore: feature.metadata.completenessScore,
          completenessClass: feature.metadata.completenessClass
        },
        track: feature.metadata
      }));
    for (const assignment of selected) {
      assignments.push(assignment);
      const members = clusterMembers.get(assignment.term) || [];
      members.push(assignment);
      clusterMembers.set(assignment.term, members);
    }
  }

  const clusters = Array.from(clusterMembers.entries())
    .map(([term, members]) => {
      const memberRows = members
        .slice()
        .sort((left, right) => (right.membershipScore - left.membershipScore)
          || (right.evidence.completenessScore - left.evidence.completenessScore)
          || left.track.artist.localeCompare(right.track.artist))
        .slice(0, 8);
      const years = members.map((member) => member.track.year).filter((year) => Number.isFinite(year));
      const bpms = members.map((member) => member.track.bpm).filter((bpm) => Number.isFinite(bpm));
      const labels = new Map();
      for (const member of members) {
        if (member.track.label) labels.set(member.track.label, (labels.get(member.track.label) || 0) + 1);
      }
      return {
        clusterKey: `metadata:${term}`,
        name: labelDisplayName(term),
        source: BOOTSTRAP_SOURCE,
        modelVersion: BOOTSTRAP_MODEL_VERSION,
        status: "provisional-metadata-only",
        memberCount: members.length,
        supportCount: support.get(term) || members.length,
        metadata: {
          facet: term,
          metadataOnly: true,
          noSonicCentroid: true,
          fields: Array.from(new Set(members.flatMap((member) => member.evidence.fields))).sort(),
          yearRange: years.length ? { min: Math.min(...years), max: Math.max(...years) } : null,
          bpmRange: bpms.length ? { min: Math.min(...bpms), max: Math.max(...bpms) } : null,
          topLabels: Array.from(labels.entries())
            .sort((left, right) => (right[1] - left[1]) || left[0].localeCompare(right[0]))
            .slice(0, 8)
            .map(([label, count]) => ({ label, count })),
          representativeTracks: memberRows.map((member) => ({
            localFileId: member.localFileId,
            artist: member.track.artist,
            title: member.track.title,
            album: member.track.album,
            membershipScore: member.membershipScore
          }))
        },
        members
      };
    })
    .sort((left, right) => (right.memberCount - left.memberCount) || left.name.localeCompare(right.name));

  return {
    schemaVersion: TASTE_CLUSTER_SCHEMA_VERSION,
    generatedAt,
    model: {
      source: BOOTSTRAP_SOURCE,
      version: BOOTSTRAP_MODEL_VERSION,
      type: "overlapping metadata facets",
      metadataOnly: true,
      productionDiscoveryEnabled: false,
      note: "These provisional facets bootstrap library organization; sonic embeddings and feedback may later split, merge, or cross them."
    },
    summary: {
      rowsScanned: rows.length,
      eligibleRows,
      excludedNoIdentity,
      excludedNoUsefulFacet,
      clusterCount: clusters.length,
      assignmentCount: assignments.length,
      minSupport: safeMinSupport,
      maxClusters: safeMaxClusters
    },
    clusters,
    assignments
  };
}

class TasteClusterStore {
  constructor({ db = null, dbFile = "", logger = console, clock = Date.now } = {}) {
    this.db = db;
    this.ownsDb = false;
    this.dbFile = dbFile;
    this.logger = logger;
    this.clock = typeof clock === "function" ? clock : Date.now;
    if (!this.db && dbFile) {
      let DatabaseSync;
      try {
        ({ DatabaseSync } = require("node:sqlite"));
      } catch (error) {
        throw new Error(`node:sqlite is not available: ${error.message}`);
      }
      fs.mkdirSync(path.dirname(dbFile), { recursive: true });
      this.db = new DatabaseSync(dbFile);
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA busy_timeout = 5000");
      this.db.exec("PRAGMA foreign_keys = ON");
      this.ownsDb = true;
    }
    if (!this.db) throw new Error("A Rabbit Hole music-memory database is required.");
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS taste_cluster (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cluster_key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        source TEXT NOT NULL,
        model_version TEXT NOT NULL,
        status TEXT NOT NULL,
        member_count INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS taste_cluster_member (
        cluster_id INTEGER NOT NULL,
        local_file_id INTEGER NOT NULL,
        membership_score REAL NOT NULL,
        membership_kind TEXT NOT NULL,
        evidence_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (cluster_id, local_file_id),
        FOREIGN KEY (cluster_id) REFERENCES taste_cluster(id) ON DELETE CASCADE,
        FOREIGN KEY (local_file_id) REFERENCES local_library_file(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS local_library_identity_link (
        local_file_id INTEGER PRIMARY KEY,
        track_identity_id INTEGER,
        link_status TEXT NOT NULL,
        confidence INTEGER NOT NULL DEFAULT 0,
        match_type TEXT NOT NULL,
        evidence_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (local_file_id) REFERENCES local_library_file(id) ON DELETE CASCADE,
        FOREIGN KEY (track_identity_id) REFERENCES track_identity(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_local_library_identity_link_identity
        ON local_library_identity_link(track_identity_id, link_status);

      CREATE TABLE IF NOT EXISTS taste_cluster_profile (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cluster_id INTEGER NOT NULL,
        direction TEXT NOT NULL,
        model TEXT NOT NULL,
        model_version TEXT NOT NULL,
        dimensions INTEGER,
        embedding_base64 TEXT,
        status TEXT NOT NULL,
        linked_identity_count INTEGER NOT NULL DEFAULT 0,
        feedback_identity_count INTEGER NOT NULL DEFAULT 0,
        embedding_identity_count INTEGER NOT NULL DEFAULT 0,
        feedback_event_count INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (cluster_id, direction, model, model_version),
        FOREIGN KEY (cluster_id) REFERENCES taste_cluster(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_taste_cluster_profile_lookup
        ON taste_cluster_profile(model, model_version, direction, status);

      CREATE INDEX IF NOT EXISTS idx_taste_cluster_source ON taste_cluster(source, model_version);
      CREATE INDEX IF NOT EXISTS idx_taste_cluster_member_file ON taste_cluster_member(local_file_id);
    `);
  }

  replaceMetadataBootstrap(report) {
    if (!report?.clusters) throw new Error("A taste-cluster bootstrap report is required.");
    const now = new Date(Number(this.clock())).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM taste_cluster WHERE source = ?").run(BOOTSTRAP_SOURCE);
      const clusterStatement = this.db.prepare(`
        INSERT INTO taste_cluster (
          cluster_key, name, source, model_version, status, member_count, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const memberStatement = this.db.prepare(`
        INSERT INTO taste_cluster_member (
          cluster_id, local_file_id, membership_score, membership_kind, evidence_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const cluster of report.clusters) {
        const result = clusterStatement.run(
          cluster.clusterKey,
          cluster.name,
          cluster.source || BOOTSTRAP_SOURCE,
          cluster.modelVersion || BOOTSTRAP_MODEL_VERSION,
          cluster.status || "provisional-metadata-only",
          cluster.memberCount || 0,
          JSON.stringify(cluster.metadata || {}),
          now,
          now
        );
        const clusterId = Number(result.lastInsertRowid);
        for (const member of cluster.members || []) {
          memberStatement.run(
            clusterId,
            member.localFileId,
            member.membershipScore || 0,
            member.membershipKind || "secondary",
            JSON.stringify(member.evidence || {}),
            now,
            now
          );
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.status();
  }

  replaceIdentityLinks(links = []) {
    const now = new Date(Number(this.clock())).toISOString();
    const statement = this.db.prepare(`
      INSERT INTO local_library_identity_link (
        local_file_id, track_identity_id, link_status, confidence, match_type,
        evidence_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(local_file_id) DO UPDATE SET
        track_identity_id = excluded.track_identity_id,
        link_status = excluded.link_status,
        confidence = excluded.confidence,
        match_type = excluded.match_type,
        evidence_json = excluded.evidence_json,
        updated_at = excluded.updated_at
    `);
    for (const link of links) {
      statement.run(
        Number(link.localFileId),
        link.trackIdentityId ? Number(link.trackIdentityId) : null,
        link.linkStatus || "UNMATCHED",
        Number(link.confidence || 0),
        link.matchType || "UNMATCHED",
        JSON.stringify(link.evidence || {}),
        now,
        now
      );
    }
    return this.identityLinkStatus();
  }

  replaceProfiles(report) {
    if (!report?.profiles) throw new Error("A taste-cluster profile report is required.");
    const model = cleanText(report.model) || DEFAULT_PROFILE_MODEL;
    const modelVersion = cleanText(report.modelVersion) || DEFAULT_PROFILE_MODEL_VERSION;
    const now = new Date(Number(this.clock())).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM taste_cluster_profile WHERE model = ? AND model_version = ?").run(model, modelVersion);
      const statement = this.db.prepare(`
        INSERT INTO taste_cluster_profile (
          cluster_id, direction, model, model_version, dimensions, embedding_base64,
          status, linked_identity_count, feedback_identity_count, embedding_identity_count,
          feedback_event_count, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const profile of report.profiles) {
        const vector = Array.isArray(profile.vector) && profile.vector.length ? profile.vector : null;
        statement.run(
          Number(profile.clusterId),
          profile.direction,
          model,
          modelVersion,
          Number(profile.dimensions || (vector ? vector.length : 0)) || null,
          vector ? encodeVector(normalizeVector(vector)) : null,
          profile.status || "pending",
          Number(profile.linkedIdentityCount || 0),
          Number(profile.feedbackIdentityCount || 0),
          Number(profile.embeddingIdentityCount || 0),
          Number(profile.feedbackEventCount || 0),
          JSON.stringify({ ...(profile.metadata || {}), conflictIdentityCount: Number(profile.conflictIdentityCount || 0) }),
          now,
          now
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.profileStatus({ model, modelVersion });
  }

  identityLinkStatus() {
    const rows = this.db.prepare(`
      SELECT link_status AS status, COUNT(*) AS count
      FROM local_library_identity_link
      GROUP BY link_status
      ORDER BY link_status
    `).all();
    return Object.fromEntries(rows.map((row) => [cleanText(row.status), Number(row.count || 0)]));
  }

  profileStatus({ model = DEFAULT_PROFILE_MODEL, modelVersion = DEFAULT_PROFILE_MODEL_VERSION } = {}) {
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM taste_cluster_profile
      WHERE model = ? AND model_version = ?
      GROUP BY status
      ORDER BY status
    `).all(model, modelVersion);
    return Object.fromEntries(rows.map((row) => [cleanText(row.status), Number(row.count || 0)]));
  }

  status() {
    const count = (sql, params = []) => Number(this.db.prepare(sql).get(...params)?.count || 0);
    return {
      schemaVersion: TASTE_CLUSTER_SCHEMA_VERSION,
      clusterCount: count("SELECT COUNT(*) AS count FROM taste_cluster WHERE source = ?", [BOOTSTRAP_SOURCE]),
      memberAssignmentCount: count(`
        SELECT COUNT(*) AS count
        FROM taste_cluster_member m
        JOIN taste_cluster c ON c.id = m.cluster_id
        WHERE c.source = ?
      `, [BOOTSTRAP_SOURCE]),
      identityLinkStatus: this.identityLinkStatus(),
      profileStatus: this.profileStatus()
    };
  }

  close() {
    if (!this.ownsDb) return;
    try {
      this.db?.close?.();
    } catch {
      // best effort
    }
    this.db = null;
  }
}

module.exports = {
  BOOTSTRAP_MODEL_VERSION,
  BOOTSTRAP_SOURCE,
  CLUSTER_PROFILE_SCHEMA_VERSION,
  DEFAULT_PROFILE_MODEL,
  DEFAULT_PROFILE_MODEL_VERSION,
  GENERIC_TERMS,
  TasteClusterStore,
  buildFeedbackIndex,
  buildTasteClusterProfiles,
  readExternalNegativeSeedRows,
  bootstrapTasteClusters,
  canonicalTerm,
  identityTextCompatible,
  identityTextKey,
  linkLocalLibraryToTrackIdentities,
  labelDisplayName,
  meanNormalizedVector,
  rowFeature,
  termsForLabel
};
