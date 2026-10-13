"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { BandcampAnalysisSource, parseTrackPage, exactRecording, checkedUrl, POLICY } = require("../src/bandcampAnalysisSource");
const { createBandcampEligibility } = require("../src/bandcampEligibility");
const { RecommendationEngineV2 } = require("../src/recommendationEngineV2");
const { DiscoveryDiagnosticsStore } = require("../src/discoveryDiagnostics");
const { TidalVerifier } = require("../src/tidalVerifier");
const track = { tidalId: "123", artist: "Example Artist", title: "Test (Extended Mix)", album: "Test", durationMs: 300000 };
const pageUrl = "https://example.bandcamp.com/track/test";
const data = { artist: track.artist, album_title: "Test", current: { type: "track" }, trackinfo: [{ track_id: 45,
  title: track.title, title_link: "/track/test", duration: 300, file: { "mp3-128": "https://t4.bcbits.com/stream/test?token=secret" } }] };
const page = input => `<script data-tralbum="${JSON.stringify(input || data).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></script>`;
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-bandcamp-")), file = path.join(dir, "state.json");
  t.after(() => { for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f)); fs.rmdirSync(dir); });
  let now = 2000000000000; const calls = [];
  const source = new BandcampAnalysisSource({ file, clock: () => now, sleep: async ms => { now += ms; },
    verifyEligibility: async () => ({ tidalAvailable: true, roonQueueable: true }),
    fetchImpl: async url => { calls.push(url); if (url.includes('/search?')) return new Response(`<a href="${pageUrl}">Track</a>`);
      if (url.includes('bandcamp.com/track/')) return new Response(page());
      return new Response(Buffer.alloc(4096, 12), { headers: { 'content-type': 'audio/mpeg' } }); }, ...options });
  return { source, calls, file, advance: ms => { now += ms; } };
}
test("exact recording requires credits, version, duration and corroborating release", () => {
  const candidate = parseTrackPage(page(), pageUrl); assert.ok(exactRecording(track, candidate));
  for (const bad of [{ artist: "Different Artist" }, { title: "Test (Radio Edit)" }, { durationMs: 290000 }, { album: "Other" }, { artist: "Example Artist, Extra" }]) {
    assert.equal(exactRecording(track, { ...candidate, ...bad }), false, JSON.stringify(bad));
  }
  assert.throws(() => parseTrackPage('<html>changed</html>', pageUrl), { code: 'FORMAT_CHANGED' });
});
test("eligibility fails closed before any Bandcamp request", async t => {
  for (const proof of [{}, { tidalAvailable: true }, { tidalAvailable: false, roonQueueable: true }]) {
    const { source, calls } = fixture(t, { verifyEligibility: async () => proof });
    await assert.rejects(source.acquire(track)); assert.equal(calls.length, 0);
  }
});
test("one stream attempt is persisted across restart and signed URL never reaches reports", async t => {
  const { source, calls, file } = fixture(t); const result = await source.acquire(track);
  assert.equal(result.buffer.length, 4096); assert.equal(calls.length, 3);
  source.record(track, "ANALYZED", { sourceTrackId: result.source.id, sourcePage: result.source.pageUrl });
  const restarted = new BandcampAnalysisSource({ file, fetchImpl: () => { throw Error('must not fetch'); } });
  await assert.rejects(restarted.acquire(track), { code: 'ALREADY_ATTEMPTED' });
  assert.doesNotMatch(JSON.stringify(restarted.report([track])) + fs.readFileSync(file), /token=secret|streamUrl/);
  assert.equal(restarted.report([track]).items[0].code, 'ANALYZED');
});
test("provider 429 honors Retry-After across restart; 403 stays an unspecified denial", async t => {
  for (const status of [429, 403, 401]) {
    const { source, file } = fixture(t, { fetchImpl: async () => new Response('', { status, headers: { 'retry-after': '172800' } }) });
    await assert.rejects(source.acquire(track), { code: status === 429 ? 'RATE_LIMIT' : 'ACCESS_DENIED' });
    assert.ok(Date.parse(source.status().cooldownUntil) >= 2000000000000 + 172800000);
    const restarted = new BandcampAnalysisSource({ file, clock: source.clock });
    await assert.rejects(restarted.request(pageUrl), { code: 'COOLDOWN' });
    if (status !== 429) assert.match(source.report([track]).items[0].message, /reason is not confirmed/);
  }
});
test("missing stream, purchase limit and challenge have distinct safe diagnostics", async t => {
  for (const [code, response] of [['NO_STREAM', new Response(page({ ...data, trackinfo: [{ ...data.trackinfo[0], file: null }] }))],
    ['PLAY_LIMIT', new Response('', { status: 402 })], ['CHALLENGE', new Response('Please verify you are human')]]) {
    let count = 0; const { source } = fixture(t, { fetchImpl: async () => ++count === 1 && code === 'NO_STREAM' ? new Response(`<a href="${pageUrl}">x</a>`) : response });
    await assert.rejects(source.acquire(track), { code }); assert.equal(source.status().streamAttemptsLast24h, 0);
  }
});
test("local budget and permanent stream history are independent from provider quota", async t => {
  const { source, calls } = fixture(t); source.state.requests = Array(POLICY.requestsPerDay).fill(source.clock());
  await assert.rejects(source.acquire(track), { code: 'LOCAL_BUDGET' }); assert.equal(calls.length, 0);
  assert.equal(source.status().providerQuotaRemaining, null);
});
test("redirects and unsafe destinations are never followed; bytes are bounded", async t => {
  for (const url of ['http://example.bandcamp.com/track/x', 'https://bandcamp.com.evil.test/x', 'https://127.0.0.1/x', 'https://a.bcbits.com@evil.test/x']) {
    assert.throws(() => checkedUrl(url, 'page'), { code: 'UNSAFE_URL' });
  }
  const redirect = fixture(t, { fetchImpl: async (_, init) => { assert.equal(init.redirect, 'manual'); return new Response('', { status: 302, headers: { location: 'http://127.0.0.1' } }); } });
  await assert.rejects(redirect.source.acquire(track), { code: 'UNSAFE_URL' });
  const big = fixture(t, { fetchImpl: async () => new Response('x', { headers: { 'content-length': String(POLICY.maxPageBytes + 1) } }) });
  await assert.rejects(big.source.acquire(track), { code: 'AUDIO_LIMIT' });
});
test("network failures are sanitized and negatively cached without repeating requests", async t => {
  let requests = 0; const { source } = fixture(t, { fetchImpl: async () => { requests++; throw Error('https://secret.test/token=private'); } });
  await assert.rejects(source.acquire(track), { code: 'NETWORK_ERROR' }); await assert.rejects(source.acquire(track), { code: 'NETWORK_ERROR' });
  assert.equal(requests, 1); assert.doesNotMatch(JSON.stringify(source.report([track])), /secret|private/);
});
test("corrupt safety history disables requests", async t => {
  const { file } = fixture(t); fs.writeFileSync(file, '{broken'); let calls = 0;
  const source = new BandcampAnalysisSource({ file, fetchImpl: () => calls++ });
  await assert.rejects(source.acquire(track), { code: 'STATE_UNAVAILABLE' }); assert.equal(calls, 0);
});
test("eligibility resolves an exact Roon action, removes token, and never executes playback", async () => {
  const tokens = new Map([['temporary', {}]]); let calls = 0;
  const verify = createBandcampEligibility({ tidal: { countryCode: 'US', streamingAvailability: async () => ({ available: true }) },
    zoneId: () => 'zone', roon: { exactQueueActions: tokens, canQueueTrack: async (input, zone, options) => {
      calls++; assert.equal(input.tidalTrackId, '123'); assert.equal(zone, 'zone'); assert.equal(options.exactVerification, true);
      return { success: true, identityEvidence: { accepted: true }, queueToken: 'temporary' };
    } } });
  assert.equal((await verify(track)).roonQueueable, true); assert.equal(calls, 1); assert.equal(tokens.size, 0);
});
test("separate TIDAL version field is included in the strict Roon lookup", async () => {
  let observed;
  const verify = createBandcampEligibility({ tidal: { streamingAvailability: async () => ({ available: true }) }, zoneId: () => 'z',
    roon: { canQueueTrack: async t => { observed = t; return { success: true, identityEvidence: { accepted: true } }; } } });
  await verify({ ...track, title: 'Test', version: 'Extended Mix' }); assert.equal(observed.title, 'Test (Extended Mix)');
});
test("ambiguous matches do not fetch audio", async t => {
  const { source } = fixture(t, { fetchImpl: async url => {
    if (url.includes('/search?')) return new Response(`<a href="${pageUrl}">x</a><a href="https://other.bandcamp.com/track/test">y</a>`);
    return new Response(page({ ...data, trackinfo: [{ ...data.trackinfo[0], track_id: url.includes('other.') ? 46 : 45 }] }));
  } });
  await assert.rejects(source.acquire(track), { code: 'AMBIGUOUS' }); assert.equal(source.status().streamAttemptsLast24h, 0);
});
test("a failed stream is not retried even for a different TIDAL release after the negative cache expires", async t => {
  let streams = 0; const { source, advance } = fixture(t, { fetchImpl: async url => {
    if (url.includes('/search?')) return new Response(`<a href="${pageUrl}">x</a>`);
    if (url.includes('bandcamp.com/track/')) return new Response(page());
    streams++; throw Error('connection lost');
  } });
  await assert.rejects(source.acquire(track), { code: 'NETWORK_ERROR' }); advance(2 * 86400000);
  await assert.rejects(source.acquire({ ...track, tidalId: '124' }), { code: 'ALREADY_ATTEMPTED' }); assert.equal(streams, 1);
});
test("one active fallback admits no concurrent provider traffic", async t => {
  let release; const { source, calls } = fixture(t, { verifyEligibility: () => new Promise(r => { release = r; }) });
  const pending = source.acquire(track); await assert.rejects(source.acquire({ ...track, tidalId: '124' }), { code: 'BUSY' });
  release({}); await assert.rejects(pending, { code: 'TIDAL_UNAVAILABLE' }); assert.equal(calls.length, 0);
});
test("regional TIDAL availability requires explicit STREAM and the same ID", async () => {
  const t = new TidalVerifier({ countryCode: 'US' });
  for (const [data, expected] of [[{ id: '123', attributes: { availability: ['STREAM'] } }, true],
    [{ id: '124', attributes: { availability: ['STREAM'] } }, false], [{ id: '123', attributes: {} }, false]]) {
    t.fetchTidalJson = async url => { assert.match(url, /countryCode=US/); return { data }; };
    assert.equal((await t.streamingAvailability('123')).available, expected);
  }
});
test("engine fallback happens only for an acquisition miss and preserves canonical identity", async t => {
  const { source } = fixture(t); let analyzed = 0, bytes;
  const engine = Object.create(RecommendationEngineV2.prototype);
  engine.bandcamp = source; engine.resolveTidalTrackReference = async () => track; engine.findStoredSonicProfile = () => null;
  engine.analyzeBeatportSource = async () => { throw Object.assign(Error('missing'), { bandcampEligible: true }); };
  const result = await engine.analyzeBeatportPreviewForTidalTrack(track, { analysisHandler: async (buffer, canonical, options) => {
    analyzed++; bytes = buffer; assert.equal(canonical.identityKey, 'tidal:123'); assert.equal(options.metadata.sourceTrackId, '45');
    assert.doesNotMatch(JSON.stringify(options), /token=secret/); return { prepared: true };
  } });
  assert.equal(result.sourceProvider, 'bandcamp'); assert.equal(analyzed, 1); assert.ok(bytes.every(b => b === 0));
  engine.analyzeBeatportSource = async () => { throw Object.assign(Error('429'), { statusCode: 429, beatportAcquisition: true }); };
  await assert.rejects(engine.analyzeBeatportPreviewForTidalTrack(track), /429/); assert.equal(analyzed, 1);
});
test("discovery diagnostics retain per-track restrictions without modifying scores", t => {
  const { source, file } = fixture(t); source.record(track, 'NO_STREAM');
  const store = new DiscoveryDiagnosticsStore({ file: path.join(path.dirname(file), 'reports.json') });
  store.sourceDiagnostics = tracks => source.report(tracks);
  const result = store.record({}, { tracks: [{ ...track, score: 72 }] });
  assert.equal(result.tracks[0].score, 72); assert.equal(result.bandcampDiagnostics.items[0].code, 'NO_STREAM');
  assert.equal(store.get({ runId: result.discoveryRunId }).bandcamp.items[0].code, 'NO_STREAM');
});
