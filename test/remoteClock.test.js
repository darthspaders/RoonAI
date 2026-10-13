"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { localTime, localDate, dateLabel, condition, fetchWeather, createWeatherController } = require("../public/remoteClock");

test("device-local midnight and dates preserve 24-hour format across year rollover", () => {
  assert.equal(localTime(new Date(2026, 11, 31, 23, 59)), "23:59");
  assert.equal(localTime(new Date(2027, 0, 1, 0, 0)), "00:00");
  assert.equal(localDate(new Date(2027, 0, 1)), "2027-01-01");
  assert.match(dateLabel(new Date(2027, 0, 1)), /Fri.*1 Jan/);
});
test("weather uses approximate coordinates, Fahrenheit and no credentials or referrer", async () => {
  const now = 1791700000000;
  const value = await fetchWeather({ latitude: 39.123456, longitude: -104.987654 }, { now: () => now,
    fetchImpl: async (url, options) => {
      const u = new URL(url);
      assert.equal(u.origin, "https://api.open-meteo.com");
      assert.equal(u.searchParams.get("latitude"), "39.12");
      assert.equal(u.searchParams.get("longitude"), "-104.99");
      assert.equal(u.searchParams.get("temperature_unit"), "fahrenheit");
      assert.equal(options.credentials, "omit"); assert.equal(options.referrerPolicy, "no-referrer");
      return { ok: true, json: async () => ({ current_units: { temperature_2m: "°F" }, current: { temperature_2m: 53.7, weather_code: 0, is_day: 0, time: now / 1000 } }) };
    } });
  assert.equal(value.temperature, 54); assert.equal(value.icon, "moon");
});
test("bad, stale, wrong-unit and refused weather never becomes a current temperature", async () => {
  let calls = 0;
  await assert.rejects(fetchWeather({ latitude: NaN, longitude: 0 }, { fetchImpl: async () => calls++ }));
  assert.equal(calls, 0);
  for (const response of [
    { ok: false, status: 429 },
    { ok: true, json: async () => ({ current: {} }) },
    { ok: true, json: async () => ({ current_units: { temperature_2m: "°C" }, current: { temperature_2m: 10, weather_code: 0 } }) },
    { ok: true, json: async () => ({ current_units: { temperature_2m: "°F" }, current: { temperature_2m: 54, weather_code: 0, time: 1 } }) }
  ]) await assert.rejects(fetchWeather({ latitude: 40, longitude: -105 }, { fetchImpl: async () => response }));
  assert.equal(condition(95).label, "Thunderstorm");
  assert.equal(condition(999).label, "Conditions unknown");
});
function fixture(overrides = {}) {
  let currentTime = 0, shown = true;
  const events = [], saved = [], calls = [];
  const controller = createWeatherController({ now: () => currentTime, visible: () => shown,
    locate: async () => { calls.push("locate"); return { coords: { latitude: 40, longitude: -105 } }; },
    fetchCurrent: async () => { calls.push("fetch"); return { temperature: 60, updatedAt: 0, label: "Clear" }; },
    render: event => events.push(event), persist: value => saved.push(value), ...overrides });
  return { controller, events, saved, calls, advance: ms => currentTime += ms, hide: () => shown = false, show: () => shown = true };
}
test("weather is opt-in, refreshes at most every 15 minutes, and skips hidden pages", async () => {
  const f = fixture(); await f.controller.refresh(); assert.equal(f.calls.length, 0);
  await f.controller.enable(); assert.deepEqual(f.calls, ["locate", "fetch"]);
  await f.controller.refresh(); assert.equal(f.calls.length, 2);
  f.hide(); f.controller.suspend(); f.advance(1000); f.show(); await f.controller.refresh(); assert.equal(f.calls.length, 2);
  f.hide(); f.advance(900000); await f.controller.refresh(); assert.equal(f.calls.length, 2);
  f.show(); await f.controller.refresh(); assert.equal(f.calls.length, 4);
  f.controller.disable(); f.advance(900000); await f.controller.refresh(); assert.equal(f.calls.length, 4);
  assert.deepEqual(f.saved, [true, false]);
});
test("location denial disables automatic requests and reports a useful reason", async () => {
  const f = fixture({ locate: async () => { throw { code: 1 }; } });
  await f.controller.enable(); assert.equal(f.controller.isEnabled(), false);
  assert.match(f.events.at(-1).message, /permission was declined/);
  assert.deepEqual(f.saved, [true, false]); assert.equal(f.calls.length, 0);
});
test("turning weather off before location arrives prevents sending coordinates", async () => {
  let resolve; const located = new Promise(r => resolve = r);
  const f = fixture({ locate: () => located });
  const pending = f.controller.enable(); f.controller.disable(); resolve({ coords: { latitude: 40, longitude: -105 } });
  await pending; assert.equal(f.calls.length, 0); assert.equal(f.events.at(-1).enabled, false);
});
test("late fetch after turning off cannot restore weather and aborts the request", async () => {
  let resolve, signal;
  const fetched = new Promise(r => resolve = r);
  const f = fixture({ fetchCurrent: (_coords, options) => { signal = options.signal; return fetched; } });
  const pending = f.controller.enable(); await Promise.resolve(); f.controller.disable();
  assert.equal(signal.aborted, true); resolve({ temperature: 99, updatedAt: 0 }); await pending;
  assert.equal(f.events.at(-1).enabled, false);
});
test("network failures clear current weather and respect the refresh cooldown", async () => {
  let requests = 0;
  const f = fixture({ fetchCurrent: async () => { requests++; throw Error("network"); } });
  await f.controller.enable(); assert.equal(f.events.at(-1).weather, undefined);
  assert.match(f.events.at(-1).message, /unavailable/);
  await f.controller.refresh(); assert.equal(requests, 1);
});
