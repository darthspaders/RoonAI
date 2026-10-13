"use strict";

const fs = require("node:fs"), path = require("node:path");
const { STEPS, BAND_COUNT, ATTACK_SECONDS, RELEASE_SECONDS, MAX_FRAME_SECONDS, PEAK_GAIN, PEN, PRESETS,
  createGeometry, sampleLevels, smoothLevels, evaluateSegment, palette, colorAt } = require("./geometry.cjs");
const PACKAGE_NAME = "RabbitHole.Meters.package";
// Measured native line calibration at 1280x720. AutoLineScale owns subsequent
// resolution scaling; using live HEIGHT here would apply that growth twice.
const LINE_REFERENCE_HEIGHT = 720, NATIVE_LINE_CALIBRATION = .35, MIN_NATIVE_LINE_WIDTH = .55;
const format = value => Number(value.toFixed(7)).toString();
const vector = values => "{" + values.map(format).join(",") + "}";
const matrix = rows => "{" + rows.map(vector).join(",") + "}";

function waveShape(geometry) {
  const { preset, segments } = geometry;
  const coordinates = component => segments.map(segment => segment.points.map(point => point[component]));
  const metadata = segments.map(segment => [segment.kind, segment.control, segment.threshold, segment.pen, ...segment.center, segment.width]);
  const pcm = preset.id === "emerald-vu";
  const audioAxis = pcm ? "vectorLR(32,0,1)" : `.008*(.92/.008)^vectorLR(${BAND_COUNT},0,1)`;
  const audioSource = pcm ? "abs(mag(A3))" : "clamp(4*abs(fft(A3)))";
  const levels = pcm ? `clamp(${PEAK_GAIN}*largest(B3))` : preset.groups === 2 ? "{sqrt(largest(subrange(B3,0,0,8,0))),sqrt(largest(subrange(B3,14,0,25,0)))}" : "sqrt(B3)";
  const needlePen = pcm ? `select(B12==1,select(B18>.86,${format(PEN.red)},B15),B15)` : "B15";
  return `// Original procedural ${preset.name}; no factory paths, fonts or image overlays.
// Relative analysis level only: not calibrated VU/dB, Hz, or stereo channels.
// A stores geometry and integer metadata; each NUM/ID instance is one segment.
// B uses the installed shared-result select(ID,previous,new) idiom.
// Branch laziness is undocumented: conservative audio lookup bound is
// ${segments.length} instances * ${pcm ? 32 : BAND_COUNT} sample/bin positions per frame.
// C only interpolates line coordinates; it never accesses audio or metadata.
// Time only smooths incoming audio; silence cannot produce autonomous motion.
// Line width uses a calibrated nominal 720px frame; native AutoLineScale may
// scale it once after resize. No preference is read or changed by this config.
Aspc=1
NUM=${segments.length}
Stps=${STEPS}
ConB=1
NCap=1
Vers=310

A0="${matrix(coordinates(0))}"
A1="${matrix(coordinates(1))}"
A2="${matrix(metadata)}"
A3="${audioAxis}"

B0=".94*min(X_EXTENTS/${format(geometry.halfWidth)},Y_EXTENTS/${format(geometry.halfHeight)})"
B1="select(ID,B1,min(${MAX_FRAME_SECONDS},max(0,t-B2)))"
B2="select(ID,B2,t)"
B3="select(ID,B3,${audioSource})"
B4="select(ID,B4,${levels})"
B5="select(ID,B5,clamp(B5+(B4-B5)*(1-exp(-B1/select(B4>B5,${ATTACK_SECONDS},${RELEASE_SECONDS})))))"
B6="select(ID,B6,(150-120*B5)*PI/180)"
B7="select(ID,B7,cos(B6))"
B8="select(ID,B8,sin(B6))"
B9="row(A0,ID)"
B10="row(A1,ID)"
B11="row(A2,ID)"
B12="col(B11,0)"
B13="col(B11,1)"
B14="col(B11,2)"
B15="col(B11,3)"
B16="col(B11,4)"
B17="col(B11,5)"
B18="col(B5,B13)"
B19="col(B7,B13)"
B20="col(B8,B13)"
B21="col(B11,6)"

C0="map1D(B9,s,1)"
C1="map1D(B10,s,1)"
X0="B0*select(B12==1,B16+B19*C0-B20*C1,C0)"
Y0="B0*select(B12==1,B17+B20*C0+B19*C1,C1)"
LWdt="max(${MIN_NATIVE_LINE_WIDTH},${NATIVE_LINE_CALIBRATION}*B21*B0*${LINE_REFERENCE_HEIGHT}/(2*Y_EXTENTS))"
Pen="select(B12==2,select(B18>=B14,B15,0),${needlePen})"
`;
}

