"use strict";
const {memory} = require("./synapseMemory");
const { REJECTION_BASES, compactReviewEvidence } = require("./candidateReviewEvidence");

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
The requested genre/style is the current search lane. The seed playlist and saved taste are guidance about texture, energy, mood, and adjacency—not a genre allowlist.
If the seed playlist or saved taste and requested genre differ, translate the useful sonic traits into the requested genre instead of reverting to the learned genre.
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
  "intentRoute": "genre | theme | activity | artist | similarity | era | mood | open",
  "themeTerms": ["lyrical or emotional subject terms, not genres"],
  "activityTerms": ["listening context terms such as driving, focus, sleep, party"],
  "promptStrictness": "theme-first | activity-first | genre-first | artist-first | similarity-first | era-first | open-discovery",
  "allowOutsideTaste": true,
  "tasteInfluence": "strongly | lightly | not at all",
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
- For simple theme prompts like "love songs about being apart", use intentRoute "theme", keep targetGenres empty unless the user named a genre, add themeTerms such as "love" and "being apart", and create title/theme/tag search queries such as "long distance love electronic" or "missing you vocal electronic".
- For activity prompts like "chill driving music", use intentRoute "activity", add activityTerms, and only use learned taste as a light preference unless the user asks for similar/taste-guided results.
- For narrow genre/year discovery, include credible labels, artists, and one-ring adjacent scene terms; avoid generic SEO phrases like "best mix", "top hits", "playlist", or "summer vibes".
- Treat saved taste as a soft preference, never as a whitelist. A request for a genre outside the saved profile must still search that requested genre and may keep unfamiliar artists when the current metadata matches.
- For an explicit genre request, do not copy saved-taste artists into candidateArtists or standalone searchQueries merely because they are historically successful. Use current-lane artists, labels, and genre queries; use taste to shape sonic descriptors and ranking.
- Do not default to progressive house just because the listener often likes it. Use progressive assumptions only when the request, seed, or explicit genre points there.
- Pure Search means tasteInfluence "not at all". For every other mode, explicit genre discovery keeps taste as a soft preference unless the user explicitly asks for strict taste-only behavior. Explore/outside-taste/theme/activity/open discovery should allowOutsideTaste true. Similar Mode should keep tasteInfluence "strongly".
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

function normalizeBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const key = String(value || "").trim().toLowerCase();
  return ["1", "true", "yes", "y", "allow", "allowed"].includes(key);
}

