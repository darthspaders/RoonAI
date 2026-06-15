"use strict";

const LLM_TIMEOUT_MS = 45_000;
const OPENAI_COMPATIBLE_PROVIDERS = new Set(["openai-compatible", "openai_compatible", "lmstudio", "llamacpp"]);

async function fetchWithTimeout(url, options = {}, timeoutMs = LLM_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`LLM request timed out after ${Math.round(timeoutMs / 1000)}s`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function extractJsonObject(text) {
  const trimmed = String(text || "").trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch (_) {
    // Some models wrap JSON in thinking/prose; recover the first object.
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("The model did not return a JSON object.");
  }

  return JSON.parse(trimmed.slice(start, end + 1));
}

function inferCount(request, fallback) {
  const effective = Number(fallback?.effectiveCount || 0);
  if (effective > 0) return effective;
  const match = String(request || "").match(/\b(\d{1,2})\s*(?:track|song|cut|pick)s?\b/i);
  if (match) return Number(match[1]);
  if (fallback) return Number(fallback);
  if (/\b(short|quick|small|mini)\b/i.test(String(request || ""))) return 5;
  return 12;
}

function requestedCountFor(options = {}) {
  const effective = Number(options.effectiveCount || 0);
  if (effective > 0) return effective;
  return inferCount(options.request, options.count);
}

function buildNowPlayingContext(nowPlaying) {
  if (!nowPlaying) return "";

  const title = nowPlaying.title || nowPlaying.track || nowPlaying.one_line?.line1 || nowPlaying.two_line?.line1 || "";
  const artist = nowPlaying.artist || nowPlaying.one_line?.line2 || nowPlaying.two_line?.line2 || "";
  const album = nowPlaying.album || nowPlaying.three_line?.line2 || "";
  const lines = [title && `Current title: ${title}`, artist && `Current artist/context: ${artist}`, album && `Current album/context: ${album}`].filter(Boolean);

  return lines.length ? lines.join("\n") : "";
}

function compactReference(value, maxLength = 3000) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function buildSearchPlanPrompt({ request, genres, years, mood, language, count, reference, history, nowPlaying }) {
  const nowPlayingContext = buildNowPlayingContext(nowPlaying);
  const seedText = compactReference(reference || history || "");
  const constraints = [
    genres && `Requested genre/style: ${genres}`,
    years && `Release date/year constraint: ${years}`,
    mood && `Mood/energy: ${mood}`,
    language && `Language: ${language}`,
    count && `Requested track count: ${count}`
  ].filter(Boolean).join("\n");

  return `You are the strategy layer for a local Roon/TIDAL music discovery app.

IMPORTANT:
- Do NOT recommend specific tracks.
- Do NOT invent track titles.
- Your job is to create a catalogue search plan that the app will execute against TIDAL and Roon.
- TIDAL/Roon are the source of truth. The app will only show verified playable catalogue results.

Interpret the user's request, seed playlist, current Roon track, and optional filters.
If the seed playlist and requested genre differ, translate the seed's sonic traits into the requested genre.
Example: an 80s playlist plus "progressive house" means search progressive/melodic/deep/organic/progressive-trance-adjacent catalogues with 80s traits such as analog synth color, neon mood, gated drums, new-wave melancholy, Italo/boogie bass, or retro melodic hooks.
The current Roon track is context only. Use it as a seed only if the user asks for now/current/like-this discovery or gives no other search intent.

User request:
${request || "Find tasteful music discoveries."}

${nowPlayingContext ? `Current Roon context:\n${nowPlayingContext}` : "Current Roon context: none"}
${constraints ? `Explicit constraints:\n${constraints}` : "Explicit constraints: none"}
${seedText ? `Seed playlist / reference notes:\n${seedText}` : "Seed playlist / reference notes: none"}

Return ONLY valid JSON in this exact shape:
{
  "intent": "one sentence",
  "targetGenres": ["genre/style terms to search"],
  "vibeTerms": ["sonic traits and mood words"],
  "seedArtists": ["artists from the seed or now playing"],
  "candidateArtists": ["credible artists to search, no track titles"],
  "candidateLabels": ["credible labels to search"],
  "searchQueries": ["short TIDAL/Roon search queries, no made-up track titles"],
  "avoidTerms": ["terms to avoid"],
  "notes": "short note"
}

Rules:
- searchQueries should be catalogue-safe strings like "Anjunadeep melodic house 2026", "tech house Toolroom", or "Hernan Cattaneo progressive house".
- Prefer artist/label/genre/year queries over guessed song titles.
- For narrow genre/year discovery, include credible labels, artists, and one-ring adjacent scene terms; avoid generic SEO phrases like "best mix", "top hits", "playlist", or "summer vibes".
- Do not default to progressive house just because the listener often likes it. Use progressive assumptions only when the request, seed, or explicit genre points there.
- Treat "progressive psytrance" as psytrance, not progressive house. Treat "psychedelic trance" as a psytrance genre phrase, not a 70s/disco/funk vibe.
- Do not include the current Roon artist as a seed when the user asks for an unrelated genre/date/vibe search.
- If a year or date filter exists, include it in the relevant search queries.
- Do not include more than 18 search queries, 16 candidateArtists, or 16 candidateLabels.
- Do not include Markdown or extra text.`;
}

function normalizeStringArray(value, limit = 16) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const item of value) {
    const text = String(item || "").replace(/\s+/g, " ").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
    if (result.length >= limit) break;
  }
  return result;
}

