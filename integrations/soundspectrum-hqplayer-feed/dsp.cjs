'use strict';

const { parseHeader, formatKey, HEADER_BYTES } = require('./protocol.cjs');
const OUTPUT_RATE = 44100;
const MAX_PCM_BYTES = 128 * 1024;

// Independent radix-2 inverse transform; no third-party FFT implementation.
function inverseFft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let size = 2; size <= n; size *= 2) {
    const angle = 2 * Math.PI / size, wr0 = Math.cos(angle), wi0 = Math.sin(angle);
    for (let base = 0; base < n; base += size) {
      let wr = 1, wi = 0;
      for (let j = 0; j < size / 2; j++) {
        const a = base + j, b = a + size / 2;
        const tr = wr * re[b] - wi * im[b], ti = wr * im[b] + wi * re[b];
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const next = wr * wr0 - wi * wi0; wi = wr * wi0 + wi * wr0; wr = next;
      }
    }
  }
  for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

class AnalysisDsp {
  constructor() { this.reset(); }
  reset() { this.key = ''; this.sequence = null; this.acc = []; this.weights = null; this.window = null; this.gains = []; this.position = 0; this.previous = [0, 0]; }
  configure(h) {
    this.key = formatKey(h); this.acc = Array.from({ length: h.channels }, () => new Float64Array(h.transformLength));
    this.weights = new Float64Array(h.transformLength); this.window = Float64Array.from({ length: h.transformLength }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / h.transformLength));
    this.gains = Array(h.channels).fill(null); this.position = 0; this.previous = [0, 0];
  }
  process(bytes, sequence) {
    const h = parseHeader(bytes);
    if (bytes.length !== h.frameBytes || !Number.isSafeInteger(sequence) || sequence < 0) throw Error('Malformed HQPlayer analysis frame.');
    const discontinuity = this.key !== formatKey(h) || this.sequence !== null && sequence !== this.sequence + 1;
    if (discontinuity || !this.key) { this.reset(); this.configure(h); }
    this.sequence = sequence;
    const blocks = [], targets = [];
    for (let channel = 0; channel < h.channels; channel++) {
      const start = HEADER_BYTES + channel * (16 + h.bins * 8), levels = [];
      for (let i = 0; i < 4; i++) {
        const level = bytes.readFloatLE(start + i * 4);
        if (Number.isNaN(level) || level === Infinity || level > 24) throw Error('Invalid HQPlayer analysis level.');
        levels.push(level);
      }
      const re = new Float64Array(h.transformLength), im = new Float64Array(h.transformLength); let energy = 0;
      for (let i = 0; i < h.bins; i++) {
        let real = bytes.readFloatLE(start + 16 + i * 4), imaginary = bytes.readFloatLE(start + 16 + (h.bins + i) * 4);
        if (!Number.isFinite(real) || !Number.isFinite(imaginary) || Math.abs(real) > 64 || Math.abs(imaginary) > 64) throw Error('Invalid HQPlayer transform coefficient.');
        if ((i === 0 || i === h.bins - 1) && Math.abs(imaginary) > 0.00001) throw Error('Unsupported HQPlayer transform endpoints.');
        // Downsampling must not fold ultrasonic analysis into audible bands.
        // Taper the already available spectrum before inverse synthesis.
        if (h.sourceRate > OUTPUT_RATE) {
          const frequency = i * h.sourceRate / h.transformLength;
          const attenuation = frequency >= OUTPUT_RATE / 2 ? 0 : frequency > 20000 ? 0.5 + 0.5 * Math.cos(Math.PI * (frequency - 20000) / (OUTPUT_RATE / 2 - 20000)) : 1;
          real *= attenuation; imaginary *= attenuation;
        }
        re[i] = real; im[i] = imaginary;
        energy += real * real + imaginary * imaginary;
        if (i && i !== h.bins - 1) { re[h.transformLength - i] = real; im[h.transformLength - i] = -imaginary; }
      }
      if (!h.sourceInactive) inverseFft(re, im);
      const levelTarget = Number.isFinite(levels[2]) ? Math.min(0.5, 0.5 * Math.pow(10, levels[2] / 20)) : 0;
      const target = !h.sourceInactive && energy > 1e-20 && levelTarget >= 0.000001 ? levelTarget : 0;
      targets.push(target);
      if (!target) { this.acc[channel].fill(0); this.previous[channel] = 0; }
      const scale = h.transformLength / h.transformGain;
      for (let i = 0; i < h.transformLength; i++) this.acc[channel][i] += target >= 0.000001 ? re[i] * scale * this.window[i] : 0;
    }
    for (let i = 0; i < h.transformLength; i++) this.weights[i] += this.window[i] * this.window[i];
    for (let channel = 0; channel < h.channels; channel++) {
      const values = new Float64Array(h.hop); let squares = 0;
      for (let i = 0; i < h.hop; i++) { const value = this.weights[i] > 0.02 ? this.acc[channel][i] / this.weights[i] : 0; values[i] = value; squares += value * value; }
      const rms = Math.sqrt(squares / h.hop), desired = rms > 1e-8 && targets[channel] > 0 ? Math.min(4, targets[channel] / rms) : 0;
      const smooth = 1 - Math.exp(-h.hopSeconds / 0.1);
      const gain = this.gains[channel] === null ? desired : this.gains[channel] + smooth * (desired - this.gains[channel]);
      this.gains[channel] = gain;
      // Silence is authoritative; held overlap or numeric residue cannot raise it.
      for (let i = 0; i < h.hop; i++) values[i] = targets[channel] > 0 ? Math.max(-0.9, Math.min(0.9, values[i] * gain)) : 0;
      blocks.push(values);
      this.acc[channel].copyWithin(0, h.hop); this.acc[channel].fill(0, h.transformLength - h.hop);
    }
    this.weights.copyWithin(0, h.hop); this.weights.fill(0, h.transformLength - h.hop);
    const left = blocks[0], right = blocks[1] || left, ratio = h.sourceRate / OUTPUT_RATE;
    const capacity = Math.ceil((h.hop + 1) / ratio) + 2;
    if (capacity * 4 > MAX_PCM_BYTES) throw Error('Derived HQPlayer PCM block exceeded its bound.');
    const pcm = Buffer.allocUnsafe(capacity * 4); let frames = 0;
    while (this.position < h.hop - 1) {
      const low = Math.floor(this.position), fraction = this.position - low;
      for (let c = 0; c < 2; c++) {
        const values = c ? right : left, a = low < 0 ? this.previous[c] : values[low], b = values[low + 1];
        const sample = Math.max(-0.9, Math.min(0.9, a + (b - a) * fraction));
        pcm.writeInt16LE(Math.round(sample * 32767), frames * 4 + c * 2);
      }
      frames++; this.position += ratio;
    }
    this.position -= h.hop; this.previous = [left[h.hop - 1], right[h.hop - 1]];
    return { pcm: pcm.subarray(0, frames * 4), header: h, discontinuity };
  }
}

module.exports = { AnalysisDsp, inverseFft, OUTPUT_RATE, MAX_PCM_BYTES };
