#!/usr/bin/env node
"use strict";

// Build an offline sonic-evaluation manifest from Rabbit Hole's existing
// feedback memory and a local audio library. This script is read-only against
// Rabbit Hole SQLite; it only writes the caller-selected JSON artifact.

const fs = require("node:fs");
const path = require("node:path");

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  DatabaseSync = null;
}

const AUDIO_EXTENSIONS = new Set([".flac", ".mp3", ".wav", ".m4a", ".aiff", ".ogg", ".opus"]);
const IGNORED_TOKENS = new Set([
  "a", "an", "and", "the", "of", "in", "on", "with", "feat", "featuring", "from", "vs",
  "mix", "remix", "original", "extended", "edit", "version", "club", "radio", "live", "vip",
  "rework", "dub", "instrumental", "vocal", "main", "cut", "remastered", "remaster"
]);
const RATING_CATEGORIES = new Map([
  ["love", "positive"],
  ["like", "positive"],
  ["good", "positive"],
  ["up", "positive"],
  ["ok", "neutral"],
  ["okay", "neutral"],
  ["dislike", "negative"],
  ["wrong_genre", "mismatch"],
  ["wrong genre", "mismatch"],
  ["wrong", "mismatch"],
  ["reject_similar", "mismatch"],
  ["reject similar", "mismatch"],
  ["skip", "negative"],
  ["down", "negative"],
  ["never", "negative"],
  ["never_again", "negative"],
  ["never again", "negative"]
]);
const CANONICAL_RATINGS = new Map([
  ["love", "love"], ["like", "like"], ["good", "good"], ["up", "good"], ["ok", "ok"], ["okay", "ok"], ["dislike", "dislike"],
  ["wrong_genre", "wrong_genre"], ["wrong genre", "wrong_genre"], ["wrong", "wrong_genre"],
  ["reject_similar", "reject_similar"], ["reject similar", "reject_similar"],
  ["skip", "skip"], ["down", "skip"], ["never", "never"],
  ["never_again", "never"], ["never again", "never"]
]);

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeText(value) {
  return cleanText(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function meaningfulTokens(value) {
  return normalizeText(value)
    .split(" ")
    .filter((token) => token.length >= 3 && !IGNORED_TOKENS.has(token));
}

function parseArgs(argv) {
  const args = {
    db: path.join(__dirname, "..", "data", "rabbit-hole-memory.sqlite"),
    musicRoot: "Z:\\Music",
    output: path.join(require("node:os").tmpdir(), "rabbit-hole-rated-manifest.json"),
    maxPerLabel: 120
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--db") args.db = path.resolve(argv[++index]);
    else if (arg === "--music-root") args.musicRoot = path.resolve(argv[++index]);
    else if (arg === "--output") args.output = path.resolve(argv[++index]);
    else if (arg === "--max-per-label") args.maxPerLabel = Math.max(1, Number(argv[++index]) || 120);
    else if (arg === "--help") {
      console.log("Usage: node scripts/sonic-build-rated-manifest.js [--db path] [--music-root path] [--output path] [--max-per-label n]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function stableHash(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function walkAudioFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) stack.push(file);
      else if (AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        const basename = normalizeText(path.basename(entry.name, path.extname(entry.name)));
        const normalizedPath = normalizeText(file);
        const baseTokens = new Set(basename.split(" ").filter(Boolean));
        files.push({
          file,
          basename,
          normalizedPath,
          baseTokens,
          pathTokens: new Set(normalizedPath.split(" ").filter(Boolean))
        });
      }
    }
  }
  return files;
}

function buildTokenIndex(files) {
  const index = new Map();
  files.forEach((file, fileIndex) => {
    for (const token of file.baseTokens) {
      if (!index.has(token)) index.set(token, []);
      index.get(token).push(fileIndex);
    }
  });
  return index;
}

function readFeedback(dbFile) {
  if (!DatabaseSync) throw new Error("node:sqlite is not available in this Node runtime");
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const rows = db.prepare(`
    SELECT
      ti.id,
      ti.artist,
      ti.title,
      ti.mix_version,
      ti.album,
      ti.tidal_id,
      tf.rating,
      tf.created_at,
      tf.context,
      tf.source_label
    FROM taste_feedback tf
    JOIN track_identity ti ON ti.id = tf.track_identity_id
    WHERE ti.artist <> '' AND ti.title <> ''
    ORDER BY tf.created_at ASC, tf.id ASC
  `).all();
  db.close();

  const byIdentity = new Map();
  for (const row of rows) {
    const entry = byIdentity.get(row.id) || {
      id: row.id,
      artist: cleanText(row.artist),
      title: cleanText(row.title),
      mixVersion: cleanText(row.mix_version),
      album: cleanText(row.album),
      tidalId: cleanText(row.tidal_id),
      events: []
    };
    const rawRating = cleanText(row.rating).toLowerCase();
    const normalizedRating = normalizeText(rawRating).replace(/ /g, "_");
    const category = RATING_CATEGORIES.get(normalizedRating) || RATING_CATEGORIES.get(rawRating) || "unknown";
    entry.events.push({
      rating: CANONICAL_RATINGS.get(normalizedRating) || CANONICAL_RATINGS.get(rawRating) || rawRating,
      category,
      at: cleanText(row.created_at),
      context: cleanText(row.context),
      source: cleanText(row.source_label)
    });
    byIdentity.set(row.id, entry);
  }
  return [...byIdentity.values()];
}

function clearLabel(entry) {
  const categories = new Set(entry.events.map((event) => event.category).filter((category) => category !== "unknown"));
  if (categories.size !== 1) return "";
  return [...categories][0];
}

function scoreFileMatch(entry, file, titleTokens, artistTokens) {
  const titleNormalized = normalizeText(entry.title);
  const titlePhrase = titleNormalized.length >= 4 && file.basename.includes(titleNormalized);
  const titleHits = titleTokens.filter((token) => file.baseTokens.has(token)).length;
  const titleRatio = titleTokens.length ? titleHits / titleTokens.length : 0;
  const artistHits = artistTokens.filter((token) => file.pathTokens.has(token)).length;
  const artistPhrase = normalizeText(entry.artist).length >= 4 && file.normalizedPath.includes(normalizeText(entry.artist));

  if (!titlePhrase && (titleHits < Math.min(2, titleTokens.length) || titleRatio < 0.6)) return null;
  if (!titlePhrase && artistTokens.length && artistHits === 0) return null;

  const score = (titlePhrase ? 12 : titleRatio * 8)
    + Math.min(artistHits, 3) * 3
    + (artistPhrase ? 2 : 0);
  return {
    file: file.file,
    score: Number(score.toFixed(3)),
    titlePhrase,
    titleHits,
    titleTokenCount: titleTokens.length,
    artistHits,
    artistTokenCount: artistTokens.length
  };
}

function matchEntry(entry, files, tokenIndex) {
  const titleTokens = meaningfulTokens(entry.title);
  const artistTokens = meaningfulTokens(entry.artist);
  if (!titleTokens.length) return [];

  const postings = titleTokens.map((token) => tokenIndex.get(token) || []).filter((items) => items.length);
  if (!postings.length) return [];
  postings.sort((left, right) => left.length - right.length);

  const candidates = [];
  for (const fileIndex of postings[0]) {
    const result = scoreFileMatch(entry, files[fileIndex], titleTokens, artistTokens);
    if (result) candidates.push(result);
  }
  return candidates.sort((left, right) => right.score - left.score || left.file.localeCompare(right.file));
}

function collectionName(root, file) {
  const relative = path.relative(root, file);
  const first = relative.split(path.sep).filter(Boolean)[0];
  return first || "root";
}

function chooseBalanced(rows, maxPerLabel) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.collection)) groups.set(row.collection, []);
    groups.get(row.collection).push(row);
  }
  for (const groupRows of groups.values()) groupRows.sort((left, right) => right.matchScore - left.matchScore || left.id - right.id);

  const selected = [];
  const groupList = [...groups.values()];
  while (selected.length < maxPerLabel && groupList.some((group) => group.length)) {
    for (const group of groupList) {
      if (selected.length >= maxPerLabel) break;
      const row = group.shift();
      if (row) selected.push(row);
    }
  }
  return selected;
}