function normalizeSearchPlan(plan = {}) {
  return {
    intent: String(plan.intent || "").replace(/\s+/g, " ").trim(),
    targetGenres: normalizeStringArray(plan.targetGenres, 12),
    vibeTerms: normalizeStringArray(plan.vibeTerms, 16),
    seedArtists: normalizeStringArray(plan.seedArtists, 12),
    candidateArtists: normalizeStringArray(plan.candidateArtists, 16),
    candidateLabels: normalizeStringArray(plan.candidateLabels, 16),
    searchQueries: normalizeStringArray(plan.searchQueries, 18),
    avoidTerms: normalizeStringArray(plan.avoidTerms, 12),
    notes: String(plan.notes || "").replace(/\s+/g, " ").trim()
  };
}

function clampScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function normalizeCandidateText(value, maxLength = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function llmTrackId(track = {}, index = 0) {
  const explicit = track.tidal?.id || track.tidalId || track.id || track.trackId || track.tidal?.tidalUrl || track.tidalUrl;
  if (explicit) return String(explicit);
  return `${index}:${normalizeCandidateText(track.artist, 80)}|${normalizeCandidateText(track.title, 100)}`;
}

function compactCandidate(track = {}, index = 0) {
  const breakdown = track.scoreBreakdown || {};
  return {
    id: llmTrackId(track, index),
    title: normalizeCandidateText(track.title),
    artist: normalizeCandidateText(track.artist),
    album: normalizeCandidateText(track.album),
    label: normalizeCandidateText(track.label || track.tidal?.label),
    duration_min: Number(track.durationMs || 0) ? Math.round((Number(track.durationMs || 0) / 60000) * 10) / 10 : null,
    release_date: normalizeCandidateText(track.releaseDate || track.tidal?.releaseDate || track.year),
    source_query: normalizeCandidateText(track.query || track.discoverySource),
    current_score: Number(track.score || breakdown.total || 0) || null,
    current_prompt_match: breakdown.promptMatch?.percent ?? null,
    current_taste_match: breakdown.tasteMatch?.percent ?? null,
    reason: normalizeCandidateText(track.reason, 240),
    why: Array.isArray(track.why) ? track.why.slice(0, 5).map((item) => normalizeCandidateText(item, 160)) : []
  };
}

function topWeightedEntries(map = {}, limit = 12) {
  return Object.values(map || {})
    .filter((entry) => Number(entry.score || 0) !== 0)
    .sort((left, right) => Number(right.score || 0) - Number(left.score || 0))
    .slice(0, limit)
    .map((entry) => ({
      name: normalizeCandidateText(entry.name, 120),
      score: Number(entry.score || 0)
    }));
}

function compactTasteProfile(tasteProfile = {}) {
  return {
    liked_artists: topWeightedEntries(tasteProfile.artists, 14).filter((entry) => entry.score > 0),
    rejected_artists: topWeightedEntries(tasteProfile.artists, 10).filter((entry) => entry.score < 0),
    liked_labels: topWeightedEntries(tasteProfile.labels, 14).filter((entry) => entry.score > 0),
    rejected_labels: topWeightedEntries(tasteProfile.labels, 10).filter((entry) => entry.score < 0),
    feedback_count: Object.keys(tasteProfile.feedback || {}).length,
    candidate_signals: Object.keys(tasteProfile.candidates || {}).length
  };
}

function buildCandidateScoringPrompt({ tracks = [], options = {}, tasteProfile = {} } = {}) {
  return `You are the strict scoring reviewer for The Rabbit Hole, a Roon/TIDAL music discovery app.

You do NOT invent songs. You only score the provided TIDAL candidates.
Return ONLY valid JSON. No markdown, no prose, no code fences.

Reject obvious junk: playlists, compilations, chart packs, SEO genre/year uploads, karaoke, covers, tribute versions, live versions unless requested, remasters, reissues, anniversary/deluxe/archive versions, and generic background-music catalogue filler.
Do NOT reject legitimate DJ-friendly remixes or extended/original mixes just because they are remixes.
If metadata is missing, lower confidence. Never make up labels, years, genres, or facts.

Discovery request:
${JSON.stringify({
    request: options.request || "",
    genres: options.genres || "",
    years: options.years || "",
    mood: options.mood || "",
    language: options.language || "",
    scoringMode: options.scoringMode || "",
    minScore: options.minScore || ""
  })}

Taste profile:
${JSON.stringify(compactTasteProfile(tasteProfile))}

TIDAL candidates:
${JSON.stringify(tracks.map(compactCandidate))}

Return exactly this shape:
{
  "candidates": [
    {
      "track_id": "same id from input",
      "rejected": false,
      "rejection_reason": "",
      "scores": {
        "prompt_match": 0,
        "taste_match": 0,
        "freshness": 0,
        "artist_label_match": 0,
        "length_preference": 0,
        "genre_confidence": 0
      },
      "final_score": 0,
      "genre": "short genre label",
      "why": ["short reason", "short reason"]
    }
  ]
}

Scoring guidance:
- prompt_match: how well it follows the explicit current request and advanced fields.
- taste_match: how well it fits the user's saved likes/dislikes.
- freshness: release/date fit and whether it avoids stale reissue tricks.
- artist_label_match: artist/label relevance to request or taste profile.
- length_preference: duration fit only, not genre quality.
- genre_confidence: confidence this is actually the requested genre/vibe.
- final_score should balance prompt first, taste second: 35% prompt, 25% taste, 15% freshness, 15% artist/label, 10% length, then adjust down for low genre confidence.
- For a genre-only search, prompt_match and genre_confidence matter more than existing progressive-house taste.
- Keep why bullets factual and tied to metadata/request/taste.`;
}

function normalizeCandidateScore(item = {}) {
  const scores = item.scores && typeof item.scores === "object" ? item.scores : {};
  const finalScore = clampScore(item.final_score);
  return {
    trackId: String(item.track_id || item.id || "").trim(),
    rejected: Boolean(item.rejected),
    rejectionReason: normalizeCandidateText(item.rejection_reason, 180),
    scores: {
      promptMatch: clampScore(scores.prompt_match),
      tasteMatch: clampScore(scores.taste_match),
      freshness: clampScore(scores.freshness),
      artistLabelMatch: clampScore(scores.artist_label_match),
      lengthPreference: clampScore(scores.length_preference ?? (100 - Number(scores.length_penalty || 0))),
      genreConfidence: clampScore(scores.genre_confidence)
    },
    finalScore,
    genre: normalizeCandidateText(item.genre, 120),
    why: Array.isArray(item.why)
      ? item.why.map((reason) => normalizeCandidateText(reason, 180)).filter(Boolean).slice(0, 5)
      : []
  };
}

async function scoreCandidateBatch(config, { tracks = [], options = {}, tasteProfile = {}, timeoutMs = 30_000 } = {}) {
  const candidates = tracks.filter((track) => track?.artist && track?.title).slice(0, 50);
  if (!candidates.length) return { prompt: "", scores: [], rawCount: 0 };

  const prompt = buildCandidateScoringPrompt({ tracks: candidates, options, tasteProfile });
  const raw = await callConfiguredModel(config, prompt, timeoutMs);
  const parsed = extractJsonObject(raw);
  const items = Array.isArray(parsed.candidates) ? parsed.candidates : [];
  const scores = items.map(normalizeCandidateScore).filter((item) => item.trackId);
  return {
    prompt,
    scores,
    rawCount: items.length
  };
}

async function callOllama(config, prompt, timeoutMs = LLM_TIMEOUT_MS) {
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
  }, timeoutMs);

  if (!response.ok) {
    throw new Error(`Ollama request failed: ${response.status} ${await response.text()}`);
  }

  const body = await response.json();
  return body.response;
}

