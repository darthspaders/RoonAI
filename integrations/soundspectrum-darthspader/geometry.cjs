"use strict";

// Original hand-drawn lowercase outlines. No font, image or factory geometry is
// imported. Units use y-up, baseline 0, x-height 1, ascender 1.5, descender -.44.
const GLYPHS = {
  d: {
    width: 0.88,
    contours: [
      [[0.88, 0], [0.23, 0], [0.08, 0.12], [0, 0.32], [0, 0.69], [0.08, 0.88], [0.23, 1], [0.5, 1], [0.7, 0.92], [0.7, 1.5], [0.88, 1.5]],
      [[0.18, 0.29], [0.24, 0.2], [0.35, 0.16], [0.52, 0.16], [0.64, 0.24], [0.7, 0.36], [0.7, 0.64], [0.64, 0.76], [0.52, 0.84], [0.35, 0.84], [0.24, 0.77], [0.18, 0.65]]
    ]
  },
  a: {
    width: 0.9,
    contours: [
      [[0.9, 0], [0.76, 0], [0.7, 0.1], [0.54, 0], [0.24, 0], [0.08, 0.12], [0, 0.32], [0, 0.69], [0.08, 0.89], [0.24, 1], [0.53, 1], [0.71, 0.9], [0.72, 1], [0.9, 1]],
      [[0.18, 0.29], [0.24, 0.2], [0.35, 0.16], [0.53, 0.16], [0.65, 0.24], [0.71, 0.36], [0.71, 0.65], [0.64, 0.77], [0.52, 0.84], [0.35, 0.84], [0.24, 0.77], [0.18, 0.65]]
    ]
  },
  r: {
    width: 0.64,
    contours: [
      [[0, 0], [0.18, 0], [0.18, 0.63], [0.24, 0.76], [0.34, 0.83], [0.46, 0.83], [0.55, 0.78], [0.64, 0.92], [0.49, 1], [0.32, 1], [0.18, 0.91], [0.18, 1], [0, 1]]
    ]
  },
  t: {
    width: 0.61,
    contours: [
      [[0.28, 0], [0.19, 0.04], [0.14, 0.15], [0.14, 0.83], [0, 0.83], [0, 1], [0.14, 1], [0.14, 1.34], [0.32, 1.34], [0.32, 1], [0.59, 1], [0.59, 0.83], [0.32, 0.83], [0.32, 0.24], [0.36, 0.18], [0.47, 0.17], [0.55, 0.2], [0.61, 0.06], [0.49, 0]]
    ]
  },
  h: {
    width: 0.8,
    contours: [
      [[0, 0], [0.18, 0], [0.18, 0.63], [0.24, 0.76], [0.35, 0.83], [0.48, 0.83], [0.59, 0.76], [0.62, 0.63], [0.62, 0], [0.8, 0], [0.8, 0.65], [0.75, 0.82], [0.64, 0.95], [0.49, 1], [0.35, 1], [0.18, 0.91], [0.18, 1.5], [0, 1.5]]
    ]
  },
  s: {
    width: 0.8,
    contours: [
      [[0.79, 0.84], [0.65, 0.96], [0.49, 1], [0.23, 1], [0.07, 0.91], [0, 0.75], [0.04, 0.6], [0.16, 0.48], [0.54, 0.35], [0.62, 0.26], [0.57, 0.18], [0.42, 0.15], [0.22, 0.17], [0.09, 0.26], [0, 0.12], [0.17, 0.03], [0.39, 0], [0.59, 0.04], [0.75, 0.16], [0.8, 0.3], [0.76, 0.44], [0.62, 0.54], [0.25, 0.66], [0.17, 0.73], [0.21, 0.8], [0.34, 0.84], [0.53, 0.83], [0.68, 0.74]]
    ]
  },
  p: {
    width: 0.84,
    contours: [
      [[0, -0.44], [0.18, -0.44], [0.18, 0.09], [0.31, 0], [0.57, 0], [0.73, 0.12], [0.84, 0.31], [0.84, 0.68], [0.73, 0.89], [0.57, 1], [0.31, 1], [0.18, 0.9], [0.18, 1], [0, 1]],
      [[0.18, 0.35], [0.24, 0.24], [0.35, 0.16], [0.53, 0.16], [0.64, 0.24], [0.67, 0.35], [0.67, 0.65], [0.64, 0.76], [0.53, 0.84], [0.35, 0.84], [0.24, 0.76], [0.18, 0.65]]
    ]
  },
  e: {
    width: 0.8,
    contours: [
      [[0.78, 0.28], [0.66, 0.12], [0.49, 0.03], [0.26, 0], [0.1, 0.1], [0, 0.3], [0, 0.69], [0.11, 0.9], [0.28, 1], [0.53, 1], [0.71, 0.89], [0.8, 0.7], [0.8, 0.43], [0.18, 0.43], [0.2, 0.3], [0.28, 0.19], [0.42, 0.16], [0.55, 0.19], [0.65, 0.3]],
      [[0.18, 0.6], [0.18, 0.69], [0.26, 0.8], [0.37, 0.84], [0.51, 0.84], [0.61, 0.78], [0.65, 0.67], [0.65, 0.6]]
    ]
  }
};

