const test = require('node:test');
const assert = require('node:assert/strict');
const { RoonClient } = require('../src/roonClient');
const { DirectRoonQueue } = require('../src/directRoonQueue');
const { resolveVerifiedTracksForRoon } = require('../src/roonExactResolution');

function fixture({ title = 'Tranquilo', wrong = 'Tranquilo (Franco Giannoni Remix)', contained = title, albumTitle = 'Tranquilo', albumArtist = '[[836218|Hernan Cattaneo]]', absent = false, albumCount = 1, wrapped = false, manyTracks = false, discTrackPrefix = '' } = {}) {
  const roon = new RoonClient(); roon.transport = {}; roon.zones.set('z', { zone_id: 'z' });
  const sessions = new Map(), writes = [], opens = [];
  const state = args => { if (!sessions.has(args.multi_session_key)) sessions.set(args.multi_session_key, { stack: ['root'], keys: new Map(), generation: 0 }); return sessions.get(args.multi_session_key); };
  roon.browse = {
    browse(args, cb) {
      const s = state(args);
      if (args.pop_all) s.stack = ['root'];
      else if (args.pop_levels) s.stack.splice(-args.pop_levels);
      else if (args.item_key) {
        const key = s.keys.get(args.item_key);
        if (!key) return cb('Stale browse key');
        opens.push(key);
        if (key === 'queue') writes.push(key);
        else s.stack.push(key);
      }
      s.keys.clear(); cb(null, {});
    },
    load(args, cb) {
      const s = state(args), page = s.stack.at(-1); s.generation++;
      const row = (key, title, subtitle, hint = 'list') => { const handle = `${s.generation}:${key}`; s.keys.set(handle, key); return { item_key: handle, title, subtitle, hint }; };
      s.keys.clear(); let items = [];
      if (page === 'root') items = [row('tracks', 'Tracks', '1 Result'), row('albums', 'Albums', '1 Result')];
      else if (page === 'tracks') items = [row('wrong', wrong, 'Hernán Cattáneo', 'action_list')];
      else if (page === 'albums') items = Array.from({ length: albumCount }, (_, i) => row(`album${i}`, albumTitle, albumArtist, 'album'));
      else if (/^album\d+$/.test(page)) items = wrapped ? [row('albumVersion', albumTitle, albumArtist)] : [row('queueAlbum', 'Queue', '', 'action'), row('albumTracks', 'Tracks', '')];
      else if (page === 'albumVersion') items = [row('queueAlbum', 'Play Album', '', 'action_list'), row('right', `${discTrackPrefix || '1. '}${contained}`, 'Hernán Cattáneo', 'action_list'), row('wrong', `2. ${wrong}`, 'Hernán Cattáneo', 'action_list')];
      else if (page === 'albumTracks') items = manyTracks ? [...Array.from({length:100},(_,i)=>row(`wrong${i}`, `${i+1}. ${wrong}`, 'Hernán Cattáneo', 'action_list')),row('right',`101. ${contained}`,'Hernán Cattáneo','action_list')] : [row('wrong', wrong, 'Hernan Cattaneo', 'action_list'), ...(!absent ? [row('right', `${discTrackPrefix}${contained}`, '7:45', 'action_list')] : [])];
      else if (page === 'right') items = [row('queue', 'Queue', '', 'action')];
      cb(null, { items: items.slice(0, args.count) });
    }
  };
  return { roon, writes, opens, track: { artist: 'Hernán Cattáneo', title } };
}