async function callOpenRouter(config, prompt, timeoutMs = LLM_TIMEOUT_MS) {
  if (!config.openRouterApiKey) throw new Error("OPENROUTER_API_KEY is not set.");

  const response = await fetchWithTimeout("https://openrouter.ai/api/v1/chat/completions", {
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
  }, timeoutMs);

  if (!response.ok) {
    throw new Error(`OpenRouter request failed: ${response.status} ${await response.text()}`);
  }

  const body = await response.json();
  const content = body.choices?.[0]?.message?.content || "";
  const parsed = JSON.parse(content);
  if (Array.isArray(parsed)) return content;
  if (Array.isArray(parsed.tracks) || Array.isArray(parsed.playlist)) return JSON.stringify(parsed.tracks || parsed.playlist);
  return content;
}

function normalizeBaseUrl(baseUrl = "") {
  return String(baseUrl || "").replace(/\/+$/, "");
}

async function callOpenAiCompatible(config, prompt, timeoutMs = LLM_TIMEOUT_MS) {
  const baseUrl = normalizeBaseUrl(config.openAiCompatibleBaseUrl);
  if (!baseUrl) throw new Error("LLM_BASE_URL is not set.");

  const headers = {
    "content-type": "application/json"
  };
  if (config.openAiCompatibleApiKey) {
    headers.authorization = `Bearer ${config.openAiCompatibleApiKey}`;
  }

  const response = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: config.openAiCompatibleModel,
      messages: [
        { role: "system", content: "You generate strict JSON playlist candidates for Roon. Return only valid JSON." },
        { role: "user", content: prompt }
      ],
      temperature: 0.35,
      top_p: 0.9,
      response_format: { type: "text" }
    })
  }, timeoutMs);

  if (!response.ok) {
    throw new Error(`OpenAI-compatible LLM request failed: ${response.status} ${await response.text()}`);
  }

  const body = await response.json();
  const content = body.choices?.[0]?.message?.content || "";
  if (!content) throw new Error("OpenAI-compatible LLM returned an empty response.");
  return content;
}

function callConfiguredModel(config, modelPrompt, timeoutMs = LLM_TIMEOUT_MS) {
  if (config.llmProvider === "openrouter") return callOpenRouter(config, modelPrompt, timeoutMs);
  if (OPENAI_COMPATIBLE_PROVIDERS.has(config.llmProvider)) {
    return callOpenAiCompatible(config, modelPrompt, timeoutMs);
  }
  return callOllama(config, modelPrompt, timeoutMs);
}

async function generateSearchPlan(config, options) {
  const requestedCount = Math.max(1, Math.min(requestedCountFor(options), 40));
  const prompt = buildSearchPlanPrompt({
    ...options,
    history: options.reference || options.history || "",
    count: requestedCount
  });

  const raw = await callConfiguredModel(config, prompt);
  const plan = normalizeSearchPlan(extractJsonObject(raw));
  if (!plan.searchQueries.length && !plan.candidateArtists.length && !plan.candidateLabels.length && !plan.targetGenres.length) {
    throw new Error("The model did not return a usable search plan.");
  }
  return {
    prompt,
    requestedCount,
    plan
  };
}

module.exports = {
  generateSearchPlan,
  scoreCandidateBatch
};