function buildManifest(args) {
  const files = walkAudioFiles(args.musicRoot);
  const tokenIndex = buildTokenIndex(files);
  const feedback = readFeedback(args.db);
  const matched = [];
  const unmatched = [];
  const usedFiles = new Set();

  for (const entry of feedback) {
    const label = clearLabel(entry);
    if (!label) continue;
    const candidates = matchEntry(entry, files, tokenIndex);
    if (!candidates.length) {
      unmatched.push({ id: entry.id, artist: entry.artist, title: entry.title, label, reason: "no filename match" });
      continue;
    }
    const best = candidates[0];
    const ties = candidates.filter((candidate) => candidate.score === best.score);
    if (ties.length > 1 && !best.titlePhrase) {
      unmatched.push({ id: entry.id, artist: entry.artist, title: entry.title, label, reason: "ambiguous filename match", candidates: ties.slice(0, 3) });
      continue;
    }
    if (usedFiles.has(best.file)) continue;
    usedFiles.add(best.file);
    const latest = entry.events.at(-1) || {};
    matched.push({
      id: String(entry.id),
      file: best.file,
      sourceFile: best.file,
      artist: entry.artist,
      title: entry.title,
      mixVersion: entry.mixVersion,
      album: entry.album,
      tidalId: entry.tidalId,
      rating: latest.rating,
      label,
      relevance: label === "positive" ? 1 : 0,
      split: label === "positive" ? (stableHash(entry.id) % 5 === 0 ? "test" : "train") : "pool",
      collection: collectionName(args.musicRoot, best.file),
      matchScore: best.score,
      matchEvidence: best,
      feedbackCount: entry.events.length,
      feedbackEvents: entry.events
    });
  }

  const byLabel = new Map();
  for (const row of matched) {
    if (!byLabel.has(row.label)) byLabel.set(row.label, []);
    byLabel.get(row.label).push(row);
  }
  const tracks = [];
  for (const label of ["positive", "neutral", "negative", "mismatch"]) {
    tracks.push(...chooseBalanced(byLabel.get(label) || [], args.maxPerLabel));
  }
  tracks.sort((left, right) => left.id.localeCompare(right.id));

  const counts = {};
  const splitCounts = {};
  for (const row of tracks) {
    counts[row.label] = (counts[row.label] || 0) + 1;
    splitCounts[row.split] = (splitCounts[row.split] || 0) + 1;
  }
  return {
    schemaVersion: 3,
    generatedAt: new Date().toISOString(),
    purpose: "offline sonic embedding evaluation from existing Rabbit Hole feedback",
    source: {
      database: path.resolve(args.db),
      musicRoot: path.resolve(args.musicRoot),
      audioFileCount: files.length,
      feedbackIdentityCount: feedback.length,
      clearMatchedIdentityCount: matched.length,
      unmatchedIdentityCount: unmatched.length
    },
    labels: {
      positive: "love/like (legacy good/up) feedback",
      neutral: "ok/okay feedback",
      negative: "dislike/never (legacy skip) feedback",
      mismatch: "wrong-genre/reject-similar feedback; not sonic dislike",
      collection: "top-level local music folder; provisional only"
    },
    counts: { selected: tracks.length, byLabel: counts, bySplit: splitCounts },
    tracks,
    unmatched
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = buildManifest(args);
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    output: args.output,
    selected: manifest.counts.selected,
    byLabel: manifest.counts.byLabel,
    bySplit: manifest.counts.bySplit,
    audioFileCount: manifest.source.audioFileCount,
    feedbackIdentityCount: manifest.source.feedbackIdentityCount,
    clearMatchedIdentityCount: manifest.source.clearMatchedIdentityCount,
    unmatchedIdentityCount: manifest.source.unmatchedIdentityCount
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(`sonic rated manifest failed: ${error.message}`);
  process.exitCode = 1;
}
