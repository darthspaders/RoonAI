"use strict";

// Original y-up stroke geometry. No image, font outline or factory path is read.
const STEPS = 3, BAND_COUNT = 26, BAR_ROWS = 16;
const ATTACK_SECONDS = .045, RELEASE_SECONDS = .24, MAX_FRAME_SECONDS = .05;
const PEAK_GAIN = 1.25;
const PEN = Object.freeze({ black: 0, ink: 32 / 255, cyan: 96 / 255, green: 144 / 255,
  yellow: 184 / 255, amber: 218 / 255, red: 242 / 255, white: 1 });
const PRESETS = Object.freeze([
  Object.freeze({ id: "emerald-vu", name: "Rabbit Hole - Emerald VU", kind: "analog", groups: 1,
    colors: ["#000000", "#123704", "#28b812", "#39f318", "#efbd42", "#ffd060", "#ff3030", "#f5ffe9"] }),
  Object.freeze({ id: "twin-cyan-vu", name: "Rabbit Hole - Twin Cyan VU", kind: "analog", groups: 2,
    colors: ["#000000", "#123b48", "#55dfff", "#b1f4ff", "#e1f7ff", "#ffd17a", "#ff6872", "#effcff"] }),
  Object.freeze({ id: "prism-spectrum", name: "Rabbit Hole - Prism Spectrum", kind: "spectrum", groups: BAND_COUNT,
    colors: ["#000000", "#12323e", "#43cfff", "#5bea92", "#f5df6b", "#ffa969", "#ff5e76", "#f4fbff"] })
]);
const ANCHORS = [0, 32, 96, 144, 184, 218, 242, 255];

// Each glyph is a few separately penned polylines, drawn here on a unit grid.
// These deliberately simple shapes are ours, rather than installed font data.
const GLYPHS = {
  A: [[[0, 0], [.5, 1], [1, 0]], [[.2, .4], [.8, .4]]],
  B: [[[0, 0], [0, 1], [.65, 1], [.92, .8], [.65, .55], [0, .55]], [[.65, .55], [1, .3], [.75, 0], [0, 0]]],
  C: [[[1, .85], [.7, 1], [.22, 1], [0, .75], [0, .25], [.22, 0], [.7, 0], [1, .15]]],
  D: [[[0, 0], [0, 1], [.6, 1], [1, .75], [1, .25], [.6, 0], [0, 0]]],
  E: [[[1, 1], [0, 1], [0, 0], [1, 0]], [[0, .5], [.8, .5]]],
  G: [[[1, .85], [.7, 1], [.22, 1], [0, .75], [0, .25], [.22, 0], [1, 0], [1, .45], [.6, .45]]],
  H: [[[0, 0], [0, 1]], [[1, 0], [1, 1]], [[0, .5], [1, .5]]],
  I: [[[.2, 1], [.8, 1]], [[.5, 1], [.5, 0]], [[.2, 0], [.8, 0]]],
  L: [[[0, 1], [0, 0], [1, 0]]],
  M: [[[0, 0], [0, 1], [.5, .45], [1, 1], [1, 0]]],
  N: [[[0, 0], [0, 1], [1, 0], [1, 1]]],
  O: [[[.22, 0], [0, .25], [0, .75], [.22, 1], [.78, 1], [1, .75], [1, .25], [.78, 0], [.22, 0]]],
  P: [[[0, 0], [0, 1], [.75, 1], [1, .75], [.75, .5], [0, .5]]],
  R: [[[0, 0], [0, 1], [.75, 1], [1, .75], [.75, .5], [0, .5]], [[.5, .5], [1, 0]]],
  S: [[[1, .85], [.75, 1], [.2, 1], [0, .8], [.2, .55], [.8, .45], [1, .2], [.8, 0], [.2, 0], [0, .15]]],
  T: [[[0, 1], [1, 1]], [[.5, 1], [.5, 0]]],
  U: [[[0, 1], [0, .2], [.2, 0], [.8, 0], [1, .2], [1, 1]]],
  V: [[[0, 1], [.5, 0], [1, 1]]],
  W: [[[0, 1], [.2, 0], [.5, .5], [.8, 0], [1, 1]]],
  Y: [[[0, 1], [.5, .5], [1, 1]], [[.5, .5], [.5, 0]]],
  "0": [[[.2, 0], [0, .2], [0, .8], [.2, 1], [.8, 1], [1, .8], [1, .2], [.8, 0], [.2, 0]]],
  "1": [[[.2, .8], [.5, 1], [.5, 0]], [[.2, 0], [.8, 0]]],
  "2": [[[0, .8], [.2, 1], [.8, 1], [1, .8], [1, .65], [0, 0], [1, 0]]],
  "3": [[[0, 1], [.8, 1], [1, .75], [.65, .5], [1, .25], [.8, 0], [0, 0]], [[.35, .5], [.65, .5]]],
  "4": [[[.8, 0], [.8, 1], [0, .35], [1, .35]]],
  "5": [[[1, 1], [0, 1], [0, .55], [.8, .55], [1, .3], [.8, 0], [0, 0]]],
  "6": [[[1, .9], [.75, 1], [.2, 1], [0, .75], [0, .2], [.2, 0], [.8, 0], [1, .2], [1, .45], [.8, .6], [0, .6]]],
  "7": [[[0, 1], [1, 1], [.25, 0]]],
  "8": [[[.2, .5], [0, .75], [.2, 1], [.8, 1], [1, .75], [.8, .5], [.2, .5], [0, .25], [.2, 0], [.8, 0], [1, .25], [.8, .5]]],
  "9": [[[1, .4], [.2, .4], [0, .6], [0, .8], [.2, 1], [.8, 1], [1, .8], [1, .2], [.8, 0], [.1, 0]]],
  "-": [[[.1, .5], [.9, .5]]], "+": [[[.1, .5], [.9, .5]], [[.5, .15], [.5, .85]]]
};
const clamp = value => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const bandPositions = () => Array.from({ length: BAND_COUNT }, (_, index) => .008 * (.92 / .008) ** (index / (BAND_COUNT - 1)));
const radians = degrees => degrees * Math.PI / 180;
const polar = (cx, cy, radius, degrees) => [cx + radius * Math.cos(radians(degrees)), cy + radius * Math.sin(radians(degrees))];

