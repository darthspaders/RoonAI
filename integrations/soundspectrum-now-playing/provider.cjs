'use strict';

// Optional, read-only metadata. Never imports a player/control/audio integration.
const crypto = require('node:crypto');
const net = require('node:net');
const { radioEnrichmentKey, radioEnrichmentResultKey } = require('../../src/radioPlaybackState');
const MAX_BYTES = 2 * 1024 * 1024, MAX_DIMENSION = 4096, TIMEOUT_MS = 3000;
const MAX_ART = 16, MAX_ART_READS = 2;
const ZONE = /^[a-f0-9]{20,128}$/i, PLAYER = /^[a-f0-9]{2}(?::[a-f0-9]{2}){5}$/i;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const unavailable = () => ({ state: 'unavailable', track: null });
const text = value => typeof value === 'string' ? value.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 512) : '';
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const seconds = value => Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) <= 7 * 86400 ? Math.round(Number(value) * 1000) : 0;
function origin(value) {
  try {
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.pathname !== '/' || u.search || u.hash) return null;
    return u.origin;
  } catch { return null; }
}
function coreOrigins(core) {
  const host = core?.moo?.transport?.host;
  if (typeof host !== 'string' || !host || host.length > 253 || /[\s/@?#\\]/.test(host)) return [];
  const bare = host.replace(/^\[|\]$/g, '');
  if (!net.isIP(bare) && !/^[a-z0-9.-]+$/i.test(bare)) return [];
  const ports = [...new Set([core?.moo?.transport?.port, core?.registration?.http_port].map(Number))];
  return ports.filter(port => Number.isInteger(port) && port > 0 && port <= 65535)
    .map(port => origin(`http://${net.isIP(bare) === 6 ? '[' + bare + ']' : bare}:${port}`)).filter(Boolean);
}
function safeExternalArt(value) {
  // These are fixed vendor image routes, not an arbitrary imageproxy escape.
  try {
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.port || u.hash || u.search || u.href.length > 2048) return false;
    const p = u.pathname;
    if (u.hostname === 'resources.tidal.com') return /^\/images\/(?:[a-f0-9]{8}\/){1}[a-f0-9]{4}\/[a-f0-9]{4}\/[a-f0-9]{4}\/[a-f0-9]{12}\/(?:80|160|320|640|1280)x(?:80|160|320|640|1280)\.jpg$/i.test(p);
    if (['i1.sndcdn.com', 'i2.sndcdn.com'].includes(u.hostname)) return /^\/(?:artworks|avatars)-[a-z0-9-]+-(?:large|t500x500|t300x300|t67x67|crop)\.jpg$/i.test(p);
    if (u.hostname === 'pri.art.prod.streaming.siriusxm.com') return /^\/images\/[a-z0-9/_-]+\.(?:png|jpe?g)$/i.test(p);
    if (u.hostname === 'www.siriusxm.com') return /^\/content\/dam\/sxm-com\/[a-z0-9/_-]+\.(?:png|jpe?g)$/i.test(p);
    if (u.hostname === 'imgsrv-sxm-prod-device.streaming.siriusxm.com') {
      if (!/^\/[a-z0-9+/=]+$/i.test(p)) return false;
      const encoded = p.slice(1), decoded = Buffer.from(encoded, 'base64');
      if (decoded.toString('base64') !== encoded || decoded.length > 1024) return false;
      const request = JSON.parse(decoded.toString('utf8'));
      return /^\/?(?:live|aem|if)\/[a-z0-9/_-]+(?:\.[a-z0-9]+)?$/i.test(request.key || '') &&
        Array.isArray(request.edits) && request.edits.length === 2 && request.edits[0]?.format?.type === 'jpeg' &&
        Object.keys(request).every(key => ['key', 'edits'].includes(key)) &&
        Object.keys(request.edits[0]).length === 1 && Object.keys(request.edits[1]).length === 1 &&
        Object.keys(request.edits[1]?.resize || {}).length === 2 &&
        ['width', 'height'].every(key => Number.isInteger(request.edits[1]?.resize?.[key]) && request.edits[1].resize[key] > 0 && request.edits[1].resize[key] <= 1024);
    }
  } catch {}
  return false;
}
function lyrionArt(value, base) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    let path = value;
    if (value.startsWith('/api/lyrion/artwork?')) {
      const wrapper = new URL(value, base);
      if (wrapper.pathname !== '/api/lyrion/artwork' || wrapper.hash || [...wrapper.searchParams.keys()].some(key => key !== 'path') || wrapper.searchParams.getAll('path').length !== 1) return null;
      path = wrapper.searchParams.get('path');
    }
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(path) || /(?:^|\/)\.\.(?:\/|$)|%2e/i.test(path)) return null;
    const u = new URL(path, base);
    if (u.origin !== base || u.username || u.password || u.search || u.hash) return null;
    if (/^\/music\/[a-z0-9_-]{1,128}\/cover\.jpg$/i.test(u.pathname)) return u.href;
    const proxy = u.pathname.match(/^\/imageproxy\/([^/]+)\/image\.png$/);
    if (!proxy || !safeExternalArt(decodeURIComponent(proxy[1]))) return null;
    return u.href;
  } catch { return null; }
}
function rasterInfo(data) {
  if (!Buffer.isBuffer(data) || !data.length || data.length > MAX_BYTES) return null;
  if (data.length >= 45 && data.subarray(0, 8).equals(PNG)) {
    if (data.readUInt32BE(8) !== 13 || data.toString('ascii', 12, 16) !== 'IHDR') return null;
    const width = data.readUInt32BE(16), height = data.readUInt32BE(20), depth = data[24], color = data[25];
    if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION || !({0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]})[color]?.includes(depth) || data[26] || data[27] || data[28] > 1) return null;
    let at = 8, image = false, end = false;
    while (at + 12 <= data.length) {
      const size = data.readUInt32BE(at), name = data.toString('ascii', at + 4, at + 8);
      if (size > MAX_BYTES || at + size + 12 > data.length || !/^[a-z]{4}$/i.test(name)) return null;
      if (name === 'IHDR' && at !== 8) return null;
      if (name === 'IDAT') image = true;
      at += size + 12;
      if (name === 'IEND') { if (size || at !== data.length) return null; end = true; break; }
    }
    return image && end ? { width, height, extension: 'png' } : null;
  }
  if (data.length < 12 || data[0] !== 0xff || data[1] !== 0xd8 || data[data.length - 2] !== 0xff || data[data.length - 1] !== 0xd9) return null;
  let at = 2, dimensions = null;
  while (at < data.length - 2) {
    if (data[at++] !== 0xff) return null;
    while (data[at] === 0xff) at++;
    const marker = data[at++];
    if (!marker || marker === 0xd8 || marker === 0xd9 || marker >= 0xd0 && marker <= 0xd7) return null;
    if (at + 2 > data.length) return null;
    const size = data.readUInt16BE(at);
    if (size < 2 || at + size > data.length - 2) return null;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (dimensions || size < 8 || data[at + 2] !== 8 || ![1, 3, 4].includes(data[at + 7]) || size !== 8 + data[at + 7] * 3) return null;
      const height = data.readUInt16BE(at + 3), width = data.readUInt16BE(at + 5);
      if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION) return null;
      dimensions = { width, height, extension: 'jpg' };
    } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return null;
    if (marker === 0xda) return dimensions && size >= 6 && at + size < data.length - 2 ? dimensions : null;
    at += size;
  }
  return null;
}

