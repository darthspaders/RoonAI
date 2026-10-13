"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const { STEPS, BAND_COUNT, BAR_ROWS, ATTACK_SECONDS, RELEASE_SECONDS, MAX_FRAME_SECONDS,
  PEAK_GAIN, PEN, PRESETS, bandPositions, createGeometry, sampleLevels, smoothLevels,
  evaluateSegment, palette, colorAt } = require("./geometry.cjs");
const near = (actual, expected, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);

for (const preset of PRESETS) {
  test(`${preset.name}: finite bounded geometry at silence, midpoint and full scale`, () => {
    const geometry = createGeometry(preset.id);
    assert.ok(geometry.segments.length < 600);
    assert.equal(geometry.nativePointsPerFrame, geometry.segments.length * STEPS);
    assert.ok(geometry.nativePointsPerFrame < (preset.kind === "spectrum" ? 2200 : 3500));
    for (const segment of geometry.segments) {
      assert.equal(segment.points.length, 3);
      assert.ok([0, 1, 2].includes(segment.kind));
      assert.ok(Number.isInteger(segment.control) && segment.control >= 0 && segment.control < preset.groups);
      assert.ok(Number.isFinite(segment.width) && segment.width > 0);
      assert.ok(segment.pen >= 0 && segment.pen <= 1);
      for (const level of [0, .5, 1]) {
        const rendered = evaluateSegment(segment, Array(preset.groups).fill(level));
        for (const [x, y] of rendered.points) {
          assert.ok(Number.isFinite(x) && Number.isFinite(y));
          assert.ok(Math.abs(x) + segment.width / 2 <= geometry.halfWidth, `x clipping: ${segment.role} ${x}`);
          assert.ok(Math.abs(y) + segment.width / 2 <= geometry.halfHeight, `y clipping: ${segment.role} ${y}`);
        }
      }
    }
  });
  test(`${preset.name}: silence has no autonomous movement and the face stays fixed`, () => {
    const geometry = createGeometry(preset.id), zero = Array(preset.groups).fill(0);
    assert.deepEqual(sampleLevels(preset.id), zero);
    let smoothed = zero;
    for (let frame = 0; frame < 300; frame++) smoothed = smoothLevels(smoothed, sampleLevels(preset.id), 1 / 60);
    assert.deepEqual(smoothed, zero);
    for (const segment of geometry.segments) {
      assert.deepEqual(evaluateSegment(segment, zero), evaluateSegment(segment, smoothed));
      if (segment.kind === 0) assert.deepEqual(evaluateSegment(segment, zero), evaluateSegment(segment, Array(preset.groups).fill(1)));
    }
  });
  test(`${preset.name}: original palette is bounded with exact native intensity anchors`, () => {
    const colors = palette(preset), anchors = [0, 32, 96, 144, 184, 218, 242, 255];
    assert.equal(colors.length, 256);
    assert.deepEqual(colors[0], [0, 0, 0]);
    for (const rgb of colors) {
      assert.equal(rgb.length, 3);
      assert.ok(rgb.every(value => Number.isFinite(value) && value >= 0 && value <= 1));
    }
    anchors.forEach((anchor, index) => {
      assert.equal(colorAt(preset, anchor / 255), preset.colors[index]);
      if (anchor > 0) assert.deepEqual(colors[anchor - 1], colors[anchor]);
      if (anchor < 255) assert.deepEqual(colors[anchor + 1], colors[anchor]);
    });
  });
}

test("Emerald needle sweeps 120 degrees with actual signed PCM amplitude", () => {
  const geometry = createGeometry("emerald-vu"), needle = geometry.segments.find(segment => segment.role === "needle");
  near(sampleLevels("emerald-vu", { sampleAt: () => -.2 })[0], PEAK_GAIN * .2);
  near(sampleLevels("emerald-vu", { sampleAt: () => .2 })[0], PEAK_GAIN * .2);
  assert.equal(sampleLevels("emerald-vu", { sampleAt: () => 2 })[0], 1);
  const tip = needle.points[2], radius = Math.hypot(...tip);
  for (const level of [0, .5, 1]) {
    const renderedTip = evaluateSegment(needle, [level]).points[2];
    const relative = renderedTip.map((coordinate, index) => coordinate - needle.center[index]);
    near(Math.hypot(...relative), radius);
    near(Math.atan2(relative[1], relative[0]), (150 - 120 * level) * Math.PI / 180);
  }
  assert.equal(evaluateSegment(needle, [.8]).pen, PEN.amber);
  assert.equal(evaluateSegment(needle, [.9]).pen, PEN.red);
});

test("Twin meters independently respond to low and high frequencies, rather than stereo", () => {
  const low = sampleLevels("twin-cyan-vu", { spectrumAt: position => position < .04 ? .25 : 0 });
  const high = sampleLevels("twin-cyan-vu", { spectrumAt: position => position > .3 ? .25 : 0 });
  assert.deepEqual(low, [1, 0]);
  assert.deepEqual(high, [0, 1]);
  const geometry = createGeometry("twin-cyan-vu");
  const needles = geometry.segments.filter(segment => segment.kind === 1);
  assert.deepEqual([...new Set(needles.map(segment => segment.control))], [0, 1]);
  for (const needle of needles) {
    assert.equal(evaluateSegment(needle, [1, 1]).pen, PEN.white);
    assert.equal(needle.overload, false);
  }
  for (const segment of geometry.segments) assert.ok(![PEN.amber, PEN.red, PEN.yellow, PEN.green].includes(segment.pen));
});