function addLine(segments, a, b, options = {}) {
  segments.push({ points: [a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], b],
    kind: 0, control: 0, threshold: 0, pen: PEN.cyan, center: [0, 0], width: .008, role: "fixed", overload: false, ...options });
}
function addPolyline(segments, points, options) {
  for (let index = 1; index < points.length; index++) addLine(segments, points[index - 1], points[index], options);
}
function addLabel(segments, text, cx, baseline, height, pen = PEN.white) {
  const glyphWidth = height * .56, advance = glyphWidth * 1.45;
  const start = cx - (text.length * advance - (advance - glyphWidth)) / 2;
  [...text].forEach((letter, index) => {
    if (letter === " ") return;
    if (!GLYPHS[letter]) throw Error("Unsupported original stroke glyph: " + letter);
    for (const stroke of GLYPHS[letter]) addPolyline(segments, stroke.map(([x, y]) => [start + index * advance + x * glyphWidth, baseline + y * height]), { pen, role: "label", width: height * .045 });
  });
}
function addArc(segments, cx, cy, radius, start, end, steps, options) {
  addPolyline(segments, Array.from({ length: steps + 1 }, (_, index) => polar(cx, cy, radius, start + (end - start) * index / steps)), options);
}
function addFrame(segments, cx, bottom, halfWidth, top) {
  const corner = .055;
  addPolyline(segments, [[cx - halfWidth + corner, bottom], [cx + halfWidth - corner, bottom], [cx + halfWidth, bottom + corner],
    [cx + halfWidth, top - corner], [cx + halfWidth - corner, top], [cx - halfWidth + corner, top],
    [cx - halfWidth, top - corner], [cx - halfWidth, bottom + corner], [cx - halfWidth + corner, bottom]], { pen: PEN.ink, width: .009, role: "frame" });
}
function addMeter(segments, { cx, cy, radius, control, scale, label, emerald }) {
  const color = emerald ? PEN.green : PEN.cyan;
  addArc(segments, cx, cy, radius, 150, 56.4, 48, { pen: color, width: (emerald ? .05 : .012) * scale, role: "scale" });
  addArc(segments, cx, cy, radius, 56.4, 30, 14, { pen: emerald ? PEN.red : color, width: (emerald ? .05 : .012) * scale, role: "scale-hot" });
  addArc(segments, cx, cy, radius - .025 * scale, 150, 30, 58, { pen: color, width: .004 * scale, role: "scale" });
  for (let index = 0; index <= 30; index++) {
    const major = index % 5 === 0, angle = 150 - 120 * index / 30;
    addLine(segments, polar(cx, cy, radius + .014 * scale, angle), polar(cx, cy, radius + (major ? .13 : .074) * scale, angle),
      { pen: emerald && index >= 24 ? PEN.red : color, width: (emerald ? major ? .016 : .01 : major ? .009 : .005) * scale, role: "tick" });
  }
  // Relative analysis scale, deliberately no unverified dB/Hz calibration.
  for (const [value, position] of [["0", 0], ["25", .25], ["50", .5], ["75", .75], ["100", 1]]) {
    const [x, y] = polar(cx, cy, radius + .22 * scale, 150 - 120 * position);
    addLabel(segments, value, x, y - .043 * scale, .084 * scale, emerald && position >= .8 ? PEN.red : PEN.white);
  }
  const needle = { kind: 1, control, center: [cx, cy], pen: emerald ? PEN.amber : PEN.white, width: .005 * scale, role: "needle", overload: emerald };
  const length = radius - .04 * scale, tail = -.055 * scale, thickness = .011 * scale;
  addPolyline(segments, [[tail, -thickness], [length, 0], [tail, thickness], [tail, -thickness]], needle);
  addLine(segments, [tail, 0], [length, 0], needle);
  addArc(segments, cx, cy, .048 * scale, 0, 360, 16, { pen: PEN.white, width: .009 * scale, role: "hub" });
  addLabel(segments, label, cx, cy - .18 * scale, .1 * scale, color);
}