function bridgeArt(value, config) {
  // Resolve only a cached object ID through the configured bridge listener.
  // Never fetch the supplied hostname or accept a source URL/proxy query.
  try {
    if (!config || config.enabled === false || typeof value !== 'string' || value.length > 2048) return null;
    const base = new URL(config.cacheUrl), u = new URL(value);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
        base.pathname !== '/api/art/cache' || base.search || base.hash ||
        !['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.hash ||
        !/^\/art\/[a-f0-9]{40}\.jpg$/i.test(u.pathname) ||
        (u.search && !/^\?v=\d{1,20}$/.test(u.search))) return null;
    return base.origin + u.pathname + u.search;
  } catch { return null; }
}
function radioArtUrls(now, config) {
  const lookup = now.radio_lookup, key = radioEnrichmentKey(lookup);
  if (!key || lookup.catalogEnrichmentAllowed === false) return [];
  const meta = now.metadata_enrichment, radio = now.radio_enrichment;
  const matchesMeta = meta?.status === 'found' &&
    radioEnrichmentKey({ artist: meta.inputArtist, title: meta.inputTitle }) === key;
  const length = Number(now.length) * 1000, duration = Number(meta?.durationMs);
  const lengthMatches = !(length > 0 && duration > 0) || Math.abs(length - duration) <= Math.max(30000, length * .12);
  const candidates = [matchesMeta && lengthMatches ? meta.imageUrl : '',
    radioEnrichmentResultKey(radio || {}) === key && radio?.radioArtworkResolved !== false ? radio.imageUrl : ''];
  return [...new Set(candidates.map(value => bridgeArt(value, config)).filter(Boolean))];
}

