"use strict";
const voiceExecution = require("./voiceExecution");
const { exactIntent, parseTrackList } = require("./exactTrackVerification");
const {
  policySchema: directRoonPolicySchema,
  trackSchema: directRoonTrackSchema,
  validate: validateDirectRoonQueue
} = require("./directRoonQueue");

const crypto = require("crypto");

const DEFAULT_TIMEOUT_MS = Math.max(5_000, Number(process.env.RABBIT_HOLE_MCP_TIMEOUT_MS || 120_000));
const MAX_MCP_BODY_BYTES = 5 * 1024 * 1024;
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function shortText(value, maxLength = 180) {
  const text = cleanText(value).replace(/\s+/g, " ");
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function booleanInput(value) {
  return value === true || /^(?:1|true|yes|on)$/i.test(String(value || "").trim());
}

function compactTrack(track = {}) {
  return {
    artist: shortText(track.artist, 120),
    title: shortText(track.title, 150),
    album: shortText(track.album, 140),
    label: shortText(track.label, 120),
    year: track.year || track.releaseYear || null,
    releaseDate: cleanText(track.releaseDate),
    durationMs: Number.isFinite(Number(track.durationMs)) ? Number(track.durationMs) : null,
    genre: shortText(track.genre, 80),
    score: Number.isFinite(Number(track.score)) ? Number(track.score) : null,
    discoverySource: shortText(track.discoverySource, 80),
    discoveryLane: shortText(track.discoveryLane, 60),
    feedback: cleanText(track.feedback),
    tidalUrl: cleanText(track.tidalUrl || track.tidal?.url || track.tidal?.shareUrl),
    reason: shortText(track.reason || track.why, 220)
  };
}

function tracksFromResult(result = {}, limit = 40) {
  return Array.isArray(result.tracks) ? result.tracks.slice(0, limit).map(compactTrack) : [];
}

function alternatesFromResult(result = {}, limit = 20) {
  return Array.isArray(result.alternates) ? result.alternates.slice(0, limit).map(compactTrack) : [];
}

function summarizeQueueResult(result = {}, requested = 0) {
  return {
    requested: result.requested || requested,
    queuedCount: result.queuedCount || 0,
    failedCount: result.failedCount || 0,
    topOfQueue: Boolean(result.topOfQueue),
    appendOnly: Boolean(result.appendOnly),
    queued: Array.isArray(result.queued)
      ? result.queued.slice(0, 40).map((item) => compactTrack(item.track || item))
      : [],
    failed: Array.isArray(result.failed)
      ? result.failed.slice(0, 20).map((item) => ({
        track: compactTrack(item.track || item),
        reason: cleanText(item.reason)
      }))
      : []
  };
}

function zonesFromStatus(status = {}) {
  return Array.isArray(status.zones) ? status.zones : [];
}

function selectedZoneId(status = {}) {
  return cleanText(
    status.selectedZoneId ||
    status.zoneId ||
    status.app?.selectedZoneId ||
    status.app?.settings?.zoneId ||
    status.app?.session?.options?.zoneId
  );
}

function createRabbitHoleMcpTools(options = {}) {
  const fetch = options.fetchImpl || globalThis.fetch;
  const baseUrl = String(options.baseUrl || process.env.RABBIT_HOLE_BASE_URL || "http://127.0.0.1:3777").replace(/\/+$/, "");
  const timeoutMs = Math.max(5_000, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));
  let lastSearchResult = null;
  let lastSearchOptions = null;
  let lastStatus = null;

  function activeZone(status = lastStatus || {}) {
    const zones = zonesFromStatus(status);
    const selectedId = selectedZoneId(status);
    if (selectedId) {
      const selected = zones.find((zone) => zone.zone_id === selectedId || zone.id === selectedId);
      if (selected) return selected;
    }
    return (
      zones.find((zone) => zone.state === "playing" && zone.now_playing) ||
      zones.find((zone) => zone.now_playing) ||
      zones[0] ||
      null
    );
  }

  function nowPlayingFromZone(zone = null) {
    if (!zone?.now_playing) return null;
    const now = zone.now_playing;
    const one = now.one_line || {};
    const two = now.two_line || {};
    const three = now.three_line || {};
    const enrichment = now.metadata_enrichment || now.radio_enrichment || {};
    const title = cleanText(enrichment.title || two.line1 || three.line2 || one.line1 || now.title);
    const artist = cleanText(enrichment.artist || two.line2 || three.line3 || now.artist);
    const album = cleanText(enrichment.album || three.line1 || now.album);
    const imageKey = cleanText(now.image_key || now.imageKey);
    return {
      title,
      artist,
      album,
      zoneId: cleanText(zone.zone_id || zone.id),
      zoneName: cleanText(zone.display_name || zone.name),
      state: cleanText(zone.state),
      imageKey,
      imageUrl: imageKey
        ? `${baseUrl}/api/roon/image/${encodeURIComponent(imageKey)}?width=700&height=700`
        : cleanText(enrichment.sourceImageUrl || enrichment.imageUrl || now.imageUrl),
      seekPosition: Number.isFinite(Number(now.seek_position)) ? Number(now.seek_position) : null,
      length: Number.isFinite(Number(now.length)) ? Number(now.length) : null,
      sourceFormat: cleanText(zone.outputs?.[0]?.source_controls?.[0]?.display_name || zone.display_name),
      genre: cleanText(enrichment.genre),
      releaseDate: cleanText(enrichment.releaseDate),
      year: enrichment.releaseYear || enrichment.year || null,
      tidalUrl: cleanText(enrichment.tidalUrl)
    };
  }

  function nowPlayingTrackFromStatus(status = lastStatus || {}) {
    const now = nowPlayingFromZone(activeZone(status));
    if (!now?.title) return null;
    return {
      artist: now.artist || "Unknown artist",
      title: now.title,
      album: now.album || "",
      durationMs: now.length ? now.length * 1000 : null,
      genre: now.genre || "",
      releaseDate: now.releaseDate || "",
      year: now.year || null,
      tidalUrl: now.tidalUrl || "",
      imageUrl: now.imageUrl || "",
      discoverySource: "Now playing",
      statusChecks: ["Now playing in Roon"]
    };
  }

  async function requestJson(apiPath, requestOptions = {}) {
    voiceExecution.check();
    const voiceContext = voiceExecution.current();
    const controller = new AbortController();
    const effectiveTimeoutMs = Math.max(1, Number(requestOptions.timeoutMs || timeoutMs));
    const timeout = setTimeout(() => controller.abort(), effectiveTimeoutMs);
    const headers = {
      "accept": "application/json",
      ...(voiceContext ? { "x-rabbit-hole-voice-execution": voiceContext.id } : {}),
      ...(requestOptions.body === undefined ? {} : { "content-type": "application/json" })
    };
    try {
      const response = await fetch(`${baseUrl}${apiPath}`, {
        method: requestOptions.method || (requestOptions.body === undefined ? "GET" : "POST"),
        headers,
        body: requestOptions.body === undefined ? undefined : JSON.stringify(requestOptions.body),
        signal: voiceContext ? AbortSignal.any([controller.signal, voiceContext.controller.signal]) : controller.signal
      });
      const text = await response.text();
      let payload = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = { raw: text };
        }
      }
      if (!response.ok) {
        const detail = payload?.error || payload?.message || text || response.statusText;
        throw new Error(`Rabbit Hole ${response.status} ${response.statusText}: ${detail}`);
      }
      return payload || {};
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(`Rabbit Hole request timed out after ${effectiveTimeoutMs}ms: ${apiPath}`);
      }
      if (/fetch failed|ECONNREFUSED|Failed to fetch/i.test(error.message || "")) {
        throw new Error(`Rabbit Hole is not reachable at ${baseUrl}. Start the Rabbit Hole app and try again.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function getStatus() {
    lastStatus = await requestJson("/api/status", { timeoutMs: 10_000 });
    const zone = activeZone(lastStatus);
    const sessionResult = lastStatus.app?.session?.result || {};
    return {
      baseUrl,
      latestResultSource: lastStatus.app?.latestResultSource || "discovery",
      connected: Boolean(lastStatus.connected),
      core: lastStatus.core || null,
      zone: zone ? {
        id: cleanText(zone.zone_id || zone.id),
        name: cleanText(zone.display_name || zone.name),
        state: cleanText(zone.state),
        isActive: true
      } : null,
      zones: zonesFromStatus(lastStatus).map((item) => ({
        id: cleanText(item.zone_id || item.id),
        name: cleanText(item.display_name || item.name),
        state: cleanText(item.state),
        hasNowPlaying: Boolean(item.now_playing)
      })),
      nowPlaying: nowPlayingFromZone(zone),
      session: {
        updatedAt: cleanText(lastStatus.app?.session?.updatedAt),
        requestedCount: sessionResult.requestedCount || null,
        trackCount: Array.isArray(sessionResult.tracks) ? sessionResult.tracks.length : 0,
        alternateCount: Array.isArray(sessionResult.alternates) ? sessionResult.alternates.length : 0,
        discardedCount: Array.isArray(sessionResult.discarded) ? sessionResult.discarded.length : 0,
        topTracks: tracksFromResult(sessionResult, 8)
      },
      standby: lastStatus.app?.standby ? {
        count: lastStatus.app.standby.count || 0,
        targetCount: lastStatus.app.standby.targetCount || 25,
        ready: Boolean(lastStatus.app.standby.ready),
        refreshing: Boolean(lastStatus.app.standby.refreshing),
        synapseReview: lastStatus.app.standby.lastRun?.diagnostics?.synapseReview || null,
        novelty: lastStatus.app.standby.lastRun?.diagnostics?.novelty || null,
        lastError: cleanText(lastStatus.app.standby.lastError)
      } : null,
      tidal: lastStatus.app?.tidal || null,
      llm: lastStatus.app?.llm || null
    };
  }

  async function latestSessionResult() {
    if (lastSearchResult) return lastSearchResult;
    const status = lastStatus || await requestJson("/api/status", { timeoutMs: 10_000 });
    return status.app?.session?.result || {};
  }

  function searchBody(input = {}) {
    const body = {};
    const stringFields = [
      "request",
      "genres",
      "years",
      "mood",
      "reference",
      "scoringMode",
      "minScore",
      "releasePreset",
      "releaseExactDate",
      "releaseStartDate",
      "releaseEndDate"
    ];
    for (const field of stringFields) {
      const value = cleanText(input[field]);
      if (value) body[field] = value;
    }
    if (!body.request) throw new Error("search_rabbit_hole requires a request.");
    body.count = clampNumber(input.count, 1, 40, 12);

    const status = lastStatus || {};
    const zone = activeZone(status);
    const zoneId = cleanText(input.zoneId) || cleanText(zone?.zone_id || zone?.id);
    if (zoneId) body.zoneId = zoneId;
    const now = nowPlayingFromZone(zone);
    if (now) body.nowPlaying = now;
    body.requireRoonQueueable = input.requireRoonQueueable ? "true" : "";
    if (input.preferExtendedMixes !== undefined) body.preferExtendedMixes = Boolean(input.preferExtendedMixes);
    return body;
  }

  async function searchRabbitHole(input = {}) {
    const intent = exactIntent(input);
    if (intent) return verifyTracks({ ...input, tracks: intent.tracks });
    await getStatus();
    const body = searchBody(input);
    lastSearchOptions = body;
    lastSearchResult = await requestJson("/api/ai/playlist", {
      body,
      timeoutMs: Math.max(timeoutMs, 120_000)
    });
    return {
      requestedCount: lastSearchResult.requestedCount || body.count,
      tracks: tracksFromResult(lastSearchResult, 40),
      alternates: alternatesFromResult(lastSearchResult, 20),
      discardedCount: Array.isArray(lastSearchResult.discarded) ? lastSearchResult.discarded.length : 0,
      verification: lastSearchResult.verification || null
    };
  }

  async function verifyTracks(input = {}) {
    await getStatus();
    const tracks = parseTrackList(input.tracks || input.request || "");
    if (!tracks.length) throw new Error("verify_tracks requires at least one track.");
    const zone = activeZone(lastStatus);
    const body = {
      tracks: tracks.slice(0, clampNumber(input.max || input.limit || tracks.length, 1, 40, tracks.length)),
      checkRoon: booleanInput(input.checkRoon || input.requireRoonQueueable || input.roonQueueable),
      allowKnown: booleanInput(input.allowKnown || input.allowRepeats || input.allowPreviouslySuggested),
      strict: booleanInput(input.strict),
      preferExtendedMixes: booleanInput(input.preferExtendedMixes),
      zoneId: cleanText(input.zoneId || input.zone_id) || cleanText(zone?.zone_id || zone?.id),
      searchLimit: clampNumber(input.searchLimit, 1, 8, 5),
      maxQueries: clampNumber(input.maxQueries, 1, 8, 4)
    };
    for (const field of ["minDurationMs", "minDurationSeconds", "minDurationMinutes", "timeoutMs", "perTrackTimeoutMs", "roonTimeoutMs"]) {
      if (input[field] !== undefined && input[field] !== null && input[field] !== "") body[field] = input[field];
    }
    return requestJson("/api/tracks/verify", {
      body,
      timeoutMs: Math.max(timeoutMs, 120_000)
    });
  }

  async function queueRabbitHoleTracks(input = {}) {
    await getStatus();
    if (lastStatus?.app?.latestResultSource === "exact_verification") return queueVerifiedTracks(input);
    if (lastStatus?.app?.latestResultSource === "standby") return queueStandbyTracks(input);
    const result = await latestSessionResult();
    const count = clampNumber(input.count, 1, 40, Array.isArray(result.tracks) ? result.tracks.length : 12);
    const tracks = Array.isArray(result.tracks) ? result.tracks.slice(0, count) : [];
    if (!tracks.length) throw new Error("There are no Rabbit Hole result tracks to queue. Run search_rabbit_hole first or generate tracks in the app.");
    const zone = activeZone(lastStatus);
    const zoneId = cleanText(input.zoneId) || cleanText(zone?.zone_id || zone?.id);
    if (!zoneId) throw new Error("No active Roon zone is available.");
    const queued = await requestJson("/api/roon/queue-tracks", {
      body: {
        zoneId,
        tracks,
        alternates: result.alternates || [],
        targetCount: count,
        mode: input.mode === "next" ? "next" : "append",
        preferExtendedMixes: input.preferExtendedMixes !== undefined
          ? Boolean(input.preferExtendedMixes)
          : Boolean(lastSearchOptions?.preferExtendedMixes),
        matchPolicy: input.matchPolicy || "strict",
        allowBridge: input.allowBridge !== false,
        bridgeSyncDelaysMs: input.bridgeSyncDelaysMs || [0, 3000, 7000]
      },
      timeoutMs: 90_000
    });
    return summarizeQueueResult(queued, count);
  }

  async function sendRabbitHoleToTidal(input = {}) {
    await getStatus();
    if (lastStatus?.app?.latestResultSource === "exact_verification") return requestJson("/api/tracks/verified/playlist", { body: input, timeoutMs: 120000 });
    const result = await latestSessionResult();
    const count = clampNumber(input.count, 1, 40, Array.isArray(result.tracks) ? result.tracks.length : 12);
    const tracks = Array.isArray(result.tracks) ? result.tracks.slice(0, count) : [];
    if (!tracks.length) throw new Error("There are no Rabbit Hole result tracks to send. Run search_rabbit_hole first or generate tracks in the app.");
    const payload = await requestJson("/api/tidal/queue-playlist", {
      body: {
        tracks,
        title: cleanText(input.title) || `Rabbit Hole Queue - ${new Date().toLocaleString()}`,
        description: cleanText(input.description) || "Temporary Rabbit Hole queue created by the Rabbit Hole MCP bridge."
      },
      timeoutMs: 90_000
    });
    return {
      title: payload.playlist?.title || payload.title || "",
      addedCount: payload.addedCount || 0,
      skippedCount: payload.skippedCount || 0,
      playlist: payload.playlist || null,
      added: Array.isArray(payload.added) ? payload.added.slice(0, 40).map(compactTrack) : []
    };
  }

  async function getStandbyPool() {
    const payload = await requestJson("/api/standby", { timeoutMs: 15_000 });
    return {
      count: payload.count || 0,
      targetCount: payload.targetCount || 25,
      ready: Boolean(payload.ready),
      refreshing: Boolean(payload.refreshing),
      lastRefreshAt: cleanText(payload.lastRefreshAt),
      nextRefreshAt: cleanText(payload.nextRefreshAt),
      lastError: cleanText(payload.lastError),
      tracks: Array.isArray(payload.tracks) ? payload.tracks.slice(0, 25).map(compactTrack) : []
    };
  }

  async function refreshStandbyPool(input = {}) {
    const refreshOptions = { ...input };
    delete refreshOptions.reason;
    const payload = await requestJson("/api/standby/refresh", {
      body: {
        reason: cleanText(input.reason) || "chatgpt-mcp",
        options: refreshOptions
      },
      timeoutMs: Math.max(timeoutMs, 120_000)
    });
    return {
      count: payload.count || 0,
      targetCount: payload.targetCount || 25,
      ready: Boolean(payload.ready),
      refreshing: Boolean(payload.refreshing),
      lastError: cleanText(payload.lastError),
      tracks: Array.isArray(payload.tracks) ? payload.tracks.slice(0, 25).map(compactTrack) : []
    };
  }

  async function standbyTracks(count) {
    const payload = await requestJson("/api/standby", { timeoutMs: 15_000 });
    const tracks = Array.isArray(payload.tracks) ? payload.tracks.slice(0, count) : [];
    if (!tracks.length) throw new Error("There are no standby tracks available.");
    return tracks;
  }

  async function queueStandbyTracks(input = {}) {
    await getStatus();
    const count = clampNumber(input.count, 1, 25, 12);
    const tracks = await standbyTracks(count);
    const zone = activeZone(lastStatus);
    const zoneId = cleanText(input.zoneId) || cleanText(zone?.zone_id || zone?.id);
    if (!zoneId) throw new Error("No active Roon zone is available.");
    const queued = await requestJson("/api/roon/queue-tracks", {
      body: {
        zoneId,
        tracks,
        targetCount: count,
        mode: input.mode === "next" ? "next" : "append",
        preferExtendedMixes: Boolean(input.preferExtendedMixes),
        matchPolicy: input.matchPolicy || "strict",
        allowBridge: input.allowBridge !== false,
        bridgeSyncDelaysMs: input.bridgeSyncDelaysMs || [0, 3000, 7000]
      },
      timeoutMs: 90_000
    });
    return summarizeQueueResult(queued, count);
  }

  async function sendStandbyToTidal(input = {}) {
    const count = clampNumber(input.count, 1, 25, 12);
    const tracks = await standbyTracks(count);
    const payload = await requestJson("/api/tidal/queue-playlist", {
      body: {
        tracks,
        title: cleanText(input.title) || `Rabbit Hole Standby - ${new Date().toLocaleString()}`,
        description: cleanText(input.description) || "Rabbit Hole standby pool created by the Rabbit Hole MCP bridge."
      },
      timeoutMs: 90_000
    });
    return {
      title: payload.playlist?.title || payload.title || "",
      addedCount: payload.addedCount || 0,
      skippedCount: payload.skippedCount || 0,
      playlist: payload.playlist || null,
      added: Array.isArray(payload.added) ? payload.added.slice(0, 25).map(compactTrack) : []
    };
  }

  async function createTidalPlaylist(input = {}) {
    const title = cleanText(input.title || input.name);
    if (!title) throw new Error("create_tidal_playlist requires a title.");
    const payload = await requestJson("/api/tidal/playlist", {
      body: {
        title,
        description: cleanText(input.description) || "Created from Rabbit Hole MCP."
      },
      timeoutMs: 30_000
    });
    return {
      connected: payload.connected !== false,
      playlist: payload.playlist || null
    };
  }

  async function addNowPlayingToTidal(input = {}) {
    await getStatus();
    const track = nowPlayingTrackFromStatus(lastStatus);
    if (!track) throw new Error("There is no current track to add.");
    const body = {
      track,
      allowDuplicate: Boolean(input.allowDuplicate || input.allow_duplicate)
    };
    const playlistId = cleanText(input.playlistId || input.playlist_id);
    const playlistTitle = cleanText(input.playlistTitle || input.title);
    if (playlistId) body.playlistId = playlistId;
    if (playlistTitle) body.playlistTitle = playlistTitle;
    const payload = await requestJson("/api/tidal/playlist-track", {
      body,
      timeoutMs: 45_000
    });
    return {
      track: compactTrack(payload.track || track),
      resolvedBy: cleanText(payload.resolvedBy),
      added: payload.added !== false,
      duplicate: Boolean(payload.duplicate),
      playlist: payload.playlist || null
    };
  }

  async function rateNowPlaying(input = {}) {
    const rating = cleanText(input.rating).toLowerCase();
    if (!rating) throw new Error("rate_now_playing requires a rating.");
    await getStatus();
    const track = nowPlayingTrackFromStatus(lastStatus);
    if (!track) throw new Error("There is no current track to rate.");
    const payload = await requestJson("/api/feedback", {
      body: {
        track,
        rating,
        reason: cleanText(input.reason)
      },
      timeoutMs: 30_000
    });
    return {
      rating,
      track: compactTrack({ ...track, feedback: rating }),
      taste: payload.profile || null,
      genreProfiles: payload.genreProfiles || null
    };
  }

  async function controlRoon(input = {}) {
    await getStatus();
    const aliases = {
      resume: "play",
      previous_track: "previous",
      prev: "previous",
      skip: "next",
      next_track: "next",
      toggle: "playpause"
    };
    const requested = cleanText(input.control || input.action).toLowerCase();
    const control = aliases[requested] || requested;
    const allowed = new Set(["play", "pause", "playpause", "stop", "previous", "next"]);
    if (!allowed.has(control)) throw new Error("control_roon requires play, pause, playpause, stop, previous, or next.");
    const zone = activeZone(lastStatus);
    const zoneId = cleanText(input.zoneId || input.zone_id) || cleanText(zone?.zone_id || zone?.id);
    if (!zoneId) throw new Error("No active Roon zone is available.");
    const payload = await requestJson("/api/control", {
      body: { zoneId, control },
      timeoutMs: 15_000
    });
    return {
      control,
      ok: payload.ok !== false,
      result: payload.result || null,
      zone: zone ? {
        id: cleanText(zone.zone_id || zone.id),
        name: cleanText(zone.display_name || zone.name),
        state: cleanText(zone.state)
      } : null
    };
  }

  async function explainLastRejections(input = {}) {
    const result = await latestSessionResult();
    const discarded = Array.isArray(result.discarded) ? result.discarded : [];
    const limit = clampNumber(input.limit, 1, 50, 20);
    return {
      discardedCount: discarded.length,
      poolDiagnostics: result.verification?.poolDiagnostics || null,
      queryYield: result.verification?.queryYield || null,
      examples: discarded.slice(0, limit).map((track) => ({
        artist: cleanText(track.artist),
        title: cleanText(track.title),
        album: cleanText(track.album),
        label: cleanText(track.label),
        year: track.year || null,
        query: cleanText(track.query),
        reason: cleanText(track.reason)
      }))
    };
  }

  async function inspectGenreProfile(input = {}) {
    const status = lastStatus || await requestJson("/api/status", { timeoutMs: 10_000 });
    const needle = cleanText(input.genre || input.name).toLowerCase();
    const profiles = status.app?.genreProfiles?.profiles || [];
    return {
      genreProfiles: status.app?.genreProfiles || null,
      matchingProfiles: Array.isArray(profiles)
        ? profiles.filter((profile) => {
          if (!needle) return true;
          return String(profile.name || profile.key || "").toLowerCase().includes(needle);
        })
        : [],
      lastIntent: status.app?.session?.result?.verification?.intent || status.app?.session?.options || null
    };
  }

  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const writeAction = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

  async function queueVerifiedTracks(input = {}) {
    await getStatus();
    const zone = activeZone(lastStatus);
    return requestJson("/api/tracks/verified/queue", { body: { ...input, zoneId: input.zoneId || zone?.zone_id || zone?.id }, timeoutMs: 1800000 });
  }
  async function retryPendingBridgeTracks(input = {}) {
    await getStatus();
    const zone = activeZone(lastStatus);
    return requestJson("/api/roon/exact-bridge/pending/retry", {
      body: { ...input, zoneId: input.zoneId || zone?.zone_id || zone?.id, queue: input.queue !== false },
      timeoutMs: Math.max(timeoutMs, 900000)
    });
  }
  const registry = {
    roon_queue_tracks: {
      title: "Queue Tracks Directly in Roon",
      description: "DEFAULT for 'add these tracks to Roon': pass structured artist/title objects directly to the proven Roon bulk queue. flexible by default; strict for exact version/no substitutions. No list parser, discovery, standby, scoring or models. Direct and album resolution run first; only queue failures with exact TIDAL identity can use the permanent deduplicated playlist bridge. Read-only search never writes a playlist. Retry only failed requestedTrack objects; inspect the queue before retrying an uncertain queue acknowledgement. Requires queue authorization.",
      inputSchema: { type: "object", properties: {
        tracks: { type: "array", minItems: 1, maxItems: 500, items: directRoonTrackSchema },
        zoneId: { type: "string" }, mode: { type: "string", enum: ["append", "next"], default: "append" },
        matchPolicy: directRoonPolicySchema,
        allowBridge: { type: "boolean", default: true },
        bridgeSyncDelaysMs: { type: "array", items: { type: "integer", minimum: 0, maximum: 120000 }, maxItems: 8 },
        bridgeLookupTimeoutMs: { type: "integer", minimum: 1000, maximum: 60000 }
      }, required: ["tracks"], additionalProperties: false }, annotations: writeAction,
      handler: async (input = {}) => {
        validateDirectRoonQueue(input);
        await getStatus(); const zone = activeZone(lastStatus);
        return requestJson('/api/roon/direct/queue', { body: { ...input, zoneId: input.zoneId || zone?.zone_id || zone?.id }, timeoutMs: 3600000 });
      }
    },
    roon_search_track: {
      title: "Resolve a Track in Roon",
      description: "Search the existing Roon resolver without queueing or discovery. Return best matches, available metadata, confidence and an expiring queueToken usable by roon_queue_tracks in append mode. Missing metadata is unknown; Roon does not always expose album, duration, version or service IDs.",
      inputSchema: { type: "object", properties: { ...directRoonTrackSchema.properties, zoneId: { type: "string" }, matchPolicy: directRoonPolicySchema }, required: ["artist", "title"], additionalProperties: false }, annotations: readOnly,
      handler: async (input = {}) => {
        validateDirectRoonQueue(input, true);
        await getStatus(); const zone = activeZone(lastStatus);
        return requestJson('/api/roon/direct/search', { body: { ...input, zoneId: input.zoneId || zone?.zone_id || zone?.id }, timeoutMs: 60000 });
      }
    },
    roon_get_queue: {
      title: "Inspect Roon Queue",
      description: "Read the active or specified zone, current track, Roon queue count/time and subscribed queue titles/artists. Queue subscription exposes at most 50 entries; truncated and unavailable are explicit. No discovery or playback changes.",
      inputSchema: { type: "object", properties: { zoneId: { type: "string" } }, additionalProperties: false }, annotations: readOnly,
      handler: async (input = {}) => {
        await getStatus();
        const zone = input.zoneId ? zonesFromStatus(lastStatus).find(z => z.zone_id === input.zoneId || z.id === input.zoneId) : activeZone(lastStatus);
        if (!zone) throw new Error('Roon zone is unavailable.');
        const queue = zone.queue;
        const count = Number.isFinite(zone.queue_items_remaining) ? zone.queue_items_remaining : null;
        const tracks = (queue?.items || []).map(item => {
          const artist = item.subtitle || item.artist || '';
          const suffix = ` - ${artist}`;
          return { title: artist && item.title?.endsWith(suffix) ? item.title.slice(0, -suffix.length) : item.title, artist, durationSeconds: item.length || null };
        });
        return { zoneId: zone.zone_id || zone.id, zoneName: zone.display_name, currentTrack: nowPlayingFromZone(zone), queuedCount: count,
          remainingSeconds: zone.queue_time_remaining ?? null, tracks, listedCount: tracks.length, subscriptionLimit: 50,
          truncated: count === null ? null : count > tracks.length, available: Boolean(queue && !queue.error), updatedAt: queue?.updatedAt || null };
      }
    },
    retry_pending_bridge_tracks: {
      title: "Retry Pending Exact Bridge Tracks",
      description: "Retry exact TIDAL-verified tracks previously added to the permanent Rabbit Hole Exact Verification Bridge but not yet exposed by Roon. Does not run discovery, TIDAL search, replacement matching, or substitutions. Queues only when Roon now exposes the exact saved playlist action. Requires queue authorization.",
      inputSchema: { type: "object", properties: {
        trackIds: { type: "array", items: { type: "string" }, maxItems: 40 },
        count: { type: "integer", minimum: 1, maximum: 40 },
        zoneId: { type: "string" },
        queue: { type: "boolean", default: true },
        bridgeSyncDelaysMs: { type: "array", items: { type: "integer", minimum: 0, maximum: 120000 }, maxItems: 8 },
        bridgeLookupTimeoutMs: { type: "integer", minimum: 1000, maximum: 60000 }
      }, additionalProperties: false },
      annotations: writeAction,
      handler: retryPendingBridgeTracks
    },
    queue_supplied_tracks: {
      title: "Queue Supplied Tracks",
      description: "Legacy compatibility for supplied text lists. Prefer roon_queue_tracks with structured objects for new Synapse calls. Uses the existing bulk Roon path. Default queuePolicy fast: no pre-verification or discovery. Use strict only when the user requests verify first, exact versions only, availability confirmation or Roon queueability checks. Partial failures are returned separately; retryFailures retries only the last failed entries, optionally with strict policy. Requires user queue authorization.",
      inputSchema: { type: "object", properties: { tracks: { oneOf: [{type:"string"},{type:"array",minItems:1,maxItems:500,items:{oneOf:[{type:"string"},{type:"object",additionalProperties:true}]}}] }, queuePolicy:{type:"string",enum:["fast","strict"],default:"fast"}, verifyBeforeQueue:{type:"boolean",default:false}, retryFailures:{type:"boolean"}, zoneId:{type:"string"} }, additionalProperties:false },
      annotations: writeAction,
      handler: async (input={}) => { await getStatus(); const zone=activeZone(lastStatus); return requestJson("/api/tracks/supplied/queue", {body:{...input,zoneId:input.zoneId||zone?.zone_id||zone?.id},timeoutMs:Math.max(timeoutMs,3600000)}); }
    },
    get_rabbit_hole_status: {
      title: "Get Rabbit Hole Status",
      description: "Return compact Rabbit Hole status, selected/active Roon zone, now playing track, current result summary, standby status, TIDAL state, and LLM state.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false
      },
      annotations: readOnly,
      handler: getStatus
    },
    search_rabbit_hole: {
      title: "Search Rabbit Hole",
      description: "Discover NEW music. For supplied lists to queue, use roon_queue_tracks with structured objects (flexible by default); for verification-only requests use verify_tracks; never reinterpret verification requests as discovery seeds.",
      inputSchema: {
        type: "object",
        properties: {
          request: { type: "string", description: "Natural language discovery request." },
          genres: { type: "string", description: "Optional genre or child genre." },
          years: { type: "string", description: "Optional release year filter." },
          mood: { type: "string", description: "Optional traits or mood." },
          reference: { type: "string", description: "Optional seed tracks or notes." },
          count: { type: "integer", minimum: 1, maximum: 40, description: "Target track count." },
          scoringMode: { type: "string", enum: ["", "pure", "explore", "similar"] },
          minScore: { type: "string", enum: ["", "0", "60", "70", "80", "90"] },
          requireRoonQueueable: { type: "boolean" },
          preferExtendedMixes: { type: "boolean" },
          zoneId: { type: "string" }
        },
        required: ["request"],
        additionalProperties: false
      },
      annotations: writeAction,
      handler: searchRabbitHole
    },
    verify_tracks: {
      title: "Verify Tracks",
      description: "Verify exact supplied artist/title/version pairs directly on TIDAL, optionally checking Roon queueability. No discovery, novelty rejection, replacement tracks, or queue/playlist writes. Results are saved separately for queue_verified_tracks and send_verified_tracks_to_tidal_playlist.",
      inputSchema: {
        type: "object",
        properties: {
          tracks: {
            type: "array",
            minItems: 1,
            maxItems: 40,
            description: "Candidate tracks to verify. Each item should include artist and title, or a TIDAL track URL/id.",
            items: {
              oneOf: [
                { type: "string", description: "Artist - Title" },
                {
                  type: "object",
                  properties: {
                    artist: { type: "string" },
                    title: { type: "string" },
                    album: { type: "string" },
                    year: { type: "integer" },
                    releaseDate: { type: "string" },
                    durationMs: { type: "integer" },
                    tidalUrl: { type: "string" }
                  },
                  additionalProperties: true
                }
              ]
            }
          },
          checkRoon: { type: "boolean", description: "Also verify that Roon exposes a queue action for each candidate." },
          requireRoonQueueable: { type: "boolean", description: "Alias for checkRoon." },
          allowKnown: { type: "boolean", description: "Allow tracks already present in Rabbit Hole history or memory to be marked usable." },
          allowRepeats: { type: "boolean", description: "Alias for allowKnown." },
          minDurationMinutes: { type: "number", minimum: 0, description: "Reject candidates shorter than this duration." },
          minDurationSeconds: { type: "number", minimum: 0 },
          minDurationMs: { type: "integer", minimum: 0 },
          preferExtendedMixes: { type: "boolean" },
          strict: { type: "boolean" },
          zoneId: { type: "string" },
          max: { type: "integer", minimum: 1, maximum: 40 },
          searchLimit: { type: "integer", minimum: 1, maximum: 8 },
          maxQueries: { type: "integer", minimum: 1, maximum: 8 }
        },
        required: ["tracks"],
        additionalProperties: false
      },
      annotations: readOnly,
      handler: verifyTracks
    },
    queue_verified_tracks: {
      title: "Queue Exact Verified Tracks",
      description: "On explicit queue authorization, consume saved TIDAL-verified tracks including TIDAL_VERIFIED_ROON_PENDING. Automatically resolve pending/expired identities through the bulk Roon resolver, then append through the shared bulk queue. Uses the permanent exact TIDAL playlist after direct Roon misses unless allowBridge is false; if Roon sync lags, report the manual refresh state instead of substituting versions. Never rerun TIDAL verification, discovery, or substitute versions.",
      inputSchema: { type: "object", properties: { zoneId: { type: "string" }, trackIds: { type: "array", items: { type: "string" } }, count: { type: "integer", minimum: 1, maximum: 40 }, mode: { type: "string", enum: ["append"] }, allowBridge: { type: "boolean", default: true }, bridgeSyncDelaysMs: { type: "array", items: { type: "integer", minimum: 0, maximum: 120000 }, maxItems: 8 }, bridgeLookupTimeoutMs: { type: "integer", minimum: 1000, maximum: 60000 } }, additionalProperties: false },
      annotations: writeAction,
      handler: queueVerifiedTracks
    },
    send_verified_tracks_to_tidal_playlist: {
      title: "Send Exact Verified Tracks to TIDAL",
      description: "On explicit request, create a playlist using the saved exact verified TIDAL IDs. Does not discover replacements.",
      inputSchema: { type: "object", properties: { title: { type: "string" }, description: { type: "string" }, count: { type: "integer", minimum: 1, maximum: 40 } }, additionalProperties: false },
      annotations: writeAction,
      handler: (input = {}) => requestJson("/api/tracks/verified/playlist", { body: input, timeoutMs: 120000 })
    },
    queue_rabbit_hole_tracks: {
      title: "Queue Rabbit Hole Tracks",
      description: "Queue the latest Rabbit Hole result tracks into the active or specified Roon zone.",
      inputSchema: {
        type: "object",
        properties: {
          count: { type: "integer", minimum: 1, maximum: 40 },
          mode: { type: "string", enum: ["append", "next"] },
          preferExtendedMixes: { type: "boolean" },
          allowBridge: { type: "boolean", default: true },
          matchPolicy: { type: "string", enum: ["flexible", "strict"], default: "strict" },
          bridgeSyncDelaysMs: { type: "array", items: { type: "integer", minimum: 0, maximum: 120000 }, maxItems: 8 },
          bridgeLookupTimeoutMs: { type: "integer", minimum: 1000, maximum: 60000 },
          zoneId: { type: "string" }
        },
        additionalProperties: false
      },
      annotations: writeAction,
      handler: queueRabbitHoleTracks
    },
    send_rabbit_hole_to_tidal_playlist: {
      title: "Send Rabbit Hole To TIDAL Playlist",
      description: "Create a TIDAL playlist from the latest Rabbit Hole result tracks.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          count: { type: "integer", minimum: 1, maximum: 40 }
        },
        additionalProperties: false
      },
      annotations: writeAction,
      handler: sendRabbitHoleToTidal
    },
    get_standby_pool: {
      title: "Get Standby Pool",
      description: "Return the current Rabbit Hole standby discovery pool.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: readOnly,
      handler: getStandbyPool
    },
    refresh_standby_pool: {
      title: "Refresh Standby Pool",
      description: "Refresh the Rabbit Hole standby discovery pool.",
      inputSchema: {
        type: "object",
        properties: {
          reason: { type: "string" },
          request: { type: "string" },
          genres: { type: "string" },
          years: { type: "string" },
          mood: { type: "string" },
          scoringMode: { type: "string", enum: ["", "pure", "explore", "similar"] },
          minScore: { type: "string", enum: ["", "0", "60", "70", "80", "90"] }
        },
        additionalProperties: false
      },
      annotations: writeAction,
      handler: refreshStandbyPool
    },
    queue_standby_tracks: {
      title: "Queue Standby Tracks",
      description: "Queue tracks from the Rabbit Hole standby pool into Roon.",
      inputSchema: {
        type: "object",
        properties: {
          count: { type: "integer", minimum: 1, maximum: 25 },
          mode: { type: "string", enum: ["append", "next"] },
          preferExtendedMixes: { type: "boolean" },
          allowBridge: { type: "boolean", default: true },
          matchPolicy: { type: "string", enum: ["flexible", "strict"], default: "strict" },
          bridgeSyncDelaysMs: { type: "array", items: { type: "integer", minimum: 0, maximum: 120000 }, maxItems: 8 },
          bridgeLookupTimeoutMs: { type: "integer", minimum: 1000, maximum: 60000 },
          zoneId: { type: "string" }
        },
        additionalProperties: false
      },
      annotations: writeAction,
      handler: queueStandbyTracks
    },
    send_standby_to_tidal_playlist: {
      title: "Send Standby To TIDAL Playlist",
      description: "Create a TIDAL playlist from the Rabbit Hole standby pool.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          count: { type: "integer", minimum: 1, maximum: 25 }
        },
        additionalProperties: false
      },
      annotations: writeAction,
      handler: sendStandbyToTidal
    },
    create_tidal_playlist: {
      title: "Create TIDAL Playlist",
      description: "Create an empty TIDAL playlist through the connected Rabbit Hole TIDAL profile.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" }
        },
        required: ["title"],
        additionalProperties: false
      },
      annotations: writeAction,
      handler: createTidalPlaylist
    },
    add_now_playing_to_tidal_playlist: {
      title: "Add Now Playing To TIDAL Playlist",
      description: "Add the currently playing Roon track to a TIDAL playlist.",
      inputSchema: {
        type: "object",
        properties: {
          playlistId: { type: "string" },
          playlistTitle: { type: "string" },
          title: { type: "string" },
          allowDuplicate: { type: "boolean" }
        },
        additionalProperties: false
      },
      annotations: writeAction,
      handler: addNowPlayingToTidal
    },
    rate_now_playing: {
      title: "Rate Now Playing",
      description: "Rate the currently playing track in Rabbit Hole taste memory.",
      inputSchema: {
        type: "object",
        properties: {
          rating: {
            type: "string",
            enum: ["love", "good", "ok", "wrong_genre", "skip", "never", "reject_similar"]
          },
          reason: { type: "string" }
        },
        required: ["rating"],
        additionalProperties: false
      },
      annotations: writeAction,
      handler: rateNowPlaying
    },
    control_roon: {
      title: "Control Roon",
      description: "Send a transport control to the active or specified Roon zone.",
      inputSchema: {
        type: "object",
        properties: {
          control: {
            type: "string",
            enum: ["play", "pause", "playpause", "stop", "previous", "next", "skip", "resume"]
          },
          zoneId: { type: "string" }
        },
        required: ["control"],
        additionalProperties: false
      },
      annotations: writeAction,
      handler: controlRoon
    },
    explain_last_rejections: {
      title: "Explain Last Rejections",
      description: "Explain the last Rabbit Hole search rejection diagnostics.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 50 }
        },
        additionalProperties: false
      },
      annotations: readOnly,
      handler: explainLastRejections
    },
    inspect_genre_profile: {
      title: "Inspect Genre Profile",
      description: "Inspect learned Rabbit Hole genre profiles.",
      inputSchema: {
        type: "object",
        properties: {
          genre: { type: "string" }
        },
        additionalProperties: false
      },
      annotations: readOnly,
      handler: inspectGenreProfile
    }
  };
  registry.verify_exact_tracks = { ...registry.verify_tracks, title: "Verify Exact Tracks", inputSchema: {
    ...registry.verify_tracks.inputSchema, properties: { ...registry.verify_tracks.inputSchema.properties,
      tracks: { oneOf: [registry.verify_tracks.inputSchema.properties.tracks, { type: "string", description: "One artist — title pair per line; surrounding instructions are ignored." }] }
    }
  } };
  registry.resolve_verified_tracks_for_roon = {
    title: "Resolve Verified Tracks for Roon",
    description: "Resolve only unresolved saved exact TIDAL identities into Roon queue actions. Never repeats TIDAL verification or discovery. Retries bounded Roon queries with strict version validation; returns timing, failure types and queue tokens. Does not queue. Uses one designated playlist containing only verified IDs after direct resolution fails unless allowBridge is false; if Roon has not synced that playlist yet, the bridge result says manual refresh is required.",
    inputSchema: { type: "object", properties: { trackIds: { type: "array", items: { type: "string" }, maxItems: 40 }, zoneId: { type: "string" }, allowBridge: { type: "boolean", default: true }, retries: { type: "integer", minimum: 0, maximum: 2 }, roonTimeoutMs: { type: "integer", minimum: 100, maximum: 30000 }, bridgeSyncDelaysMs: { type: "array", items: { type: "integer", minimum: 0, maximum: 120000 }, maxItems: 8 }, bridgeLookupTimeoutMs: { type: "integer", minimum: 1000, maximum: 60000 } }, additionalProperties: false },
    annotations: writeAction,
    handler: async (input = {}) => {
      await getStatus();
      const zone = activeZone(lastStatus);
      return requestJson("/api/tracks/verified/resolve-roon", { body: { ...input, zoneId: input.zoneId || zone?.zone_id || zone?.id }, timeoutMs: Math.max(timeoutMs, (input.trackIds?.length || 40) * (input.roonTimeoutMs || 12000) * (1 + (input.retries ?? 2)) + 10000) });
    }
  };
  for (const [name, tool] of Object.entries(registry)) {
    const handler = tool.handler;
    tool.handler = async (...args) => {
      voiceExecution.check();
      const ctx = voiceExecution.current();
      let result;
      try {
        result = await handler(...args);
      } catch (error) {
        if (ctx) ctx.actions.push({ type: name, success: false });
        throw error;
      }
      if (ctx) ctx.actions.push({ type: name, success: result?.ok !== false && !result?.error && !result?.failedCount && !result?.failed && !result?.lastError });
      voiceExecution.check(); return result;
    };
  }
  return registry;
}

function toolList(tools) {
  return Object.entries(tools).map(([name, tool]) => ({
    name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations || {}
  }));
}

function mcpHeaders(sessionId) {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, accept, mcp-protocol-version, mcp-session-id",
    "access-control-expose-headers": "mcp-session-id",
    "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
    "pragma": "no-cache",
    "expires": "0",
    "mcp-session-id": sessionId
  };
}

function sendJson(res, status, payload, sessionId) {
  res.writeHead(status, {
    ...mcpHeaders(sessionId),
    "content-type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(payload));
}

function sendNoBody(res, status, sessionId) {
  res.writeHead(status, mcpHeaders(sessionId));
  res.end();
}

async function readRequestJson(req) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_MCP_BODY_BYTES) {
      const error = new Error("MCP request body too large.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Invalid MCP JSON request body.");
    error.statusCode = 400;
    throw error;
  }
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code,
      message
    }
  };
}

function hasRequestId(message) {
  return Object.prototype.hasOwnProperty.call(message, "id") && message.id !== undefined && message.id !== null;
}

function isAuthorized(req, url, token) {
  if (!token) return true;
  const authorization = String(req.headers.authorization || "");
  if (authorization === `Bearer ${token}`) return true;
  return url.searchParams.get("token") === token;
}

function createRabbitHoleMcpHttpHandler(options = {}) {
  const sessionId = options.sessionId || crypto.randomUUID();
  const token = cleanText(options.token || process.env.RABBIT_HOLE_MCP_TOKEN);
  const serverName = cleanText(options.serverName) || "rabbit-hole";
  const serverVersion = cleanText(options.serverVersion) || "0.1.0";
  const tools = options.tools || createRabbitHoleMcpTools(options);

  async function handleMessage(message) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return jsonRpcError(null, -32600, "Invalid JSON-RPC request.");
    }

    const id = message.id;
    const method = cleanText(message.method);
    if (!hasRequestId(message)) return null;

    try {
      if (method === "initialize") {
        return jsonRpcResult(id, {
          protocolVersion: message.params?.protocolVersion || DEFAULT_PROTOCOL_VERSION,
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: serverName,
            version: serverVersion
          },
          instructions: "Use Rabbit Hole to inspect Roon status, generate discovery tracks, queue music into Roon, create TIDAL bridge playlists, manage standby discovery, and rate now playing tracks."
        });
      }
      if (method === "ping") return jsonRpcResult(id, {});
      if (method === "tools/list") return jsonRpcResult(id, { tools: toolList(tools) });
      if (method === "resources/list") return jsonRpcResult(id, { resources: [] });
      if (method === "prompts/list") return jsonRpcResult(id, { prompts: [] });
      if (method === "tools/call") {
        const name = cleanText(message.params?.name);
        const tool = tools[name];
        if (!tool) return jsonRpcError(id, -32602, `Unknown Rabbit Hole tool: ${name}`);
        const result = await tool.handler(message.params?.arguments || {});
        return jsonRpcResult(id, {
          structuredContent: result,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        });
      }
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
    } catch (error) {
      return jsonRpcError(id, -32000, error.message || "Rabbit Hole MCP tool failed.");
    }
  }

  return async function handleMcpHttp(req, res, url) {
    if (req.method === "OPTIONS") {
      return sendNoBody(res, 204, sessionId);
    }

    if (!isAuthorized(req, url, token)) {
      res.writeHead(401, {
        ...mcpHeaders(sessionId),
        "www-authenticate": "Bearer realm=\"Rabbit Hole MCP\"",
        "content-type": "application/json; charset=utf-8"
      });
      res.end(JSON.stringify({ error: "Unauthorized Rabbit Hole MCP request." }));
      return;
    }

    if (req.method === "GET") {
      return sendJson(res, 200, {
        name: serverName,
        version: serverVersion,
        endpoint: "/mcp",
        protocol: "mcp-streamable-http",
        tools: toolList(tools).map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description
        }))
      }, sessionId);
    }

    if (req.method !== "POST") {
      return sendJson(res, 405, { error: "Method not allowed." }, sessionId);
    }

    let payload;
    try {
      payload = await readRequestJson(req);
    } catch (error) {
      const status = Number(error.statusCode || 400);
      return sendJson(res, status, jsonRpcError(null, -32700, error.message), sessionId);
    }

    const messages = Array.isArray(payload) ? payload : [payload];
    if (!messages.length) {
      return sendJson(res, 400, jsonRpcError(null, -32600, "Invalid empty JSON-RPC batch."), sessionId);
    }

    const responses = [];
    for (const message of messages) {
      const response = await handleMessage(message);
      if (response) responses.push(response);
    }

    if (!responses.length) return sendNoBody(res, 202, sessionId);
    return sendJson(res, 200, Array.isArray(payload) ? responses : responses[0], sessionId);
  };
}

module.exports = {
  createRabbitHoleMcpHttpHandler,
  createRabbitHoleMcpTools
};