function createGeometry(id) {
  const preset = PRESETS.find(value => value.id === id);
  if (!preset) throw Error("Unknown meter preset: " + id);
  const segments = [];
  if (id === "emerald-vu") {
    addFrame(segments, 0, -.68, 1.49, .98);
    addMeter(segments, { cx: 0, cy: -.38, radius: 1.04, control: 0, scale: 1, label: "VU", emerald: true });
    addLabel(segments, "EMERALD VU", 0, -.88, .12, PEN.green);
  } else if (id === "twin-cyan-vu") {
    for (const [control, cx, label] of [[0, -.86, "LOW"], [1, .86, "HIGH"]]) {
      addFrame(segments, cx, -.62, .8, .69);
      addMeter(segments, { cx, cy: -.34, radius: .61, control, scale: .58, label: "VU", emerald: false });
      addLabel(segments, label, cx, .51, .105, PEN.cyan);
    }
    addLabel(segments, "TWIN CYAN VU", 0, -.85, .12, PEN.cyan);
  } else {
    const left = -1.5, step = 3 / BAND_COUNT, baseline = -.52, spacing = .071;
    for (let band = 0; band < BAND_COUNT; band++) for (let row = 0; row < BAR_ROWS; row++) {
      const cx = left + (band + .5) * step, y = baseline + row * spacing;
      const pen = row < 4 ? PEN.cyan : row < 9 ? PEN.green : row < 12 ? PEN.yellow : row < 14 ? PEN.amber : PEN.red;
      addLine(segments, [cx - step * .25, y], [cx + step * .25, y],
        { kind: 2, control: band, threshold: (row + 1) / BAR_ROWS, pen, width: .045, role: "bar" });
    }
    addLine(segments, [-1.55, -.59], [1.55, -.59], { pen: PEN.ink, role: "baseline" });
    addLabel(segments, "LOW", -1.13, -.76, .1, PEN.cyan); addLabel(segments, "MID", 0, -.76, .1, PEN.green);
    addLabel(segments, "HIGH", 1.12, -.76, .1, PEN.red);
    addLabel(segments, "PRISM SPECTRUM", 0, .72, .12, PEN.white);
  }
  const halfWidth = id === "twin-cyan-vu" ? 1.71 : 1.58, halfHeight = id === "emerald-vu" ? 1.03 : .93;
  return { preset, segments, halfWidth, halfHeight, nativePointsPerFrame: segments.length * STEPS };
}

