"use strict";

const CODECS = { flc: "FLAC", alc: "ALAC", mp3: "MP3", aac: "AAC", mp4: "AAC", wav: "WAV", aif: "AIFF", dsf: "DSD", dff: "DSD", ogg: "Ogg Vorbis", ops: "Opus", wma: "WMA", wvp: "WavPack", ape: "Monkey's Audio" };
const MIME_CODECS = { "audio/flac": "FLAC", "audio/x-flac": "FLAC", "audio/wav": "WAV", "audio/x-wav": "WAV", "audio/aiff": "AIFF", "audio/x-aiff": "AIFF", "audio/x-dsf": "DSD", "audio/x-dff": "DSD", "audio/mpeg": "MP3", "audio/mp4": "AAC" };
const LIBRARY_TAGS = "tags:altdrTIo";
const DURATION_SLACK_SECONDS = 1.5;

const words = value => String(value || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const unbracketed = value => String(value || "").replace(/\s*[([][^)\]]*[)\]]/g, "").trim();
const base = value => words(unbracketed(value));
const artistNames = value => String(value || "").split(/\s*(?:\/|;|,|&|\bfeat\.?|\bft\.?)\s*/i).map(words).filter(Boolean);

function rateText(rateHz) {
  const rate = Number(rateHz) || 0;
  if (!rate) return "";
  return rate >= 1e6 ? `${+(rate / 1e6).toFixed(4)} MHz` : `${+(rate / 1000).toFixed(1)} kHz`;
}

function formatText({ codec = "", rateHz = 0, bits = 0, bitrate = "" } = {}) {
  const rate = [rateText(rateHz), Number(bits) > 0 ? `${Number(bits)}-bit` : ""].filter(Boolean).join(" / ");
  return [codec, rate, String(bitrate || "").replace(/(\d)kbps/i, "$1 kbps")].filter(Boolean).join(" · ");
}

function nowPlayingTrack(zone) {
  const lines = zone?.now_playing?.three_line || {};
  const title = String(lines.line1 || "").trim();
  if (!title) return null;
  return { title, artist: String(lines.line2 || "").trim(), album: String(lines.line3 || "").trim(), lengthSeconds: Number(zone.now_playing.length) || 0 };
}

function libraryMatches(track, rows = []) {
  const title = base(track.title), album = base(track.album), artists = new Set(artistNames(track.artist));
  if (!title || !artists.size || !track.lengthSeconds) return [];
  const matches = rows.filter(row => base(row.title) === title
    && artistNames(row.artist).some(name => artists.has(name))
    && Math.abs(Number(row.duration) - track.lengthSeconds) <= DURATION_SLACK_SECONDS
    && Number(row.samplerate) > 0);
  const sameAlbum = album ? matches.filter(row => base(row.album) === album) : [];
  return sameAlbum.length ? sameAlbum : matches;
}

function libraryFormat(matches) {
  if (!matches.length) return null;
  const formats = new Set(matches.map(row => `${row.type}|${row.samplerate}|${row.samplesize}`));
  if (formats.size !== 1) return null;
  const [row] = matches;
  const bitrates = new Set(matches.map(row => String(row.bitrate || "")));
  return formatText({
    codec: CODECS[String(row.type || "").toLowerCase()] || String(row.type || "").toUpperCase(),
    rateHz: row.samplerate,
    bits: row.samplesize,
    bitrate: bitrates.size === 1 && row.bitrate !== "0" ? row.bitrate : ""
  });
}

function tidalFormat(quality) {
  if (quality?.catalogSource !== "TIDAL" || !quality.track?.id) return null;
  const tags = new Set((quality.mediaTags || []).map(tag => String(tag).toUpperCase()));
  if (tags.has("HIRES_LOSSLESS")) return "FLAC · HiRes Lossless";
  if (tags.has("LOSSLESS")) return "FLAC · 44.1 kHz / 16-bit";
  return null;
}

function createRoonSourceFormat({ getZone, hqplayerZones, control, lyrionTitles, tidalQuality }) {
  const cache = new Map();
  return async (zoneId) => {
    const zone = getZone(String(zoneId || ""));
    const track = nowPlayingTrack(zone);
    if (!track) return { format: null, from: null };

    const host = hqplayerZones.get(zone.display_name);
    if (host) {
      const source = (await control.status(host).catch(() => null))?.source;
      if (source?.rate) return { format: formatText({ codec: MIME_CODECS[source.mime] || "", rateHz: source.rate, bits: source.bits }), from: "hqplayer" };
    }

    const key = JSON.stringify([track.title, track.artist, track.album, track.lengthSeconds]);
    if (cache.has(key)) return cache.get(key);

    let result = { format: null, from: null };
    const rows = await lyrionTitles(unbracketed(track.title) || track.title).catch(() => null);
    const library = rows ? libraryFormat(libraryMatches(track, rows)) : null;
    if (library) {
      result = { format: library, from: "library" };
    } else {
      let quality = null, failed = false;
      try { quality = await tidalQuality({ title: track.title, artist: track.artist, album: track.album, durationMs: track.lengthSeconds * 1000 }); }
      catch { failed = true; }
      const tidal = tidalFormat(quality);
      if (tidal) result = { format: tidal, from: "tidal" };
      if (failed) return result;
    }
    if (rows) cache.set(key, result);
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return result;
  };
}

function lyrionTitleSearch(client) {
  return async (title) => (await client.rpc("", ["titles", 0, 50, `search:${title}`, LIBRARY_TAGS])).titles_loop || [];
}

module.exports = { createRoonSourceFormat, lyrionTitleSearch, libraryMatches, libraryFormat, tidalFormat, formatText };
