'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { candidates, resolve, probe, refresh } = require('./source-links.cjs');
const record = () => ({ id: 'nasa-science-42', presentationSha256: 'a'.repeat(64), stage: 'verified',
  sourceUrl: 'https://science.nasa.gov/image-detail/actual-recorded-url/?view=full',
  assetUrl: 'https://assets.science.nasa.gov/actual-recorded-image.png',
  apiUrl: 'https://science.nasa.gov/wp-json/wp/v2/media/42', aliases: ['science:42'] });
const html = (body = '<title>NASA science image</title>') => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });

test('joint-mission gallery provenance accepts only the explicit ESA archive hosts', async () => {
  const {official}=require('./source-links.cjs');
  for(const host of ['esahubble.org','cdn.esahubble.org','esawebb.org','cdn.esawebb.org'])assert.equal(official('https://'+host+'/images/example/'),'https://'+host+'/images/example/');
  for(const host of ['esawebb.org.evil.test','arbitrary.esawebb.org','example.org'])assert.equal(official('https://'+host+'/images/example/'),null);
  const row={...record(),sourceUrl:'https://esahubble.org/images/heic2007a/'};
  assert.equal((await resolve(row,{fetch:async()=>html()})).selected.url,row.sourceUrl);
});
test('prefers the recorded human source without changing meaningful URL components or original metadata', async () => {
  const row = record(), before = JSON.stringify(row), urls = [];
  const result = await resolve(row, { fetch: async url => { urls.push(url); return html(); } });
  assert.equal(result.selected.url, row.sourceUrl); assert.deepEqual(urls, [row.sourceUrl]); assert.equal(JSON.stringify(row), before);
});
test('NASA redirect to an actual 404 falls back to the recorded official image', async () => {
  const row = record(), calls = [];
  const result = await resolve(row, { fetch: async (url, options) => {
    calls.push({ url, method: options.method });
    if (url === row.sourceUrl) return new Response(null, { status: 301, headers: { location: '/images/' } });
    if (url.endsWith('/images/')) return new Response('Not found', { status: 404 });
    return new Response(null, { status: 200, headers: { 'content-type': 'image/png' } });
  } });
  assert.equal(result.selected.url, row.assetUrl); assert.equal(result.selected.kind, 'image');
  assert.equal(result.checks[0].state, 'missing'); assert.equal(calls.at(-1).method, 'HEAD');
});
test('recognizes soft 404 pages and prefers real page aliases before direct assets', async () => {
  const row = { ...record(), aliases: ['https://science.nasa.gov/actual-alternate-page/'] };
  const result = await resolve(row, { fetch: async url => url === row.sourceUrl ? html('<title>Page not found - NASA Science</title>') : html() });
  assert.equal(result.checks[0].soft404, true); assert.equal(result.selected.url, row.aliases[0]);
});
test('no title, ID, provider or filename is ever converted into a URL', () => {
  assert.deepEqual(candidates({ id: '42', nasaId: 'PIA13014', provider: 'images', title: 'Cosmic Cliffs', filename: 'anything.jpg', aliases: ['science:42'] }), []);
});
test('refuses third-party redirects and secret-bearing URLs', async () => {
  const row = { ...record(), aliases: ['https://evil.example/a'], apiUrl: 'https://api.nasa.gov/a?api_key=secret' };
  assert.equal(candidates(row).length, 2);
  let calls = 0;
  const result = await probe(row.sourceUrl, 'page', { fetch: async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://evil.example/a' } }); } });
  assert.equal(result.state, 'unsafe-redirect'); assert.equal(calls, 1);
});
test('missing preferred and fallback links yield no clickable decision', async () => {
  const result = await resolve(record(), { fetch: async () => new Response(null, { status: 404 }) });
  assert.equal(result.selected, null); assert.equal(result.state, 'unavailable');
});
test('rate limiting stops validation, rather than retrying another endpoint', async () => {
  let calls = 0;
  await assert.rejects(resolve(record(), { fetch: async () => { calls++; return new Response(null, { status: 429 }); } }), /backoff/);
  assert.equal(calls, 1);
});
test('valid receipt is reusable and bad/unavailable body is not mislabeled as an image', async () => {
  const result = await probe(record().assetUrl, 'image', { fetch: async () => html('<title>Error</title>') });
  assert.equal(result.state, 'wrong-content');
});
test('refresh uses existing per-record metadata and leaves it byte-for-byte unchanged', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'nasa-source-links-')); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const catalogHome = path.join(home, 'catalog'), row = record();
  const asset = path.join(catalogHome, 'assets', row.id); await fs.mkdir(asset, { recursive: true });
  const raw = JSON.stringify(row); await fs.writeFile(path.join(asset, 'metadata.json'), raw);
  await fs.writeFile(path.join(home, 'manifest.json'), JSON.stringify({ files: { image: { ids: [row.id] } } }));
  let calls = 0;
  const opts = { home, catalogHome, fetch: async () => { calls++; return html(); } };
  assert.equal((await refresh(opts)).processed, 1); assert.equal((await refresh(opts)).processed, 0); assert.equal(calls, 1);
  assert.equal(await fs.readFile(path.join(asset, 'metadata.json'), 'utf8'), raw);
  const receipts = JSON.parse(await fs.readFile(path.join(home, 'source-links.json')));
  assert.equal(receipts.records[row.id].selected.url, row.sourceUrl);
});
test('an unreadable receipt releases the validator lock without replacing provenance', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'nasa-source-lock-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const receipt = path.join(home, 'source-links.json');
  await fs.writeFile(receipt, '{interrupted');
  await assert.rejects(refresh({ home }));
  assert.equal(await fs.readFile(receipt, 'utf8'), '{interrupted');
  await assert.rejects(fs.stat(path.join(home, 'source-links.lock')), { code: 'ENOENT' });
});
test('interrupted revalidation cannot keep a previously valid but now missing URL clickable', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'nasa-source-revalidate-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const catalogHome = path.join(home, 'catalog'), row = record();
  const asset = path.join(catalogHome, 'assets', row.id); await fs.mkdir(asset, { recursive: true });
  await fs.writeFile(path.join(asset, 'metadata.json'), JSON.stringify(row));
  await fs.writeFile(path.join(home, 'manifest.json'), JSON.stringify({ files: { image: { ids: [row.id] } } }));
  await refresh({ home, catalogHome, fetch: async () => html() });
  let calls = 0;
  const result = await refresh({ home, catalogHome, force: true, fetch: async () => new Response(null, { status: 404 }),
    beforeRequest: async () => { if (++calls > 1) throw Error('source-link-budget'); } });
  assert.equal(result.deferred, 'source-link-budget');
  const receipts = JSON.parse(await fs.readFile(path.join(home, 'source-links.json')));
  assert.equal(receipts.records[row.id].selected, null);
  assert.equal(receipts.records[row.id].state, 'validating');
});
