"use strict";

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

const YEAR_WORDS = new Map(Object.entries({
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  "twenty one": 21,
  "twenty two": 22,
  "twenty three": 23,
  "twenty four": 24,
  "twenty five": 25,
  "twenty six": 26,
  "twenty seven": 27,
  "twenty eight": 28,
  "twenty nine": 29,
  thirty: 30
}));
const YEAR_WORD_PATTERN = [
  "twenty[-\\s]+nine",
  "twenty[-\\s]+eight",
  "twenty[-\\s]+seven",
  "twenty[-\\s]+six",
  "twenty[-\\s]+five",
  "twenty[-\\s]+four",
  "twenty[-\\s]+three",
  "twenty[-\\s]+two",
  "twenty[-\\s]+one",
  "nineteen",
  "eighteen",
  "seventeen",
  "sixteen",
  "fifteen",
  "fourteen",
  "thirteen",
  "twelve",
  "eleven",
  "thirty",
  "twenty",
  "ten",
  "nine",
  "eight",
  "seven",
  "six",
  "five",
  "four",
  "three",
  "two",
  "one",
  "zero"
].join("|");

function expandShortYear(value) {
  const year = Number(value);
  if (!Number.isFinite(year)) return null;
  if (year >= 1000) return year;
  if (year >= 0 && year <= 49) return 2000 + year;
  if (year >= 50 && year <= 99) return 1900 + year;
  return null;
}

function yearWordSuffix(value) {
  const normalized = cleanText(value).toLowerCase().replace(/-/g, " ");
  if (YEAR_WORDS.has(normalized)) return YEAR_WORDS.get(normalized);

  const parts = normalized.split(/\s+/).filter(Boolean);
  let total = 0;
  for (const part of parts) {
    if (!YEAR_WORDS.has(part)) return null;
    total += YEAR_WORDS.get(part);
  }
  return total >= 0 && total <= 49 ? total : null;
}

function normalizeYearText(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[\u2012\u2013\u2014\u2212]/g, "-")
    .replace(new RegExp(String.raw`\btwenty[-\s]+twenty[-\s]+(${YEAR_WORD_PATTERN})\b`, "g"), (match, word) => {
      const suffix = yearWordSuffix(word);
      const adjusted = suffix !== null && suffix < 10 ? suffix + 20 : suffix;
      return adjusted === null ? match : String(2000 + adjusted);
    })
    // Voice input sometimes turns "2025 to 2026" into "20-25 to 2026".
    .replace(/\b20\s*[-/]\s*(\d{2})(?=\s*(?:-|to|through|thru|until|and|\/)\s*(?:19|20)?\d{2})/g, "20$1");
}

function buildRange(first, second) {
  const start = expandShortYear(first);
  const end = expandShortYear(second);
  if (!start || !end) return null;
  const min = Math.min(start, end);
  const max = Math.max(start, end);
  if (min < 1900 || max > 2049) return null;
  return { min, max, label: `${min}-${max}` };
}

function parseYearRange(value) {
  const text = normalizeYearText(value);
  if (!text) return null;

  const separator = String.raw`(?:-|to|through|thru|until|and|/)`;
  const fullRange = text.match(new RegExp(String.raw`\b(19\d{2}|20\d{2})\s*${separator}\s*(19\d{2}|20\d{2})\b`));
  if (fullRange) return buildRange(fullRange[1], fullRange[2]);

  const shortRange = text.match(new RegExp(String.raw`\b'?([0-4]\d)\s*${separator}\s*'?([0-4]\d)\b`));
  if (shortRange) return buildRange(shortRange[1], shortRange[2]);

  const years = Array.from(text.matchAll(/\b(19\d{2}|20\d{2})\b/g), (match) => Number(match[1]));
  if (years.length >= 2) {
    const min = Math.min(...years);
    const max = Math.max(...years);
    return { min, max, label: `${min}-${max}` };
  }
  if (years.length === 1) {
    const year = years[0];
    return { min: year, max: year, label: String(year) };
  }

  return null;
}

function yearFits(year, range) {
  if (!range) return true;
  return Number(year) >= range.min && Number(year) <= range.max;
}

function extractYearSearchTerms(value, limit = 4) {
  const range = parseYearRange(value);
  if (range) {
    return Array.from(
      { length: Math.min(limit, range.max - range.min + 1) },
      (_, index) => String(range.max - index)
    );
  }

  const text = normalizeYearText(value);
  return Array.from(text.matchAll(/\b(19\d{2}|20\d{2})\b/g), (match) => match[1]).slice(0, limit);
}

module.exports = {
  parseYearRange,
  yearFits,
  extractYearSearchTerms,
  normalizeYearText
};
