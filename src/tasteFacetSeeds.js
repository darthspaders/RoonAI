"use strict";

// The metadata bootstrap is intentionally only a seed source. It does not
// decide what the user likes and it never becomes a hard genre filter. Its
// job is to keep a mixed library from collapsing into one global top-artist
// list while the sonic/feedback profiles continue to mature.

const GENERIC_FACETS = new Set([
  "house",
  "tech",
  "melodic",
  "deep",
  "progressive",
  "future",
  "mainstage",
  "alternative",
  "nu"
]);

const ELECTRONIC_TERMS = [
  "electronic", "edm", "dance", "house", "techno", "trance", "dubstep",
  "bass", "drum and bass", "dnb", "breakbeat", "breaks", "electronica",
  "electro", "future bass", "indie dance"
];

const NON_ELECTRONIC_TERMS = [
  "rock", "country", "folk", "blues", "jazz", "classical", "baroque",
  "renaissance", "metal", "hip hop", "rap", "soul", "r and b", "soundtrack",
  "spoken word", "audiobook"
];

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalize(value) {
  return cleanText(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function usefulEntity(value) {
  const text = cleanText(value);
  const key = normalize(text);
  if (!key || key.length < 2) return "";
  if (/^(?:various artists?|unknown|unknown artist|soundtrack|compilation|music|records?|recordings?)$/.test(key)) return "";
  return text;
}

function hasTerm(text, terms) {
  return terms.some((term) => {
    const key = normalize(term);
    return key && (text === key || text.includes(key));
  });
}

function facetIsElectronic(name = "") {
  return hasTerm(normalize(name), ELECTRONIC_TERMS);
}

function metadataDomainScore(row = {}, facetName = "") {
  if (!facetIsElectronic(facetName)) return 0;
  const text = normalize(row.genre_text || "");
  const electronic = hasTerm(text, ELECTRONIC_TERMS);
  const nonElectronic = hasTerm(text, NON_ELECTRONIC_TERMS);
  if (electronic && !nonElectronic) return 2;
  if (!electronic && nonElectronic) return -2;
  if (electronic && nonElectronic) return 1;
  return 0;
}

function artistSort(left, right) {
  // Direct feedback beats raw library size. Otherwise a large unengaged
  // artist can starve a smaller but genuinely liked facet.
  return Number(right.positiveCount > 0) - Number(left.positiveCount > 0) ||
    right.positiveCount - left.positiveCount ||
    right.domainScore - left.domainScore ||
    right.sonicCount - left.sonicCount ||
    right.beatportCount - left.beatportCount ||
    right.score - left.score ||
    right.trackCount - left.trackCount ||
    left.name.localeCompare(right.name);
}

function readTasteFacetSeeds(db, {
  maxFacets = 12,
  artistsPerFacet = 3,
  labelsPerFacet = 3
} = {}) {
  const empty = { facets: [], artists: [], labels: [] };
  if (!db || typeof db.prepare !== "function") return empty;

  let rows;
  try {
    rows = db.prepare(`
      SELECT
        c.cluster_key,
        c.name AS cluster_name,
        c.member_count,
        lf.artist,
        lf.label,
        COUNT(*) AS track_count,
        COUNT(DISTINCT CASE WHEN COALESCE(fb.positive, 0) = 1 THEN lf.id END) AS positive_count,
        COUNT(DISTINCT CASE WHEN COALESCE(fb.negative, 0) = 1 THEN lf.id END) AS negative_count,
        COUNT(DISTINCT CASE WHEN be.track_identity_id IS NOT NULL OR TRIM(COALESCE(lf.beatport_id, '')) <> '' THEN lf.id END) AS beatport_count,
        COUNT(DISTINCT CASE WHEN sp.identity_key IS NOT NULL THEN lf.id END) AS sonic_count,
        GROUP_CONCAT(DISTINCT TRIM(COALESCE(lf.genre, '') || ' ' || COALESCE(lf.subgenre, '') || ' ' || COALESCE(be.genre, '') || ' ' || COALESCE(be.subgenre, ''))) AS genre_text
      FROM taste_cluster c
      JOIN taste_cluster_member m ON m.cluster_id = c.id
      JOIN local_library_file lf ON lf.id = m.local_file_id
      LEFT JOIN local_library_identity_link link ON link.local_file_id = lf.id
      LEFT JOIN track_identity ti ON ti.id = link.track_identity_id
      LEFT JOIN beatport_enrichment be ON be.track_identity_id = link.track_identity_id
      LEFT JOIN (SELECT DISTINCT identity_key FROM track_sonic_profile WHERE model = 'discogs-effnet') sp ON sp.identity_key = ti.identity_key
      LEFT JOIN (
        SELECT
          track_identity_id,
          MAX(CASE WHEN LOWER(rating) IN ('love', 'like', 'good', 'up') THEN 1 ELSE 0 END) AS positive,
          MAX(CASE WHEN LOWER(rating) IN ('dislike', 'skip', 'down', 'never', 'never_again') THEN 1 ELSE 0 END) AS negative
        FROM taste_feedback
        GROUP BY track_identity_id
      ) fb ON fb.track_identity_id = link.track_identity_id
      WHERE c.source = 'metadata-bootstrap'
        AND TRIM(COALESCE(lf.artist, '')) <> ''
      GROUP BY c.id, LOWER(TRIM(lf.artist)), LOWER(TRIM(COALESCE(lf.label, '')))
      ORDER BY c.member_count DESC, positive_count DESC, track_count DESC, LOWER(lf.artist) ASC
    `).all();
  } catch {
    return empty;
  }

  const groups = new Map();
  for (const row of rows) {
    const clusterKey = cleanText(row.cluster_key);
    const facet = cleanText(row.cluster_name || clusterKey.replace(/^metadata:/i, ""));
    const facetKey = normalize(facet);
    const artist = usefulEntity(row.artist);
    if (!clusterKey || !facetKey || !artist || GENERIC_FACETS.has(facetKey)) continue;
    if (!groups.has(clusterKey)) {
      groups.set(clusterKey, {
        clusterKey,
        name: facet,
        memberCount: Number(row.member_count || 0),
        artists: new Map(),
        labels: new Map()
      });
    }
    const group = groups.get(clusterKey);
    const artistKey = normalize(artist);
    const trackCount = Number(row.track_count || 0);
    const positiveCount = Number(row.positive_count || 0);
    const negativeCount = Number(row.negative_count || 0);
    const beatportCount = Number(row.beatport_count || 0);
    const sonicCount = Number(row.sonic_count || 0);
    const domainScore = metadataDomainScore(row, facet);
    const score = trackCount + positiveCount * 8 - negativeCount * 6;
    const previousArtist = group.artists.get(artistKey);
    const artistItem = { name: artist, score, trackCount, positiveCount, negativeCount, beatportCount, sonicCount, domainScore };
    if (!previousArtist || artistSort(artistItem, previousArtist) < 0) {
      group.artists.set(artistKey, artistItem);
    }
    const label = usefulEntity(row.label);
    if (label) {
      const labelKey = normalize(label);
      const previousLabel = group.labels.get(labelKey);
      const labelItem = { name: label, score, trackCount, positiveCount, negativeCount, beatportCount, sonicCount, domainScore };
      if (!previousLabel || artistSort(labelItem, previousLabel) < 0) {
        group.labels.set(labelKey, labelItem);
      }
    }
  }

  // Prefer facets with actual positive feedback, then rotate across facets so
  // a large House facet cannot consume the entire taste reservoir.
  const facets = Array.from(groups.values())
    .map(group => ({
      ...group,
      artists: Array.from(group.artists.values()).sort(artistSort),
      labels: Array.from(group.labels.values()).sort(artistSort)
    }))
    .sort((a, b) => {
      const aPositive = a.artists.reduce((sum, item) => sum + item.positiveCount, 0);
      const bPositive = b.artists.reduce((sum, item) => sum + item.positiveCount, 0);
      return bPositive - aPositive || b.memberCount - a.memberCount || a.name.localeCompare(b.name);
    })
    .slice(0, Math.max(1, Number(maxFacets) || 12));

  const artists = [];
  const labels = [];
  const artistKeys = new Set();
  const labelKeys = new Set();
  for (const facet of facets) {
    for (const item of facet.artists.slice(0, Math.max(1, Number(artistsPerFacet) || 3))) {
      const key = normalize(item.name);
      if (!artistKeys.has(key)) {
        artistKeys.add(key);
        artists.push(item.name);
      }
    }
    for (const item of facet.labels.slice(0, Math.max(1, Number(labelsPerFacet) || 3))) {
      const key = normalize(item.name);
      if (!labelKeys.has(key)) {
        labelKeys.add(key);
        labels.push(item.name);
      }
    }
  }

  return {
    facets: facets.map(facet => ({
      clusterKey: facet.clusterKey,
      name: facet.name,
      memberCount: facet.memberCount,
      artists: facet.artists.slice(0, Math.max(1, Number(artistsPerFacet) || 3)).map(item => item.name),
      artistEvidence: facet.artists.slice(0, Math.max(1, Number(artistsPerFacet) || 3)).map(item => ({
        name: item.name,
        positiveCount: item.positiveCount,
        negativeCount: item.negativeCount,
        beatportCount: item.beatportCount,
        sonicCount: item.sonicCount,
        domainScore: item.domainScore,
        // Only external relationship expansion uses this flag. Direct
        // artist/catalog searches can still use every learned anchor.
        similaritySafe: item.domainScore >= 0 && (item.positiveCount > 0 || item.beatportCount > 0 || item.sonicCount > 0)
      })),
      labels: facet.labels.slice(0, Math.max(1, Number(labelsPerFacet) || 3)).map(item => item.name)
    })),
    artists,
    labels
  };
}

module.exports = { readTasteFacetSeeds };
