'use strict';
// Shared source-link decisions only. Never edits catalog provenance or image assets.
const fs = require('node:fs/promises'), path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { read, atomic, noLinks, hash } = require('../soundspectrum-nasa-backgrounds/library.cjs');
const HOME = path.resolve(__dirname, '../../data/nasa-wallpaper');
const CATALOG = path.resolve(__dirname, '../../data/nasa-whitecap/pipeline');
const HOUR = 3600000, TTL = 7 * 24 * HOUR;
const ID = /^nasa-(?:science-\d+|auto-[a-f0-9]{24})$/;

function official(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.port ||
        !(u.hostname === 'nasa.gov' || u.hostname.endsWith('.nasa.gov') ||
          ['esahubble.org', 'cdn.esahubble.org', 'esawebb.org', 'cdn.esawebb.org'].includes(u.hostname)) ||
        [...u.searchParams.keys()].some(k => /key|token|secret|signature|credential/i.test(k))) return null;
    return u.href;
  } catch { return null; }
}
function kind(url) {
  const u = new URL(url);
  if (/\.(?:jpe?g|png|webp|gif|tiff?)(?:$)/i.test(u.pathname) || /^assets\.|^images-assets\./.test(u.hostname)) return 'image';
  if (/\/wp-json\/|\/api\//.test(u.pathname) || /^api\.|^images-api\./.test(u.hostname)) return 'api';
  return 'page';
}
function candidates(record) {
  const preferred = official(record.sourceUrl);
  const other = [...new Set([...(Array.isArray(record.aliases) ? record.aliases : []), record.assetUrl, record.apiUrl, record.manifestUrl]
    .map(official).filter(Boolean))].filter(u => u !== preferred);
  // Keep the exact recorded URLs, including meaningful query strings and trailing slashes.
  const all = [...(preferred ? [preferred] : []), ...other];
  return all.map(url => ({ url, kind: kind(url) })).sort((a, b) => {
    const rank = x => x.url === preferred && x.kind === 'page' ? 0 : x.kind === 'page' ? 1 : x.kind === 'image' ? 2 : 3;
    return rank(a) - rank(b);
  }).slice(0, 16);
}
function fingerprint(record) { return hash(Buffer.from(JSON.stringify(candidates(record)))); }
async function smallBody(response, max = 262144) {
  const reader = response.body?.getReader(); if (!reader) return '';
  const parts = []; let bytes = 0;
  try {
    while (bytes < max) {
      const { value, done } = await reader.read(); if (done) break;
      const part = value.subarray(0, max - bytes); parts.push(Buffer.from(part)); bytes += part.length;
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(parts).toString('utf8');
}
async function probe(url, type, options = {}) {
  const fetcher = options.fetch || fetch;
  const visited = new Set(); let current = official(url);
  if (!current) return { url, state: 'unsafe', status: null };
  try {
    for (let hop = 0; hop < 5; hop++) {
      if (visited.has(current)) return { url, state: 'redirect-loop', status: null };
      visited.add(current);
      await options.beforeRequest?.();
      const response = await fetcher(current, { method: type === 'image' ? 'HEAD' : 'GET', redirect: 'manual',
        signal: AbortSignal.timeout(12000), headers: { 'User-Agent': 'RabbitHole-NASA-SourceLinks/1.0', Accept: type === 'page' ? 'text/html' : '*/*' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location'); await response.body?.cancel();
        const target = location && official(new URL(location, current).href);
        if (!target) return { url, state: 'unsafe-redirect', status: response.status };
        current = target; continue;
      }
      if (response.status === 429 || response.status === 503) {
        await response.body?.cancel();
        const seconds = Number(response.headers.get('retry-after'));
        const error = new Error('source-link-backoff'); error.retryMs = Math.max(HOUR, (Number.isFinite(seconds) ? seconds : 3600) * 1000); throw error;
      }
      if (!response.ok) { await response.body?.cancel(); return { url, finalUrl: current, state: response.status === 404 || response.status === 410 ? 'missing' : 'http-error', status: response.status }; }
      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      if (type === 'image') {
        await response.body?.cancel();
        return { url, finalUrl: current, state: contentType.startsWith('image/') ? 'valid' : 'wrong-content', status: response.status, contentType };
      }
      const body = await smallBody(response);
      if (/text\/html/.test(contentType)) {
        const heading = (body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '') + ' ' + (body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '');
        if (/\b404\b|page (?:was )?not found|page (?:you|doesn.t) exist|page you.re looking for/i.test(heading))
          return { url, finalUrl: current, state: 'missing', status: response.status, soft404: true };
      }
      if (type === 'page' && !/text\/html/.test(contentType)) return { url, finalUrl: current, state: 'wrong-content', status: response.status };
      if (type === 'api' && !/json/.test(contentType)) return { url, finalUrl: current, state: 'wrong-content', status: response.status };
      return { url, finalUrl: current, state: 'valid', status: response.status, contentType };
    }
    return { url, state: 'redirect-limit', status: null };
  } catch (error) {
    if (/source-link-(?:backoff|budget)/.test(error.message)) throw error;
    return { url, state: 'unreachable', status: null };
  }
}
async function resolve(record, options = {}) {
  const checks = [], checkedAt = new Date(options.now || Date.now()).toISOString();
  let selected = null;
  for (const candidate of candidates(record)) {
    const result = await probe(candidate.url, candidate.kind, options);
    checks.push({ ...result, kind: candidate.kind });
    if (result.state === 'valid') { selected = { url: result.finalUrl, kind: candidate.kind, status: result.status, originalUrl: candidate.url }; break; }
  }
  return { id: record.id, presentationSha256: record.presentationSha256, fingerprint: fingerprint(record),
    state: selected ? 'valid' : 'unavailable', selected, checkedAt,
    validUntil: new Date(Date.parse(checkedAt) + (selected ? TTL : HOUR)).toISOString(), checks };
}

async function refresh(options = {}) {
  const home = options.home || HOME, catalogHome = options.catalogHome || CATALOG;
  await noLinks(home); await fs.mkdir(home, { recursive: true });
  const lock = path.join(home, 'source-links.lock'); let handle;
  try { handle = await fs.open(lock, 'wx'); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const prior = await read(lock, null); if (!Number.isInteger(prior?.pid)) throw Error('Unknown source-link lock preserved');
    try { process.kill(prior.pid, 0); return { deferred: 'validation already running' }; }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    await fs.rename(lock, lock + '.interrupted-' + Date.now()); handle = await fs.open(lock, 'wx');
  }
  const receiptPath = path.join(home, 'source-links.json'), budgetPath = path.join(home, 'source-link-budget.json');
  let processed = 0, budget;
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid }));
    const receipts = await read(receiptPath, { version: 1, records: {} });
    budget = await read(budgetPath, { requests: [], backoffUntil: 0 });
    if (budget.backoffUntil > Date.now()) return { deferred: 'NASA backoff', retryAt: budget.backoffUntil };
    const manifest = await read(path.join(home, 'manifest.json'), { files: {} });
    const ids = [...new Set(Object.values(manifest.files).flatMap(f => f.ids || []))].filter(id => ID.test(id));
    const priority = options.ids || [];
    ids.sort((a, b) => Number(priority.includes(b)) - Number(priority.includes(a)));
    const limit = Math.min(600, Math.max(1, options.limit || 12));
    const beforeRequest = async () => {
      const now = Date.now(); budget.requests = budget.requests.filter(t => t > now - HOUR);
      // Reserve at most 100 public checks/hour alongside the existing collector's 900 ceiling.
      // No API key is loaded here; redirects also consume this persisted allowance.
      if (budget.requests.length >= 100) throw Error('source-link-budget');
      const wait = (budget.requests.at(-1) || 0) + 350 - now; if (wait > 0) await delay(wait);
      budget.requests.push(Date.now()); await atomic(budgetPath, budget);
      await options.beforeRequest?.();
    };
    for (const id of ids) {
      const record = await read(path.join(catalogHome, 'assets', id, 'metadata.json'), null);
      if (!record || record.stage !== 'verified') continue;
      const prior = receipts.records[id];
      if (!options.force && prior?.presentationSha256 === record.presentationSha256 && prior?.fingerprint === fingerprint(record) && Date.parse(prior.validUntil) > Date.now()) continue;
      // Withdraw a previous decision before revalidation. A budget/network interruption
      // after discovering a 404 must never leave the old clickable URL in the shared receipt.
      receipts.records[id] = { id, presentationSha256: record.presentationSha256, fingerprint: fingerprint(record),
        state: 'validating', selected: null, checkedAt: new Date().toISOString(), validUntil: null, checks: [] };
      await atomic(receiptPath, receipts);
      const decision = await resolve(record, { fetch: options.fetch, beforeRequest });
      receipts.records[id] = decision; receipts.updatedAt = new Date().toISOString();
      await atomic(receiptPath, receipts); processed++;
      if (processed >= limit) break;
    }
    return { processed, records: Object.keys(receipts.records).length, requestsInLastHour: budget.requests.length };
  } catch (error) {
    if (error.message === 'source-link-backoff') { budget.backoffUntil = Date.now() + error.retryMs; await atomic(budgetPath, budget); }
    if (/source-link-(?:backoff|budget)/.test(error.message)) return { processed, deferred: error.message, requestsInLastHour: budget.requests.length };
    throw error;
  } finally { await handle.close(); await fs.unlink(lock); }
}

module.exports = { official, candidates, fingerprint, probe, resolve, refresh, TTL };
if (require.main === module) {
  const args = process.argv.slice(2), value = key => args[args.indexOf(key) + 1];
  refresh({ limit: args.includes('--limit') ? Number(value('--limit')) : 12,
    ids: args.includes('--ids') ? value('--ids').split(',').filter(id => ID.test(id)) : [], force: args.includes('--force') })
    .then(result => console.log(JSON.stringify(result))).catch(() => { console.error('Source-link validation failed; source catalog and images were not changed.'); process.exitCode = 1; });
}
