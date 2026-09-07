const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const selection = source.slice(source.indexOf('function selectedNowTidalPlaylists()'), source.indexOf('function renderNowTidalPlaylistControl('));
const addition = source.slice(source.indexOf('async function addNowTrackToTidalPlaylist('), source.indexOf('function updateNowDiscoveryTools('));
function fixture() {
  const player = {};
  const status = {};
  const context = {
    state: { nowTrack: { artist: 'Artist', title: 'Original' }, extraTidalPlaylistIds: ['b', 'c'], nowTidalPlaylistArmed: [true, true, true], tidalPlaylists: ['a', 'b', 'c'].map(id => ({ id, title: id })) },
    full: true, calls: [],
    document: { querySelector: () => player },
    $: () => status,
    renderNowTidalPlaylistControl() {},
    confirm: () => false,
    alert: message => { throw new Error(message); },
  };
  context.selectedTidalPlaylist = () => context.state.tidalPlaylists[0];
  context.playerFullscreenElement = () => context.full ? player : null;
  context.api = async (url, request) => { context.calls.push(request); return { added: true }; };
  vm.createContext(context);
  vm.runInContext(selection + '\n' + addition, context);
  return { context, status };
}

test('extra destinations apply only in full screen and duplicate IDs coalesce', () => {
  const { context: c } = fixture();
  c.state.extraTidalPlaylistIds = ['a', 'b'];
  assert.equal(c.selectedNowTidalPlaylists().map(p => p.id).join(','), 'a,b');
  c.full = false;
  assert.equal(c.selectedNowTidalPlaylists().map(p => p.id).join(','), 'a');
});

test('disarmed fullscreen destinations stay loaded but are skipped', () => {
  const { context: c } = fixture();
  c.state.extraTidalPlaylistIds = ['b', 'c'];
  c.state.nowTidalPlaylistArmed = [true, false, true];
  assert.equal(c.selectedNowTidalPlaylists().map(p => p.id).join(','), 'a,c');
  c.state.nowTidalPlaylistArmed = [false, true, false];
  assert.equal(c.selectedNowTidalPlaylists().map(p => p.id).join(','), 'b');
});

test('one failed destination does not stop others and track identity is captured', async () => {
  const { context: c, status } = fixture();
  c.api = async (url, request) => {
    c.calls.push(request);
    c.state.nowTrack.title = 'Next song';
    if (request.playlistId === 'a') throw new Error('Unavailable');
    return { added: true };
  };
  await c.addNowTrackToTidalPlaylist();
  assert.equal(c.calls.length, 3);
  assert.ok(c.calls.every(r => r.track.title === 'Original'));
  assert.match(status.textContent, /Failed: a/);
  assert.match(status.textContent, /Added to b.*Added to c/);
  assert.equal(c.state.nowTidalAddBusy, false);
});

test('declining duplicate still adds to subsequent destinations', async () => {
  const { context: c, status } = fixture();
  c.api = async (url, request) => {
    c.calls.push(request);
    return request.playlistId === 'a' ? { duplicate: true, added: false } : { added: true };
  };
  await c.addNowTrackToTidalPlaylist();
  assert.equal(c.calls.length, 3);
  assert.match(status.textContent, /Already in a.*Added to b.*Added to c/);
});

test('double tap cannot start overlapping additions', async () => {
  const { context: c } = fixture();
  const first = c.addNowTrackToTidalPlaylist();
  const second = c.addNowTrackToTidalPlaylist();
  await Promise.all([first, second]);
  assert.equal(c.calls.length, 3);
});
