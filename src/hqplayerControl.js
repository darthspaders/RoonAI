"use strict";
const net = require("node:net");

const HQPLAYER_CONTROL_PORT = 4321;

function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value.replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")]));
}

function parseHqplayerStatus(xml) {
  const status = String(xml).match(/<Status\b([^>]*?)\/?>/);
  if (!status) return null;
  const a = attributes(status[1]);
  const metadata = String(xml).match(/<metadata\b([^>]*?)\/?>/);
  const m = metadata ? attributes(metadata[1]) : null;
  const number = value => (Number.isFinite(Number(value)) ? Number(value) : 0);
  return { state: number(a.state), mode: a.active_mode || "", rate: number(a.active_rate), bits: number(a.active_bits),
    filter: a.active_filter || "", shaper: a.active_shaper || "", speed: number(a.process_speed),
    source: m ? { rate: number(m.samplerate), bits: number(m.bits), mime: m.mime || "" } : null };
}

function createHqplayerControl({ connect = options => net.createConnection(options), clock = Date.now, timeoutMs = 1500, cacheMs = 2500 } = {}) {
  const cache = new Map();
  function query(host) {
    return new Promise(resolve => {
      let reply = "", settled = false;
      const socket = connect({ host, port: HQPLAYER_CONTROL_PORT });
      const finish = value => { if (settled) return; settled = true; socket.destroy(); resolve(value); };
      socket.setTimeout(timeoutMs, () => finish(null));
      socket.on("error", () => finish(null));
      socket.on("close", () => finish(parseHqplayerStatus(reply)));
      socket.on("connect", () => socket.write('<?xml version="1.0" encoding="UTF-8"?><Status subscribe="0" />\n'));
      socket.on("data", chunk => {
        reply += chunk.toString("utf8");
        if (/<\/Status>|<Status\b[^>]*\/>/.test(reply) || reply.length > 65536) finish(parseHqplayerStatus(reply));
      });
    });
  }
  return {
    async status(host) {
      const cached = cache.get(host);
      if (cached && clock() - cached.at < cacheMs) return cached.value;
      const value = await query(host);
      cache.set(host, { at: clock(), value });
      if (cache.size > 20) cache.delete(cache.keys().next().value);
      return value;
    }
  };
}

module.exports = { parseHqplayerStatus, createHqplayerControl, HQPLAYER_CONTROL_PORT };
