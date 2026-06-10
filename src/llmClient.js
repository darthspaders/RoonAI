"use strict";

const OLLAMA_TIMEOUT_MS = 20_000;

async function fetchWithTimeout(url, options = {}, timeoutMs = OLLAMA_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`Ollama request timed out after ${Math.round(timeoutMs / 1000)}s`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function extractJsonArray(text) {
  const trimmed = String(text || "").trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.tracks)) return parsed.tracks;
    if (Array.isArray(parsed.playlist)) return parsed.playlist;
    if (Array.isArray(parsed.songs)) return parsed.songs;
    if (Array.isArray(parsed.recommendations)) return parsed.recommendations;

    const firstArray = Object.values(parsed).find(Array.isArray);
    if (firstArray) return firstArray;
  } catch (_) {
    // Some models ignore format instructions; recover the first JSON array.
  }

  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("The model did not return a JSON array.");
  }

  return JSON.parse(trimmed.slice(start, end + 1));
}

function normalizeTrack(track) {
  return {
    artist: String(track.artist || "").trim(),
    title: String(track.title || "").trim(),
    reason: String(track.reason || "").trim(),
    year: Number(track.year || 0) || null
  };
}

function parseYearRange(years) {
  const text = String(years || "").trim();
  if (!text) return null;

  const range = text.match(/\b(19\d{2}|20\d{2})\s*[-–]\s*(19\d{2}|20\d{2})\b/);
  if (range) {
    const min = Math.min(Number(range[1]), Number(range[2]));
    const max = Math.max(Number(range[1]), Number(range[2]));
    return { min, max, label: `${min}-${max}` };
  }

  const single = text.match(/\b(19\d{2}|20\d{2})\b/);
  if (single) {
    const year = Number(single[1]);
    return { min: year, max: year, label: String(year) };
  }

  return null;
}

function inferCount(request, fallback) {
  const match = String(request || "").match(/\b(\d{1,2})\s*(?:track|song|cut|pick)s?\b/i);
  if (match) return Number(match[1]);
  if (fallback) return Number(fallback);
  if (/\b(short|quick|small|mini)\b/i.test(String(request || ""))) return 5;
  return 12;
}

function inferCandidateCount(targetCount, options = {}) {
  const hasHardFilters = Boolean(options.years || options.genres || options.mood || options.reference || options.history);
  const multiplier = hasHardFilters ? 4 : 3;
  return Math.min(80, Math.max(targetCount + 12, targetCount * multiplier));
}

