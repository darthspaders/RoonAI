"use strict";

function createPcMonitorStatus({ config, fetchJsonWithTimeout }) {
  function cleanPcMonitorText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function pcMonitorNumber(value, digits = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? Number(number.toFixed(digits)) : null;
  }

  function pcMonitorEndpoint(pathname) {
    return new URL(pathname, config.pcMonitor.baseUrl).toString();
  }

  function normalizePcCpu(body = {}) {
    return {
      source: cleanPcMonitorText(body.source),
      name: cleanPcMonitorText(body.name),
      temperatureC: pcMonitorNumber(body.temperatureC),
      usagePercent: pcMonitorNumber(body.usagePercent),
      clockMhz: pcMonitorNumber(body.clockMhz),
      packagePowerW: pcMonitorNumber(body.packagePowerW, 1),
      fanRpm: pcMonitorNumber(body.fanRpm)
    };
  }

  function normalizePcGpu(body = {}) {
    return {
      source: cleanPcMonitorText(body.source),
      name: cleanPcMonitorText(body.name),
      temperatureC: pcMonitorNumber(body.temperatureC),
      hotspotTemperatureC: pcMonitorNumber(body.hotspotTemperatureC),
      usagePercent: pcMonitorNumber(body.usagePercent),
      powerW: pcMonitorNumber(body.powerW, 1),
      fanRpm: pcMonitorNumber(body.fanRpm),
      fanPercent: pcMonitorNumber(body.fanPercent)
    };
  }

  async function readPcMonitorJson(pathname) {
    const { response, body } = await fetchJsonWithTimeout(
      pcMonitorEndpoint(pathname),
      { headers: { accept: "application/json" } },
      Math.max(250, config.pcMonitor.timeoutMs)
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return body;
  }

  async function pcMonitorSnapshot() {
    const updatedAt = new Date().toISOString();
    if (!config.pcMonitor.enabled) {
      return { connected: false, updatedAt, cpu: null, gpu: null, error: "PC monitor disabled" };
    }

    const [cpuResult, gpuResult] = await Promise.allSettled([
      readPcMonitorJson("/api/cpu"),
      readPcMonitorJson("/api/gpu")
    ]);

    const cpu = cpuResult.status === "fulfilled" ? normalizePcCpu(cpuResult.value) : null;
    const gpu = gpuResult.status === "fulfilled" ? normalizePcGpu(gpuResult.value) : null;
    const errors = [
      cpuResult.status === "rejected" ? `CPU ${cpuResult.reason?.message || "unavailable"}` : "",
      gpuResult.status === "rejected" ? `GPU ${gpuResult.reason?.message || "unavailable"}` : ""
    ].filter(Boolean);

    return {
      connected: Boolean(cpu || gpu),
      updatedAt,
      cpu,
      gpu,
      error: errors.join("; ")
    };
  }

  return {
    cleanPcMonitorText,
    normalizePcCpu,
    normalizePcGpu,
    pcMonitorEndpoint,
    pcMonitorNumber,
    pcMonitorSnapshot,
    readPcMonitorJson
  };
}

module.exports = {
  createPcMonitorStatus
};
