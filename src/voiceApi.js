"use strict";
const fs = require("node:fs");
const path = require("node:path");
const execution = require("./voiceExecution");
const { VoiceDeviceStore, atomicWrite, defaultDirectory } = require("./voiceDeviceStore");
const terminal = new Set(["completed", "failed", "cancelled", "interrupted"]);
const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, "twenty five": 25 };
function intent(text) {
  const t = text.toLowerCase().replace(/^hey synapse[,\s]*/, "").replace(/[’']/g, "").replace(/[.,!?]/g, "").trim().replace(/^q\b|^cue\b/, "queue").replace(/\bstand by\b/g, "standby");
  if (/^(whats playing|what is playing|what song is this)$/.test(t)) return { kind: "playing" };
  const control = { pause: "pause", "pause music": "pause", play: "play", "play music": "play", resume: "play", skip: "next", next: "next", "skip this": "next", "skip this track": "next", "next track": "next", previous: "previous", stop: "stop" }[t];
  if (control) return { kind: "control", control };
  const rating = { "love this": "love", "love this track": "love", good: "good", "this is good": "good", "reject this": "never", "reject this track": "never" }[t];
  if (rating) return { kind: "rating", rating };
  if (/^refresh (?:the )?standby(?: pool)?$/.test(t)) return { kind: "refresh" };
  if (/^(what did rabbit hole find|whats in standby|what is in standby)$/.test(t)) return { kind: "found" };
  if (/^(cancel|cancel that|cancel discovery)$/.test(t)) return { kind: "cancel" };
  const queue = /^queue (?:the )?(?:next )?(?:(\d+|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty five|twenty) )?standby(?: tracks)?$/.exec(t);
  if (queue) return { kind: "queue", count: Math.min(25, Math.max(1, words[queue[1]] || Number(queue[1]) || 10)) };
  if (/^send (?:these|these tracks) to roon$/.test(t)) return { kind: "send" };
  return { kind: "complex" };
}
function createVoiceApi({ tools, router, directory = defaultDirectory, availability = () => ({}) }) {
  const devices = new VoiceDeviceStore(directory);
  const file = path.join(directory, "jobs.json");
  const jobs = new Map((fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : []).map(job => [job.id, job]));
  const running = new Map();
  let complexTail = Promise.resolve();
  const save = () => atomicWrite(file, [...jobs.values()]);
  for (const job of jobs.values()) if (!terminal.has(job.status)) {
    Object.assign(job, { status: "interrupted", success: false, spokenResponse: "Rabbit Hole restarted. Check the result before trying again.", displayResponse: "Interrupted; actions already executed were not rolled back." });
  }
  if (jobs.size) save();
  function view(job) { const { deviceId, text, ...safe } = job; return safe; }
  function reply(res, status, payload) {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); res.end(JSON.stringify(payload));
  }
  async function body(req) {
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 8192) throw Object.assign(new Error("Request too large."), { status: 413 }); chunks.push(chunk); }
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Object required.");
      return value;
    } catch { throw Object.assign(new Error("Invalid JSON object."), { status: 400 }); }
  }
  async function perform(job) {
    if (terminal.has(job.status)) return;
    const ctx = execution.create(); running.set(job.id, ctx);
    try {
      job.status = "running"; save();
      const result = await execution.run(ctx, async () => {
        const cmd = intent(job.text);
        const call = async (name, input = {}) => { execution.check(); const r = await tools[name].handler(input); execution.check(); return r; };
        let spokenResponse, displayResponse;
        if (cmd.kind === "complex") {
          const prior = complexTail; let release;
          complexTail = new Promise(resolve => { release = resolve; });
          try {
            await prior; execution.check();
            const result = await router.respond({ message: job.text, mode: "auto" }); execution.check();
            displayResponse = String(result.text || "Request finished.").slice(0, 6000);
            spokenResponse = displayResponse.replace(/[*#`]/g, "").split(/(?<=[.!?])\s/).slice(0, 2).join(" ").slice(0, 260);
            return { success: !ctx.actions.some(a => !a.success), spokenResponse, displayResponse, provider: result.provider || "AUTO", model: result.model || "" };
          } finally { release(); }
        }
        if (cmd.kind === "playing") {
          const s = await call("get_rabbit_hole_status");
          spokenResponse = s.nowPlaying ? `${s.nowPlaying.artist}, ${s.nowPlaying.title}.` : "Nothing is playing.";
        } else if (cmd.kind === "control") {
          const r = await call("control_roon", { control: cmd.control });
          if (!r.ok) throw new Error("Roon did not confirm the command.");
          spokenResponse = { pause: "Paused.", play: "Playing.", next: "Skipped.", previous: "Previous track.", stop: "Stopped." }[cmd.control];
        } else if (cmd.kind === "rating") {
          await call("rate_now_playing", { rating: cmd.rating }); spokenResponse = { love: "Loved.", good: "Rated good.", never: "Rejected." }[cmd.rating];
        } else if (cmd.kind === "queue" || cmd.kind === "send") {
          const state = await call("get_rabbit_hole_status");
          const input = { ...(state.zone?.id ? { zoneId: state.zone.id } : {}) };
          if (cmd.kind === "queue") input.count = cmd.count;
          else if (state.latestResultSource === "standby") input.count = state.standby?.count || 25;
          const r = await call(cmd.kind === "queue" ? "queue_standby_tracks" : "queue_rabbit_hole_tracks", input);
          spokenResponse = `Queued ${r.queuedCount || 0} tracks${state.zone?.name ? ` to ${state.zone.name}` : ""}.${r.failedCount ? ` ${r.failedCount} could not be queued.` : ""}`;
          return { success: (r.queuedCount || 0) > 0 && !r.failedCount, spokenResponse, displayResponse: spokenResponse, provider: "LOCAL", model: "direct" };
        } else if (cmd.kind === "refresh") {
          const r = await call("refresh_standby_pool", { reason: "manual-voice" });
          if (r.lastError) throw new Error("Standby refresh failed. The previous pool was retained.");
          spokenResponse = `Standby refreshed. ${r.count ?? r.tracks?.length ?? 0} tracks available.`;
        } else if (cmd.kind === "found") {
          const s = await call("get_rabbit_hole_status");
          spokenResponse = `Rabbit Hole has ${s.standby?.count || 0} standby tracks and ${s.session?.trackCount || 0} discovery results.`;
          displayResponse = spokenResponse + "\n" + (s.session?.topTracks || []).map(t => `${t.artist} — ${t.title}`).join("\n");
        }
        return { success: true, spokenResponse, displayResponse: displayResponse || spokenResponse, provider: "LOCAL", model: "direct" };
      });
      if (job.status !== "cancelled") Object.assign(job, result, { status: "completed" });
    } catch (error) {
      if (job.status !== "cancelled") Object.assign(job, { status: "failed", success: false,
        spokenResponse: "That command did not complete. Check Rabbit Hole before retrying.", displayResponse: "Command failed. Existing actions may have completed; no automatic retry was made." });
      // Do not expose backend errors (which may contain credential-bearing URLs) to a device.
    } finally {
      job.actions = ctx.actions; job.finishedAt = new Date().toISOString(); running.delete(job.id); execution.release(ctx); save();
    }
  }
  function cancel(deviceId, id) {
    const job = id ? jobs.get(id) : [...jobs.values()].reverse().find(j => j.deviceId === deviceId && !terminal.has(j.status));
    if (!job || job.deviceId !== deviceId) return null;
    if (!terminal.has(job.status)) {
      running.get(job.id)?.controller.abort(); Object.assign(job, { status: "cancelled", success: false,
        spokenResponse: "Cancelled. Actions already completed remain in place.", displayResponse: "Stopped further steps. An in-flight external action may still finish; completed actions are not undone." }); save();
    }
    return job;
  }
  return async function handle(req, res, url) {
    try {
      const device = devices.authenticate(req.headers.authorization);
      if (!device) return reply(res, 401, { error: "A valid Rabbit Hole device token is required." });
      if (req.method === "GET" && url.pathname === "/api/voice/status") {
        const status = await tools.get_rabbit_hole_status.handler({});
        return reply(res, 200, { connected: true, roon: Boolean(status.connected), ...availability(), activeZone: status.zone?.name || "", protocolVersion: 1 });
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/voice/jobs/")) {
        const job = jobs.get(url.pathname.slice("/api/voice/jobs/".length));
        return job?.deviceId === device.id ? reply(res, 200, view(job)) : reply(res, 404, { error: "Unknown request." });
      }
      if (req.method !== "POST") return reply(res, 405, { error: "Method not allowed." });
      const input = await body(req);
      if (url.pathname === "/api/voice/cancel") {
        const job = cancel(device.id, input.requestId);
        return reply(res, 200, job ? view(job) : { status: "completed", success: true, spokenResponse: "Nothing to cancel." });
      }
      if (url.pathname !== "/api/voice/command") return reply(res, 404, { error: "Unknown voice route." });
      const text = typeof input.text === "string" ? input.text.trim() : "";
      if (!text || text.length > 2000 || !/^[a-f0-9-]{36}$/i.test(input.requestId || "")) return reply(res, 400, { error: "text (1–2000 characters) and a UUID requestId are required." });
      const existing = jobs.get(input.requestId);
      if (existing) {
        if (existing.deviceId !== device.id || existing.text !== text) return reply(res, 409, { error: "Request ID already used." });
        return reply(res, terminal.has(existing.status) ? 200 : 202, view(existing));
      }
      if (intent(text).kind === "cancel") {
        const job = cancel(device.id); return reply(res, 200, job ? view(job) : { status: "completed", success: true, spokenResponse: "Nothing to cancel." });
      }
      if ([...jobs.values()].filter(j => !terminal.has(j.status)).length >= 8) return reply(res, 429, { error: "Voice service is busy." });
      // Retain IDs rather than silently permitting replay after a TTL. Fail closed at a generous limit.
      if (jobs.size >= 50000) return reply(res, 503, { error: "Voice request archive needs maintenance." });
      const job = { id: input.requestId, requestId: input.requestId, deviceId: device.id, text,
        status: "queued", createdAt: new Date().toISOString(), spokenResponse: "Rabbit Hole is working.", actions: [] };
      jobs.set(job.id, job); save();
      reply(res, 202, view(job)); setImmediate(() => { perform(job).catch(() => console.warn("Voice job persistence failed; check local storage.")); });
    } catch (error) { if (!res.headersSent) reply(res, error.status || 503, { error: error.status ? error.message : "Voice service unavailable." }); }
  };
}
module.exports = { createVoiceApi, intent };
