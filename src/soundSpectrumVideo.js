"use strict";

const WebSocket = require("ws");
const PATH = "/api/soundspectrum/frames";
const HEADER_BYTES = 20;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;

function packet(frame, sequence, generation, capturedAt) {
  const header = Buffer.alloc(HEADER_BYTES);
  header.write("RHSS", 0, "ascii");
  header.writeUInt32BE(sequence >>> 0, 4);
  header.writeUInt32BE(generation >>> 0, 8);
  header.writeDoubleBE(capturedAt, 12);
  return Buffer.concat([header, frame]);
}

// One JPEG may be in flight until the browser has decoded and presented it.
// While it does so, only the newest capture is kept. This bounds latency at the
// browser as well as at the socket; slow viewers cannot stall native capture.
function attachSoundSpectrumVideo(server, { service, requestOrigin, clock = Date.now, ackTimeoutMs = 4000 } = {}) {
  const sockets = new Map();
  const wsServer = new WebSocket.Server({ noServer: true, clientTracking: false, perMessageDeflate: false, maxPayload: 64 });
  let sequence = 0, latest = null, ending = false;
  const close = client => { sockets.delete(client.socket); client.socket.terminate(); };
  function authorized(client) {
    try { service.authorizeVideo(client.viewerId); return true; } catch { close(client); return false; }
  }
  function send(client) {
    if (!latest || client.awaiting || latest.sequence === client.sent || !authorized(client)) return;
    if (client.socket.readyState !== WebSocket.OPEN || client.socket.bufferedAmount > MAX_FRAME_BYTES + HEADER_BYTES) { close(client); return; }
    client.awaiting = latest.sequence; client.sent = latest.sequence; client.sentAt = clock();
    client.socket.send(latest.packet, { binary: true, compress: false }, error => { if (error) close(client); });
  }
  const unsubscribe = service.onVideo(event => {
    if (ending) return;
    if (event.type === "frame") {
      sequence = sequence % 0xffffffff + 1;
      latest = { sequence, packet: packet(event.frame, sequence, event.generation, event.capturedAt) };
      for (const client of sockets.values()) send(client);
    } else {
      latest = null;
      for (const client of sockets.values()) {
        if (["idle", "error"].includes(event.state) || !authorized(client)) close(client);
        else if (client.socket.readyState === WebSocket.OPEN) client.socket.send(JSON.stringify({ state: event.state, generation: event.generation }), { compress: false });
      }
    }
  });
  function reject(socket, code) { socket.end(`HTTP/1.1 ${code} ${code === 403 ? "Forbidden" : "Unavailable"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); }
  function upgrade(req, socket, head) {
    let url;
    try { url = new URL(req.url, `http://${req.headers.host}`); } catch { reject(socket, 400); return; }
    if (url.pathname !== PATH) { reject(socket, 404); return; }
    if (ending || req.method !== "GET") { reject(socket, 503); return; }
    if (req.headers["sec-fetch-site"] === "cross-site" || req.headers.origin !== requestOrigin(req, url)) { reject(socket, 403); return; }
    const viewerId = url.searchParams.get("viewerId");
    let current;
    try { current = service.authorizeVideo(viewerId); } catch { reject(socket, 403); return; }
    // A second connection for this lease replaces only its own media connection.
    for (const client of sockets.values()) if (client.viewerId === viewerId) close(client);
    socket.setNoDelay(true);
    wsServer.handleUpgrade(req, socket, head, ws => {
      const client = { socket: ws, viewerId, awaiting: 0, sent: 0, sentAt: 0 };
      sockets.set(ws, client);
      ws.on("error", () => close(client));
      ws.on("close", () => sockets.delete(ws));
      ws.on("message", (data, isBinary) => {
        // ws 7 emits strings for text; later releases include isBinary=false.
        if (isBinary === true || typeof data !== "string" && isBinary !== false || Buffer.byteLength(data) > 64) { close(client); return; }
        let message; try { message = JSON.parse(data.toString()); } catch { close(client); return; }
        if (!Number.isInteger(message?.ack) || !client.awaiting || message.ack !== client.awaiting) return;
        client.awaiting = 0;
        send(client);
      });
      if (!latest && current.frame) {
        sequence = sequence % 0xffffffff + 1;
        latest = { sequence, packet: packet(current.frame, sequence, current.generation, current.capturedAt) };
      }
      send(client);
    });
  }
  const sweep = setInterval(() => {
    for (const client of sockets.values()) if (!authorized(client) || client.awaiting && clock() - client.sentAt > ackTimeoutMs) close(client);
  }, 500);
  sweep.unref?.();
  function stop() {
    if (ending) return;
    ending = true; clearInterval(sweep); unsubscribe(); server.removeListener("upgrade", upgrade);
    for (const client of sockets.values()) close(client);
    wsServer.close();
  }
  server.on("upgrade", upgrade); server.once("close", stop);
  return { close: stop, size: () => sockets.size };
}

module.exports = { attachSoundSpectrumVideo, packet, PATH, HEADER_BYTES };
