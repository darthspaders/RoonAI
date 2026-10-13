"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { PRESETS, PEN, PEAK_GAIN, createGeometry, palette } = require("./geometry.cjs");
const { PACKAGE_NAME, LINE_REFERENCE_HEIGHT, NATIVE_LINE_CALIBRATION, MIN_NATIVE_LINE_WIDTH,
  waveShape, colorMap, packageSource, previewLevels, svgPreview, generate } = require("./generate.cjs");
const assignments = source => Object.fromEntries(source.split(/\r?\n/).filter(line => /^[A-Za-z][A-Za-z0-9]*=/.test(line)).map(line => {
  const equal = line.indexOf("="); return [line.slice(0, equal), line.slice(equal + 1).replace(/^"|"$/g, "")];
}));
const literal = value => JSON.parse(value.replace(/\{/g, "[").replace(/\}/g, "]"));
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) <= 5.1e-8, `${actual} != ${expected}`);

for (const preset of PRESETS) {
  test(`${preset.name}: native geometry and integer metadata round-trip accurately`, () => {
    const geometry = createGeometry(preset.id), data = assignments(waveShape(geometry));
    assert.equal(Number(data.NUM), geometry.segments.length);
    assert.equal(data.Stps, "3"); assert.equal(data.Aspc, "1");
    const xs = literal(data.A0), ys = literal(data.A1), metadata = literal(data.A2);
    assert.equal(xs.length, geometry.segments.length); assert.equal(ys.length, xs.length); assert.equal(metadata.length, xs.length);
    geometry.segments.forEach((segment, index) => {
      assert.equal(xs[index].length, 3); assert.equal(ys[index].length, 3); assert.equal(metadata[index].length, 7);
      segment.points.forEach((point, pointIndex) => { near(xs[index][pointIndex], point[0]); near(ys[index][pointIndex], point[1]); });
      const expected = [segment.kind, segment.control, segment.threshold, segment.pen, ...segment.center, segment.width];
      expected.forEach((value, column) => near(metadata[index][column], value));
      assert.ok(Number.isInteger(metadata[index][0]) && Number.isInteger(metadata[index][1]));
    });
    assert.equal(data.B11, "row(A2,ID)"); assert.equal(data.B13, "col(B11,1)");
    assert.equal(data.B18, "col(B5,B13)");
    for (const name of ["C0", "C1", "X0", "Y0"]) assert.doesNotMatch(data[name], /A2|fft\(|mag\(/);
  });
  test(`${preset.name}: palette RGB arrays preserve 256 native intensity entries`, () => {
    const data = assignments(colorMap(preset)), expected = palette(preset), tables = [data.A0, data.A1, data.A2].map(literal);
    for (const table of tables) assert.equal(table.length, 256);
    expected.forEach((rgb, index) => rgb.forEach((value, component) => near(tables[component][index], value)));
    assert.equal(data.R, "map1D(A0,i,1)"); assert.equal(data.G, "map1D(A1,i,1)"); assert.equal(data.B, "map1D(A2,i,1)");
    assert.deepEqual(tables.map(table => table[0]), [0, 0, 0]);
  });
}

test("Native assignments use short unique keys and balanced quoted expressions", () => {
  for (const preset of PRESETS) for (const source of [waveShape(createGeometry(preset.id)), colorMap(preset)]) {
    const lines = source.split(/\r?\n/).filter(line => line && !line.startsWith("//")), keys = new Set();
    for (const line of lines) {
      const match = /^([A-Za-z][A-Za-z0-9]{0,3})=(.+)$/.exec(line);
      assert.ok(match, `Unsupported assignment shape: ${line.slice(0, 100)}`);
      assert.ok(!keys.has(match[1]), `Duplicate ${match[1]}`); keys.add(match[1]);
      if (match[2].startsWith('"')) {
        assert.ok(match[2].endsWith('"')); assert.equal((match[2].match(/"/g) || []).length, 2);
        const stack = [];
        for (const char of match[2].slice(1, -1)) {
          if (char === "(" || char === "{") stack.push(char);
          if (char === ")" || char === "}") assert.equal(stack.pop(), char === ")" ? "(" : "{");
        }
        assert.equal(stack.length, 0);
      }
    }
  }
});

test("Audio smoothing is confined to per-frame B expressions with bounded elapsed time", () => {
  for (const preset of PRESETS) {
    const source = waveShape(createGeometry(preset.id)), data = assignments(source);
    assert.match(data.B1, /min\(0?\.05,max\(0,t-B2\)\)/);
    assert.match(data.B5, /exp\(-B1\/select\(B4>B5,0\.045,0\.24\)\)/);
    for (const [key, expression] of Object.entries(data)) if (!key.startsWith("B")) assert.doesNotMatch(expression, /\b(?:fft|mag)\(|\bdt\b/);
    assert.match(source, /Branch laziness is undocumented/);
    assert.match(source, new RegExp(`${createGeometry(preset.id).segments.length} instances \\* ${preset.id === "emerald-vu" ? 32 : 26} sample/bin positions`));
    assert.doesNotMatch(source, /once per frame|one audio lookup/);
  }
});

test("Native audio model matches Emerald gain and Twin retains white needles at peak", () => {
  const emerald = assignments(waveShape(createGeometry("emerald-vu"))), twin = assignments(waveShape(createGeometry("twin-cyan-vu")));
  assert.equal(emerald.B4, `select(ID,B4,clamp(${PEAK_GAIN}*largest(B3)))`);
  assert.match(emerald.Pen, /B18>\.86/);
  assert.equal(twin.Pen, "select(B12==2,select(B18>=B14,B15,0),B15)");
  assert.ok(literal(twin.A2).filter(row => row[0] === 1).every(row => Math.abs(row[3] - PEN.white) <= 5.1e-8));
  assert.match(twin.B4, /subrange\(B3,0,0,8,0\)/);
  assert.match(twin.B4, /subrange\(B3,14,0,25,0\)/);
});

test("Native line width uses a nominal frame so resize cannot apply HEIGHT scaling twice", () => {
  assert.equal(LINE_REFERENCE_HEIGHT, 720); assert.equal(NATIVE_LINE_CALIBRATION, .35);
  for (const preset of PRESETS) {
    const data = assignments(waveShape(createGeometry(preset.id)));
    assert.doesNotMatch(data.LWdt, /\bHEIGHT\b|\bWIDTH\b|GetPref|SetPref/);
    const calculate = new Function("B21", "B0", "Y_EXTENTS", "HEIGHT", "WIDTH", "max", `return ${data.LWdt};`);
    for (const thickness of [.005, .045, .05]) {
      const hd = calculate(thickness, .94, 1, 720, 1280, Math.max);
      const uhd = calculate(thickness, .94, 1, 2160, 3840, Math.max);
      assert.equal(hd, uhd, "Only external native AutoLineScale should change pixel thickness with frame size");
      assert.equal(hd, Math.max(MIN_NATIVE_LINE_WIDTH, .35 * thickness * .94 * 720 / 2));
    }
    assert.match(data.B0, /X_EXTENTS/); assert.match(data.B0, /Y_EXTENTS/);
  }
});

test("Native calibrated Prism LED stroke retains headroom between the 16 rows", () => {
  const geometry = createGeometry("prism-spectrum"), bars = geometry.segments.filter(segment => segment.kind === 2 && segment.control === 0);
  const fit = .94 / geometry.halfHeight;
  // The observed native stroke was roughly twice the supplied LWdt; this is
  // empirical QA calibration, not a documented renderer radius convention.
  const empiricalThickness = 2 * Math.max(MIN_NATIVE_LINE_WIDTH, NATIVE_LINE_CALIBRATION * bars[0].width * fit * LINE_REFERENCE_HEIGHT / 2);
  const rowPitch = (bars[1].points[0][1] - bars[0].points[0][1]) * fit * LINE_REFERENCE_HEIGHT / 2;
  assert.ok(empiricalThickness < rowPitch * .6);
  assert.ok(empiricalThickness > rowPitch * .35);
  assert.ok(bars.every(segment => segment.width === .045), "SVG geometry and serialized metadata stay unchanged");
});

test("Package registers only original WaveShapes and optional ColorMaps", () => {
  const source = packageSource();
  assert.equal(PACKAGE_NAME, "RabbitHole.Meters.package");
  assert.equal((source.match(/AddEntryTree\(/g) || []).length, 2);
  assert.match(source, /AddEntryTree\('WaveShapes', \{'ConfigType': 'WaveShape'\}\)/);
  assert.match(source, /AddEntryTree\('ColorMaps', \{'ConfigType': 'ColorMap'\}\)/);
  assert.doesNotMatch(source, /FlowField|Particle|Sprite|Audio|Preferences|Scripts/);
});

test("SVG previews are original reproducible vectors, with honest synthetic/silence labels", () => {
  for (const preset of PRESETS) {
    const geometry = createGeometry(preset.id), silence = svgPreview(geometry, false), audio = svgPreview(geometry, true);
    assert.equal(silence, svgPreview(geometry, false)); assert.equal(audio, svgPreview(geometry, true));
    assert.notEqual(audio, silence);
    assert.match(silence, /not a native G-Force capture/); assert.match(audio, /synthetic audio/);
    assert.match(audio, /frequency ranges, not stereo channels/);
    assert.doesNotMatch(audio, /<(?:image|text|script|foreignObject)\b|href=|data:/i);
    const levels = previewLevels(geometry, true);
    assert.ok(levels.every(level => Number.isFinite(level) && level > 0 && level <= 1));
    assert.deepEqual(previewLevels(geometry, false), Array(preset.groups).fill(0));
    if (preset.id === "emerald-vu") assert.ok(levels[0] > .5 && levels[0] < .86, "Typical synthetic signal should remain amber instead of pegging overload");
    if (preset.kind === "spectrum") assert.ok((audio.match(/<path /g) || []).length > (silence.match(/<path /g) || []).length);
  }
});

test("Generator writes exactly scoped reproducible assets without touching unrelated files", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-hole-meter-test-")), destination = path.join(tempRoot, "assets");
  try {
    fs.mkdirSync(destination); const sentinel = path.join(destination, "README.md"); fs.writeFileSync(sentinel, "preserve unrelated documentation\n");
    const first = generate(destination);
    assert.equal(first.files.length, 13);
    const contents = new Map(first.files.map(relative => [relative, fs.readFileSync(path.join(destination, relative), "utf8")]));
    const second = generate(destination);
    assert.deepEqual(first, second);
    assert.equal(fs.readFileSync(sentinel, "utf8"), "preserve unrelated documentation\n");
    for (const relative of first.files) {
      assert.ok(relative.startsWith(`${PACKAGE_NAME}/WaveShapes/`) || relative.startsWith(`${PACKAGE_NAME}/ColorMaps/`) || relative === `${PACKAGE_NAME}/_package.py` || /^preview\/[a-z-]+-(?:audio|silence)\.svg$/.test(relative));
      assert.equal(fs.readFileSync(path.join(destination, relative), "utf8"), contents.get(relative));
    }
    for (const receipt of first.presets) {
      const geometry = createGeometry(receipt.id);
      assert.equal(receipt.nativePointsPerFrame, geometry.segments.length * 3);
      assert.equal(receipt.conservativeAudioLookupsPerFrame, receipt.segments * receipt.audioPositions);
    }
  } finally {
    const resolved = path.resolve(tempRoot), expectedParent = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(resolved.startsWith(expectedParent) && path.basename(resolved).startsWith("rabbit-hole-meter-test-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
