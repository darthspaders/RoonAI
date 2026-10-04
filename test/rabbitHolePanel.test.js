const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const panelSource = source.slice(source.indexOf('function setRabbitHolePanelOpen('), source.indexOf('function scrollToDiscoveryTrack('));
const bindingSource = source.slice(source.indexOf('function bindRabbitHolePanel('), source.indexOf('\nbindRabbitHolePanel();'));
const renderingSource = source.slice(source.indexOf('function updateNowDiscoveryTools('), source.indexOf('function setFeedbackButtonsActive('));
const navigationSource = source.slice(source.indexOf('$("#rabbitHolePanel").addEventListener("click", async (event) => {'), source.indexOf('\n$("#bridgeSyncDismiss")'));

function fixture() {
  const elements = new Map();
  const document = { activeElement: null, querySelector: () => elements.get('.player'), getElementById: id => elements.get(`#${id}`) };
  for (const id of ['#rabbitHolePanel', '#rabbitHoleContent', '#openRabbitHole', '#closeRabbitHole', '#nowDiscoveryTools', '#nowFeedback', '#nowDiscoveryBadge', '#request', '#track-0', '.player']) {
    const element = {
      hidden: id === '#rabbitHolePanel', disabled: false, innerHTML: '', dataset: {},
      attributes: {}, listeners: {}, scrolls: 0,
      setAttribute(key, value) { this.attributes[key] = value; },
      focus() { document.activeElement = this; },
      closest() { return null; },
      scrollIntoView() { this.scrolls += 1; },
      addEventListener(name, listener) { this.listeners[name] = listener; }
    };
    elements.set(id, element);
  }
  const context = {
    document,
    $: selector => elements.get(selector),
    state: { nowTrack: { id: 'exact-track' }, playerMaximized: false, lastTracks: [] },
    calls: [], full: false,
    trackKeyFor: track => track.id,
    rabbitHoleContextTracks: () => [],
    rabbitHoleGraphHtml: graph => graph.html,
    cleanRenderedArtifacts() {},
    escapeHtml: text => String(text).replace(/</g, '&lt;'),
    api: async () => ({ html: 'Graph loaded' }),
    findNowPlayingMatch: () => ({ index: -1, track: null, source: '' }),
    renderNowTidalPlaylistControl() {},
    setRabbitPrompt: text => { elements.get('#request').value = text; },
    runRabbitPrompt: text => { elements.get('#request').value = text; context.calls.push(['run', text]); },
    jumpToTrackIdentity: track => { context.calls.push(['jump', track.id]); return true; },
    rabbitHoleTextFor: track => track.artist
  };
  context.playerFullscreenElement = () => context.full ? elements.get('.player') : null;
  context.setPlayerFullWindow = async value => { context.calls.push(['fullscreen', value]); context.full = value; };
  context.setPlayerMaximized = value => { context.calls.push(['maximized', value]); context.state.playerMaximized = value; };
  vm.createContext(context);
  vm.runInContext(panelSource + '\n' + bindingSource + '\n' + renderingSource, context);
  context.bindRabbitHolePanel();
  vm.runInContext(navigationSource, context);
  return { context, elements };
}

function graphClick(elements, selector, dataset) {
  return elements.get('#rabbitHolePanel').listeners.click({ target: { closest: match => match === selector ? { dataset } : null } });
}

test('a missing now-playing track does not open or request a graph', () => {
  const { context: c, elements: e } = fixture();
  c.state.nowTrack = null;
  c.api = () => { throw new Error('Unexpected request'); };
  e.get('#openRabbitHole').listeners.click();
  assert.equal(e.get('#rabbitHolePanel').hidden, true);
});

test('closing a pending graph request keeps the panel closed when it completes', async () => {
  const { context: c, elements: e } = fixture();
  let finish;
  c.api = () => new Promise(resolve => { finish = resolve; });
  c.setRabbitHolePanelOpen(true);
  const request = c.loadRabbitHole(c.state.nowTrack);
  e.get('#closeRabbitHole').listeners.click();
  finish({ html: 'Late graph' });
  await request;
  assert.equal(e.get('#rabbitHolePanel').hidden, true);
  assert.equal(e.get('#openRabbitHole').attributes['aria-expanded'], 'false');
  assert.equal(c.document.activeElement, e.get('#openRabbitHole'));
  assert.equal(e.get('#rabbitHoleContent').innerHTML, 'Late graph');
});

test('reopening the same exact track displays its cached graph without another request', async () => {
  const { context: c, elements: e } = fixture();
  let requests = 0;
  c.api = async () => { requests += 1; return { html: 'Cached graph' }; };
  await c.loadRabbitHole(c.state.nowTrack);
  c.setRabbitHolePanelOpen(false);
  c.setRabbitHolePanelOpen(true);
  await c.loadRabbitHole(c.state.nowTrack);
  assert.equal(requests, 1);
  assert.equal(e.get('#rabbitHoleContent').innerHTML, 'Cached graph');
  assert.equal(e.get('#openRabbitHole').attributes['aria-expanded'], 'true');
});

