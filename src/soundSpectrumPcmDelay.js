"use strict";

// A causal delay for the disposable visual PCM branch only. The caller supplies
// already paced stereo S16LE, including silence, and advances skipped time.
const MAX_DELAY_MS = 5000;
const SAMPLE_RATE = 44100;
const FRAME_BYTES = 4;

function validateDelayMs(value) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_DELAY_MS) {
    throw new RangeError(`Choose a visual delay from 0 through ${MAX_DELAY_MS} milliseconds.`);
  }
  return value;
}

class PcmDelay {
  constructor({ delayMs = 0 } = {}) {
    this.capacityFrames = SAMPLE_RATE * MAX_DELAY_MS / 1000;
    this.storage = null;
    this.head = 0;
    this.delayMs = 0;
    this.delayFrames = 0;
    this.advancedFrames = 0;
    this.setDelayMs(delayMs);
  }
  snapshot() {
    const bufferedFrames = Math.min(this.delayFrames, this.advancedFrames);
    return { delayMs: this.delayMs, delayFrames: this.delayFrames,
      effectiveDelayMs: this.delayFrames * 1000 / SAMPLE_RATE,
      bufferedFrames, bufferedBytes: bufferedFrames * FRAME_BYTES,
      primingFrames: this.delayFrames - bufferedFrames,
      capacityBytes: this.storage?.length || 0 };
  }
  zero(start, frames) {
    if (!frames) return;
    const first = Math.min(frames, this.capacityFrames - start);
    this.storage.fill(0, start * FRAME_BYTES, (start + first) * FRAME_BYTES);
    if (frames > first) this.storage.fill(0, 0, (frames - first) * FRAME_BYTES);
  }
  setDelayMs(value, { reset = false } = {}) {
    validateDelayMs(value);
    const frames = Math.round(value * SAMPLE_RATE / 1000);
    if (!frames) {
      this.delayMs = 0; this.delayFrames = 0; this.storage = null;
      this.head = 0; this.advancedFrames = 0;
      return this.snapshot();
    }
    if (!this.storage) this.storage = Buffer.alloc(this.capacityFrames * FRAME_BYTES);
    const difference = frames - this.delayFrames;
    if (difference > 0) {
      // Increasing adds silence before queued PCM; it never replays previously
      // emitted history. Decreasing skips the oldest pending visual samples.
      this.head = (this.head - difference + this.capacityFrames) % this.capacityFrames;
      this.zero(this.head, difference);
    } else if (difference < 0) {
      this.zero(this.head, -difference);
      this.head = (this.head - difference) % this.capacityFrames;
    }
    this.advancedFrames = Math.min(this.advancedFrames, frames);
    this.delayMs = value; this.delayFrames = frames;
    if (reset) this.reset();
    return this.snapshot();
  }
  reset() {
    this.storage?.fill(0); this.head = 0; this.advancedFrames = 0;
  }
  process(input) {
    if (!Buffer.isBuffer(input) || input.length % FRAME_BYTES) throw new TypeError("Visual PCM must contain complete stereo S16LE frames.");
    if (!this.delayFrames || !input.length) return input;
    const result = Buffer.allocUnsafe(input.length);
    let frame = 0, remaining = input.length / FRAME_BYTES;
    while (remaining) {
      const tail = (this.head + this.delayFrames) % this.capacityFrames;
      // Limit each copy to the queue length: new input must never overwrite
      // samples that a later copy in this same block still needs to emit.
      const count = Math.min(remaining, this.delayFrames, this.capacityFrames - this.head, this.capacityFrames - tail);
      this.storage.copy(result, frame * FRAME_BYTES, this.head * FRAME_BYTES, (this.head + count) * FRAME_BYTES);
      input.copy(this.storage, tail * FRAME_BYTES, frame * FRAME_BYTES, (frame + count) * FRAME_BYTES);
      this.head = (this.head + count) % this.capacityFrames;
      frame += count; remaining -= count;
    }
    this.advancedFrames = Math.min(this.delayFrames, this.advancedFrames + frame);
    return result;
  }
  skipFrames(frames) {
    if (!Number.isSafeInteger(frames) || frames < 0) throw new RangeError("Skipped visual frames must be a nonnegative integer.");
    if (!frames || !this.delayFrames) return;
    if (frames >= this.delayFrames) {
      // Everything previously queued is now expired. Missing input is silence;
      // do not replay the old queue when the writer/pacer becomes available.
      this.storage.fill(0);
      this.head = (this.head + frames % this.capacityFrames) % this.capacityFrames;
    } else {
      const tail = (this.head + this.delayFrames) % this.capacityFrames;
      this.zero(tail, frames);
      this.head = (this.head + frames) % this.capacityFrames;
    }
    this.advancedFrames = Math.min(this.delayFrames, this.advancedFrames + frames);
  }
}

module.exports = { PcmDelay, validateDelayMs, MAX_DELAY_MS, SAMPLE_RATE, FRAME_BYTES };
