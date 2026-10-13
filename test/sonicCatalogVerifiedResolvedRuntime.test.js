"use strict";
// Pure injected transport/runtime boundaries. No provider calls or private writes.
const test = require("node:test"), assert = require("node:assert/strict");
const rt = require("../scripts/sonic-catalog-scout-verified-resolved"), { TidalVerifier } = require("../src/tidalVerifier");
const { RESOLVED_HTTPS_POLICY } = require("../src/sonicResolvedHttpsTransport");
test("primary instance fetch is injected into both provider configurations without global or credential mutation", () => {
  const fetchBefore = globalThis.fetch, primaryFetch = async () => new Response("{}", { status: 200 });
  const config = { beatport: { enabled: true, clientId: "private-fixture-bp" }, tidal: { enabled: true, clientId: "private-fixture-tidal" } }, before = structuredClone(config);
  const primary = rt.primaryProviderConfigurations(config, primaryFetch);
  assert.equal(primary.beatport.fetchImpl, primaryFetch); assert.equal(primary.tidal.fetchImpl, primaryFetch); assert.deepEqual(config, before);
  assert.equal(globalThis.fetch, fetchBefore); assert.equal(RESOLVED_HTTPS_POLICY.maximumDnsCallsPerRequest, 1); assert.equal(RESOLVED_HTTPS_POLICY.maximumPhysicalRequests, 1);
  assert.equal(RESOLVED_HTTPS_POLICY.retries, 0); assert.equal(RESOLVED_HTTPS_POLICY.fallbacks, 0); assert.equal(RESOLVED_HTTPS_POLICY.redirects, 0); assert.equal(RESOLVED_HTTPS_POLICY.rejectUnauthorized, true);
});
test("latest physical histories are retained exactly once and the prior failure latch does not restart", async () => {
  const prior = { priorTransportCalls: 11, transport: [{ kind: "catalogue", status: "transport-error" }], refreshAttempts: 0, previewCalls: 5,
    tidalTransport: [{ kind: "search", status: 200 }], tidalRawTransport: [...Array.from({ length: 72 }, () => ({ kind: "search", status: 200 })), ...Array.from({ length: 2 }, () => ({ kind: "authentication", status: 200 }))],
    infrastructureFailure: { reason: "network-or-request-error" } }, before = structuredClone(prior);
  const ledger = rt.seedTransportLedger(prior, { refreshAttempts: 0, transport: [] }); assert.equal(ledger.priorTransportCalls, 12);
  assert.equal(ledger.tidalRawTransport.length, 74); assert.equal(ledger.priorTidalApiCalls, 72); assert.equal(ledger.priorTidalAuthenticationCalls, 2);
  assert.equal(ledger.infrastructureFailure, undefined); assert.equal(ledger.previewCalls, 5);
  const primaryFetch = async () => new Response('{"fixture":true}', { status: 200 });
  const tidal = new TidalVerifier({ enabled: true, accessToken: "private-fixture-token", fetchImpl: primaryFetch,
    catalogPaginationFile: "unused-resolved-pagination.json", artistAliasFile: "unused-resolved-alias.json" });
  rt.configureRecoveryTidalTransport(tidal, ledger, () => {}); await tidal.fetchTidalJson("https://openapi.tidal.com/v2/searchResults/fixture/relationships/tracks");
  assert.equal(ledger.tidalRawTransport.length, 75); assert.equal(ledger.tidalRawTransport.at(-1).status, 200); assert.deepEqual(prior, before);
});
test("normal raw/no-retry guards still make one attempt with the injected primary transport", async () => {
  let physicalCalls = 0; const config = rt.primaryProviderConfigurations({ beatport: {}, tidal: { enabled: true, accessToken: "private-fixture-token",
    catalogPaginationFile: "unused-resolved-pagination.json", artistAliasFile: "unused-resolved-alias.json" } }, async () => { physicalCalls++; return new Response("{}", { status: 429 }); });
  const tidal = new TidalVerifier(config.tidal), ledger = { transport: [], tidalTransport: [], tidalRawTransport: [] };
  rt.configureRecoveryTidalTransport(tidal, ledger, () => {});
  await assert.rejects(tidal.fetchTidalJson("https://openapi.tidal.com/v2/searchResults/fixture/relationships/tracks")); assert.equal(physicalCalls, 1);
  assert.equal(ledger.tidalRawTransport[0].status, 429); assert.equal(ledger.infrastructureFailure.reason, "http-429");
  await assert.rejects(tidal.fetchTidalJson("https://openapi.tidal.com/v2/searchResults/fixture/relationships/tracks")); assert.equal(physicalCalls, 1);
  assert.doesNotMatch(JSON.stringify(ledger), /private-fixture|authorization|https?:/);
});
test("the additional two attempts stay excluded without changing the original twenty-one receipt seed", () => {
  const originals = Array.from({ length: 21 }, (_, i) => ({ beatportTrackId: String(1000 + i) }));
  const latest = { attempts: [...originals, { beatportTrackId: "3000" }, { beatportTrackId: "3001" }], entries: [] };
  const reserved = Array.from({ length: 6 }, (_, i) => ({ identityKey: "tidal:" + (i + 1), artist: "Reserved " + i, title: "Reserved " + i }));
  const original = { heldOut: reserved, originalManifest: { items: reserved.map(track => ({ track: { ...track, analysisLocal: { sha256: "a".repeat(64) } } })) } };
  const prior = { excludedBeatportTrackIds: [...originals.map(row => row.beatportTrackId), ...Array.from({ length: 481 }, (_, i) => String(10000 + i))], excluded: [], excludedSourceSha256: [] };
  const exclusions = rt.exclusionsFrom([], [{ attempts: originals, entries: [] }, latest], original, [prior]);
  assert.equal(exclusions.excludedBeatportTrackIds.length, 504); assert.ok(exclusions.excludedBeatportTrackIds.includes("3000")); assert.ok(exclusions.excludedBeatportTrackIds.includes("3001"));
  assert.equal(originals.length, 21); assert.equal(21 + 2 + 139, 162);
});
