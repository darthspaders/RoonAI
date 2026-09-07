const test = require('node:test');
const assert = require('node:assert/strict');
const { DirectRoonQueue, identity, validate } = require('../src/directRoonQueue');
const { RoonClient } = require('../src/roonClient');
const { createRabbitHoleMcpTools } = require('../src/mcpHttpServer');

test('structured-only validation rejects entire malformed batch before writing', () => {
  assert.throws(() => validate({ tracks: 'Artist - Title' }), /structured/);
  assert.throws(() => validate({ tracks: [{ artist: 'Artist', title: 'Title' }, 'Other - Song'] }), /object/);
  assert.throws(() => validate({ tracks: [{ title: 'Title' }] }), /artist/);
});
test('flexible identity normalizes accents, punctuation, artist order and additional credits', () => {
  assert.ok(identity({ artist: 'Hernán Cattáneo & M.O.S.', title: 'Tranquilo' }, { title: 'Tranquilo', subtitle: 'MOS, Hernan Cattaneo, Soundexile' }).accepted);
  assert.ok(!identity({ artist: 'Hernan Cattaneo, MOS', title: 'Tranquilo' }, { title: 'Tranquilo', subtitle: 'MOS' }).accepted);
});
test('missing generic suffix requires strong identity while named remix remains strict', () => {
  const track = { artist: 'M.O.S.', title: 'Immensity (Extended Mix)', tidalTrackId: '123' };
  assert.ok(!identity(track, { artist: 'MOS', title: 'Immensity' }).accepted);
  assert.ok(identity(track, { artist: 'MOS', title: 'Immensity', tidalTrackId: '123' }).accepted);
  assert.ok(!identity(track, { artist: 'MOS', title: 'Immensity', tidalTrackId: '123' }, 'strict').accepted);
  assert.ok(identity(track, { artist: 'MOS', title: 'Immensity', version: 'Extended Mix' }, 'strict').accepted);
  assert.ok(!identity({ artist: 'Fluke', title: 'Bullet (Nick Warren & Nicolas Rada Remix)' }, { artist: 'Fluke', title: 'Bullet (Original Mix)' }, 'strict').accepted);
  assert.ok(!identity(track, { artist: 'MOS', title: track.title, tidalTrackId: '999' }).accepted);
});
function fakeClient() {
  const roon = Object.create(RoonClient.prototype);
  roon.getZone = () => ({ settings: {} }); roon.zoneOrOutputId = () => 'zone';
  roon.emit = () => {};
  const actions = [];
  roon.browse = { browse(args, cb) { actions.push(args.item_key); cb(null, { action: 'message', message: 'Queued' }); } };
  roon.resolveSearchAction = async track => track.title === 'Missing'
    ? { success: false, failureType: 'not_found', reason: 'Not found' }
    : { success: true, match: { title: track.title, subtitle: track.artist, item_key: track.title },
      playable: { item_key: track.title, title: 'Queue' }, session: track.title, identityEvidence: { confidence: .96 }, attempts: [{ query: `${track.artist} ${track.title}` }] };
  return { roon, actions };
}
test('direct wrapper reuses real bulk/perform path and isolates failures with original indices', async () => {
  const { roon, actions } = fakeClient(); const service = new DirectRoonQueue(roon);
  const tracks = ['Whispers in the Wind (Extended Mix)', 'Missing', 'Tranquilo'].map(title => ({ artist: 'Artist', title }));
  const result = await service.queue({ tracks, zoneId: 'zone' });
  assert.equal(result.queued, 2); assert.equal(result.failed, 1);
  assert.equal(result.results[1].status, 'NOT_FOUND');
  assert.deepEqual(actions, [tracks[0].title, tracks[2].title]);
});
test('Add Next preserves 101-track input order across 50-track chunks', async () => {
  const { roon, actions } = fakeClient(); const service = new DirectRoonQueue(roon);
  const tracks = Array.from({ length: 101 }, (_, index) => ({ artist: 'Artist', title: String(index) }));
  const result = await service.queue({ tracks, zoneId: 'zone', mode: 'next' });
  assert.equal(result.queued, 101);
  assert.deepEqual(actions, tracks.map(t => t.title).reverse());
  assert.deepEqual(result.results.map(r => r.requestedTitle), tracks.map(t => t.title));
});
test('search caches an expiring action, queue uses it once without another search', async () => {
  const { roon, actions } = fakeClient(); let searches = 0;
  const resolve = roon.resolveSearchAction; roon.resolveSearchAction = (...args) => { searches++; return resolve(...args); };
  const service = new DirectRoonQueue(roon); const track = { artist: 'Das Pharaoh', title: 'Whispers in the Wind (Extended Mix)' };
  const search = await service.search({ ...track, zoneId: 'zone' });
  assert.ok(search.queueToken); assert.equal(actions.length, 0);
  const result = await service.queue({ tracks: [{ ...track, queueToken: search.queueToken }], zoneId: 'zone' });
  assert.equal(result.queued, 1); assert.equal(searches, 1); assert.equal(actions.length, 1);
  assert.equal(roon.hasVerifiedQueueAction(search.queueToken), false);
});
test('queue transport failures are not retried and later tracks continue', async () => {
  const { roon } = fakeClient(); let writes = 0;
  roon.browse.browse = (args, cb) => { writes++; cb(writes === 1 ? 'Disconnected' : null, {}); };
  const result = await new DirectRoonQueue(roon).queue({ tracks: [{ artist: 'A', title: 'One' }, { artist: 'A', title: 'Two' }], zoneId: 'zone' });
  assert.equal(writes, 2); assert.equal(result.queued, 1); assert.equal(result.results[0].status, 'QUEUE_FAILED');
  assert.equal(result.resolved, 2);
});
test('MCP direct queue sends only structured payload to direct endpoint', async () => {
  const calls = [];
  const tools = createRabbitHoleMcpTools({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, text: async () => JSON.stringify(url.endsWith('/api/status') ? { zones: [{ zone_id: 'z', state: 'playing' }] } : { queued: 1 }) };
  } });
  const tracks = [{ artist: 'A', title: 'Title; this punctuation stays' }];
  const result = await tools.roon_queue_tracks.handler({ tracks });
  assert.equal(result.queued, 1);
  assert.ok(calls[1].url.endsWith('/api/roon/direct/queue'));
  assert.deepEqual(JSON.parse(calls[1].options.body), { tracks, zoneId: 'z' });
  assert.equal(calls.length, 2);
});

