'use strict';

function toneFrame({ channels = 2, length = 2048, rate = 44100, hop = length / 2,
  bin = 20, amplitude = 0.2, phase = 0, rmsDb = 20 * Math.log10(amplitude / Math.SQRT2), sourceBits = 24 } = {}) {
  const bins = length / 2 + 1, bytes = Buffer.alloc(32 + channels * (16 + bins * 8));
  bytes.writeUInt32LE(1, 0); bytes.writeUInt32LE(channels, 4); bytes.writeUInt32LE(bins, 8); bytes.writeInt32LE(sourceBits, 12);
  bytes.writeFloatLE(rate / 2, 16); bytes.writeFloatLE(hop / rate, 20); bytes.writeFloatLE(2, 24);
  for (let channel = 0; channel < channels; channel++) {
    const base = 32 + channel * (16 + bins * 8);
    for (let i = 0; i < 4; i++) bytes.writeFloatLE(i >= 2 ? rmsDb : 20 * Math.log10(amplitude), base + i * 4);
    if (amplitude) { bytes.writeFloatLE(amplitude * Math.cos(phase) / 2, base + 16 + bin * 4);
      bytes.writeFloatLE(-amplitude * Math.sin(phase) / 2, base + 16 + (bins + bin) * 4); }
  }
  return bytes;
}

module.exports = { toneFrame };
