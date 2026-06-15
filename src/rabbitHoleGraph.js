"use strict";

const fs = require("fs");
const path = require("path");

const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const CACHE_VERSION = 2;
const USER_AGENT = "TheRabbitHole/0.1.0 (local Roon discovery app)";

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
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

function splitArtists(value) {
  return cleanText(value)
    .split(/\s+(?:and|feat\.?|featuring|with)\s+|[,/&+|]+/i)
    .map(cleanText)
    .filter((part) => part && part.length > 1 && part.length <= 80);
}

function trackKey(track = {}) {
  const tidalUrl = cleanText(track.tidal?.tidalUrl || track.tidalUrl);
  if (tidalUrl) return tidalUrl.toLowerCase();
  return `${normalize(track.artist)}|${normalize(track.title)}`;
}

function labelFor(track = {}) {
  return cleanText(track.label || track.tidal?.label);
}

function durationMinutes(track = {}) {
  return Number(track.durationMs || 0) / 60000;
}

function uniqueBy(values, keyFn = normalize) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const key = keyFn(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function topWeighted(items, { limit = 12, key = (item) => item.name } = {}) {
  const map = new Map();
  for (const item of items || []) {
    const name = cleanText(key(item));
    const normalized = normalize(name);
    if (!normalized) continue;
    const current = map.get(normalized) || { ...item, name, weight: 0, sources: [] };
    current.weight += Number(item.weight || 1);
    current.sources = uniqueBy([...(current.sources || []), ...(item.sources || []), item.source].filter(Boolean));
    map.set(normalized, current);
  }
  return [...map.values()]
    .sort((left, right) => Number(right.weight || 0) - Number(left.weight || 0) || cleanText(left.name).localeCompare(cleanText(right.name)))
    .slice(0, limit);
}

function remixersFromTitle(title) {
  const remixers = [];
  for (const match of cleanText(title).matchAll(/[\[(]([^)\]]*(?:remix|rework|rerub|dub|edit|mix)[^)\]]*)[\])]/gi)) {
    const text = cleanText(match[1]
      .replace(/\b(?:original|extended|club|radio|vocal|instrumental|dub|edit|mix|remix|rework|rerub|version)\b/gi, " "));
    if (text && !/^original$/i.test(text)) remixers.push(text);
  }
  return uniqueBy(remixers);
}

function cleanTrack(track = {}) {
  return {
    key: track.key || trackKey(track),
    artist: cleanText(track.artist || track.tidal?.artist),
    title: cleanText(track.title || track.tidal?.title),
    album: cleanText(track.album || track.tidal?.album),
    label: labelFor(track),
    year: track.year || track.tidal?.year || null,
    durationMs: track.durationMs || track.tidal?.durationMs || null,
    score: track.score || track.scoreBreakdown?.total || null,
    feedback: cleanText(track.feedback),
    tidalUrl: cleanText(track.tidal?.tidalUrl || track.tidalUrl),
    source: cleanText(track.source || track.discoverySource)
  };
}

function mergeTrack(base = {}, next = {}) {
  const cleanedNext = cleanTrack(next);
  return {
    ...base,
    ...Object.fromEntries(Object.entries(cleanedNext).filter(([, value]) => value !== "" && value !== null && value !== undefined)),
    tidal: next.tidal || base.tidal || null,
    roon: next.roon || base.roon || null
  };
}

function baseTitleForCatalogMatch(value) {
  return normalize(String(value || "")
    .replace(/\s*[\[(][^\])]*(?:mix|remix|edit|version|rework|dub|rerub|original|extended)[^\])]*[\])]/gi, " ")
    .replace(/\s+/g, " "));
}

function titleConfirmsSeed(seed = {}, candidate = {}) {
  const seedTitle = normalize(seed.title);
  const candidateTitle = normalize(candidate.title);
  const seedBase = baseTitleForCatalogMatch(seed.title);
  const candidateBase = baseTitleForCatalogMatch(candidate.title);
  return Boolean(
    seedTitle &&
    candidateTitle &&
    (seedTitle === candidateTitle || (seedBase && seedBase === candidateBase))
  );
}

function artistConfirmsSeed(seed = {}, candidate = {}) {
  const seedArtists = splitArtists(seed.artist).map(normalize).filter(Boolean);
  const candidateArtists = splitArtists(candidate.artist).map(normalize).filter(Boolean);
  if (!seedArtists.length || !candidateArtists.length) return false;
  return seedArtists.some((seedArtist) => candidateArtists.some((candidateArtist) => (
    seedArtist === candidateArtist ||
    (seedArtist.length >= 4 && candidateArtist.length >= 4 && (seedArtist.includes(candidateArtist) || candidateArtist.includes(seedArtist)))
  )));
}

