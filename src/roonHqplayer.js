"use strict";
const HOST = /^(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*|\[?[0-9A-Fa-f:]*:[0-9A-Fa-f:.]*\]?)$/;

function parseRoonHqplayerZones(text = "") {
  const zones = new Map();
  for (const entry of String(text).split(",")) {
    const at = entry.indexOf("=");
    if (at < 1) continue;
    const zone = entry.slice(0, at).trim(), host = entry.slice(at + 1).trim();
    if (zone && HOST.test(host)) zones.set(zone, host.replace(/^\[|\]$/g, ""));
  }
  return zones;
}

function createRoonHqplayerRoute({ zones, control }) {
  return async (zone) => {
    const host = zones.get(String(zone || ""));
    return { hqplayer: host ? await control.status(host) : null };
  };
}

module.exports = { parseRoonHqplayerZones, createRoonHqplayerRoute };
