"use strict";

// Pure runtime boundaries: fixtures never construct providers, touch the private
// run directory, authenticate, inspect playback, or send network requests.
const test = require("node:test"), assert = require("node:assert/strict");
const { exclusionsFrom, safeBeatportTransport } = require("../scripts/sonic-catalog-scout-verified");
const hash = value => String(value).padStart(64, "0"), track = (id, extra = {}) => ({ identityKey: "tidal:" + id, artist: "Artist " + id, title: "Track " + id, ...extra });
const original = () => { const heldOut = Array.from({ length: 6 }, (_, i) => track(i + 101)); return { heldOut, originalManifest: { items: heldOut.map((value, i) => ({ track: { ...value, analysisLocal: { sha256: hash(i + 1) } } })) } }; };
const entry = (id, beatportId) => ({ track: track(id), source: { sourceType: "beatport-preview", sourceTrackId: String(beatportId), sourceSha256: hash(id) } });
function transportFixture(extra = {}, status = 200) {
  const calls = [], snapshots = [], ledger = { refreshAttempts: 0, priorTransportCalls: 0, transport: [], ...extra };
  const provider = { baseUrl: "https://catalog.example/v4", fetchImpl: async (url, options) => { calls.push({ url, options }); return { status }; } };
  safeBeatportTransport(provider, ledger, () => snapshots.push(JSON.parse(JSON.stringify(ledger)))); return { provider, ledger, calls, snapshots };
}
test("freezes inherited failed attempts, private exposures and unjudged collected sources", () => {
  const plan = { groups: [{ anchor: track(11), candidates: [{ track: track(12, { beatportTrackId: "212" }) }] }], clips: { one: { sourceSha256: hash(11) } } };
  const collection = { attempts: [{ beatportTrackId: "301", status: "unavailable" }], entries: [entry(21, 321)] };
  const pool = { entries: [entry(31, 331)] }, inherited = { excludedBeatportTrackIds: ["401"], excluded: [track(41)], excludedSourceSha256: [hash(41)] };
  const result = exclusionsFrom([plan], [collection], original(), [inherited], [pool]);
  assert.deepEqual(new Set(result.excludedBeatportTrackIds), new Set(["212", "301", "321", "331", "401"]));
  assert.deepEqual(new Set(result.excluded.map(value => value.identityKey)), new Set(["tidal:11", "tidal:12", "tidal:21", "tidal:31", "tidal:41"]));
  for (const value of [hash(11), hash(21), hash(31), hash(41), ...Array.from({ length: 6 }, (_, i) => hash(i + 1))]) assert.ok(result.excludedSourceSha256.includes(value));
  assert.equal(result.heldOut.length, 6);
});
test("keeps conflicting prior descriptors excluded and deduplicates exact repeated evidence", () => {
  const first = track(10, { isrc: "FIRST" }), second = track(10, { isrc: "SECOND" });
  const result = exclusionsFrom([{ groups: [{ anchor: first, candidates: [{ track: first }, { track: second }] }], clips: {} }], [], original());
  assert.equal(result.excluded.length, 2); assert.deepEqual(result.excluded.map(value => value.isrc), ["FIRST", "SECOND"]);
});
test("rejects malformed prior source IDs and missing heldout hashes before declaring", () => {
  assert.throws(() => exclusionsFrom([], [{ attempts: [{ beatportTrackId: "invalid" }], entries: [] }], original()));
  const bad = original(); delete bad.originalManifest.items[0].track.analysisLocal;
  assert.throws(() => exclusionsFrom([], [], bad));
});
test("safe receipts cover actual catalogue, authentication and preview HTTP outcomes", async () => {
  const fixture = transportFixture({}, 503);
  await fixture.provider.fetchImpl("https://catalog.example/v4/catalog/tracks/?genre_id=91");
  await fixture.provider.fetchImpl("https://catalog.example/v4/auth/o/token/", { method: "POST", headers: { authorization: "private" }, body: "private" });
  await fixture.provider.fetchImpl("https://preview.example/audio?private=locator");
  assert.equal(fixture.calls.length, 3); assert.equal(fixture.ledger.refreshAttempts, 1); assert.equal(fixture.ledger.previewCalls, 1);
  assert.deepEqual(fixture.ledger.transport.map(value => [value.kind, value.status]), [["catalogue", 503], ["authentication", 503], ["preview", 503]]);
  const serialized = JSON.stringify(fixture.snapshots); assert.ok(!/authorization|locator|genre_id|catalog\.example|preview\.example|headers|body/.test(serialized));
});
test("combined transport cap includes earlier authentication calls and does not retry", async () => {
  const fixture = transportFixture({ priorTransportCalls: 199 });
  await fixture.provider.fetchImpl("https://catalog.example/v4/catalog/tracks/");
  await assert.rejects(fixture.provider.fetchImpl("https://catalog.example/v4/catalog/tracks/"));
  assert.equal(fixture.calls.length, 1); assert.equal(fixture.ledger.transport.length, 1);
});
test("one refresh and 160 previews are hard limits before transport", async () => {
  const auth = transportFixture({ refreshAttempts: 1 });
  await assert.rejects(auth.provider.fetchImpl("https://catalog.example/v4/auth/o/token/")); assert.equal(auth.calls.length, 0);
  const preview = transportFixture({ previewCalls: 159 });
  await preview.provider.fetchImpl("https://preview.example/audio");
  await assert.rejects(preview.provider.fetchImpl("https://preview.example/audio")); assert.equal(preview.calls.length, 1); assert.equal(preview.ledger.previewCalls, 160);
});
test("transport failure saves a safe terminal status without raw error text", async () => {
  const fixture = transportFixture(); fixture.provider = { baseUrl: "https://catalog.example/v4", fetchImpl: async () => { throw Error("secret locator or access token"); } };
  safeBeatportTransport(fixture.provider, fixture.ledger, () => fixture.snapshots.push(JSON.parse(JSON.stringify(fixture.ledger))));
  await assert.rejects(fixture.provider.fetchImpl("https://preview.example/audio"), /safe evidence preserved/);
  assert.equal(fixture.ledger.transport[0].status, "transport-error"); assert.ok(!JSON.stringify(fixture.snapshots).includes("secret"));
});