function catalogMatchConfirmsSeed(seed = {}, candidate = {}) {
  return titleConfirmsSeed(seed, candidate) && artistConfirmsSeed(seed, candidate);
}

function feedbackWeight(feedback, weights = {}) {
  const rating = cleanText(feedback).toLowerCase();
  if (rating === "love") return weights.love || 0;
  if (rating === "good" || rating === "up") return weights.good || 0;
  if (rating === "ok" || rating === "okay") return weights.ok || 0;
  return weights.default || 0;
}

function collectLocalTracks({ discoveryHistory, trackMemory, savedPlaylist, tasteProfile } = {}) {
  const tracks = [];
  for (const entry of trackMemory?.entries?.values?.() || []) tracks.push(cleanTrack({ ...entry, source: "track memory" }));
  for (const entry of savedPlaylist?.list?.() || []) tracks.push(cleanTrack({ ...entry, source: "playlist candidates" }));
  for (const entry of discoveryHistory?.entries?.values?.() || []) tracks.push(cleanTrack({ ...entry, source: "discovery history" }));

  const profile = tasteProfile?.read?.() || {};
  for (const entry of Object.values(profile.feedback || {})) {
    tracks.push(cleanTrack({
      artist: entry.artist,
      title: entry.title,
      label: entry.label,
      tidalUrl: entry.tidalUrl,
      feedback: entry.rating,
      source: `rated ${entry.rating}`
    }));
  }

  return uniqueBy(tracks.filter((track) => track.artist && track.title), (track) => track.key || trackKey(track));
}

function collectContextTracks(contextTracks = []) {
  return uniqueBy((Array.isArray(contextTracks) ? contextTracks : [])
    .map((track) => cleanTrack({ ...track, source: track.source || "Roon live queue" }))
    .filter((track) => track.artist && track.title), (track) => track.key || trackKey(track));
}

function artistOverlaps(track = {}, artists = []) {
  const trackArtists = splitArtists(track.artist).map(normalize);
  const wanted = artists.map(normalize);
  return trackArtists.some((artist) => wanted.some((seed) => artist === seed || artist.includes(seed) || seed.includes(artist)));
}

function sameLabel(track = {}, labels = []) {
  const label = normalize(labelFor(track));
  if (!label) return false;
  return labels.map(normalize).some((candidate) => candidate && (label === candidate || label.includes(candidate) || candidate.includes(label)));
}

function entity(type, name, extra = {}) {
  return {
    id: `${type}:${normalize(name)}`,
    type,
    name: cleanText(name),
    source: cleanText(extra.source || extra.sources?.[0]),
    sources: uniqueBy([...(extra.sources || []), extra.source].filter(Boolean)),
    weight: Number(extra.weight || 1),
    prompt: cleanText(extra.prompt),
    track: extra.track || null
  };
}

function trackEntity(track = {}, extra = {}) {
  const title = cleanText(track.title);
  const artist = cleanText(track.artist);
  return entity("track", title ? `${artist} - ${title}` : artist, {
    ...extra,
    source: extra.source || track.source || "catalogue",
    weight: extra.weight || track.score || 1,
    track: cleanTrack(track)
  });
}

async function fetchJson(url, { headers = {}, timeoutMs = 6500 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "user-agent": USER_AGENT,
        ...headers
      }
    });
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function musicBrainzRelatedArtists(artistName, enabled = true) {
  if (!enabled || !artistName) return [];
  const searchUrl = new URL("https://musicbrainz.org/ws/2/artist/");
  searchUrl.searchParams.set("query", `artist:"${artistName}"`);
  searchUrl.searchParams.set("fmt", "json");
  searchUrl.searchParams.set("limit", "1");
  const search = await fetchJson(searchUrl.toString());
  const id = search?.artists?.[0]?.id;
  if (!id) return [];

  const detailUrl = new URL(`https://musicbrainz.org/ws/2/artist/${encodeURIComponent(id)}`);
  detailUrl.searchParams.set("inc", "artist-rels");
  detailUrl.searchParams.set("fmt", "json");
  const detail = await fetchJson(detailUrl.toString());
  return uniqueBy((detail?.relations || [])
    .map((relation) => relation.artist?.name || relation["target-credit"])
    .map(cleanText)
    .filter(Boolean))
    .slice(0, 10)
    .map((name) => entity("artist", name, { source: "MusicBrainz relation", weight: 5 }));
}

