"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPcMonitorStatus } = require("../src/pcMonitorStatus");

test("PC monitor normalizers trim text and round numeric values", () => {
  const monitor = createPcMonitorStatus({
    config: { pcMonitor: { enabled: true, baseUrl: "http://pc.local", timeoutMs: 1000 } },
    fetchJsonWithTimeout: async () => ({ response: { ok: true }, body: {} })
  });

  assert.deepEqual(monitor.normalizePcCpu({
    source: "  Open   Hardware  ",
    name: "  Ryzen  ",
    temperatureC: "49.8",
    usagePercent: "12.4",
    clockMhz: "5100.6",
    packagePowerW: "88.66",
    fanRpm: "1500.2"
  }), {
    source: "Open Hardware",
    name: "Ryzen",
    temperatureC: 50,
    usagePercent: 12,
    clockMhz: 5101,
    packagePowerW: 88.7,
    fanRpm: 1500
  });

  assert.deepEqual(monitor.normalizePcGpu({
    source: "  GPU-Z ",
    name: " RTX ",
    temperatureC: "52.2",
    hotspotTemperatureC: "64.8",
    usagePercent: "91.2",
    powerW: "242.27",
    fanRpm: "1800.9",
    fanPercent: "55.5"
  }), {
    source: "GPU-Z",
    name: "RTX",
    temperatureC: 52,
    hotspotTemperatureC: 65,
    usagePercent: 91,
    powerW: 242.3,
    fanRpm: 1801,
    fanPercent: 56
  });
});

test("PC monitor snapshot reports disabled state without fetching", async () => {
  let fetched = false;
  const monitor = createPcMonitorStatus({
    config: { pcMonitor: { enabled: false, baseUrl: "http://pc.local", timeoutMs: 1000 } },
    fetchJsonWithTimeout: async () => {
      fetched = true;
      return { response: { ok: true }, body: {} };
    }
  });

  const snapshot = await monitor.pcMonitorSnapshot();

  assert.equal(fetched, false);
  assert.equal(snapshot.connected, false);
  assert.equal(snapshot.cpu, null);
  assert.equal(snapshot.gpu, null);
  assert.equal(snapshot.error, "PC monitor disabled");
});

test("PC monitor numeric readings distinguish unavailable values from valid zero", () => {
  const monitor = createPcMonitorStatus({
    config: { pcMonitor: { enabled: true, baseUrl: "http://pc.local", timeoutMs: 1000 } },
    fetchJsonWithTimeout: async () => ({ response: { ok: true }, body: {} })
  });

  for (const value of [null, undefined, "", " \t\n", "unavailable", Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(monitor.pcMonitorNumber(value), null);
    assert.equal(monitor.pcMonitorNumber(value, 1), null);
  }
  for (const value of [0, "0", " 0 "]) {
    assert.equal(monitor.pcMonitorNumber(value), 0);
    assert.equal(monitor.pcMonitorNumber(value, 1), 0);
  }
  assert.equal(monitor.pcMonitorNumber(-5.2), -5);
});

test("PC monitor normalizers preserve unavailable metrics across CPU and GPU", () => {
  const monitor = createPcMonitorStatus({
    config: { pcMonitor: { enabled: true, baseUrl: "http://pc.local", timeoutMs: 1000 } },
    fetchJsonWithTimeout: async () => ({ response: { ok: true }, body: {} })
  });

  for (const normalize of [monitor.normalizePcCpu, monitor.normalizePcGpu]) {
    const fields = Object.keys(normalize()).filter((name) => name !== "source" && name !== "name");
    for (const unavailable of [null, undefined, "", "  "]) {
      const result = normalize(Object.fromEntries(fields.map((field) => [field, unavailable])));
      for (const field of fields) assert.equal(result[field], null, field);
    }
  }
});

test("PC monitor snapshot preserves an unavailable GPU hotspot and usable zero readings", async () => {
  const monitor = createPcMonitorStatus({
    config: { pcMonitor: { enabled: true, baseUrl: "http://pc.local", timeoutMs: 1000 } },
    fetchJsonWithTimeout: async (url) => ({
      response: { ok: true },
      body: url.endsWith("/api/cpu")
        ? { source: "corsair-cpuid-service", name: "CPU", temperatureC: "59.8", usagePercent: 0, packagePowerW: "25.44", fanRpm: " " }
        : { source: "librehardwaremonitor", name: "GPU", temperatureC: "40.2", hotspotTemperatureC: null, usagePercent: 0, powerW: 0, fanRpm: 0, fanPercent: 0 }
    })
  });

  const snapshot = await monitor.pcMonitorSnapshot();
  assert.equal(snapshot.connected, true);
  assert.equal(snapshot.error, "");
  assert.equal(snapshot.cpu.temperatureC, 60);
  assert.equal(snapshot.cpu.packagePowerW, 25.4);
  assert.equal(snapshot.cpu.fanRpm, null);
  assert.equal(snapshot.cpu.clockMhz, null);
  assert.equal(snapshot.gpu.temperatureC, 40);
  assert.equal(snapshot.gpu.hotspotTemperatureC, null);
  for (const metric of ["usagePercent", "powerW", "fanRpm", "fanPercent"]) {
    assert.equal(snapshot.gpu[metric], 0, metric);
  }
});

test("PC monitor snapshot keeps partial data and reports failed endpoint", async () => {
  const monitor = createPcMonitorStatus({
    config: { pcMonitor: { enabled: true, baseUrl: "http://pc.local/base/", timeoutMs: 100 } },
    fetchJsonWithTimeout: async (url) => {
      if (url === "http://pc.local/api/cpu") {
        return {
          response: { ok: true },
          body: { source: "cpu", name: "Ryzen", temperatureC: "45" }
        };
      }
      return { response: { ok: false, status: 503 }, body: {} };
    }
  });

  const snapshot = await monitor.pcMonitorSnapshot();

  assert.equal(snapshot.connected, true);
  assert.equal(snapshot.cpu.name, "Ryzen");
  assert.equal(snapshot.gpu, null);
  assert.equal(snapshot.error, "GPU HTTP 503");
});
