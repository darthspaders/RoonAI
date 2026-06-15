"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_FILE = path.join(__dirname, "..", "data", "query-yield.json");
const MAX_ENTRIES = 750;
const MAX_EXAMPLES = 5;

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalize(value) {
  return cleanText(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function queryTemplate(query) {
  return normalize(query)
    .replace(/\b(?:19|20)\d{2}\b/g, "{year}")
    .replace(/\b\d+\b/g, "{n}")
    .replace(/\s+/g, " ")
    .trim();
}

function nowIso() {
  return new Date().toISOString();
}

function emptySnapshot() {
  return {
    version: 1,
    updatedAt: "",
    entries: {}
  };
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function rejectionBucketForReason(reason = "") {
  const text = String(reason || "").toLowerCase();
  if (/\b(?:seo|catalogue filler|catalog filler|genre date|mix compilation|filler|sludge)\b/.test(text)) return "seo";
  if (/\b(?:outside the requested|genre\/vibe|requested genre|scene|wrong genre|does not confirm|search query|corroborat|metadata)\b/.test(text)) return "genre";
  if (/\b(?:release|year|date|outside \d{4}|range)\b/.test(text)) return "date";
  if (/\b(?:previously suggested|held back|history)\b/.test(text)) return "history";
  if (/\b(?:below minimum|minimum)\b/.test(text)) return "minimum";
  if (/\b(?:short|radio edit)\b/.test(text)) return "short";
  if (/\b(?:tidal|verified|verification)\b/.test(text)) return "verification";
  return "other";
}

function entryQuality(entry = {}) {
  const attempts = Math.max(1, Number(entry.attempts || 0));
  const acceptedRate = Number(entry.accepted || 0) / attempts;
  const returnedRate = Number(entry.returned || 0) / attempts;
  const rejectRate = Number(entry.rejected || 0) / attempts;
  const seoRate = Number(entry.seoRejects || 0) / attempts;
  const genreRate = Number(entry.genreRejects || 0) / attempts;
  const errorRate = Number(entry.errorCount || 0) / attempts;

  return Math.round(clamp(
    acceptedRate * 12 +
      Math.min(returnedRate, 12) * 0.18 -
      rejectRate * 1.2 -
      seoRate * 3.4 -
      genreRate * 2.4 -
      errorRate * 2.8,
    -8,
    8
  ));
}

function displayEntry(entry = {}) {
  return {
    template: entry.template || "",
    attempts: Number(entry.attempts || 0),
    returned: Number(entry.returned || 0),
    accepted: Number(entry.accepted || 0),
    rejected: Number(entry.rejected || 0),
    seoRejects: Number(entry.seoRejects || 0),
    genreRejects: Number(entry.genreRejects || 0),
    errorCount: Number(entry.errorCount || 0),
    quality: entryQuality(entry),
    examples: Array.isArray(entry.examples) ? entry.examples.slice(0, MAX_EXAMPLES) : []
  };
}

function summarizeRecords(records = [], adjustments = []) {
  const totals = records.reduce((memo, record) => {
    memo.attempted += Number(record.attempts || 0);
    memo.returned += Number(record.returned || 0);
    memo.accepted += Number(record.accepted || 0);
    memo.rejected += Number(record.rejected || 0);
    memo.seoRejects += Number(record.seoRejects || 0);
    memo.genreRejects += Number(record.genreRejects || 0);
    memo.errorCount += Number(record.errorCount || 0);
    return memo;
  }, {
    attempted: 0,
    returned: 0,
    accepted: 0,
    rejected: 0,
    seoRejects: 0,
    genreRejects: 0,
    errorCount: 0
  });

  const worst = records
    .map((record) => ({
      query: record.query || "",
      template: record.template || queryTemplate(record.query),
      accepted: Number(record.accepted || 0),
      rejected: Number(record.rejected || 0),
      seoRejects: Number(record.seoRejects || 0),
      genreRejects: Number(record.genreRejects || 0),
      errorCount: Number(record.errorCount || 0),
      returned: Number(record.returned || 0)
    }))
    .filter((record) => record.rejected || record.seoRejects || record.genreRejects || record.errorCount)
    .sort((left, right) => {
      const leftBad = left.seoRejects * 3 + left.genreRejects * 2 + left.errorCount * 2 + left.rejected;
      const rightBad = right.seoRejects * 3 + right.genreRejects * 2 + right.errorCount * 2 + right.rejected;
      return rightBad - leftBad;
    })
    .slice(0, 6);

  const best = records
    .map((record) => ({
      query: record.query || "",
      template: record.template || queryTemplate(record.query),
      accepted: Number(record.accepted || 0),
      returned: Number(record.returned || 0),
      rejected: Number(record.rejected || 0)
    }))
    .filter((record) => record.accepted)
    .sort((left, right) => right.accepted - left.accepted || right.returned - left.returned)
    .slice(0, 6);

  return {
    enabled: true,
    ...totals,
    adjustments: adjustments.slice(0, 8),
    best,
    worst
  };
}

class QueryYieldTracker {
  constructor(file = DEFAULT_FILE) {
    this.file = file;
  }

  read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!parsed || typeof parsed !== "object") return emptySnapshot();
      return {
        ...emptySnapshot(),
        ...parsed,
        entries: parsed.entries && typeof parsed.entries === "object" ? parsed.entries : {}
      };
    } catch {
      return emptySnapshot();
    }
  }

  write(snapshot) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, `${JSON.stringify(snapshot, null, 2)}\n`);
  }

  rankQueries(queries = [], context = {}) {
    const snapshot = this.read();
    const ranked = queries
      .map((query, index) => {
        const template = queryTemplate(query);
        const entry = snapshot.entries[template] || null;
        const quality = entry ? entryQuality(entry) : 0;
        const laneBonus = context.lane && entry?.lanes?.[context.lane] ? 1 : 0;
        return {
          query,
          index,
          template,
          quality,
          score: quality + laneBonus,
          entry
        };
      })
      .sort((left, right) => right.score - left.score || left.index - right.index);

    const adjustments = ranked
      .filter((item) => item.score !== 0 && item.entry)
      .slice(0, 10)
      .map((item) => ({
        query: item.query,
        template: item.template,
        quality: item.quality,
        attempts: Number(item.entry.attempts || 0),
        accepted: Number(item.entry.accepted || 0),
        seoRejects: Number(item.entry.seoRejects || 0),
        genreRejects: Number(item.entry.genreRejects || 0)
      }));

    return {
      queries: ranked.map((item) => item.query),
      adjustments
    };
  }

  recordRun(records = [], adjustments = []) {
    const cleanRecords = records.filter((record) => cleanText(record.query));
    if (!cleanRecords.length) {
      return summarizeRecords([], adjustments);
    }

    const snapshot = this.read();
    const updatedAt = nowIso();

    for (const record of cleanRecords) {
      const template = record.template || queryTemplate(record.query);
      if (!template) continue;
      const entry = snapshot.entries[template] || {
        template,
        attempts: 0,
        returned: 0,
        accepted: 0,
        rejected: 0,
        seoRejects: 0,
        genreRejects: 0,
        errorCount: 0,
        lanes: {},
        examples: [],
        firstUsedAt: updatedAt,
        lastUsedAt: updatedAt
      };

      entry.attempts += Number(record.attempts || 0);
      entry.returned += Number(record.returned || 0);
      entry.accepted += Number(record.accepted || 0);
      entry.rejected += Number(record.rejected || 0);
      entry.seoRejects += Number(record.seoRejects || 0);
      entry.genreRejects += Number(record.genreRejects || 0);
      entry.errorCount += Number(record.errorCount || 0);
      entry.lastUsedAt = updatedAt;

      const lane = cleanText(record.lane || "unknown") || "unknown";
      entry.lanes[lane] = Number(entry.lanes[lane] || 0) + Number(record.attempts || 0);
      const example = cleanText(record.query);
      if (example && !entry.examples.includes(example)) {
        entry.examples.unshift(example);
        entry.examples = entry.examples.slice(0, MAX_EXAMPLES);
      }

      snapshot.entries[template] = entry;
    }

    snapshot.updatedAt = updatedAt;
    const entries = Object.values(snapshot.entries)
      .sort((left, right) => {
        const rightActivity = Number(right.attempts || 0) + Number(right.accepted || 0) + Number(right.rejected || 0);
        const leftActivity = Number(left.attempts || 0) + Number(left.accepted || 0) + Number(left.rejected || 0);
        return rightActivity - leftActivity;
      })
      .slice(0, MAX_ENTRIES);
    snapshot.entries = Object.fromEntries(entries.map((entry) => [entry.template, entry]));
    this.write(snapshot);

    return summarizeRecords(cleanRecords, adjustments);
  }

  summary(limit = 6) {
    const entries = Object.values(this.read().entries || {});
    const sorted = entries
      .map(displayEntry)
      .sort((left, right) => right.quality - left.quality || right.accepted - left.accepted);
    return {
      entries: entries.length,
      best: sorted.filter((entry) => entry.quality > 0).slice(0, limit),
      worst: sorted.slice().reverse().filter((entry) => entry.quality < 0).slice(0, limit)
    };
  }
}

module.exports = {
  QueryYieldTracker,
  queryTemplate,
  rejectionBucketForReason,
  entryQuality,
  summarizeRecords
};