async function lastFmSimilarArtists(artistName, apiKey) {
  if (!apiKey || !artistName) return [];
  const url = new URL("https://ws.audioscrobbler.com/2.0/");
  url.searchParams.set("method", "artist.getsimilar");
  url.searchParams.set("artist", artistName);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "12");
  const json = await fetchJson(url.toString());
  return (json?.similarartists?.artist || [])
    .map((artist) => entity("artist", artist.name, { source: "Last.fm similar", weight: Math.round(Number(artist.match || 0) * 10) || 4 }))
    .filter((item) => item.name);
}

async function discogsArtistLabels(artistName, token) {
  if (!token || !artistName) return [];
  const url = new URL("https://api.discogs.com/database/search");
  url.searchParams.set("q", artistName);
  url.searchParams.set("type", "release");
  url.searchParams.set("per_page", "20");
  const json = await fetchJson(url.toString(), {
    headers: { authorization: `Discogs token=${token}` }
  });
  const labels = [];
  for (const item of json?.results || []) {
    if (item.label?.[0]) labels.push(entity("label", item.label[0], { source: "Discogs release", weight: 3 }));
  }
  return labels;
}

function promptForEntity(entityNode, graph) {
  const artist = graph.seed.artist;
  const labels = graph.sections.labels.items.slice(0, 5).map((item) => item.name).filter(Boolean);
  const related = graph.sections.relatedArtists.items.slice(0, 6).map((item) => item.name).filter(Boolean);
  const labelText = labels.length ? labels.join(", ") : "scene-relevant labels";
  const relatedText = related.length ? related.join(", ") : "related artists from the graph";

  if (entityNode.type === "label") {
    return `Using ${artist} as the seed artist, search ${entityNode.name} and adjacent labels for deeper, less obvious tracks that fit the seed's sound. Avoid repeats and only return Roon-queueable matches.`;
  }

  if (entityNode.type === "artist" || entityNode.type === "remixer") {
    return `Using ${entityNode.name} as the seed artist, search for deeper, less obvious tracks connected to ${labelText}. Follow the user's prompt intent first, avoid repeats, and only return Roon-queueable matches.`;
  }

  if (entityNode.type === "track" && entityNode.track) {
    return `Find tracks like ${entityNode.track.artist} - ${entityNode.track.title}, but go deeper and less obvious. Use ${labelText} and similar artists such as ${relatedText}. Avoid repeats and only return Roon-queueable matches.`;
  }

  return `Using ${artist} as the seed artist, search for deeper, less obvious tracks from ${labelText}. Prioritize related artists such as ${relatedText}, follow the prompt intent first, avoid repeats, and only return Roon-queueable matches.`;
}

function section(id, label, depth, items = []) {
  return {
    id,
    label,
    depth,
    items: uniqueBy(items.filter((item) => item?.name), (item) => item.id || `${item.type}:${normalize(item.name)}`)
  };
}

class RabbitHoleGraph {
  constructor(options = {}) {
    this.file = options.file || path.join(__dirname, "..", "data", "rabbit-hole-cache.json");
    this.ttlMs = Number(options.ttlMs || CACHE_TTL_MS);
    this.cache = new Map();
    this.load();
  }

  load() {
    try {
      const json = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.cache = new Map((json.entries || []).map((entry) => [entry.key, entry]).filter(([key]) => key));
    } catch {
      this.cache = new Map();
    }
  }

