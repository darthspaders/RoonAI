"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_LIST_ID = "default";
const DEFAULT_LIST_NAME = "Candidates";

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalize(value) {
  return cleanText(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function trackKey(track = {}) {
  const tidalUrl = cleanText(track.tidal?.tidalUrl || track.tidalUrl);
  if (tidalUrl) return tidalUrl.toLowerCase();
  return `${normalize(track.artist)}|${normalize(track.title)}`;
}

function normalizeSavedTrack(track = {}) {
  const key = cleanText(track.key) || trackKey(track);
  return key && key !== "|" ? { ...track, key } : { ...track };
}

function cleanId(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function baseListId(name) {
  return cleanId(name) || "list";
}

class SavedPlaylist {
  constructor(options = {}) {
    this.file = options.file || path.join(__dirname, "..", "data", "saved-playlist.json");
    this.activeListId = DEFAULT_LIST_ID;
    this.lists = [];
    this.load();
  }

  createListId(name) {
    const base = baseListId(name);
    let id = base;
    let suffix = 2;
    while (this.lists.some((list) => list.id === id)) {
      id = `${base}-${suffix}`;
      suffix += 1;
    }
    return id;
  }

  normalizeList(list = {}, fallback = {}) {
    const now = Date.now();
    return {
      id: cleanId(list.id) || fallback.id || this.createListId(list.name || fallback.name || DEFAULT_LIST_NAME),
      name: cleanText(list.name) || fallback.name || DEFAULT_LIST_NAME,
      createdAt: Number(list.createdAt || fallback.createdAt || now),
      updatedAt: Number(list.updatedAt || fallback.updatedAt || now),
      tracks: Array.isArray(list.tracks) ? list.tracks.map(normalizeSavedTrack) : []
    };
  }

  setState(json = {}) {
    const legacyTracks = Array.isArray(json.tracks) ? json.tracks : [];
    const sourceLists = Array.isArray(json.lists) && json.lists.length
      ? json.lists
      : [{ id: DEFAULT_LIST_ID, name: DEFAULT_LIST_NAME, tracks: legacyTracks }];

    this.lists = [];
    for (const source of sourceLists) {
      const normalized = this.normalizeList(source);
      if (this.lists.some((list) => list.id === normalized.id)) {
        normalized.id = this.createListId(normalized.name);
      }
      this.lists.push(normalized);
    }

    if (!this.lists.length) {
      this.lists.push(this.normalizeList({ id: DEFAULT_LIST_ID, name: DEFAULT_LIST_NAME, tracks: [] }));
    }

    const requestedActiveId = cleanId(json.activeListId || json.active_list_id || "");
    this.activeListId = this.lists.some((list) => list.id === requestedActiveId)
      ? requestedActiveId
      : this.lists[0].id;
  }

  load() {
    try {
      const json = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.setState(json);
    } catch {
      this.setState({ tracks: [] });
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({
      activeListId: this.activeListId,
      lists: this.lists
    }, null, 2));
  }

  listSummaries() {
    return this.lists.map((list) => ({
      id: list.id,
      name: list.name,
      count: list.tracks.length,
      createdAt: list.createdAt,
      updatedAt: list.updatedAt
    }));
  }

  snapshot() {
    return {
      activeListId: this.activeListId,
      lists: this.listSummaries(),
      tracks: this.list()
    };
  }

  getList(listId) {
    const id = cleanId(listId || this.activeListId);
    return this.lists.find((list) => list.id === id) || this.lists[0];
  }

  select(listId) {
    const list = this.getList(listId);
    this.activeListId = list.id;
    this.save();
    return this.snapshot();
  }

  create(name = "") {
    const now = Date.now();
    const list = {
      id: this.createListId(name || "New candidates"),
      name: cleanText(name) || "New candidates",
      createdAt: now,
      updatedAt: now,
      tracks: []
    };
    this.lists.push(list);
    this.activeListId = list.id;
    this.save();
    return this.snapshot();
  }

  rename(listId, name = "") {
    const list = this.getList(listId);
    const nextName = cleanText(name);
    if (!nextName) throw new Error("Candidate list name is required.");
    list.name = nextName;
    list.updatedAt = Date.now();
    this.save();
    return this.snapshot();
  }

  delete(listId = "") {
    const id = cleanId(listId);
    if (!id) throw new Error("Candidate list id is required.");
    if (this.lists.length <= 1) throw new Error("Cannot delete the only candidate list.");
    const index = this.lists.findIndex((list) => list.id === id);
    if (index === -1) throw new Error("Candidate list not found.");

    this.lists.splice(index, 1);
    if (this.activeListId === id) {
      this.activeListId = this.lists[Math.max(0, index - 1)]?.id || this.lists[0].id;
    }
    this.save();
    return { deleted: true, ...this.snapshot() };
  }

  list(listId) {
    return this.getList(listId).tracks;
  }

  add(track = {}, listId = "") {
    const list = this.getList(listId);
    const key = trackKey(track);
    if (!key || key === "|") throw new Error("Cannot save a track without a title/artist or TIDAL URL.");
    const existing = list.tracks.find((candidate) => candidate.key === key || trackKey(candidate) === key);
    if (existing) {
      this.activeListId = list.id;
      this.save();
      return { added: false, track: existing, ...this.snapshot() };
    }

    const saved = {
      key,
      artist: cleanText(track.artist),
      title: cleanText(track.title),
      album: cleanText(track.album),
      label: cleanText(track.label || track.tidal?.label),
      year: track.year || null,
      releaseDate: track.releaseDate || track.tidal?.releaseDate || "",
      durationMs: track.durationMs || null,
      score: track.score || null,
      reason: cleanText(track.reason),
      tidal: track.tidal || null,
      savedAt: Date.now()
    };

    list.tracks.push(saved);
    list.updatedAt = saved.savedAt;
    this.activeListId = list.id;
    this.save();
    return { added: true, track: saved, ...this.snapshot() };
  }

  remove(key, listId = "") {
    const list = this.getList(listId);
    const before = list.tracks.length;
    list.tracks = list.tracks.filter((track) => track.key !== key);
    const removed = list.tracks.length !== before;
    if (removed) {
      list.updatedAt = Date.now();
      this.save();
    }
    return { removed, ...this.snapshot() };
  }

  move(key, fromListId = "", toListId = "") {
    const source = this.getList(fromListId);
    const targetId = cleanId(toListId);
    const target = this.lists.find((list) => list.id === targetId);
    const cleanKey = cleanText(key);
    if (!cleanKey) throw new Error("Track key is required.");
    if (!target) throw new Error("Destination candidate list not found.");
    if (source.id === target.id) return { moved: false, reason: "Track is already in that candidate list.", ...this.snapshot() };

    const sourceIndex = source.tracks.findIndex((track) => track.key === cleanKey || trackKey(track) === cleanKey);
    if (sourceIndex === -1) throw new Error("Track was not found in the selected candidate list.");

    const [track] = source.tracks.splice(sourceIndex, 1);
    const duplicate = target.tracks.some((candidate) => candidate.key === cleanKey || trackKey(candidate) === cleanKey);
    const now = Date.now();
    if (!duplicate) {
      target.tracks.push({
        ...track,
        key: track.key || cleanKey,
        movedAt: now
      });
    }
    source.updatedAt = now;
    target.updatedAt = now;
    this.save();
    return {
      moved: !duplicate,
      duplicate,
      track: duplicate ? null : target.tracks[target.tracks.length - 1],
      ...this.snapshot()
    };
  }
}

module.exports = {
  SavedPlaylist,
  trackKey
};
