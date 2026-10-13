"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { WORD, LETTER_GAP, ROW_INTERVALS, NATIVE_STEPS, WARP_CONTROLS, MAX_DEFORMATION, GLYPHS, createGeometry, interpolateRow, createAudioWarp, deformPoint } = require("./geometry.cjs");
const { NAME, PACKAGE_NAME, waveShape, colorMap, flowField, packageSource, svgPreview } = require("./generate.cjs");

const geometry = createGeometry();
const close = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) <= tolerance, `${a} differs from ${b}`);
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const clamp = (value) => Math.max(0, Math.min(1, value));
const nodeAt = (u) => Math.round(u * (WARP_CONTROLS - 1));
const spectralNodeAt = (u) => nodeAt((u - 0.02) / 0.9);

function distanceToSegment(point, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const amount = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  return distance(point, [a[0] + amount * dx, a[1] + amount * dy]);
}

function insidePolygon(point, points) {
  let inside = false;
  for (let a = 0, b = points.length - 2; a < points.length - 1; b = a++) {
    const [ax, ay] = points[a];
    const [bx, by] = points[b];
    if ((ay > point[1]) !== (by > point[1]) && point[0] < (bx - ax) * (point[1] - ay) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

function segmentsCross(a, b, c, d) {
  const orient = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return orient(a, b, c) * orient(a, b, d) < -1e-16 && orient(c, d, a) * orient(c, d, b) < -1e-16;
}

function contourAtNativeSteps(contour, warp) {
  return Array.from({ length: NATIVE_STEPS + 1 }, (_, index) => deformPoint(contour, index / NATIVE_STEPS, warp, geometry.width));
}

function parseEntries(source) {
  return new Map([...source.matchAll(/^([A-Za-z][A-Za-z0-9]*)=(?:"([^"]*)"|([^\r\n]*))$/gm)].map((entry) => [entry[1], entry[2] ?? entry[3]]));
}

const extremeProfiles = [
  { name: "silence" },
  { name: "positive PCM saturation", sampleAt: () => 1e8 },
  { name: "negative PCM saturation", sampleAt: () => -1e8 },
  { name: "alternating PCM", sampleAt: (u) => (nodeAt(u) % 2 ? 1 : -1) * 1e8 },
  { name: "alternating combined extrema", sampleAt: (u) => (nodeAt(u) % 2 ? 1 : -1) * 1e8, spectrumAt: (u) => spectralNodeAt(u) % 2 ? 1e8 : 0 },
  { name: "opposing PCM and spectrum", sampleAt: (u) => (nodeAt(u) % 2 ? 1 : -1) * 1e8, spectrumAt: (u) => spectralNodeAt(u) % 2 ? 0 : 1e8 },
  { name: "combined full step", sampleAt: (u) => (u < 0.5 ? 1 : -1) * 1e8, spectrumAt: (u) => u < 0.5 ? 1e8 : 0 },
  { name: "normalized music sample", sampleAt: (u) => 0.6 * Math.sin(2 * Math.PI * 7 * u) + 0.2 * Math.sin(2 * Math.PI * 13 * u), spectrumAt: (u) => Math.exp(-(((u - 0.17) / 0.08) ** 2)) }
];
for (let node = 0; node < WARP_CONTROLS; node += 1) extremeProfiles.push({ name: `single PCM/FFT impulse ${node}`, sampleAt: (u) => nodeAt(u) === node ? 1e8 : 0, spectrumAt: (u) => spectralNodeAt(u) === node ? 1e8 : 0 });
for (let node = 0; node < WARP_CONTROLS - 1; node += 1) extremeProfiles.push({ name: `PCM/FFT step at ${node}`, sampleAt: (u) => (nodeAt(u) <= node ? 1 : -1) * 1e8, spectrumAt: (u) => spectralNodeAt(u) <= node ? 1e8 : 0 });

test("the intended lowercase word keeps its eleven outer outlines and six counters", () => {
  assert.equal(WORD, "darthspader");
  assert.equal(geometry.letters.map((letter) => letter.letter).join(""), WORD);
  assert.equal(geometry.contours.length, 17);
  assert.deepEqual(geometry.contours.filter((contour) => contour.counter).map((contour) => contour.letterIndex), [0, 1, 6, 7, 8, 9]);
  assert.equal(geometry.contours.filter((contour) => !contour.counter).length, WORD.length);
  assert.equal(Math.max(...GLYPHS.d.contours[0].map((point) => point[1])), 1.5);
  assert.equal(Math.max(...GLYPHS.h.contours[0].map((point) => point[1])), 1.5);
  assert.equal(Math.max(...GLYPHS.a.contours[0].map((point) => point[1])), 1);
  assert.equal(Math.max(...GLYPHS.r.contours[0].map((point) => point[1])), 1);
  assert.equal(Math.min(...GLYPHS.p.contours[0].map((point) => point[1])), -0.44);
});

test("every original contour closes, contains finite coordinates and stays in its bounds", () => {
  for (const contour of geometry.contours) {
    assert.equal(contour.points.length, ROW_INTERVALS + 1);
    assert.deepEqual(contour.points.at(-1), contour.points[0]);
    assert.ok(contour.perimeter > 1);
    for (const point of contour.points) {
      assert.ok(point.every(Number.isFinite));
      assert.ok(Math.abs(point[0]) <= geometry.halfWidth + 1e-9);
      assert.ok(Math.abs(point[1]) <= geometry.halfHeight + 1e-9);
    }
  }
  for (let index = 1; index < geometry.letters.length; index += 1) close(geometry.letters[index].left - geometry.letters[index - 1].right, LETTER_GAP);
});

test("signed PCM reverses the distortion and changes the outline instead of only translating a letter", () => {
  const sampleAt = (u) => Math.sin(2 * Math.PI * 7 * u);
  const positive = createAudioWarp({ sampleAt });
  const negative = createAudioWarp({ sampleAt: (u) => -sampleAt(u) });
  const contour = geometry.contours[0];
  const movement = [];
  for (let index = 0; index <= NATIVE_STEPS; index += 1) {
    const s = index / NATIVE_STEPS;
    const base = interpolateRow(contour.points, s);
    const forward = deformPoint(contour, s, positive);
    const reverse = deformPoint(contour, s, negative);
    close(forward[0], base[0]);
    close(forward[1] - base[1], base[1] - reverse[1]);
    movement.push(forward[1] - base[1]);
  }
  assert.ok(Math.max(...movement) - Math.min(...movement) > 0.25, "one letter must bend, not move as a rigid body");
  assert.ok(Math.max(...positive.map((row) => Math.abs(row[0]))) > 0.18);
});

test("spectrum alone produces spatial distortion, while silence has no clock-driven motion", () => {
  const spectral = createAudioWarp({ spectrumAt: (u) => u < 0.35 ? 1 : 0 });
  assert.ok(spectral.some(([value]) => value > 0.05));
  assert.ok(spectral.some(([value]) => value < -0.05));
  const silent = createAudioWarp();
  assert.ok(silent.every(([value]) => value === 0));
  for (const contour of geometry.contours) for (const s of [0, 0.137, 0.5, 0.819, 1]) assert.deepEqual(deformPoint(contour, s, silent), interpolateRow(contour.points, s));
  const positions = [...parseEntries(waveShape(geometry))].filter(([key]) => /^[BCXY]\d+$/.test(key)).map(([, value]) => value).join(" ");
  assert.ok(!/\bt\b|\bsin\(|\bcos\(/.test(positions), "audio geometry must not be animated by a clock harmonic");
});

test("all saturated and impulse profiles close, keep horizontal spacing and respect the aspect-fit limits", () => {
  let maxMovement = 0;
  for (const profile of extremeProfiles) {
    const warp = createAudioWarp(profile);
    assert.equal(warp.length, WARP_CONTROLS);
    for (let index = 1; index < warp.length; index += 1) assert.ok(Math.abs(warp[index][0] - warp[index - 1][0]) <= MAX_DEFORMATION + 1e-9, "three-tap filter must cap adjacent-control jumps");
    for (const contour of geometry.contours) {
      const points = contourAtNativeSteps(contour, warp);
      assert.deepEqual(points[0], points.at(-1));
      points.forEach((point, index) => {
        const base = interpolateRow(contour.points, index / NATIVE_STEPS);
        const movement = distance(point, base);
        maxMovement = Math.max(maxMovement, movement);
        assert.ok(point.every(Number.isFinite));
        assert.equal(point[0], base[0], "shared vertical warp must preserve letter gaps");
        assert.ok(movement <= MAX_DEFORMATION + 1e-9);
        for (const [xExtent, yExtent] of [[1, 1], [16 / 9, 1], [9 / 16, 1]]) {
          const scale = 0.86 * Math.min(xExtent / geometry.halfWidth, yExtent / (geometry.halfHeight + MAX_DEFORMATION));
          assert.ok(Math.abs(point[0] * scale) <= xExtent * 0.86 + 1e-9);
          assert.ok(Math.abs(point[1] * scale) <= yExtent * 0.86 + 1e-9);
        }
      });
    }
  }
  assert.ok(maxMovement > 0.35, "extreme-profile test must exercise the larger waveform warp");
});

test("native-resolution contours have no crossings and counters stay open under every extreme profile", () => {
  let nearest = Infinity;
  for (const profile of extremeProfiles) {
    const warp = createAudioWarp(profile);
    const contours = geometry.contours.map((contour) => contourAtNativeSteps(contour, warp));
    for (const points of contours) {
      for (let a = 0; a < NATIVE_STEPS; a += 1) for (let b = a + 2; b < NATIVE_STEPS; b += 1) {
        if (a === 0 && b === NATIVE_STEPS - 1) continue;
        assert.ok(!segmentsCross(points[a], points[a + 1], points[b], points[b + 1]), `${profile.name}: self-crossing contour`);
      }
    }
    geometry.contours.forEach((counter, id) => {
      if (!counter.counter) return;
      const outerId = geometry.contours.findIndex((contour) => contour.letterIndex === counter.letterIndex && !contour.counter);
      const outer = contours[outerId];
      const inner = contours[id];
      for (const point of inner.slice(0, -1)) {
        assert.ok(insidePolygon(point, outer), `${profile.name}: ${counter.letter} counter escaped`);
        for (let index = 0; index < outer.length - 1; index += 1) nearest = Math.min(nearest, distanceToSegment(point, outer[index], outer[index + 1]));
      }
      for (const point of outer.slice(0, -1)) for (let index = 0; index < inner.length - 1; index += 1) nearest = Math.min(nearest, distanceToSegment(point, inner[index], inner[index + 1]));
      for (let a = 0; a < inner.length - 1; a += 1) for (let b = 0; b < outer.length - 1; b += 1) assert.ok(!segmentsCross(inner[a], inner[a + 1], outer[b], outer[b + 1]), `${profile.name}: ${counter.letter} counter crossing`);
    });
  }
  // At800x450, the .86-wide aspect fit gives~62 pixels per glyph unit.
  // Leave actual clear pixels between two strokes, each no wider than1.8px.
  const pixelsPerUnit = 0.86 * 400 / geometry.halfWidth;
  assert.ok(nearest * pixelsPerUnit > 2.3, `counter margin ${nearest * pixelsPerUnit}px must exceed max stroke plus .5px`);
});

test("native caches and closed geometry use two tables with a bounded per-frame sampling budget", () => {
  const entries = parseEntries(waveShape(geometry));
  assert.equal(entries.get("NUM"), "17");
  assert.equal(entries.get("Stps"), String(NATIVE_STEPS));
  assert.equal(entries.get("ConB"), "1");
  assert.equal(entries.get("Aspc"), "1");
  assert.deepEqual([...entries.keys()].filter((key) => /^X\d+$/.test(key)), ["X0"]);
  assert.deepEqual([...entries.keys()].filter((key) => /^Y\d+$/.test(key)), ["Y0"]);
  for (let component = 0; component < 2; component += 1) {
    const rows = JSON.parse(entries.get(`A${component}`).replaceAll("{", "[").replaceAll("}", "]"));
    assert.equal(rows.length, geometry.contours.length);
    rows.forEach((row, id) => {
      assert.equal(row.length, ROW_INTERVALS + 1);
      assert.equal(row[0], row.at(-1));
      row.forEach((value, index) => close(value, geometry.contours[id].points[index][component], 0.00000501));
    });
    assert.equal(entries.get(`B${component + 6}`), `row(A${component}, ID)`);
    assert.equal(entries.get(`C${component}`), `map1D(B${component + 6}, s, 1)`);
  }
  assert.equal(entries.get("A2"), `vectorLR(${WARP_CONTROLS}, 0, 1)`);
  assert.ok(!entries.has("A3"));
  for (const key of ["B2", "B3", "B4", "B5"]) assert.match(entries.get(key), new RegExp(`^select\\(ID, ${key}, `));
  assert.equal(entries.get("C3"), "map1D(B5, C2, 1)");
  assert.ok(geometry.contours.length * (ROW_INTERVALS + 1) * 2 + WARP_CONTROLS < 3500);
  assert.ok(geometry.contours.length * NATIVE_STEPS < 3000);
  assert.ok(waveShape(geometry).length < 30000);
});

test("emitted native PCM/FFT, spatial filter and point expressions match the reference", () => {
  const entries = parseEntries(waveShape(geometry));
  const operations = { clamp, abs: Math.abs, min: Math.min, select: (condition, yes, no) => condition ? yes : no };
  const evaluate = (key, values) => {
    const variables = { ...operations, ...values };
    return new Function(...Object.keys(variables), `return (${entries.get(key)});`)(...Object.values(variables));
  };
  for (const profile of [extremeProfiles[4], extremeProfiles[6], extremeProfiles[7]]) {
    const sampleAt = profile.sampleAt ?? (() => 0);
    const spectrumAt = profile.spectrumAt ?? (() => 0);
    const raw = Array.from({ length: WARP_CONTROLS }, (_, index) => {
      const values = { A2: index / (WARP_CONTROLS - 1), ID: 0, B2: 0, B3: 0, B4: 0, mag: sampleAt, fft: spectrumAt };
      values.B2 = evaluate("B2", values);
      values.B3 = evaluate("B3", values);
      return [evaluate("B4", values)];
    });
    const nativeWarp = raw.map(([value], index) => [evaluate("B5", { ID: 0, B5: 0, B4: value, A2: index / (WARP_CONTROLS - 1), map1D: (_, u) => interpolateRow(raw, u)[0] })]);
    const referenceWarp = createAudioWarp(profile);
    nativeWarp.forEach(([value], index) => close(value, referenceWarp[index][0]));
    for (const contour of geometry.contours) for (const s of [0, 0.137, 0.5, 0.819, 1]) {
      const base = interpolateRow(contour.points, s);
      const values = { C0: base[0], C1: base[1], B0: 1, B5: nativeWarp, map1D: (rows, u) => interpolateRow(rows, u)[0] };
      values.C2 = evaluate("C2", values);
      values.C3 = evaluate("C3", values);
      const reference = deformPoint(contour, s, referenceWarp);
      close(evaluate("X0", values), reference[0]);
      close(evaluate("Y0", values), reference[1]);
    }
  }
  const maxLineWidth = evaluate("LWdt", { B1: 1 });
  assert.ok(maxLineWidth <= 1.8);
});

test("source and geometry-only previews are reproducible and explicitly labeled", () => {
  const expected = new Map([
    [`${PACKAGE_NAME}/WaveShapes/${NAME}.txt`, waveShape(geometry)],
    [`${PACKAGE_NAME}/ColorMaps/${NAME}.txt`, colorMap()],
    [`${PACKAGE_NAME}/FlowFields/${NAME}.txt`, flowField()],
    [`${PACKAGE_NAME}/_package.py`, packageSource()],
    ["preview/darthspader-geometry.svg", svgPreview(geometry)],
    ["preview/darthspader-audio-sample.svg", svgPreview(geometry, true)]
  ]);
  for (const [relative, content] of expected) assert.equal(fs.readFileSync(path.join(__dirname, relative), "utf8"), content);
  for (const audio of [false, true]) {
    const svg = svgPreview(geometry, audio);
    assert.equal([...svg.matchAll(/<path\s/g)].length, geometry.contours.length);
    assert.match(svg, /GEOMETRY PREVIEW/);
    assert.match(svg, /not a SoundSpectrum screenshot or video/);
    assert.ok(!/<image\b/.test(svg));
    assert.ok(!/<text[^>]*>[^<]*darthspader/.test(svg));
  }
  assert.equal([...packageSource().matchAll(/AddEntryTree\(/g)].length, 3);
});