function normalizeSearchPlan(plan = {}) {
  return {
    intent: String(plan.intent || "").replace(/\s+/g, " ").trim(),
    intentRoute: String(plan.intentRoute || "").replace(/\s+/g, " ").trim(),
    themeTerms: normalizeStringArray(plan.themeTerms, 12),
    activityTerms: normalizeStringArray(plan.activityTerms, 10),
    promptStrictness: String(plan.promptStrictness || "").replace(/\s+/g, " ").trim(),
    allowOutsideTaste: normalizeBoolean(plan.allowOutsideTaste),
    tasteInfluence: String(plan.tasteInfluence || "").replace(/\s+/g, " ").trim(),
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

function compactCandidate(track = {}, index = 0, tasteProfile = {}) {
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
    why: Array.isArray(track.why) ? track.why.slice(0, 3).map((item) => normalizeCandidateText(item, 120)) : [],
    version_evidence: compactReviewEvidence(track, tasteProfile)
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
Score every supplied candidate exactly once, including rejected candidates.
The requested playlist count does not limit how many supplied candidates you review.

Reject obvious junk: playlists, compilations, chart packs, SEO genre/year uploads, karaoke, covers, tribute versions, live versions unless requested, remasters, reissues, anniversary/deluxe/archive versions, and generic background-music catalogue filler.
Do NOT reject legitimate DJ-friendly remixes or extended/original mixes just because they are remixes.
If metadata is missing, lower confidence. Never make up labels, years, genres, or facts.
Treat saved taste as a soft preference, not an artist allowlist. Missing an artist from the profile is not evidence of dislike.

Named-remix policy:
- Evaluate the exact remix as its own production/version. A named remixer's supplied genre/scene and taste evidence is strong evidence, even when the original artist normally works in another genre.
- Original-artist genre/taste mismatch alone is NEVER grounds for rejecting a named remix. At most it is a weak negative ranking signal; do not let it dominate prompt_match, taste_match, artist_label_match or genre_confidence.
- Evaluate remixer compatibility, release/label evidence, this track's genre metadata, requested vibe, and duration/version together. Do not assume the original artist's genre describes the remix. Missing remix metadata means uncertainty, not proof of a genre conflict.
- Sonic diagnostics are existing evidence only. An applied adjustment is already included in current_score: do not add another Sonic bonus/penalty. If unavailable or not applied, do not use it to adjust scores or infer audio; the existing coverage gate still governs Sonic scoring.
- Keep true remix/version, duration, explicit user-exclusion, catalogue-quality and supported track/vibe mismatches rejectable. A remixer's name is not blanket approval. Do not invent remixer reputation, instrumentation, vocal content or audio observations.
- Respect supplied duration_constraint semantics: minimumMs is a minimum, not a target or maximum. Do not reject a longer track for exceeding a minimum. Missing vibe evidence lowers confidence without inventing a conflict.
- Example: Pendulum - 9,000 Miles (Eelke Kleijn Remix) must be evaluated using the Eelke Kleijn remix evidence, not rejected just because Pendulum is absent from a Progressive House profile. This is a policy example, not an instruction to accept that track.

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
${JSON.stringify(tracks.map((track, index) => compactCandidate(track, index, tasteProfile)))}

Return exactly this shape:
{
  "candidates": [
    {
      "track_id": "same id from input",
      "rejected": false,
      "rejection_reason": "",
      "rejection_basis": [],
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
- For named remixes, artist_label_match and taste_match must weigh the remixer evidence strongly and original-artist mismatch only weakly.
- length_preference: duration fit only, not genre quality.
- genre_confidence: confidence this is actually the requested genre/vibe.
- final_score should balance prompt first, taste second: 35% prompt, 25% taste, 15% freshness, 15% artist/label, 10% length, then adjust down for low genre confidence.
- For a genre-only search, prompt_match and genre_confidence matter more than existing progressive-house taste.
- If rejected, list every independent reason in rejection_basis using only: ${REJECTION_BASES.join(", ")}. Use [] when not rejected. original_artist_profile_mismatch means the original artist's usual genre or saved taste fit; explicit user exclusions belong to explicit_request_mismatch. Do not relabel an original-artist-only objection as track_genre_mismatch, vibe_mismatch or insufficient_evidence. Cite the actual remix/version evidence for those reasons.
- Keep why bullets factual and tied to metadata/request/taste.`;
}

function normalizeCandidateScore(item = {}) {
  const scores = item.scores && typeof item.scores === "object" ? item.scores : {};
  const finalScore = clampScore(item.final_score);
  return {
    trackId: String(item.track_id || item.id || "").trim(),
    rejected: Boolean(item.rejected),
    rejectionReason: normalizeCandidateText(item.rejection_reason, 180),
    // Preserve unknown/missing basis as untrusted; never silently drop a
    // second objection and turn a real rejection into an artist-only warning.
    rejectionBasis: Array.isArray(item.rejection_basis) ? item.rejection_basis.map(value => normalizeCandidateText(value, 80)) : [],
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

  // Local Qwen 3.5/3.6 can spend its entire loaded context on reasoning before
  // producing JSON. Keep this bounded scoring task out of thinking mode and
  // leave room for both input and output even with an 8K loaded context.
  const boundedLocalReview = OPENAI_COMPATIBLE_PROVIDERS.has(config.llmProvider) &&
    /(?:^|\/)qwen3\.[56](?:[-_:]|$)/i.test(config.openAiCompatibleModel || "");
  if (boundedLocalReview) {
    const stableCandidates = candidates.map((track, index) => ({ ...track, id: llmTrackId(track, index) }));
    const deadline = Date.now() + Math.max(1, Number(timeoutMs || 30_000));
    const scores = [];
    const prompts = [];
    for (let offset = 0; offset < stableCandidates.length; offset += 8) {
      const batch = stableCandidates.slice(offset, offset + 8);
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new Error("LLM candidate review timed out before all batches completed.");
      const prompt = buildCandidateScoringPrompt({ tracks: batch, options, tasteProfile });
      const raw = await callConfiguredModel(config, prompt, remainingMs, {
        reasoning_effort: "none",
        max_tokens: 3000,
        response_format: candidateScoringResponseFormat(batch)
      });
      const parsed = extractJsonObject(raw);
      const items = Array.isArray(parsed.candidates) ? parsed.candidates : [];
      const expectedIds = new Set(batch.map(llmTrackId));
      const batchScores = items.map(normalizeCandidateScore);
      const returnedIds = new Set(batchScores.map(item => item.trackId));
      if (items.length !== batch.length || returnedIds.size !== expectedIds.size ||
          batchScores.some(item => !expectedIds.has(item.trackId))) {
        throw new Error("LLM review must score every supplied candidate exactly once with its original track ID.");
      }
      scores.push(...batchScores);
      prompts.push(prompt);
    }
    return { prompt: prompts.join("\n\n"), scores, rawCount: scores.length };
  }

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

function candidateScoringResponseFormat(tracks = []) {
  const scoreProperties = Object.fromEntries([
    "prompt_match", "taste_match", "freshness", "artist_label_match", "length_preference", "genre_confidence"
  ].map(key => [key, { type: "integer", minimum: 0, maximum: 100 }]));
  const properties = {
    track_id: { type: "string", enum: tracks.map(llmTrackId) },
    rejected: { type: "boolean" },
    rejection_reason: { type: "string" },
    rejection_basis: { type: "array", items: { type: "string", enum: REJECTION_BASES }, maxItems: 5 },
    scores: { type: "object", properties: scoreProperties, required: Object.keys(scoreProperties), additionalProperties: false },
    final_score: { type: "integer", minimum: 0, maximum: 100 },
    genre: { type: "string" },
    why: { type: "array", items: { type: "string" }, maxItems: 2 }
  };
  return { type: "json_schema", json_schema: {
    name: "candidate_review", strict: true,
    schema: {
      type: "object", additionalProperties: false, required: ["candidates"],
      properties: { candidates: {
        type: "array", minItems: tracks.length, maxItems: tracks.length,
        items: { type: "object", properties, required: Object.keys(properties), additionalProperties: false }
      } }
    }
  } };
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

async function callOpenAiCompatible(config, prompt, timeoutMs = LLM_TIMEOUT_MS, completionOptions = {}) {
  const activeModel = await require("./localModelRuntime").resolveLocalModel(config);
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
      model: activeModel,
      messages: [
        { role: "system", content: "You generate strict JSON playlist candidates for Roon. Return only valid JSON." },
        { role: "user", content: prompt }
      ],
      temperature: 0.35,
      top_p: 0.9,
      response_format: { type: "text" },
      ...completionOptions
    })
  }, timeoutMs);

  if (!response.ok) {
    throw new Error(`OpenAI-compatible LLM request failed: ${response.status} ${await response.text()}`);
  }

  const body = await response.json();
  if (body.choices?.[0]?.finish_reason === "length") {
    throw new Error(`OpenAI-compatible LLM reached its token or context limit (prompt ${body.usage?.prompt_tokens ?? "unknown"}, completion ${body.usage?.completion_tokens ?? "unknown"}).`);
  }
  const content = body.choices?.[0]?.message?.content || "";
  if (!content) throw new Error("OpenAI-compatible LLM returned an empty response.");
  return content;
}

function callConfiguredModel(config, modelPrompt, timeoutMs = LLM_TIMEOUT_MS, completionOptions = {}) {
  modelPrompt = [memory.context(modelPrompt), modelPrompt].filter(Boolean).join("\n\n");
  if (config.llmProvider === "openrouter") return callOpenRouter(config, modelPrompt, timeoutMs);
  if (OPENAI_COMPATIBLE_PROVIDERS.has(config.llmProvider)) {
    return callOpenAiCompatible(config, modelPrompt, timeoutMs, completionOptions);
  }
  return callOllama(config, modelPrompt, timeoutMs);
}

async function generateSearchPlan(config, options, timeoutMs = LLM_TIMEOUT_MS) {
  const requestedCount = Math.max(1, Math.min(requestedCountFor(options), 40));
  const prompt = buildSearchPlanPrompt({
    ...options,
    history: options.reference || options.history || "",
    count: requestedCount
  });

  const raw = await callConfiguredModel(config, prompt, timeoutMs);
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
  buildSearchPlanPrompt,
  extractJsonObject,
  generateSearchPlan,
  normalizeSearchPlan,
  requestedCountFor,
  scoreCandidateBatch
};