function smoothLevels(previous, target, seconds, attack = ATTACK_SECONDS, release = RELEASE_SECONDS) {
  const elapsed = Math.max(0, Math.min(MAX_FRAME_SECONDS, Number.isFinite(seconds) ? seconds : 0));
  return target.map((value, index) => {
    const desired = clamp(value), old = clamp(previous[index]);
    return clamp(old + (desired - old) * (1 - Math.exp(-elapsed / (desired > old ? attack : release))));
  });
}
function sampleLevels(id, { sampleAt = () => 0, spectrumAt = () => 0 } = {}) {
  if (id === "emerald-vu") return [clamp(PEAK_GAIN * Math.max(...Array.from({ length: 32 }, (_, index) => Math.abs(sampleAt(index / 31)))) )];
  const spectrum = bandPositions().map(position => clamp(4 * Math.abs(spectrumAt(position))));
  if (id === "twin-cyan-vu") return [Math.sqrt(Math.max(...spectrum.slice(0, 9))), Math.sqrt(Math.max(...spectrum.slice(14)))];
  if (id === "prism-spectrum") return spectrum.map(Math.sqrt);
  throw Error("Unknown meter preset: " + id);
}
function evaluateSegment(segment, levels) {
  const level = clamp(levels[segment.control]);
  const angle = radians(150 - 120 * level), cosine = Math.cos(angle), sine = Math.sin(angle);
  const points = segment.kind === 1 ? segment.points.map(([x, y]) => [segment.center[0] + cosine * x - sine * y, segment.center[1] + sine * x + cosine * y]) : segment.points.map(point => [...point]);
  const pen = segment.kind === 2 && level < segment.threshold ? 0 : segment.kind === 1 && segment.overload && level > .86 ? PEN.red : segment.pen;
  return { points, pen, width: segment.width, role: segment.role };
}
function palette(preset) {
  const colors = preset.colors.map(hex => [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16) / 255));
  return Array.from({ length: 256 }, (_, index) => {
    let upper = ANCHORS.findIndex(anchor => anchor >= index); if (upper === 0) return [...colors[0]];
    // One-bin plateaus keep quantized native Pen anchors at their exact hue.
    if (Math.abs(index - ANCHORS[upper]) <= 1) return [...colors[upper]];
    if (Math.abs(index - ANCHORS[upper - 1]) <= 1) return [...colors[upper - 1]];
    const ratio = (index - ANCHORS[upper - 1]) / (ANCHORS[upper] - ANCHORS[upper - 1]);
    return colors[upper - 1].map((value, component) => value + (colors[upper][component] - value) * ratio);
  });
}
function colorAt(preset, pen) {
  return "#" + palette(preset)[Math.round(clamp(pen) * 255)].map(value => Math.round(value * 255).toString(16).padStart(2, "0")).join("");
}

module.exports = { STEPS, BAND_COUNT, BAR_ROWS, ATTACK_SECONDS, RELEASE_SECONDS, MAX_FRAME_SECONDS, PEAK_GAIN, PEN, PRESETS, GLYPHS,
  bandPositions, addLine, addLabel, createGeometry, smoothLevels, sampleLevels, evaluateSegment, palette, colorAt };