function colorMap(preset) {
  const colors = palette(preset);
  return `// Original matching palette. Pen is a 0..1 native intensity index.
// Exact k/255 color anchors, with one-bin plateaus. i=0 remains black.
A0="${vector(colors.map(value => value[0]))}"
A1="${vector(colors.map(value => value[1]))}"
A2="${vector(colors.map(value => value[2]))}"
R="map1D(A0,i,1)"
G="map1D(A1,i,1)"
B="map1D(A2,i,1)"
Vers=310
`;
}
function packageSource() {
  return `# Original removable meters; only WaveShape and optional matching ColorMap.
def ExportPackage(inPathname):
    pkg = VisPackage(inPathname)
    pkg.DefaultEntryConfigType = 'WaveShape'
    pkg.EntryRegex = r'(.*)\\.(txt)$'
    pkg.AddEntryTree('WaveShapes', {'ConfigType': 'WaveShape'})
    pkg.AddEntryTree('ColorMaps', {'ConfigType': 'ColorMap'})
    return pkg
`;
}
function syntheticAudio() {
  return {
    sampleAt: u => .47 * Math.sin(2 * Math.PI * 5 * u) + .12 * Math.sin(2 * Math.PI * 13 * u),
    spectrumAt: u => .13 * Math.exp(-((Math.log(u / .035) / .8) ** 2)) + .055 * Math.exp(-((Math.log(u / .36) / .7) ** 2))
  };
}
function previewLevels(geometry, audio) {
  let values = Array(geometry.preset.groups).fill(0);
  if (audio) for (let frame = 0; frame < 36; frame++) values = smoothLevels(values, sampleLevels(geometry.preset.id, syntheticAudio()), 1 / 60);
  return values;
}
function svgPreview(geometry, audio = false) {
  const width = 1600, height = 900, scale = .88 * Math.min(width / (2 * geometry.halfWidth), height / (2 * geometry.halfHeight));
  const levels = previewLevels(geometry, audio), paletteColors = palette(geometry.preset);
  const point = ([x, y]) => `${format(width / 2 + x * scale)},${format(height / 2 - y * scale)}`;
  const paths = geometry.segments.map(segment => evaluateSegment(segment, levels)).filter(segment => segment.pen > 0).map(segment => {
    const color = "#" + paletteColors[Math.round(segment.pen * 255)].map(value => Math.round(value * 255).toString(16).padStart(2, "0")).join("");
    return `<path d="M${segment.points.map(point).join(" L")}" stroke="${color}" stroke-width="${format(Math.max(1.1, segment.width * scale))}"/>`;
  }).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">
<title id="title">${geometry.preset.name} — ${audio ? "synthetic audio" : "silence"} geometry preview</title>
<desc id="description">Reproducible original vector geometry and matching palette, not a native G-Force capture. ${audio ? "Needles and segments use a synthetic audio envelope." : "Zero audio: needles rest at zero and spectrum LEDs are off."} LOW and HIGH are frequency ranges, not stereo channels.</desc>
<rect width="${width}" height="${height}" fill="#050b0d"/>
<g fill="none" stroke-linecap="round" stroke-linejoin="round">${paths}</g>
</svg>\n`;
}
function generate(destination = __dirname) {
  const files = { [`${PACKAGE_NAME}/_package.py`]: packageSource() }, presets = [];
  for (const preset of PRESETS) {
    const geometry = createGeometry(preset.id);
    files[`${PACKAGE_NAME}/WaveShapes/${preset.name}.txt`] = waveShape(geometry);
    files[`${PACKAGE_NAME}/ColorMaps/${preset.name}.txt`] = colorMap(preset);
    files[`preview/${preset.id}-silence.svg`] = svgPreview(geometry, false);
    files[`preview/${preset.id}-audio.svg`] = svgPreview(geometry, true);
    presets.push({ id: preset.id, name: preset.name, segments: geometry.segments.length, nativePointsPerFrame: geometry.nativePointsPerFrame,
      audioPositions: preset.id === "emerald-vu" ? 32 : BAND_COUNT,
      conservativeAudioLookupsPerFrame: geometry.segments.length * (preset.id === "emerald-vu" ? 32 : BAND_COUNT) });
  }
  for (const [relative, content] of Object.entries(files)) {
    const filename = path.join(destination, relative); fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, content, "utf8");
  }
  return { packageName: PACKAGE_NAME, presets, files: Object.keys(files) };
}
if (require.main === module) console.log(JSON.stringify(generate(), null, 2));
module.exports = { PACKAGE_NAME, LINE_REFERENCE_HEIGHT, NATIVE_LINE_CALIBRATION, MIN_NATIVE_LINE_WIDTH,
  format, waveShape, colorMap, packageSource, syntheticAudio, previewLevels, svgPreview, generate };
