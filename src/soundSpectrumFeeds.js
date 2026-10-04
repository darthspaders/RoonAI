"use strict";

// Base service routing only. Either optional experiment can be removed without
// importing the other. No connection, device or process is created here.
const FEED_SOURCES = Object.freeze({
  "feed:pre-hqplayer": "lyrion",
  "feed:hqplayer-analysis": "roon-hqplayer"
});
const validZoneId = value => typeof value === "string" && /^[a-f0-9]{20,128}$/i.test(value);

function createHQPlayerZoneGuard(getRoonState = () => ({ connected: false, zones: [] })) {
  return async (zoneId, settings = {}) => {
    if (!validZoneId(zoneId) || zoneId !== settings.zoneId || !validZoneId(settings.outputId)) {
      throw Error("Choose the configured Roon HQPlayer zone for the music analysis feed.");
    }
    const state = await getRoonState();
    if (!state?.connected) throw Error("Roon disconnected. Reconnect it before starting HQPlayer visuals.");
    const zone = state.zones?.find(item => item.zone_id === zoneId);
    if (!zone || !Array.isArray(zone.outputs) || zone.outputs.length !== 1 || zone.outputs[0]?.output_id !== settings.outputId) {
      throw Error("The configured Roon HQPlayer output is unavailable or grouped. Choose its original zone.");
    }
    if (zone.state !== "playing") throw Error("Play music in the configured Roon HQPlayer zone before starting visuals.");
    // Return only the facts the adapter needs, never signed source/queue data.
    return { zone_id: zone.zone_id, state: zone.state, outputs: [{ output_id: zone.outputs[0].output_id }] };
  };
}

function createFeedMux(entries = []) {
  const feeds = new Map();
  for (const { id, integration } of entries) {
    if (!Object.hasOwn(FEED_SOURCES, id) || feeds.has(id) || !integration?.audioFeed || !integration?.additionalInputProvider) {
      throw Error("An exact, independent SoundSpectrum feed is required.");
    }
    feeds.set(id, integration);
  }
  const select = inputId => {
    const selected = feeds.get(inputId);
    if (!selected) throw Error("The selected SoundSpectrum music feed is unavailable.");
    return selected;
  };
  const settle = async action => {
    const results = await Promise.allSettled([...feeds.entries()].map(async ([id, entry]) => action(id, entry)));
    return results.filter(result => result.status === "fulfilled").flatMap(result => result.value || []);
  };
  const audioFeed = {
    async inspect(refresh) {
      return settle(async (id, entry) => {
        const input = await entry.audioFeed.inspect(refresh);
        return input?.id === id && input.kind === "music-feed" ? [{ ...input, source: FEED_SOURCES[id] }] : [];
      });
    },
    snapshot(inputId) { return feeds.get(inputId)?.audioFeed.snapshot() || { state: "waiting", source: "", reason: "Select a music input and Start visuals." }; },
    async validateStart({ inputId, ...selection }) { await select(inputId).audioFeed.validateStart?.(selection); },
    async start({ inputId, ...selection }) {
      const selected = select(inputId);
      // One shared renderer/cable: a previous source must finish cleanup before
      // another source can launch its writer, even after cancellation or failure.
      await audioFeed.stop();
      await selected.audioFeed.start(selection);
    },
    async stop() {
      const results = await Promise.allSettled([...feeds.values()].map(entry => Promise.resolve().then(() => entry.audioFeed.stop())));
      const failure = results.find(result => result.status === "rejected");
      if (failure) throw failure.reason;
    }
  };
  const additionalInputProvider = {
    async list(rawInputs) {
      return settle(async (id, entry) => {
        const inputs = await entry.additionalInputProvider.list(rawInputs);
        return (Array.isArray(inputs) ? inputs : []).filter(input => input?.id === id && input.kind === "music-feed");
      });
    },
    async resolve(inputId, rawInputs) {
      return select(inputId).additionalInputProvider.resolve(inputId, rawInputs);
    }
  };
  return { audioFeed, additionalInputProvider };
}

module.exports = { FEED_SOURCES, validZoneId, createHQPlayerZoneGuard, createFeedMux };
