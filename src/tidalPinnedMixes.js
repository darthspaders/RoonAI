"use strict";

const fs = require("fs");
const path = require("path");

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cleanId(value) {
  return cleanText(value)
    .replace(/[^a-zA-Z0-9_-]+/g, "")
    .slice(0, 128);
}

function inputError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function normalizeKind(value = "") {
  const text = cleanText(value).toLowerCase().replace(/_/g, "-");
  if (["artist-radio", "artistradio", "radio-artist"].includes(text)) return "artist-radio";
  if (text === "mix") return "mix";
  return "playlist";
}

function itemKey(kind, id) {
  return `${normalizeKind(kind)}:${cleanId(id).toLowerCase()}`;
}

function extractFirstUrl(value = "") {
  const text = cleanText(value);
  const match = text.match(/(?:https?:\/\/|tidal:\/\/)[^\s<>"']+/i);
  return match?.[0] || text;
}

function parsePathLikeInput(input = "") {
  const text = cleanText(input).replace(/^tidal:\/\//i, "");
  const parts = text.split(/[/?#]+/).map(cleanText).filter(Boolean);
  const browseIndex = parts.findIndex((part) => part.toLowerCase() === "browse");
  const start = browseIndex >= 0 ? browseIndex + 1 : 0;
  const route = parts.slice(start);
  const first = route[0]?.toLowerCase() || "";
  const second = route[1] || "";
  const third = route[2]?.toLowerCase() || "";

  if (["mix", "playlist"].includes(first) && second) {
    return { kind: first, id: cleanId(second) };
  }
  if (first === "artist" && second && third === "radio") {
    return { kind: "artist-radio", id: cleanId(second) };
  }
  if (first === "radio" && route[1]?.toLowerCase() === "artist" && route[2]) {
    return { kind: "artist-radio", id: cleanId(route[2]) };
  }
  return null;
}

function parseTidalPinnedInput(value = "") {
  const source = cleanText(value);
  if (!source) throw inputError("Paste a TIDAL mix, radio, or playlist link first.");

  const shorthand = source.match(/^(artist-radio|artist|radio|mix|playlist)\s*:\s*([a-zA-Z0-9_-]{2,128})$/i);
  if (shorthand) {
    const kind = /artist|radio/i.test(shorthand[1]) && !/^mix$/i.test(shorthand[1]) && !/^playlist$/i.test(shorthand[1])
      ? "artist-radio"
      : normalizeKind(shorthand[1]);
    const id = cleanId(shorthand[2]);
    if (id) return { kind, id, sourceUrl: source };
  }

  const candidate = extractFirstUrl(source);
  let parsed = null;
  try {
    const url = new URL(candidate);
    parsed = parsePathLikeInput(url.protocol === "tidal:"
      ? `${url.host}${url.pathname}${url.search}${url.hash}`
      : `${url.pathname}${url.search}${url.hash}`);
  } catch {
    parsed = parsePathLikeInput(candidate);
  }

  if (!parsed?.id && /^[a-zA-Z0-9_-]{5,128}$/.test(source)) {
    parsed = { kind: "playlist", id: cleanId(source) };
  }
  if (!parsed?.id) {
    throw inputError("That does not look like a TIDAL mix, radio, or playlist link.");
  }

  return {
    ...parsed,
    sourceUrl: source
  };
}

function tidalPinnedUrl(kind = "playlist", id = "") {
  const safeId = encodeURIComponent(cleanId(id));
  if (!safeId) return "";
  if (normalizeKind(kind) === "artist-radio") return `https://tidal.com/browse/artist/${safeId}/radio`;
  return `https://listen.tidal.com/${normalizeKind(kind) === "mix" ? "mix" : "playlist"}/${safeId}`;
}

class TidalPinnedMixStore {
  constructor(options = {}) {
    this.file = options.file || path.join(__dirname, "..", "data", "tidal-pinned-mixes.json");
    this.items = [];
    this.load();
  }

  normalizeEntry(entry = {}) {
    const kind = normalizeKind(entry.kind);
    const id = cleanId(entry.id);
    if (!id) return null;
    const now = Date.now();
    const key = itemKey(kind, id);
    return {
      key,
      kind,
      id,
      sourceUrl: cleanText(entry.sourceUrl) || tidalPinnedUrl(kind, id),
      title: cleanText(entry.title),
      createdAt: Number(entry.createdAt || now),
      updatedAt: Number(entry.updatedAt || entry.createdAt || now)
    };
  }

  setState(json = {}) {
    const source = Array.isArray(json.items) ? json.items : [];
    const seen = new Set();
    this.items = [];
    for (const item of source) {
      const normalized = this.normalizeEntry(item);
      if (!normalized || seen.has(normalized.key)) continue;
      seen.add(normalized.key);
      this.items.push(normalized);
    }
  }

  load() {
    try {
      this.setState(JSON.parse(fs.readFileSync(this.file, "utf8")));
    } catch {
      this.setState({ items: [] });
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ items: this.items }, null, 2));
  }

  list() {
    return this.items.map((item) => ({ ...item }));
  }

  snapshot() {
    return {
      count: this.items.length,
      items: this.list()
    };
  }

  add(input = "") {
    const parsed = parseTidalPinnedInput(input);
    const now = Date.now();
    const key = itemKey(parsed.kind, parsed.id);
    const existing = this.items.find((item) => item.key === key);
    if (existing) {
      existing.sourceUrl = parsed.sourceUrl || existing.sourceUrl;
      existing.updatedAt = now;
      this.items = [existing, ...this.items.filter((item) => item.key !== key)];
      this.save();
      return { added: false, item: { ...existing }, ...this.snapshot() };
    }

    const item = this.normalizeEntry({
      ...parsed,
      createdAt: now,
      updatedAt: now
    });
    this.items.unshift(item);
    this.save();
    return { added: true, item: { ...item }, ...this.snapshot() };
  }

  remove(keyOrId = "") {
    const value = cleanText(keyOrId);
    if (!value) throw new Error("Pinned TIDAL item id is required.");
    const before = this.items.length;
    this.items = this.items.filter((item) => item.key !== value && item.id !== value);
    const removed = this.items.length !== before;
    if (removed) this.save();
    return { removed, ...this.snapshot() };
  }
}

module.exports = {
  TidalPinnedMixStore,
  itemKey,
  parseTidalPinnedInput,
  tidalPinnedUrl
};
