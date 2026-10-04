"use strict";

(() => {
  const RATING_OPTIONS = [
    { value: "love", label: "Love", symbol: "♥", className: "love" },
    { value: "like", label: "Like", symbol: "👍", className: "like" },
    { value: "ok", label: "Okay", symbol: "👌", className: "ok" },
    { value: "dislike", label: "Dislike", symbol: "👎", className: "dislike" },
    { value: "never", label: "Never Again", symbol: "⊘", className: "never" }
  ];

  const state = {
    payload: null,
    zone: null,
    now: null,
    track: null,
    feedback: "",
    trackKey: "",
    isSeeking: false,
    ratingBusy: false,
    lastEventAt: 0,
    statusTimer: null
  };

  const $ = (selector) => document.querySelector(selector);

  function cleanText(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;"
    }[character]));
  }

  function normalizeFeedback(value) {
    const rating = cleanText(value).toLowerCase();
    if (rating === "love") return "love";
    if (rating === "like" || rating === "good" || rating === "up") return "like";
    if (rating === "ok" || rating === "okay") return "ok";
    if (rating === "dislike") return "dislike";
    if (["wrong_genre", "wrong genre", "wrong", "not what i asked for", "not_asked"].includes(rating)) return "wrong_genre";
    if (rating === "skip" || rating === "down") return "dislike";
    if (["never", "never_again", "never again"].includes(rating)) return "never";
    return "";
  }

  function ratingOption(value) {
    return RATING_OPTIONS.find((option) => option.value === value) || null;
  }

  function ratingLabel(value) {
    return ratingOption(normalizeFeedback(value))?.label || "Unscored now playing";
  }

  function formatSeconds(value) {
    const total = Math.max(0, Math.round(Number(value || 0)));
    if (!Number.isFinite(total) || !total) return "0:00";
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    return hours
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
      : `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  function formatDate(value) {
    const text = cleanText(value);
    if (!text) return "";
    const match = text.match(/^\d{4}-\d{2}-\d{2}/);
    return match ? match[0] : text;
  }

  function activeZone(zones = []) {
    const available = Array.isArray(zones) ? zones : [];
    const playable = available.filter((zone) => !["stopped", "disconnected"].includes(cleanText(zone?.state).toLowerCase()));
    return playable.find((zone) => cleanText(zone?.state).toLowerCase() === "playing" && zone?.now_playing)
      || playable.find((zone) => zone?.now_playing)
      || available.find((zone) => cleanText(zone?.state).toLowerCase() === "playing")
      || playable[0]
      || available[0]
      || null;
  }

  function summarizeNow(now = {}) {
    const lookup = now.radio_lookup || {};
    const enriched = now.radio_enrichment || {};
    if (lookup.title && lookup.artist) {
      return {
        title: cleanText(lookup.title),
        artist: cleanText(lookup.artist),
        album: cleanText(enriched.album || lookup.album)
      };
    }
    if (enriched.title && enriched.artist) {
      return {
        title: cleanText(enriched.title),
        artist: cleanText(enriched.artist),
        album: cleanText(enriched.album || now.three_line?.line3)
      };
    }
    return {
      title: cleanText(now.two_line?.line1 || now.three_line?.line1 || now.one_line?.line1),
      artist: cleanText(now.two_line?.line2 || now.three_line?.line2 || now.one_line?.line2),
      album: cleanText(now.three_line?.line3)
    };
  }

  function metadataFor(now = {}, summary = {}) {
    const enrichment = now.metadata_enrichment || {};
    const beatport = enrichment.beatport || {};
    const rows = [];
    const add = (label, value, className = "") => {
      const text = cleanText(value);
      if (text) rows.push({ label, value: text, className });
    };

    add("Track length", now.length ? formatSeconds(now.length) : "", "primary");
    add("Released", formatDate(beatport.releaseDate || now.releaseDate || enrichment.releaseDate || enrichment.releaseYear || enrichment.year));
    add("Label", beatport.label || enrichment.label);
    add("Genre", beatport.genre || enrichment.genre);
    const bpm = Number(beatport.bpm || enrichment.bpm || 0);
    const key = cleanText(beatport.keyName || enrichment.keyName);
    const camelot = cleanText(beatport.camelot || enrichment.camelot);
    add("BPM / Key", [bpm > 0 ? `${Math.round(bpm)} BPM` : "", key, camelot && camelot !== key ? camelot : ""].filter(Boolean).join(" • "));
    add("Beatport Track ID", beatport.id ? `#${beatport.id}` : "", "technical");
    add("Release ID", beatport.releaseId ? `#${beatport.releaseId}` : "", "technical");

    if (!rows.length && summary.artist) add("Source", "Roon now playing");
    return rows;
  }

  function safeImageUrl(value) {
    const text = cleanText(value);
    if (!text) return "";
    try {
      const url = new URL(text, window.location.origin);
      return ["http:", "https:"].includes(url.protocol) ? url.href : "";
    } catch {
      return "";
    }
  }

  function artworkMetadataMatchesRoon(now = {}, enrichment = {}) {
    const roonLengthMs = Number(now.length || 0) * 1000;
    const enrichmentLengthMs = Number(enrichment.durationMs || 0);
    if (!Number.isFinite(roonLengthMs) || !Number.isFinite(enrichmentLengthMs) || roonLengthMs <= 0 || enrichmentLengthMs <= 0) {
      return true;
    }
    const toleranceMs = Math.max(30000, roonLengthMs * 0.12);
    return Math.abs(roonLengthMs - enrichmentLengthMs) <= toleranceMs;
  }

  function artworkUrl(now = {}) {
    const metadata = now.metadata_enrichment || {};
    const radio = now.radio_enrichment || {};
    const metadataArtworkAllowed = artworkMetadataMatchesRoon(now, metadata);
    const roonImageUrl = now.image_key
      ? `/api/roon/image/${encodeURIComponent(now.image_key)}?width=640&height=640`
      : "";
    const candidates = now.radio_lookup
      ? [
        metadataArtworkAllowed ? metadata.sourceImageUrl : "",
        metadataArtworkAllowed ? metadata.imageUrl : "",
        radio.sourceImageUrl,
        radio.imageUrl,
        roonImageUrl
      ]
      : [
        // Keep the live Roon queue artwork authoritative when enrichment has
        // matched another release/version with the same artist/title.
        roonImageUrl,
        metadataArtworkAllowed ? metadata.sourceImageUrl : "",
        metadataArtworkAllowed ? metadata.imageUrl : "",
        radio.sourceImageUrl,
        radio.imageUrl
      ];
    return candidates.map(safeImageUrl).find(Boolean) || "";
  }

  function buildFeedbackTrack(zone, now, summary) {
    const enrichment = now.metadata_enrichment || {};
    const beatport = enrichment.beatport || {};
    return {
      artist: summary.artist,
      title: summary.title,
      album: summary.album,
      durationMs: now.length ? Number(now.length) * 1000 : null,
      label: cleanText(beatport.label || enrichment.label),
      genre: cleanText(beatport.genre || enrichment.genre),
      releaseDate: cleanText(beatport.releaseDate || now.releaseDate || enrichment.releaseDate),
      year: beatport.releaseYear || enrichment.releaseYear || enrichment.year || null,
      metadataEnrichment: enrichment,
      roon: {
        verified: true,
        match: { title: summary.title, subtitle: summary.artist }
      },
      zoneId: cleanText(zone?.zone_id)
    };
  }

  function renderMetadata(rows) {
    const metadata = $("#remoteMetadata");
    if (!metadata) return;
    metadata.innerHTML = rows.map((row) => `
      <div class="rabbitRemoteMetadataRow ${escapeHtml(row.className)}">
        <dt>${escapeHtml(row.label)}</dt>
        <dd>${escapeHtml(row.value)}</dd>
      </div>
    `).join("");
    metadata.hidden = !rows.length;
  }

  function renderRatingOptions() {
    const options = $("#remoteRatingOptions");
    if (!options) return;
    options.innerHTML = RATING_OPTIONS.map((option) => {
      const active = option.value === state.feedback;
      const symbol = option.symbol ? `<span class="rabbitRemoteRatingSymbol" aria-hidden="true">${option.symbol}</span>` : "";
      return `<button type="button" class="rabbitRemoteRatingOption ${option.className} ${active ? "isActive" : ""}" data-remote-rating="${option.value}" aria-pressed="${active}">${symbol}<span>${option.label}</span></button>`;
    }).join("");
  }

  function setStatus(message, isError = false) {
    const status = $("#remoteFeedbackStatus");
    if (!status) return;
    if (state.statusTimer) clearTimeout(state.statusTimer);
    status.textContent = message;
    status.dataset.state = isError ? "error" : "";
    if (message) {
      state.statusTimer = setTimeout(() => {
        status.textContent = "";
        status.dataset.state = "";
      }, 3500);
    }
  }

  function setRatingSheet(open) {
    const sheet = $("#remoteRatingSheet");
    const trigger = $("#remoteRatingTrigger");
    if (!sheet || !trigger) return;
    sheet.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
    document.body.classList.toggle("rabbitRemoteSheetOpen", open);
    if (open) {
      renderRatingOptions();
      window.setTimeout(() => $(".rabbitRemoteRatingOption.isActive")?.focus() || $("#remoteRatingClose")?.focus(), 0);
    } else {
      trigger.focus({ preventScroll: true });
    }
  }

  function render(payload) {
    state.payload = payload || {};
    state.zone = activeZone(state.payload.zones);
    state.now = state.zone?.now_playing || null;
    const summary = state.now ? summarizeNow(state.now) : { title: "", artist: "", album: "" };
    state.track = state.now && summary.title ? buildFeedbackTrack(state.zone, state.now, summary) : null;
    const nextTrackKey = state.track ? `${cleanText(state.track.artist).toLowerCase()}|${cleanText(state.track.title).toLowerCase()}` : "";
    const memoryFeedback = normalizeFeedback(state.zone?.memoryTrack?.feedback || state.now?.feedback || "");
    if (nextTrackKey !== state.trackKey) {
      state.trackKey = nextTrackKey;
      state.feedback = memoryFeedback;
    } else if (!state.feedback && memoryFeedback) {
      state.feedback = memoryFeedback;
    }

    const badge = $("#remoteBadge");
    const title = $("#remoteTitle");
    const artist = $("#remoteArtist");
    const album = $("#remoteAlbum");
    const artwork = $("#remoteArtwork");
    const artworkEmpty = $("#remoteArtworkEmpty");
    const trigger = $("#remoteRatingTrigger");
    const triggerText = $("#remoteRatingTriggerText");
    const seek = $("#remoteSeek");
    const playState = $("#remotePlayState");
    const seekTimes = $("#remoteSeekTimes");
    const hasTrack = Boolean(state.track);

    badge.textContent = hasTrack ? ratingLabel(state.feedback) : "No active track";
    badge.dataset.rating = state.feedback || "none";
    title.textContent = hasTrack ? summary.title : "No active zone";
    artist.textContent = hasTrack ? (summary.artist || "Unknown artist") : (state.payload?.connected ? "Nothing is currently playing." : "Rabbit Hole is reconnecting to Roon.");
    const displayAlbum = hasTrack && summary.album && ![summary.title, summary.artist].some((value) => cleanText(value).toLowerCase() === cleanText(summary.album).toLowerCase())
      ? summary.album
      : "";
    album.textContent = displayAlbum;
    album.hidden = !displayAlbum;
    trigger.disabled = !hasTrack || state.ratingBusy;
    triggerText.textContent = state.feedback ? `Rate: ${ratingOption(state.feedback)?.label || "Track"}` : "Rate this track";

    const image = hasTrack ? artworkUrl(state.now) : "";
    artwork.hidden = !image;
    artworkEmpty.hidden = Boolean(image);
    if (image && artwork.src !== new URL(image, window.location.origin).href) {
      artwork.src = image;
      artwork.alt = `${summary.title} by ${summary.artist}`.trim();
    } else if (!image) {
      artwork.removeAttribute("src");
      artwork.alt = "";
    }

    renderMetadata(hasTrack ? metadataFor(state.now, summary) : []);
    renderRatingOptions();

    const length = Math.max(0, Number(state.now?.length || 0));
    const position = Math.max(0, Math.min(length || Infinity, Number(state.now?.seek_position || 0)));
    seek.max = String(length);
    seek.disabled = !hasTrack || !state.zone?.is_seek_allowed || !length || Boolean(state.now?.radio_lookup);
    if (!state.isSeeking) seek.value = String(position);
    playState.textContent = cleanText(state.zone?.state || "stopped");
    seekTimes.textContent = `${formatSeconds(position)} / ${state.now?.radio_lookup ? "Live" : formatSeconds(length)}`;
    document.querySelectorAll("[data-remote-control]").forEach((button) => {
      button.disabled = !state.zone || !hasTrack || state.ratingBusy;
    });
  }

  async function getJson(path) {
    const response = await fetch(path, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) throw new Error(data.error || `Request failed: ${response.status}`);
    return data;
  }

  async function postJson(path, body) {
    const response = await fetch(path, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) throw new Error(data.error || `Request failed: ${response.status}`);
    return data;
  }

  let refreshRequest = null;
  function refresh() {
    if (refreshRequest) return refreshRequest;
    const pending = (async () => {
      try {
        render(await getJson("/api/status/live"));
        state.lastEventAt = Date.now();
      } catch (error) {
        render({ connected: false, zones: [] });
        setStatus(error.message || "Rabbit Hole is unavailable.", true);
      }
    })().finally(() => { if (refreshRequest === pending) refreshRequest = null; });
    refreshRequest = pending;
    return pending;
  }

  async function rate(value) {
    if (!state.track || state.ratingBusy) return;
    state.ratingBusy = true;
    state.feedback = normalizeFeedback(value);
    render(state.payload);
    try {
      await postJson("/api/feedback", { track: state.track, rating: state.feedback });
      setStatus(`${ratingOption(state.feedback)?.label || "Rating"} saved.`);
      setRatingSheet(false);
    } catch (error) {
      state.feedback = normalizeFeedback(state.zone?.memoryTrack?.feedback || "");
      render(state.payload);
      setStatus(error.message || "Could not save rating.", true);
    } finally {
      state.ratingBusy = false;
      render(state.payload);
    }
  }

  async function control(control) {
    if (!state.zone) return;
    try {
      await postJson("/api/control", { zoneId: state.zone.zone_id, control });
    } catch (error) {
      setStatus(error.message || "Playback control failed.", true);
    }
  }

  $("#remoteRatingTrigger")?.addEventListener("click", () => setRatingSheet(true));
  $("#remoteRatingClose")?.addEventListener("click", () => setRatingSheet(false));
  $("#remoteRatingBackdrop")?.addEventListener("click", () => setRatingSheet(false));
  $("#remoteRatingOptions")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-remote-rating]");
    if (button) rate(button.dataset.remoteRating);
  });

  document.querySelectorAll("[data-remote-control]").forEach((button) => {
    button.addEventListener("click", () => control(button.dataset.remoteControl));
  });

  $("#remoteSeek")?.addEventListener("pointerdown", () => {
    state.isSeeking = true;
  });
  $("#remoteSeek")?.addEventListener("input", (event) => {
    state.isSeeking = true;
    const length = Number(event.target.max || 0);
    const value = Number(event.target.value || 0);
    $("#remoteSeekTimes").textContent = `${formatSeconds(value)} / ${formatSeconds(length)}`;
  });
  $("#remoteSeek")?.addEventListener("change", async (event) => {
    if (!state.zone) return;
    try {
      await postJson("/api/seek", { zoneId: state.zone.zone_id, seconds: Number(event.target.value) });
    } catch (error) {
      setStatus(error.message || "Could not seek.", true);
    } finally {
      state.isSeeking = false;
    }
  });
  $("#remoteSeek")?.addEventListener("blur", () => {
    state.isSeeking = false;
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("#remoteRatingSheet")?.hidden) setRatingSheet(false);
  });

  const events = new EventSource("/api/events?compact=1");
  events.onmessage = (event) => {
    try {
      state.lastEventAt = Date.now();
      render(JSON.parse(event.data));
    } catch {
      setStatus("Rabbit Hole sent an unreadable update.", true);
    }
  };
  events.onerror = () => {
    if (Date.now() - state.lastEventAt > 8000) refresh().catch(() => {});
  };

  setInterval(() => {
    if (Date.now() - state.lastEventAt > 15000) refresh().catch(() => {});
  }, 5000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh().catch(() => {});
  });

  render({ connected: false, zones: [] });
  refresh().catch(() => {});
})();
