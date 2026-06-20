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

const MONTHS = new Map(Object.entries({
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12
}));

const MONTH_NAMES = [
  "",
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
];

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

function pad2(value) {
  return String(value).padStart(2, "0");
}

function localDateParts(date) {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate()
  };
}

function formatIsoDate(date) {
  const { year, month, day } = localDateParts(date);
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function todayLocalIso(now = new Date()) {
  return formatIsoDate(now);
}

function addDays(isoDate, days) {
  const parsed = parseIsoDate(isoDate);
  if (!parsed) return "";
  const date = new Date(parsed.year, parsed.month - 1, parsed.day + Number(days || 0));
  return formatIsoDate(date);
}

function daysInMonth(year, month) {
  return new Date(Number(year), Number(month), 0).getDate();
}

function parseIsoDate(value) {
  const match = cleanText(value).match(/\b((19|20)\d{2})[-/](0?[1-9]|1[0-2])[-/](0?[1-9]|[12]\d|3[01])\b/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[3]);
  const day = Number(match[4]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() + 1 !== month || date.getDate() !== day) return null;
  const iso = `${year}-${pad2(month)}-${pad2(day)}`;
  return { year, month, day, iso };
}

function dateOnly(value) {
  const parsed = parseIsoDate(value);
  return parsed ? parsed.iso : "";
}

function dateValue(isoDate) {
  const parsed = parseIsoDate(isoDate);
  return parsed ? Number(`${parsed.year}${pad2(parsed.month)}${pad2(parsed.day)}`) : null;
}

function monthFromText(value) {
  const normalized = cleanText(value).toLowerCase().replace(/\./g, "");
  return MONTHS.get(normalized) || null;
}

function buildRange(first, second) {
  const start = expandShortYear(first);
  const end = expandShortYear(second);
  if (!start || !end) return null;
  const min = Math.min(start, end);
  const max = Math.max(start, end);
  if (min < 1900 || max > 2049) return null;
  return {
    min,
    max,
    label: `${min}-${max}`,
    dateSpecific: false,
    kind: min === max ? "year" : "year-range"
  };
}

function buildDateRange(startDate, endDate, label, kind = "date-range", dateSpecific = true) {
  const start = dateOnly(startDate);
  const end = dateOnly(endDate);
  if (!start || !end) return null;
  const startValue = dateValue(start);
  const endValue = dateValue(end);
  const minDate = startValue <= endValue ? start : end;
  const maxDate = startValue <= endValue ? end : start;
  const min = Number(minDate.slice(0, 4));
  const max = Number(maxDate.slice(0, 4));
  return {
    min,
    max,
    startDate: minDate,
    endDate: maxDate,
    label: label || (minDate === maxDate ? minDate : `${minDate} to ${maxDate}`),
    dateSpecific,
    kind
  };
}

function rangeFromPreset(preset, now = new Date()) {
  const normalized = cleanText(preset).toLowerCase();
  const today = todayLocalIso(now);
  if (!normalized) return null;
  if (normalized === "today") return buildDateRange(today, today, `Today (${today})`, "today", true);
  if (normalized === "yesterday") {
    const yesterday = addDays(today, -1);
    return buildDateRange(yesterday, yesterday, `Yesterday (${yesterday})`, "yesterday", true);
  }
  if (["last7", "last 7 days", "week", "this week"].includes(normalized)) {
    return buildDateRange(addDays(today, -6), today, "Last 7 days", "last-days", true);
  }
  if (["last30", "last 30 days", "month", "this month"].includes(normalized)) {
    return buildDateRange(addDays(today, -29), today, "Last 30 days", "last-days", true);
  }
  if (["last90", "last 90 days"].includes(normalized)) {
    return buildDateRange(addDays(today, -89), today, "Last 90 days", "last-days", true);
  }
  if (["thisyear", "this year"].includes(normalized)) {
    const year = now.getFullYear();
    return buildDateRange(`${year}-01-01`, `${year}-12-31`, String(year), "year", false);
  }
  return null;
}

function parseTextDateFilter(value, now = new Date()) {
  const text = normalizeYearText(value);
  if (!text) return null;

  const preset = text.match(/\b(today|yesterday|this week|last 7 days|last seven days|last 30 days|last thirty days|last 90 days|last ninety days|this year)\b/);
  if (preset) {
    const key = preset[1]
      .replace("seven", "7")
      .replace("thirty", "30")
      .replace("ninety", "90");
    return rangeFromPreset(key, now);
  }

  const dates = Array.from(text.matchAll(/\b(19|20)\d{2}[-/](?:0?[1-9]|1[0-2])[-/](?:0?[1-9]|[12]\d|3[01])\b/g), (match) => dateOnly(match[0])).filter(Boolean);
  if (dates.length >= 2) return buildDateRange(dates[0], dates[1]);
  if (dates.length === 1) return buildDateRange(dates[0], dates[0], dates[0], "exact-date", true);

  const yearMonth = text.match(/\b((?:19|20)\d{2})[-/](0?[1-9]|1[0-2])\b/);
  if (yearMonth) {
    const year = Number(yearMonth[1]);
    const month = Number(yearMonth[2]);
    return buildDateRange(
      `${year}-${pad2(month)}-01`,
      `${year}-${pad2(month)}-${pad2(daysInMonth(year, month))}`,
      `${MONTH_NAMES[month]} ${year}`,
      "month",
      true
    );
  }

  const monthNamePattern = Array.from(MONTHS.keys()).sort((left, right) => right.length - left.length).join("|");
  const monthYear = text.match(new RegExp(String.raw`\b(${monthNamePattern})\s+((?:19|20)\d{2})\b`, "i"));
  if (monthYear) {
    const month = monthFromText(monthYear[1]);
    const year = Number(monthYear[2]);
    return buildDateRange(
      `${year}-${pad2(month)}-01`,
      `${year}-${pad2(month)}-${pad2(daysInMonth(year, month))}`,
      `${MONTH_NAMES[month]} ${year}`,
      "month",
      true
    );
  }

  return null;
}

function parseYearOnlyRange(value) {
  const text = normalizeYearText(value);
  if (!text) return null;

  const decadeRanges = [
    [/\b(?:sixties|60s|1960s)\b/, 1960, "1960s"],
    [/\b(?:seventies|70s|1970s)\b/, 1970, "1970s"],
    [/\b(?:eighties|80s|1980s)\b/, 1980, "1980s"],
    [/\b(?:nineties|90s|1990s)\b/, 1990, "1990s"],
    [/\b(?:2000s|00s|noughties|aughts|y2k)\b/, 2000, "2000s"],
    [/\b(?:2010s|10s)\b/, 2010, "2010s"],
    [/\b(?:2020s|20s)\b/, 2020, "2020s"]
  ];
  for (const [pattern, min, label] of decadeRanges) {
    if (pattern.test(text)) {
      return {
        min,
        max: min + 9,
        label,
        dateSpecific: false,
        kind: "decade"
      };
    }
  }

  const separator = String.raw`(?:-|to|through|thru|until|and|/)`;
  const fullRange = text.match(new RegExp(String.raw`\b(19\d{2}|20\d{2})\s*${separator}\s*(19\d{2}|20\d{2})\b`));
  if (fullRange) return buildRange(fullRange[1], fullRange[2]);

  const shortRange = text.match(new RegExp(String.raw`\b'?([0-4]\d)\s*${separator}\s*'?([0-4]\d)\b`));
  if (shortRange) return buildRange(shortRange[1], shortRange[2]);

  const years = Array.from(text.matchAll(/\b(19\d{2}|20\d{2})\b/g), (match) => Number(match[1]));
  if (years.length >= 2) {
    const min = Math.min(...years);
    const max = Math.max(...years);
    return {
      min,
      max,
      label: `${min}-${max}`,
      dateSpecific: false,
      kind: "year-range"
    };
  }
  if (years.length === 1) {
    const year = years[0];
    return {
      min: year,
      max: year,
      label: String(year),
      dateSpecific: false,
      kind: "year"
    };
  }

  return null;
}

function parseReleaseDateFilter(value, now = new Date()) {
  if (value && typeof value === "object") {
    const exact = dateOnly(value.releaseExactDate);
    if (exact) return buildDateRange(exact, exact, exact, "exact-date", true);

    const start = dateOnly(value.releaseStartDate);
    const end = dateOnly(value.releaseEndDate);
    if (start || end) return buildDateRange(start || end, end || start, undefined, "date-range", true);

    const preset = rangeFromPreset(value.releasePreset, now);
    if (preset) return preset;

    const combined = [value.years, value.request].filter(Boolean).join(" ");
    return parseTextDateFilter(combined, now) || parseYearOnlyRange(combined);
  }

  return parseTextDateFilter(value, now) || parseYearOnlyRange(value);
}

function parseYearRange(value) {
  return parseReleaseDateFilter(value);
}

function releaseDateFits(releaseDate, range) {
  if (!range) return true;
  const iso = dateOnly(releaseDate);
  if (!iso) return !range.dateSpecific;
  if (range.startDate && dateValue(iso) < dateValue(range.startDate)) return false;
  if (range.endDate && dateValue(iso) > dateValue(range.endDate)) return false;
  if (!range.startDate && !range.endDate) {
    const year = Number(iso.slice(0, 4));
    return year >= range.min && year <= range.max;
  }
  return true;
}

function yearFits(year, range, releaseDate = "") {
  if (!range) return true;
  if (range.dateSpecific) return releaseDateFits(releaseDate, range);
  if (releaseDate) return releaseDateFits(releaseDate, range);
  return Number(year) >= range.min && Number(year) <= range.max;
}

function extractYearSearchTerms(value, limit = 4) {
  const range = parseYearRange(value);
  if (range) {
    const terms = [];
    if (range.kind === "month" && range.startDate) {
      const month = Number(range.startDate.slice(5, 7));
      terms.push(`${MONTH_NAMES[month]} ${range.min}`, `${range.min}-${pad2(month)}`);
    }
    if (range.dateSpecific && range.startDate === range.endDate) terms.push(range.startDate);
    for (let year = range.max; year >= range.min && terms.length < limit; year -= 1) {
      terms.push(String(year));
    }
    return Array.from(new Set(terms)).slice(0, limit);
  }

  const text = normalizeYearText(value);
  return Array.from(text.matchAll(/\b(19\d{2}|20\d{2})\b/g), (match) => match[1]).slice(0, limit);
}

module.exports = {
  parseYearRange,
  parseReleaseDateFilter,
  yearFits,
  releaseDateFits,
  extractYearSearchTerms,
  normalizeYearText,
  todayLocalIso
};