test('shared resolver traverses fresh album handles and track submenu, never album queue action', async () => {
  const { roon, track, writes, opens } = fixture();
  const r = await roon.canQueueTrack(track, 'z');
  assert.equal(r.success, true); assert.equal(r.match.title, 'Tranquilo');
  assert.equal(r.resolutionMethod, 'album_track_fallback'); assert.equal(r.match.album, 'Tranquilo');
  assert.equal(r.albumFallback.roonAlbumFallbackResolved, 1); assert.ok(opens.includes('albumTracks'));
  assert.deepEqual(writes, []); assert.ok(!opens.includes('queueAlbum'));
});
test('direct search and queue share the album-resolved action', async () => {
  const { roon, track, writes } = fixture(); const service = new DirectRoonQueue(roon);
  const search = await service.search({ ...track, zoneId: 'z' });
  assert.equal(search.queueable, true); assert.equal(search.resolutionMethod, 'album_track_fallback');
  const r = await service.queue({ tracks: [{ ...track, queueToken: search.queueToken }], zoneId: 'z' });
  assert.equal(r.queued, 1); assert.equal(r.results[0].resolvedTitle, 'Tranquilo');
  assert.equal(r.results[0].resolutionMethod, 'album_track_fallback'); assert.deepEqual(writes, ['queue']);
});
test('internal saved TIDAL exact resolution uses the same album fallback', async () => {
  const { roon, track, writes } = fixture();
  const result = { tracks: [{ tidal: { verified: true }, usable: true, tidalTrackId: '123', track, roon: {} }] };
  await resolveVerifiedTracksForRoon(result, { zoneId: 'z', retries: 0 }, { roon });
  assert.equal(result.tracks[0].status, 'ROON_QUEUEABLE');
  assert.equal(result.tracks[0].roon.resolutionMethod, 'album_track_fallback'); assert.deepEqual(writes, []);
});
for (const version of ['Extended Mix', 'Original Mix']) test(`${version} is found in album after wrong direct version`, async () => {
  const { roon, track } = fixture({ title: `Tranquilo (${version})`, wrong: 'Tranquilo (Radio Edit)' });
  const r = await roon.canQueueTrack({ ...track, exactVerification: true }, 'z', { exactVerification: true });
  assert.equal(r.success, true); assert.equal(r.match.title, track.title);
});
test('matching album without requested version stays unresolved and traversal is capped at three albums', async () => {
  const { roon, track, writes } = fixture({ absent: true, albumCount: 5 });
  const r = await roon.canQueueTrack(track, 'z', { matchPolicy: 'strict' });
  assert.equal(r.success, false); assert.equal(r.albumFallback.albumCandidatesInspected, 3);
  assert.equal(r.albumFallback.roonAlbumFallbackFailed, 1); assert.deepEqual(writes, []);
});
test('conflicting album artist is never opened', async () => {
  const { roon, track, opens } = fixture({ albumArtist: 'Unrelated Artist' });
  const r = await roon.canQueueTrack(track, 'z', { matchPolicy: 'strict' });
  assert.equal(r.success, false); assert.equal(r.albumFallback.albumCandidatesInspected, 0);
  assert.ok(!opens.includes('album0'));
});
test('live Roon shape: linked artist, same-title album wrapper and numbered track rows', async () => {
  const { roon, track, opens } = fixture({ wrapped: true });
  const r = await roon.canQueueTrack({ ...track, exactVerification: true }, 'z');
  assert.equal(r.success, true); assert.equal(r.match.title, 'Tranquilo');
  assert.equal(r.resolutionMethod, 'album_track_fallback'); assert.ok(opens.includes('albumVersion'));
  assert.ok(!opens.includes('queueAlbum'));
});
test('album fallback strips Roon disc-track prefixes like 2-2 from strict title matching', async () => {
  const { roon, opens } = fixture({
    title: 'Immensity (Extended Mix)',
    contained: 'Immensity (Extended Mix)',
    albumTitle: 'Favourite Colours EP',
    albumArtist: '[[17319774|M.O.S.]]',
    discTrackPrefix: '2-2 '
  });
  const track = { artist: 'M.O.S.', title: 'Immensity (Extended Mix)', album: 'Favourite Colours EP' };
  const r = await roon.canQueueTrack({ ...track, exactVerification: true }, 'z', { exactVerification: true, matchPolicy: 'strict' });
  assert.equal(r.success, true); assert.equal(r.match.title, 'Immensity (Extended Mix)');
  assert.equal(r.match.roonDisplayTitle, '2-2 Immensity (Extended Mix)');
  assert.equal(r.resolutionMethod, 'album_track_fallback'); assert.ok(opens.includes('albumTracks'));
});
test('100-track inspection cap is enforced without accepting a remix', async () => {
  const { roon, track, writes } = fixture({ manyTracks: true });
  const r = await roon.canQueueTrack({ ...track, exactVerification: true }, 'z');
  assert.equal(r.success, false); assert.equal(r.albumFallback.tracksInspected, 100); assert.deepEqual(writes, []);
});
test('parent cancellation interrupts album loading without later browse actions', async () => {
  const { roon, track, opens } = fixture();
  const load = roon.browse.load;
  const controller = new AbortController();
  roon.browse.load = (args, cb) => {
    if (args.multi_session_key.startsWith('album-fallback-')) { controller.abort(); return; }
    load(args, cb);
  };
  await assert.rejects(roon.canQueueTrack({ ...track, exactVerification: true }, 'z', { signal: controller.signal }));
  assert.ok(!opens.includes('album0'));
});