const WORD = "darthspader";
const LETTER_GAP = 0.24;
const WORD_WIDTH = [...WORD].reduce((sum, letter) => sum + GLYPHS[letter].width, 0) + (WORD.length - 1) * LETTER_GAP;
const ROW_INTERVALS = 96;
const NATIVE_STEPS = 160;
const WARP_CONTROLS = 48;
const PCM_GAIN = 4;
const PCM_WARP = 0.28;
const FFT_GAIN = 3;
const FFT_WARP = 0.10;
const MAX_DEFORMATION = PCM_WARP + FFT_WARP;

function length(a, b) { return Math.hypot(b[0] - a[0], b[1] - a[1]); }

function sampleClosedContour(vertices, intervals = ROW_INTERVALS) {
  const segments = vertices.map((point, index) => length(point, vertices[(index + 1) % vertices.length]));
  const perimeter = segments.reduce((sum, value) => sum + value, 0);
  const points = [];
  let segment = 0;
  let before = 0;
  for (let index = 0; index < intervals; index += 1) {
    const distance = perimeter * index / intervals;
    while (segment < segments.length - 1 && distance > before + segments[segment]) {
      before += segments[segment++];
    }
    const ratio = (distance - before) / segments[segment];
    const a = vertices[segment];
    const b = vertices[(segment + 1) % vertices.length];
    points.push([a[0] + ratio * (b[0] - a[0]), a[1] + ratio * (b[1] - a[1])]);
  }
  const normals = points.map((point, index) => {
    const beforePoint = points[(index + intervals - 1) % intervals];
    const afterPoint = points[(index + 1) % intervals];
    const dx = afterPoint[0] - beforePoint[0];
    const dy = afterPoint[1] - beforePoint[1];
    const magnitude = Math.hypot(dx, dy) || 1;
    return [-dy / magnitude, dx / magnitude];
  });
  points.push([...points[0]]);
  normals.push([...normals[0]]);
  return { points, normals, perimeter };
}

function createGeometry(word = WORD) {
  const width = [...word].reduce((sum, letter) => sum + GLYPHS[letter].width, 0) + (word.length - 1) * LETTER_GAP;
  const yCenter = (1.5 - 0.44) / 2;
  const contours = [];
  const letters = [];
  let x = -width / 2;
  [...word].forEach((letter, index) => {
    const glyph = GLYPHS[letter];
    letters.push({ letter, index, left: x, right: x + glyph.width });
    glyph.contours.forEach((vertices, contourIndex) => {
      const shifted = vertices.map(([vx, vy]) => [vx + x, vy - yCenter]);
      contours.push({ letter, letterIndex: index, counter: contourIndex > 0, ...sampleClosedContour(shifted) });
    });
    x += glyph.width + LETTER_GAP;
  });
  return { word, width, halfWidth: width / 2, halfHeight: (1.5 + 0.44) / 2, contours, letters };
}

function interpolateRow(row, s) {
  const position = Math.max(0, Math.min(1, s)) * (row.length - 1);
  const index = Math.min(row.length - 2, Math.floor(position));
  const ratio = position - index;
  return row[index].map((value, component) => value + ratio * (row[index + 1][component] - value));
}

function createAudioWarp({ sampleAt = () => 0, spectrumAt = () => 0 } = {}) {
  const clamp = (value) => Math.max(0, Math.min(1, value));
  const raw = Array.from({ length: WARP_CONTROLS }, (_, index) => {
    const u = index / (WARP_CONTROLS - 1);
    const pcm = PCM_GAIN * sampleAt(u);
    const signedPcm = pcm / (1 + Math.abs(pcm));
    const spectralContrast = clamp(FFT_GAIN * spectrumAt(0.02 + 0.9 * u)) - clamp(FFT_GAIN * spectrumAt(0.02 + 0.9 * (1 - u)));
    return PCM_WARP * signedPcm + FFT_WARP * spectralContrast;
  });
  // Three-tap spatial filtering limits steep single-bin spikes. It does not
  // average across frames or insert a clock: the field changes with live audio.
  return raw.map((value, index) => [0.25 * raw[Math.max(0, index - 1)] + 0.5 * value + 0.25 * raw[Math.min(raw.length - 1, index + 1)]]);
}

function deformPoint(contour, s, warp, width = WORD_WIDTH) {
  const position = interpolateRow(contour.points, s);
  if (!warp) return position;
  const u = (position[0] + width / 2) / width;
  // All contours use the SAME original-x field. In the continuous geometry,
  // x'=x, y'=y+F(x) is bijective and moves a bowl and its counter together.
  return [position[0], position[1] + interpolateRow(warp, u)[0]];
}

module.exports = { GLYPHS, WORD, LETTER_GAP, ROW_INTERVALS, NATIVE_STEPS, WARP_CONTROLS, PCM_GAIN, PCM_WARP, FFT_GAIN, FFT_WARP, MAX_DEFORMATION, sampleClosedContour, createGeometry, interpolateRow, createAudioWarp, deformPoint };