function validateTracks(tracks, count) {
  const seen = new Set();
  const normalized = [];

  for (const track of tracks.map(normalizeTrack)) {
    if (!track.artist || !track.title) continue;
    const key = `${track.artist.toLowerCase()}::${track.title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(track);
    if (normalized.length === count) break;
  }

  if (!normalized.length) {
    throw new Error("The model did not return usable tracks.");
  }
  return normalized;
}

function buildNowPlayingContext(nowPlaying) {
  if (!nowPlaying) return "";

  const title = nowPlaying.title || nowPlaying.track || nowPlaying.one_line?.line1 || nowPlaying.two_line?.line1 || "";
  const artist = nowPlaying.artist || nowPlaying.one_line?.line2 || nowPlaying.two_line?.line2 || "";
  const album = nowPlaying.album || nowPlaying.three_line?.line2 || "";
  const lines = [title && `Current title: ${title}`, artist && `Current artist/context: ${artist}`, album && `Current album/context: ${album}`].filter(Boolean);

  return lines.length ? lines.join("\n") : "";
}

function buildPlaylistPrompt({ request, genres, years, mood, language, count, exclude, history, nowPlaying, service }) {
  const excludeLine = exclude ? `Do NOT include any of these already selected tracks: ${exclude}.` : "";
  const historyLine = history ? `Avoid these frequently used tracks from recent playlists: ${history}.` : "";
  const referenceLine = history ? `Use these reference tracks or playlist notes as taste DNA, not as a list to copy verbatim: ${history}.` : "";
  const nowPlayingContext = buildNowPlayingContext(nowPlaying);
  const advancedLines = [
    genres && `Explicit genre constraint: ${genres}`,
    years && `HARD release-year constraint: EVERY track MUST be from ${years}. Do not include tracks outside this year range.`,
    mood && `Explicit mood/energy constraint: ${mood}`,
    language && `Explicit language constraint: ${language}`
  ].filter(Boolean).join("\n");

  return `You are a playlist generator for music discovery, built for a serious Roon/TIDAL listener.

Your job is not to list famous songs. Your job is to propose real, streamable, high-signal discovery candidates that a knowledgeable curator would plausibly put into a listening queue.

Interpret the user's plain-language ask. Infer target genre, seed playlist vibe, era, mood, tempo, discovery depth, and sequencing from the wording. The user should not have to fill out metadata fields.

Important distinction:
- Seed/reference tracks are taste DNA, not a genre cage and not a list to copy.
- The requested genre is the destination.
- If the seed playlist and requested genre differ, translate the seed's sonic traits into the requested genre.
- Example: an 80s/new-wave/synth-pop playlist plus "progressive tracks" means progressive/melodic/deep/organic/progressive-trance-adjacent tracks with 80s traits: analog synth color, new-wave melancholy, neon atmosphere, arpeggiated bass, gated/bright drums, Italo/boogie influence, or retro melodic hooks.
- This applies to any genre pairing: identify what the seed feels like, then find real tracks in the target genre that carry that feeling.

User ask: ${request || "Make a tasteful discovery playlist for what is playing now."}

${nowPlayingContext ? `Roon context:\n${nowPlayingContext}` : "Roon context: none available"}
${advancedLines ? `Optional hard constraints:\n${advancedLines}` : "Optional hard constraints: none"}
${excludeLine}
${referenceLine || historyLine}
Prefer songs likely available on ${service}, Roon, or major streaming catalogs.
IMPORTANT: discovery mode is enabled.
- Think like a TIDAL/Roon catalog curator: choose tracks that are real releases, searchable by exact artist + title, and likely present in TIDAL.
- Prefer artists and labels that make sense for the requested genre and seed vibe, not generic defaults.
- If the ask says "like this", "more like this", "keep this vibe", or similar, use the Roon context as the seed.
- Avoid obvious starter-pack picks unless the user explicitly asks for classics.
- Prefer tasteful deep cuts, current/recent discoveries, underground-adjacent releases, and DJ-friendly album/single versions.
- Stay inside the requested vibe, but allow adjacent subgenres when they would satisfy the listener better.
- Only use progressive-house assumptions when the user asks for progressive/progressive house. Otherwise, follow the requested genre.
- For progressive requests, include melodic progressive, deep progressive, organic house crossover, progressive trance where appropriate, and credible club/label picks; avoid big-room EDM and tracks that only look progressive because the title contains "progressive".
- For decade/vibe translation requests, do NOT just return tracks from that decade unless the user asks for that. Translate the feel into the target genre.
- Avoid live versions, radio edits, mashups, covers, karaoke, remasters, reissues, anniversary editions, deluxe/archive versions, and old tracks repackaged into recent years.
- Build a coherent mini-set: adjacent keys/energy is nice, but vibe coherence matters more than chart familiarity.
- Do not invent artists, collaborations, tracks, labels, or release years. Only return tracks you believe are real commercial releases.
${years ? `- HARD RULE: every returned track must be an original release from ${years}. Do not use remasters, reissues, edits, deluxe editions, or old tracks with a new package date to satisfy the year range. If unsure, choose a different track.` : ""}
Generate EXACTLY ${count} UNIQUE songs.
year is required: original release year as a four-digit integer.
Return ONLY a valid JSON object in this format:
{"tracks":[{"artist":"Artist Name","title":"Song Title","year":1995,"reason":"short reason this fits"}]}
No markdown, no prose, no code fences, no extra text.`;
}

async function callOllama(config, prompt) {
  const response = await fetchWithTimeout(`${config.ollamaBaseUrl}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: config.ollamaModel,
      prompt,
      stream: false,
      format: "json",
      options: {
        temperature: 0.35,
        top_p: 0.9
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Ollama request failed: ${response.status} ${await response.text()}`);
  }

  const body = await response.json();
  return body.response;
}

async function callOpenRouter(config, prompt) {
  if (!config.openRouterApiKey) throw new Error("OPENROUTER_API_KEY is not set.");

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${config.openRouterApiKey}`,
      "content-type": "application/json",
      "http-referer": "http://localhost",
      "x-title": "The Rabbit Hole"
    },
    body: JSON.stringify({
      model: config.openRouterModel,
      messages: [
        { role: "system", content: "You generate strict JSON playlist candidates for Roon." },
        { role: "user", content: prompt }
      ],
      temperature: 0.35,
      response_format: { type: "json_object" }
    })
  });

  if (!response.ok) {
    throw new Error(`OpenRouter request failed: ${response.status} ${await response.text()}`);
  }

  const body = await response.json();
  const content = body.choices?.[0]?.message?.content || "";
  const parsed = JSON.parse(content);
  return Array.isArray(parsed) ? content : JSON.stringify(parsed.tracks || parsed.playlist || []);
}

async function generatePlaylist(config, options) {
  const requestedCount = Math.max(1, Math.min(inferCount(options.request, options.count), 40));
  const candidateCount = inferCandidateCount(requestedCount, options);
  const prompt = buildPlaylistPrompt({
    ...options,
    history: options.reference || options.history || "",
    count: candidateCount,
    service: config.streamingService
  });

  const callModel = (modelPrompt) => config.llmProvider === "openrouter"
    ? callOpenRouter(config, modelPrompt)
    : callOllama(config, modelPrompt);

  let raw = await callModel(prompt);
  try {
    return {
      prompt,
      requestedCount,
      candidateCount,
      tracks: validateTracks(extractJsonArray(raw), candidateCount)
    };
  } catch (error) {
    throw error;
  }
}

module.exports = {
  generatePlaylist
};