function createNowPlayingProvider({ getRoonState = () => ({ connected: false, zones: [] }), getRoonCore = () => null, lyrionClient, artBridge, fetchImpl = fetch } = {}) {
  const art = new Map(), descriptors = new Map(), controllers = new Set();
  let closed = false, artReads = 0;
  const currentCore = () => { const core = getRoonCore(); return { origins: coreOrigins(core), id: text(core?.core_id || '') }; };
  function descriptorCurrent(descriptor) {
    if (descriptor.source === 'roon-hqplayer') {
      const core = currentCore();
      return core.id === descriptor.coreId && JSON.stringify(core.origins) === JSON.stringify(descriptor.origins);
    }
    return origin(lyrionClient?.baseUrl) === descriptor.origin;
  }
  async function bounded(signal, work) {
    signal?.throwIfAborted();
    if (closed) throw new Error('Metadata provider closed');
    const control = new AbortController(); controllers.add(control);
    const abort = () => control.abort(signal.reason);
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => control.abort(new DOMException('Metadata request timed out', 'TimeoutError')), TIMEOUT_MS);
    let abortListener;
    const aborted = new Promise((_, reject) => { abortListener = () => reject(control.signal.reason); control.signal.addEventListener('abort', abortListener, { once: true }); });
    try { return await Promise.race([Promise.resolve().then(() => work(control.signal)), aborted]); }
    finally { clearTimeout(timer); control.signal.removeEventListener('abort', abortListener); signal?.removeEventListener('abort', abort); controllers.delete(control); }
  }
  function remember(key, descriptor) {
    if (!descriptor) return { artToken: '', artKind: 'none' };
    const identity = hash([key, descriptor]);
    let token = descriptors.get(identity);
    if (token) { const record = art.get(token); art.delete(token); art.set(token, record); }
    else {
      token = crypto.randomBytes(24).toString('hex'); descriptors.set(identity, token); art.set(token, { key, identity, descriptor });
      while (art.size > MAX_ART) { const oldest = art.keys().next().value; descriptors.delete(art.get(oldest).identity); art.delete(oldest); }
    }
    return { artToken: token, artKind: descriptor.kind };
  }
  async function readTrack(target, { signal } = {}) {
    try {
      return await bounded(signal, async internal => {
        let state, now, identity, descriptor = null;
        if (target?.source === 'roon-hqplayer' && ZONE.test(target.zoneId || '') && !target.playerId) {
          const raw = await getRoonState(); internal.throwIfAborted();
          const zone = raw?.connected && Array.isArray(raw.zones) && raw.zones.find(item => item?.zone_id === target.zoneId);
          if (!zone || !['playing', 'paused', 'stopped'].includes(zone.state)) return unavailable();
          state = zone.state; now = zone.now_playing;
          if (state === 'stopped' || !now) return { state: 'waiting', track: null };
          const core = currentCore(), metadata = now.metadata || now.item || {};
          const radio = artBridge && now.radio_lookup?.artist && now.radio_lookup?.title ? now.radio_lookup : null;
          const radioUrls = radio ? radioArtUrls(now, artBridge) : [];
          now = { title: now.two_line?.line1 || now.three_line?.line1 || now.one_line?.line1, artist: now.two_line?.line2 || now.three_line?.line2 || now.one_line?.line2,
            album: now.three_line?.line3, duration: now.length, id: now.tidal_id || now.tidalId || metadata.tidal_id || metadata.tidalId || now.item_key || now.itemKey || metadata.item_key || metadata.itemKey || '', imageKey: now.image_key };
          identity = ['roon-hqplayer', core.id, target.zoneId, text(String(now.id))];
          if (core.origins.length && typeof now.imageKey === 'string' && now.imageKey.length <= 512 && now.imageKey.trim() && !/[\u0000-\u001f\u007f]/.test(now.imageKey)) descriptor = { source: 'roon-hqplayer', origins: core.origins, coreId: core.id,
            path: `/api/image/${encodeURIComponent(now.imageKey)}?width=512&height=512&scale=fit&format=image%2Fjpeg`, kind: 'album' };
          if (radio) {
            // Station image keys and queue IDs can stay fixed for many songs.
            // The current parsed song identifies the artwork lifecycle instead.
            now.title = radio.title; now.artist = radio.artist; now.album = radio.album || ''; now.duration = 0;
            identity.push('radio', radioEnrichmentKey(radio), text(now.imageKey));
            if (descriptor) descriptor.kind = 'channel';
            if (radioUrls.length) descriptor = { source: 'roon-hqplayer', origins: core.origins, coreId: core.id,
              urls: radioUrls, zoneId: target.zoneId, kind: 'album' };
          }
        } else if (target?.source === 'lyrion' && PLAYER.test(target.playerId || '') && !target.zoneId && lyrionClient?.status) {
          const base = origin(lyrionClient.baseUrl);
          if (!base) return unavailable();
          const raw = await lyrionClient.status(target.playerId, 0, 1, { signal: internal, timeoutMs: TIMEOUT_MS, redirect: 'error' }); internal.throwIfAborted();
          if (!raw?.connected || raw.playerId !== target.playerId || !['playing', 'paused', 'stopped'].includes(raw.state)) return unavailable();
          state = raw.state; now = raw.nowPlaying;
          if (state === 'stopped' || !now) return { state: 'waiting', track: null };
          identity = ['lyrion', target.playerId.toLowerCase(), text(String(now.id || '')), Number.isSafeInteger(raw.queueIndex) ? raw.queueIndex : null];
          const url = lyrionArt(now.artwork, base);
          // Raw SiriusXM artwork can be station branding. Do not label it as a
          // verified album image without the separate display alignment layer.
          if (url) descriptor = { source: 'lyrion', origin: base, url, kind: /^SiriusXM/i.test(now.source || '') || now.artwork === now.artworkFallback ? 'channel' : 'album' };
        } else return unavailable();
        const title = text(now.title), artist = text(now.artist), album = text(now.album);
        if (!title) return { state: 'waiting', track: null };
        const key = hash([...identity, title, artist, album, seconds(now.duration)]);
        internal.throwIfAborted();
        return { state, track: { key, title, artist, album, ...remember(key, descriptor) } };
      });
    } catch (error) { if (signal?.aborted) throw signal.reason; return closed ? unavailable() : { state: 'waiting', track: null }; }
  }
  async function fetchRaster(url, headers, signal) {
    const response = await fetchImpl(url, { signal, redirect: 'error', headers }); signal.throwIfAborted();
    const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (response.status !== 200 || !['image/jpeg', 'image/png'].includes(type) || Number(response.headers.get('content-length')) > MAX_BYTES || !response.body) {
      await response.body?.cancel?.().catch(() => {}); return null;
    }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { signal.throwIfAborted(); size += chunk.length; if (size > MAX_BYTES) return null; chunks.push(Buffer.from(chunk)); }
    signal.throwIfAborted();
    const data = Buffer.concat(chunks), info = rasterInfo(data);
    return info && (info.extension === 'png') === (type === 'image/png') ? { data, ...info } : null;
  }
  async function readArt(track, { signal } = {}) {
    try {
      return await bounded(signal, async internal => {
        const record = art.get(track?.artToken);
        if (!record || record.key !== track?.key || artReads >= MAX_ART_READS) return null;
        const descriptor = record.descriptor;
        if (!descriptorCurrent(descriptor)) return null;
        const radioCurrent = async () => {
          if (!descriptor.urls) return true;
          const current = await readTrack({ source: 'roon-hqplayer', zoneId: descriptor.zoneId }, { signal: internal });
          return current.track?.key === track.key && current.track?.artToken === track.artToken;
        };
        if (!await radioCurrent() || artReads >= MAX_ART_READS) return null;
        artReads++;
        try {
          const headers = { accept: 'image/jpeg, image/png' };
          if (descriptor.source === 'lyrion' && process.env.LYRION_USERNAME) headers.Authorization = `Basic ${Buffer.from(`${process.env.LYRION_USERNAME}:${process.env.LYRION_PASSWORD || ''}`).toString('base64')}`;
          const urls = descriptor.urls || (descriptor.source === 'roon-hqplayer' ? descriptor.origins.map(base => base + descriptor.path) : [descriptor.url]);
          for (const url of urls) {
            if (!descriptorCurrent(descriptor)) return null;
            let image;
            try { image = await fetchRaster(url, headers, internal); }
            catch { internal.throwIfAborted(); continue; }
            if (closed || art.get(track.artToken) !== record || !descriptorCurrent(descriptor) || !await radioCurrent()) return null;
            if (image) return image;
          }
          return null;
        } finally { artReads--; }
      });
    } catch (error) { if (signal?.aborted) throw signal.reason; return null; }
  }
  function close() { closed = true; for (const control of controllers) control.abort(new DOMException('Metadata provider closed', 'AbortError')); art.clear(); descriptors.clear(); }
  return { readTrack, readArt, close };
}

module.exports = { createNowPlayingProvider };