  save() {
    const entries = [...this.cache.values()]
      .sort((left, right) => Number(right.updatedAtMs || 0) - Number(left.updatedAtMs || 0))
      .slice(0, 500);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ entries }, null, 2));
    this.cache = new Map(entries.map((entry) => [entry.key, entry]));
  }

  cacheKey(track = {}) {
    return trackKey(track);
  }

  cached(track = {}) {
    const key = this.cacheKey(track);
    const entry = key ? this.cache.get(key) : null;
    if (!entry || Date.now() - Number(entry.updatedAtMs || 0) > this.ttlMs) return null;
    if (entry.version !== CACHE_VERSION) return null;
    return {
      ...entry.graph,
      cached: true
    };
  }

  async build(track = {}, deps = {}, options = {}) {
    const cached = !options.force ? this.cached(track) : null;
    if (cached) return cached;

    const graph = await this.createGraph(track, deps);
    const keys = uniqueBy([this.cacheKey(graph.seed), this.cacheKey(track)].filter(Boolean), (value) => value);
    for (const key of keys) {
      this.cache.set(key, {
        key,
        version: CACHE_VERSION,
        updatedAtMs: Date.now(),
        graph
      });
    }
    if (keys.length) {
      this.save();
    }
    return graph;
  }

  async enrichSeed(track = {}, tidal) {
    let seed = cleanTrack(track);
    if (tidal?.isConfigured?.() && seed.artist && seed.title) {
      try {
        const verified = await tidal.verify(seed, { strict: false });
        if (verified && catalogMatchConfirmsSeed(seed, verified)) seed = mergeTrack(seed, { ...verified, tidal: verified });
      } catch {
        // Rabbit Hole can still be useful from local memory if TIDAL is slow or unavailable.
      }
    }
    return seed;
  }

  async tidalArtistCatalog(artistName, tidal) {
    if (!tidal?.isConfigured?.() || !artistName) return [];
    const tracks = [];
    try {
      const albums = await tidal.getArtistAlbums(artistName, { limit: 8 });
      for (const album of albums.slice(0, 6)) {
        const albumTracks = await tidal.getAlbumTracks(album, { limit: 10 });
        tracks.push(...albumTracks.map((track) => cleanTrack({ ...track, source: "TIDAL artist catalog" })));
      }
    } catch {
      return tracks;
    }
    return uniqueBy(tracks.filter((track) => track.artist && track.title), (track) => track.key || trackKey(track));
  }

  async createGraph(track = {}, deps = {}) {
    const {
      config = {},
      tidal,
      discoveryHistory,
      trackMemory,
      savedPlaylist,
      tasteProfile,
      contextTracks = []
    } = deps;
    const seed = await this.enrichSeed(track, tidal);
    const primaryArtists = splitArtists(seed.artist);
    const primaryArtist = primaryArtists[0] || seed.artist || "Unknown artist";
    const seedLabels = [labelFor(seed)].filter(Boolean);
    const localTracks = collectLocalTracks({ discoveryHistory, trackMemory, savedPlaylist, tasteProfile });
    const queueTracks = collectContextTracks(contextTracks);
    const artistCatalog = (await Promise.all(primaryArtists.slice(0, 2).map((artist) => this.tidalArtistCatalog(artist, tidal)))).flat();
    const allTracks = uniqueBy([seed, ...artistCatalog, ...queueTracks, ...localTracks], (item) => item.key || trackKey(item));
    const artistTracks = allTracks.filter((item) => artistOverlaps(item, primaryArtists));
    const labelTracks = seedLabels.length ? allTracks.filter((item) => sameLabel(item, seedLabels)) : [];
    const remixers = remixersFromTitle(seed.title);
    const collaboratorNames = [];
    const relatedArtistSignals = [];
    const labelSignals = [];

    for (const item of [...artistTracks, ...labelTracks]) {
      const artists = splitArtists(item.artist);
      for (const artist of artists) {
        if (!primaryArtists.map(normalize).includes(normalize(artist))) {
          collaboratorNames.push(entity("artist", artist, { source: "collaboration", weight: feedbackWeight(item.feedback, { love: 8, good: 6, ok: 4, default: 3 }) }));
        }
      }
      const label = labelFor(item);
      if (label) labelSignals.push(entity("label", label, { source: item.source || "catalogue label", weight: feedbackWeight(item.feedback, { love: 8, good: 6, ok: 4, default: 3 }) }));
    }

    const profile = tasteProfile?.read?.() || {};
    for (const entry of Object.values(profile.artists || {})) {
      if (Number(entry.score || 0) > 0) relatedArtistSignals.push(entity("artist", entry.name, { source: "liked artist", weight: 2 + Number(entry.score || 0) }));
    }
    for (const entry of Object.values(profile.labels || {})) {
      if (Number(entry.score || 0) > 0) labelSignals.push(entity("label", entry.name, { source: "liked label", weight: 2 + Number(entry.score || 0) }));
    }

    const externalArtistSignals = [
      ...(await musicBrainzRelatedArtists(primaryArtist, config.rabbitHole?.musicBrainz !== false)),
      ...(await lastFmSimilarArtists(primaryArtist, config.rabbitHole?.lastfmApiKey)),
    ];
    const externalLabelSignals = await discogsArtistLabels(primaryArtist, config.rabbitHole?.discogsToken);

    const collaborators = topWeighted(collaboratorNames, { limit: 10 });
    const labels = topWeighted([...labelSignals, ...externalLabelSignals, ...seedLabels.map((label) => entity("label", label, { source: "seed track", weight: 10 }))], { limit: 10 });
    const relatedArtists = topWeighted([...collaborators, ...relatedArtistSignals, ...externalArtistSignals], { limit: 14 })
      .filter((item) => !primaryArtists.map(normalize).includes(normalize(item.name)));

    const hiddenCandidates = allTracks
      .filter((item) => item.title && item.artist && !artistOverlaps(item, [seed.artist]) && (artistOverlaps(item, relatedArtists.map((artist) => artist.name)) || sameLabel(item, labels.map((label) => label.name))))
      .filter((item) => trackKey(item) !== trackKey(seed))
      .map((item) => ({
        ...item,
        weight: Number(item.score || 0) + (durationMinutes(item) >= 7 ? 12 : 0) + feedbackWeight(item.feedback, { love: 18, good: 10, ok: 5 })
      }))
      .sort((left, right) => Number(right.weight || 0) - Number(left.weight || 0))
      .slice(0, 12);

    const deepCatalog = artistCatalog
      .filter((item) => trackKey(item) !== trackKey(seed))
      .sort((left, right) => Number(right.year || 0) - Number(left.year || 0) || Number(right.durationMs || 0) - Number(left.durationMs || 0))
      .slice(0, 10);

    const remixerNodes = remixers.map((name) => entity("remixer", name, { source: "track title", weight: 8 }));
    const sections = {
      artist: section("artist", "Artist", 1, primaryArtists.map((artist) => entity("artist", artist, { source: "seed track", weight: 10 }))),
      collaborators: section("collaborators", "Collaborators & Remixers", 2, [...collaborators, ...remixerNodes]),
      labels: section("labels", "Frequent / Similar Labels", 3, labels),
      relatedArtists: section("relatedArtists", "Related Artists", 4, relatedArtists),
      hiddenGems: section("hiddenGems", "Hidden Gems", 5, hiddenCandidates.map((item) => trackEntity(item, { source: item.source || "local graph", weight: item.weight }))),
      deepCatalog: section("deepCatalog", "Deep Catalog", 5, deepCatalog.map((item) => trackEntity(item, { source: "TIDAL artist catalog", weight: Number(item.year || 0) })))
    };

    const graph = {
      updatedAt: new Date().toISOString(),
      cached: false,
      seed: {
        ...seed,
        artist: seed.artist || primaryArtist,
        label: labelFor(seed),
        remixers
      },
      providerStatus: {
        tidal: artistCatalog.length ? `catalog tracks: ${artistCatalog.length}` : "no artist catalog tracks",
        musicBrainz: config.rabbitHole?.musicBrainz === false ? "disabled" : "attempted",
        lastFm: config.rabbitHole?.lastfmApiKey ? "enabled" : "missing LASTFM_API_KEY",
        discogs: config.rabbitHole?.discogsToken ? "enabled" : "missing DISCOGS_TOKEN",
        queue: `queue tracks: ${queueTracks.length}`,
        local: `local tracks: ${localTracks.length}`
      },
      sections
    };

    for (const group of Object.values(graph.sections)) {
      group.items = group.items.map((item) => ({
        ...item,
        prompt: item.prompt || promptForEntity(item, graph)
      }));
    }

    graph.prompts = {
      artist: promptForEntity(entity("artist", primaryArtist), graph),
      label: labels[0] ? promptForEntity(labels[0], graph) : promptForEntity(entity("artist", primaryArtist), graph),
      similarArtists: `Using ${primaryArtist} as the seed artist, explore related artists ${relatedArtists.slice(0, 8).map((item) => item.name).join(", ") || "from this graph"}. Find deeper, less obvious tracks that fit the seed's sound, avoid repeats, and only return Roon-queueable matches.`,
      hiddenGems: `Find hidden gems connected to ${primaryArtist}, ${labels.slice(0, 5).map((item) => item.name).join(", ") || "adjacent labels"}, and ${relatedArtists.slice(0, 6).map((item) => item.name).join(", ") || "related artists"}. Avoid obvious top tracks and repeats. Only return Roon-queueable matches.`,
      graph: promptForEntity(entity("artist", primaryArtist), graph)
    };

    return graph;
  }
}

module.exports = {
  RabbitHoleGraph
};
