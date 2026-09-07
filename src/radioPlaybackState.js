"use strict";

const { parseRadioTrack } = require("./radioMetadataResolver");

function summarizeZoneTrack(zone = {}) {
  const now = zone.now_playing;
  if (!now) return null;
  return {
    title: now.two_line?.line1 || now.three_line?.line1 || now.one_line?.line1 || "",
    artist: now.two_line?.line2 || now.three_line?.line2 || now.one_line?.line2 || "",
    album: now.three_line?.line3 || "",
    durationMs: now.length ? Number(now.length) * 1000 : null
  };
}

function cleanRadioText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cleanHttpUrl(value) {
  const text = cleanRadioText(value);
  if (!text) return "";
  try {
    const url = new URL(text);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

function cleanArtworkUrl(value) {
  const text = cleanHttpUrl(value);
  if (!text) return "";
  try {
    const url = new URL(text);
    if (
      url.protocol === "http:" &&
      /(?:^|\.)coverartarchive\.org$|(?:^|\.)resources\.tidal\.com$|^i\.scdn\.co$/i.test(url.hostname)
    ) {
      url.protocol = "https:";
    }
    return url.toString();
  } catch {
    return text;
  }
}

function normalizeRadioText(value) {
  return cleanRadioText(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function splitRadioArtistTitle(value) {
  const text = cleanRadioText(value);
  const parts = text.split(/\s+[-\u2013\u2014]\s+/).map(cleanRadioText).filter(Boolean);
  if (parts.length < 2) return null;
  return {
    artist: parts[0],
    title: parts.slice(1).join(" - ")
  };
}

function looksLikeRadioProgramTitle(value) {
  const text = cleanRadioText(value);
  if (!text) return false;
  const monthAndYear = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{4}\b/i;
  return monthAndYear.test(text) ||
    /\b(?:episode|showcase|takeover|podcast|radio\s+show|guest\s+mix|dj\s+set|live\s+set|monthly\s+mix|weekly\s+mix|mixed\s+by|with\s+[a-z0-9][\w .'-]{2,})\b/i.test(text);
}

function looksLikeStationText(value) {
  const text = cleanRadioText(value);
  if (!text) return false;
  return /\b(?:station|fm|di\.?fm|frisky|proton|afterhours|live\s+radio|radio\s+station|stream|premium)\b/i.test(text);
}

function looksLikeNonMusicStatus(value) {
  return /\b(?:muted detected|twitch stream|system output|no media|no track|silence)\b/i.test(cleanRadioText(value));
}

function radioTrackFromZone(zone = {}) {
  const now = zone.now_playing;
  if (!now) return null;

  const line1 = cleanRadioText(now.two_line?.line1 || now.three_line?.line1 || now.one_line?.line1);
  const line2 = cleanRadioText(now.two_line?.line2 || now.three_line?.line2 || now.one_line?.line2);
  const threeTitle = cleanRadioText(now.three_line?.line2);
  const threeArtist = cleanRadioText(now.three_line?.line3);
  const rawAlbum = cleanRadioText(now.three_line?.line3 || "");
  const oneLine = cleanRadioText(now.one_line?.line1);
  if (!line1 && !line2) return null;
  if (looksLikeNonMusicStatus(`${line1} ${line2} ${rawAlbum}`)) return null;

  const splitLine2 = splitRadioArtistTitle(line2);
  const splitLine1 = splitRadioArtistTitle(line1);
  const artistDuplicatesTitle = line2 && normalizeRadioText(line2) === normalizeRadioText(line1);
  const streamLike = !zone.is_seek_allowed || looksLikeStationText(`${zone.display_name || ""} ${line1} ${line2} ${rawAlbum}`);

  let artist = line2;
  let title = line1;
  const parsed = streamLike ? parseRadioTrack({
    title: line1,
    artist: line2,
    album: rawAlbum,
    originalTitle: line1,
    originalArtist: line2,
    originalAlbum: rawAlbum,
    activityDetails: oneLine || line1,
    activityState: line2
  }) : null;

  if (streamLike && parsed?.artist && parsed?.title) {
    artist = parsed.artist;
    title = parsed.title;
  } else if (streamLike && threeTitle && threeArtist && !looksLikeStationText(threeArtist)) {
    artist = threeArtist;
    title = threeTitle;
  } else if (streamLike && splitLine2) {
    artist = splitLine2.artist;
    title = splitLine2.title;
  } else if (splitLine1 && (!artist || artistDuplicatesTitle || streamLike || looksLikeStationText(artist))) {
    artist = splitLine1.artist;
    title = splitLine1.title;
  }

  artist = cleanRadioText(artist);
  title = cleanRadioText(title);
  if (!artist || !title) return null;
  if (looksLikeNonMusicStatus(`${artist} ${title}`)) return null;
  if (!streamLike && !artistDuplicatesTitle && !(splitLine1 && normalizeRadioText(line2).includes(normalizeRadioText(splitLine1.artist)))) return null;
  const isRadioProgram = streamLike && looksLikeRadioProgramTitle(title);

  return {
    artist,
    title,
    album: rawAlbum,
    durationMs: now.length ? Number(now.length) * 1000 : null,
    isRadioProgram,
    catalogEnrichmentAllowed: !isRadioProgram,
    source: "Roon radio metadata"
  };
}

function radioEnrichmentKey(track = {}) {
  if (!track) return "";
  const artist = normalizeRadioText(track.artist);
  const title = normalizeRadioText(track.title);
  return artist && title ? `${artist}|${title}` : "";
}

function radioEnrichmentResultKey(result = {}) {
  return cleanRadioText(result.radioTrackKey || result.key) || radioEnrichmentKey(result.lookup || result);
}

function radioEnrichmentHasArtwork(result = {}) {
  return Boolean(cleanArtworkUrl(result?.imageUrl) && result?.radioArtworkResolved !== false);
}

function parseRoonPresenceNowState(body = {}) {
  const structured = body?.nowPlaying && typeof body.nowPlaying === "object" ? body.nowPlaying : null;
  if (structured) {
    const title = cleanRadioText(structured.title);
    const artist = cleanRadioText(structured.artist);
    const albumArtUrl = cleanHttpUrl(structured.albumArtUrl);
    if (title && artist && albumArtUrl) {
      return {
        key: radioEnrichmentKey({ artist, title }),
        title,
        artist,
        album: cleanRadioText(structured.album),
        albumArtUrl,
        tidalUrl: cleanHttpUrl(structured.tidalUrl || structured.bridgeUrl),
        signalPath: cleanRadioText(structured.signalPath),
        source: "roonpresence"
      };
    }
  }

  const version = cleanRadioText(body?.version);
  if (!version || version === "idle") return null;

  const parts = version.split("|").map(cleanRadioText);
  const artist = parts[0] || "";
  const title = parts[1] || "";
  const albumArtUrl = cleanHttpUrl(parts[2]);
  if (!artist || !title || !albumArtUrl) return null;
  return {
    key: radioEnrichmentKey({ artist, title }),
    title,
    artist,
    albumArtUrl,
    tidalUrl: cleanHttpUrl(parts[3]),
    signalPath: parts.slice(4).join("|"),
    source: "roonpresence"
  };
}

module.exports = {
  cleanArtworkUrl,
  cleanHttpUrl,
  cleanRadioText,
  looksLikeNonMusicStatus,
  looksLikeRadioProgramTitle,
  looksLikeStationText,
  normalizeRadioText,
  parseRoonPresenceNowState,
  radioEnrichmentHasArtwork,
  radioEnrichmentKey,
  radioEnrichmentResultKey,
  radioTrackFromZone,
  splitRadioArtistTitle,
  summarizeZoneTrack
};