test('known TIDAL identity supplies saved metadata without replacing requested artist/title', () => {
  const service = new DirectRoonQueue({}, () => {}, () => [{ id: '123', artist: 'Saved', title: 'Saved title', isrc: 'ISRC', album: 'Album', durationMs: 480000 }]);
  assert.deepEqual(service.enrich({ artist: 'Requested', title: 'Exact version', tidalTrackId: '123' }),
    { artist: 'Requested', title: 'Exact version', tidalTrackId: '123', isrc: 'ISRC', album: 'Album', durationMs: 480000 });
});

test('real resolver accepts separately exposed version and rejects ambiguous recording IDs', async () => {
  const { roon } = fakeClient();
  roon.resolveSearchAction = RoonClient.prototype.resolveSearchAction;
  roon.browse.browse = (args, cb) => cb(null, {});
  roon.findPlayableAction = async () => ({ items: [], playable: { item_key: 'queue', title: 'Queue' } });
  const item = { title: 'Immensity', version: 'Extended Mix', artist: 'MOS', item_key: 'track', tidalTrackId: '123' };
  roon.search = async () => ({ match: item, candidates: [item], verified: true, session: 'search' });
  const request = { artist: 'M.O.S.', title: 'Immensity (Extended Mix)', directMatchPolicy: 'strict' };
  assert.ok((await roon.resolveSearchAction(request, 'zone', 'queue', { matchPolicy: 'strict' })).success);
  roon.search = async () => ({ match: item, candidates: [item, { ...item, tidalTrackId: '456', item_key: 'other' }], verified: true, session: 'search' });
  assert.equal((await roon.resolveSearchAction(request, 'zone', 'queue', { matchPolicy: 'strict' })).failureType, 'ambiguous');
  assert.ok((await roon.resolveSearchAction({ ...request, tidalTrackId: '123' }, 'zone', 'queue', { matchPolicy: 'strict' })).success);
});

test('queue inspection reports unavailable or truncated subscription honestly', async () => {
  const tools = createRabbitHoleMcpTools({ fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ zones: [
    { zone_id: 'z', state: 'playing', queue_items_remaining: 84, queue_time_remaining: 900, queue: { updatedAt: 1, items: [{ title: 'Song - Artist', subtitle: 'Artist', length: 500 }] } }
  ] }) }) });
  const result = await tools.roon_get_queue.handler({});
  assert.equal(result.queuedCount, 84); assert.equal(result.truncated, true); assert.equal(result.tracks[0].title, 'Song');
});