test('graph errors stay visible and escaped while the close control remains usable', async () => {
  const { context: c, elements: e } = fixture();
  c.api = async () => { throw new Error('<Unavailable>'); };
  c.setRabbitHolePanelOpen(true);
  await c.loadRabbitHole(c.state.nowTrack);
  assert.equal(e.get('#rabbitHolePanel').hidden, false);
  assert.match(e.get('#rabbitHoleContent').innerHTML, /&lt;Unavailable>/);
  e.get('#closeRabbitHole').listeners.click();
  assert.equal(e.get('#rabbitHolePanel').hidden, true);
});

test('loss of the now-playing track closes the region and resets disclosure state', () => {
  const { context: c, elements: e } = fixture();
  c.setRabbitHolePanelOpen(true);
  c.updateNowDiscoveryTools({});
  assert.equal(e.get('#rabbitHolePanel').hidden, true);
  assert.equal(e.get('#openRabbitHole').attributes['aria-expanded'], 'false');
  assert.equal(e.get('#openRabbitHole').disabled, true);
  assert.equal(e.get('#nowDiscoveryTools').hidden, true);
  assert.notEqual(c.document.activeElement, e.get('#openRabbitHole'));
});

test('Discovery navigation waits for native fullscreen exit before dismissing maximized mode', async () => {
  const { context: c, elements: e } = fixture();
  c.full = true;
  c.state.playerMaximized = true;
  c.setRabbitHolePanelOpen(true);
  let finish;
  c.setPlayerFullWindow = () => new Promise(resolve => { finish = resolve; });
  const navigation = c.leaveRabbitHolePlayer();
  assert.equal(e.get('#rabbitHolePanel').hidden, true);
  assert.equal(c.state.playerMaximized, true);
  finish();
  await navigation;
  assert.equal(c.state.playerMaximized, false);
  assert.deepEqual(c.calls, [['maximized', false]]);
});

test('regular-mode graph navigation leaves fullscreen and maximized settings alone', async () => {
  const { context: c } = fixture();
  await c.leaveRabbitHolePlayer();
  assert.deepEqual(c.calls, []);
});

test('Explore focuses the populated composer after leaving expanded player modes', async () => {
  const { context: c, elements: e } = fixture();
  c.full = true;
  c.state.playerMaximized = true;
  c.setRabbitHolePanelOpen(true);
  await graphClick(e, '[data-rabbit-prompt]', { rabbitPrompt: 'Explore Artist' });
  assert.equal(e.get('#rabbitHolePanel').hidden, true);
  assert.equal(c.full, false);
  assert.equal(c.state.playerMaximized, false);
  assert.equal(e.get('#request').value, 'Explore Artist');
  assert.equal(c.document.activeElement, e.get('#request'));
});

test('Run Discovery preserves its exact prompt and moves focus to the composer', async () => {
  const { context: c, elements: e } = fixture();
  c.setRabbitHolePanelOpen(true);
  await graphClick(e, '[data-rabbit-run]', { rabbitRun: 'Exact graph prompt' });
  assert.deepEqual(c.calls, [['run', 'Exact graph prompt']]);
  assert.equal(c.document.activeElement, e.get('#request'));
});

test('an exact local graph track focuses its result after fullscreen navigation', async () => {
  const { context: c, elements: e } = fixture();
  c.full = true;
  c.state.playerMaximized = true;
  c.state.lastTracks = [{ id: 'exact-identity' }];
  await graphClick(e, '[data-rabbit-node]', { rabbitNode: JSON.stringify({ type: 'track', track: { id: 'exact-identity' } }) });
  assert.equal(c.document.activeElement, e.get('#track-0'));
  assert.equal(e.get('#track-0').attributes.tabindex, '-1');
  assert.deepEqual(c.calls, [['fullscreen', false], ['maximized', false], ['jump', 'exact-identity']]);
});

test('external TIDAL track links execute before an asynchronous fullscreen exit', async () => {
  const { context: c, elements: e } = fixture();
  c.full = true;
  c.state.playerMaximized = true;
  c.setRabbitHolePanelOpen(true);
  const pending = graphClick(e, '[data-rabbit-node]', { rabbitNode: JSON.stringify({ type: 'track', track: { id: 'external-identity', tidalUrl: 'https://tidal.com/track/123' } }) });
  assert.deepEqual(c.calls, [['jump', 'external-identity']]);
  assert.equal(c.full, true);
  assert.equal(e.get('#rabbitHolePanel').hidden, false);
  await pending;
});