test("Spectrum analyzes 26 log-spaced bins without missing endpoints", () => {
  const positions = bandPositions();
  assert.equal(positions.length, BAND_COUNT);
  near(positions[0], .008); near(positions.at(-1), .92);
  for (let index = 1; index < positions.length; index++) {
    assert.ok(positions[index] > positions[index - 1]);
    near(positions[index] / positions[index - 1], positions[1] / positions[0]);
  }
  const visited = [], levels = sampleLevels("prism-spectrum", { spectrumAt: position => { visited.push(position); return .0625; } });
  assert.deepEqual(visited, positions);
  assert.deepEqual(levels, Array(BAND_COUNT).fill(.5));
});

test("Spectrum LEDs light complete rows with distinct horizontal and vertical gaps", () => {
  const geometry = createGeometry("prism-spectrum"), bars = geometry.segments.filter(segment => segment.kind === 2);
  assert.equal(bars.length, BAND_COUNT * BAR_ROWS);
  for (let band = 0; band < BAND_COUNT; band++) {
    const column = bars.filter(segment => segment.control === band);
    assert.equal(column.length, BAR_ROWS);
    assert.deepEqual(column.map(segment => segment.threshold), Array.from({ length: BAR_ROWS }, (_, index) => (index + 1) / BAR_ROWS));
    assert.equal(column.filter(segment => evaluateSegment(segment, Array(BAND_COUNT).fill(0)).pen > 0).length, 0);
    assert.equal(column.filter(segment => evaluateSegment(segment, Array(BAND_COUNT).fill(.5)).pen > 0).length, 8);
    assert.equal(column.filter(segment => evaluateSegment(segment, Array(BAND_COUNT).fill(1)).pen > 0).length, BAR_ROWS);
    for (let row = 1; row < column.length; row++) assert.ok(column[row].points[0][1] - column[row - 1].points[0][1] > column[row].width);
    const widthWithRoundCaps = column[0].points[2][0] - column[0].points[0][0] + column[0].width;
    assert.ok(widthWithRoundCaps < 3 / BAND_COUNT, "Rounded caps must leave a visible column gap");
  }
});

test("Spectrum uses cyan, green, yellow, amber and red height zones", () => {
  const bars = createGeometry("prism-spectrum").segments.filter(segment => segment.kind === 2 && segment.control === 0);
  assert.deepEqual(bars.map(segment => segment.pen), [
    ...Array(4).fill(PEN.cyan), ...Array(5).fill(PEN.green), ...Array(3).fill(PEN.yellow), ...Array(2).fill(PEN.amber), ...Array(2).fill(PEN.red)
  ]);
});

test("Envelope attack is faster than release and does not overshoot", () => {
  const attacking = smoothLevels([0], [1], 1 / 60)[0], releasing = 1 - smoothLevels([1], [0], 1 / 60)[0];
  assert.ok(ATTACK_SECONDS < RELEASE_SECONDS && attacking > releasing);
  let current = [0];
  for (let frame = 0; frame < 60; frame++) { const next = smoothLevels(current, [1], 1 / 60); assert.ok(next[0] >= current[0] && next[0] <= 1); current = next; }
  assert.ok(current[0] > .99);
  for (let frame = 0; frame < 180; frame++) { const next = smoothLevels(current, [0], 1 / 60); assert.ok(next[0] <= current[0] && next[0] >= 0); current = next; }
  assert.ok(current[0] < .00001);
});

test("Envelope follows elapsed time consistently across 30 and 60 fps", () => {
  function run(fps) { let levels = [0, 1]; for (let frame = 0; frame < fps; frame++) levels = smoothLevels(levels, [1, 0], 1 / fps); return levels; }
  const slow = run(30), fast = run(60);
  slow.forEach((value, index) => near(value, fast[index]));
});

test("Long frame gaps are bounded and invalid targets never create NaN geometry", () => {
  assert.deepEqual(smoothLevels([0], [1], 100), smoothLevels([0], [1], MAX_FRAME_SECONDS));
  assert.deepEqual(smoothLevels([.4], [1], -1), [.4]);
  assert.deepEqual(smoothLevels([.4], [1], NaN), [.4]);
  const levels = smoothLevels([NaN, -1, 3], [NaN, 4, -2], 1 / 60);
  assert.ok(levels.every(value => Number.isFinite(value) && value >= 0 && value <= 1));
  assert.equal(colorAt(PRESETS[0], NaN), "#000000");
});

test("Emerald face has a bold green/red scale while Twin retains thin cyan arcs", () => {
  const emerald = createGeometry("emerald-vu"), twin = createGeometry("twin-cyan-vu");
  assert.ok(emerald.segments.some(segment => segment.role === "scale" && segment.width === .05 && segment.pen === PEN.green));
  assert.ok(emerald.segments.some(segment => segment.role === "scale-hot" && segment.width === .05 && segment.pen === PEN.red));
  assert.ok(twin.segments.filter(segment => segment.role === "scale-hot").every(segment => segment.pen === PEN.cyan && segment.width < .01));
});

test("Unknown presets fail before any geometry is produced", () => {
  assert.throws(() => createGeometry("constructor"), /Unknown meter preset/);
  assert.throws(() => sampleLevels("unknown"), /Unknown meter preset/);
});
