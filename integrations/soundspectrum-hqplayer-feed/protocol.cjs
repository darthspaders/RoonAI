'use strict';

// Signalyst's packed metering header and per-channel real/imaginary half
// spectra. This is a receive-only analysis protocol, not HQPlayer control.
const HEADER_BYTES = 32;
const MAX_BINS = 4097;
const MAX_WIRE_BYTES = 1024 * 1024;

function parseHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < HEADER_BYTES) throw Error('Incomplete HQPlayer analysis header.');
  const h = { version: buffer.readUInt32LE(0), channels: buffer.readUInt32LE(4),
    bins: buffer.readUInt32LE(8), sourceBits: buffer.readInt32LE(12),
    bandwidth: buffer.readFloatLE(16), hopSeconds: buffer.readFloatLE(20),
    transformGain: buffer.readFloatLE(24), reserved: buffer.readFloatLE(28) };
  const n = (h.bins - 1) * 2, rate = h.bandwidth * 2, exactHop = rate * h.hopSeconds;
  const fail = code => { const error = Error('Unsupported HQPlayer analysis format.'); error.code = code; error.header = h; throw error; };
  // Only a recognized layout gives authority to consume its complete body.
  // Never scan/resynchronize arbitrary bytes after an unknown header.
  if (h.version !== 1 || ![1, 2].includes(h.channels) || h.bins < 17 || h.bins > MAX_BINS ||
      (n & (n - 1)) !== 0) fail('HQP_UNKNOWN_LAYOUT');
  // Desktop emits sourceBits=0 between tracks while retaining valid transform
  // geometry. Bit depth describes the source, not the float-array encoding.
  // This exact case is accepted only as an inactive, forcibly silent source.
  if (![0, 1, 8, 16, 20, 24, 32, -32, -64].includes(h.sourceBits) ||
      !Number.isFinite(rate) || rate < 8000 || rate > 768000 || Math.abs(rate - Math.round(rate)) > 0.01 ||
      !Number.isFinite(h.hopSeconds) || h.hopSeconds < 0.001 || h.hopSeconds > 0.25 ||
      !Number.isFinite(h.transformGain) || h.transformGain <= 0 || h.transformGain > 64 ||
      !Number.isFinite(h.reserved) || Math.abs(exactHop - Math.round(exactHop)) > 0.05 ||
      Math.round(exactHop) < 1 || Math.round(exactHop) > n) fail('HQP_UNUSABLE_METADATA');
  return { ...h, sourceInactive: h.sourceBits === 0, transformLength: n, sourceRate: Math.round(rate), hop: Math.round(exactHop),
    frameBytes: HEADER_BYTES + h.channels * (16 + h.bins * 8) };
}

function formatKey(h) { return [h.channels, h.bins, h.sourceBits, h.sourceRate, h.hop, h.transformGain].join(':'); }

class MeterParser {
  constructor({ maxBytes = MAX_WIRE_BYTES } = {}) { this.maxBytes = maxBytes; this.clear(); }
  clear() { this.parts = []; this.offset = 0; this.bytes = 0; this.header = null; this.headerBytes = null; }
  get bufferedBytes() { return this.bytes + (this.header ? HEADER_BYTES : 0); }
  push(chunk) {
    if (!Buffer.isBuffer(chunk)) throw Error('Invalid HQPlayer analysis bytes.');
    if (!chunk.length) return;
    if (this.bufferedBytes + chunk.length > this.maxBytes || this.parts.length >= 1024) throw Error('HQPlayer analysis receive buffer exceeded its bound.');
    this.parts.push(Buffer.from(chunk)); this.bytes += chunk.length;
  }
  read(count) {
    const result = Buffer.allocUnsafe(count); let written = 0;
    while (written < count) {
      const first = this.parts[0], n = Math.min(count - written, first.length - this.offset);
      first.copy(result, written, this.offset, this.offset + n); written += n; this.offset += n; this.bytes -= n;
      if (this.offset === first.length) { this.parts.shift(); this.offset = 0; }
    }
    return result;
  }
  drain(limit = 8) {
    const frames = [];
    while (frames.length < limit) {
      if (!this.header) {
        if (this.bytes < HEADER_BYTES) break;
        this.headerBytes = this.read(HEADER_BYTES);
        try { this.header = parseHeader(this.headerBytes); }
        catch (error) {
          if (error.code !== 'HQP_UNUSABLE_METADATA') throw error;
          // Preserve framing but never synthesize an unusable metadata frame.
          // The supervisor limits consecutive discarded frames and duration.
          this.header = { ...error.header, transition: true,
            frameBytes: HEADER_BYTES + error.header.channels * (16 + error.header.bins * 8) };
        }
      }
      const bodyBytes = this.header.frameBytes - HEADER_BYTES;
      if (this.bytes < bodyBytes) break;
      frames.push({ header: this.header, bytes: Buffer.concat([this.headerBytes, this.read(bodyBytes)]) });
      this.header = null; this.headerBytes = null;
    }
    return frames;
  }
}

module.exports = { HEADER_BYTES, MAX_BINS, MAX_WIRE_BYTES, parseHeader, formatKey, MeterParser };
