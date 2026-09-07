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
