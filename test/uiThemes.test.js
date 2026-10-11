"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createThemes, mapColor, themeFromCookie } = require("../src/uiThemes");

const THEMES_DIR = path.join(__dirname, "..", "src", "themes");
const themes = createThemes({ themesDir: THEMES_DIR, defaultTheme: "original" });
const theme = (id) => JSON.parse(fs.readFileSync(path.join(THEMES_DIR, `${id}.json`), "utf8"));
const rules = (id) => theme(id).rules;
const light = (c) => mapColor(c, rules("roon-light"), { greys: true });
const lum = (hex) => {
  const [r, g, b] = hex.match(/[0-9a-f]{2}/g).map((v) => parseInt(v, 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

function hsl(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2;
  if (d === 0) return { h: null, s: 0, l };
  const h = (max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60;
  return { h, s: l > 0.5 ? d / (2 - max - min) : d / (max + min), l };
}

function publicDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "themes-"));
  fs.mkdirSync(path.join(dir, "themes", "copper", "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "styles.css"), ":root{--accent:#d9b3ff;--bg:#05020b}");
  fs.writeFileSync(path.join(dir, "app.js"), 'x = "#d9b3ff";');
  fs.writeFileSync(path.join(dir, "themes", "copper", "assets", "art.jpg"), "copper art");
  fs.writeFileSync(path.join(dir, "themes", "secret.txt"), "x");
  return dir;
}

test("every bundled theme is listed with its label and the default is reported", () => {
  const listed = themes.list();
  assert.deepEqual(listed.themes.map((t) => t.id).sort(), ["copper", "dark-orange", "graphite-brass", "original", "roon", "roon-light"]);
  assert.equal(listed.themes.find((t) => t.id === "copper").label, "Obsidian & Copper");
  assert.equal(listed.default, "original");
});

test("an unknown default theme falls back to the original look", () => {
  assert.equal(createThemes({ themesDir: THEMES_DIR, defaultTheme: "nope" }).list().default, "original");
});

test("copper turns the lavender accent copper and the pink accent gold", () => {
  assert.ok(Math.abs(hsl(mapColor("#d9b3ff", rules("copper"))).h - 38) < 2);
  assert.ok(Math.abs(hsl(mapColor("#ff73d8", rules("copper"))).h - 46) < 2);
});

test("roon turns tinted darks into lifted neutral greys", () => {
  const bg = hsl(mapColor("#05020b", rules("roon")));
  assert.ok(bg.s <= 0.04 && bg.l > hsl("#05020b").l + 0.04, JSON.stringify(bg));
});

test("roon has no violet: light accents go neutral and mid accents go blue", () => {
  const spread = (hex) => { const c = hex.match(/[0-9a-f]{2}/g).map((v) => parseInt(v, 16)); return Math.max(...c) - Math.min(...c); };
  for (const light of ["#d9b3ff", "#faf6ff", "#ddc9ff", "#ff73d8", "#a77cff", "#8ff0ff"]) {
    assert.ok(spread(mapColor(light, rules("roon"))) <= 16, `${light} -> ${mapColor(light, rules("roon"))} is not neutral`);
  }
  for (const mid of ["#7a4dff", "#9b3dd6", "#5b2a9e", "#c02bb0"]) {
    const { h } = hsl(mapColor(mid, rules("roon")));
    assert.ok(h >= 210 && h <= 225, `${mid} -> ${mapColor(mid, rules("roon"))} has hue ${h}`);
  }
});

test("dark orange makes the page blue-black, light accents white and mid accents an orange that reads on it", () => {
  const spread = (hex) => { const c = hex.match(/[0-9a-f]{2}/g).map((v) => parseInt(v, 16)); return Math.max(...c) - Math.min(...c); };
  const page = mapColor("#05020b", rules("dark-orange"));
  const bg = hsl(page);
  assert.ok(Math.abs(bg.h - 225) < 3 && bg.s <= 0.22 && bg.l >= 0.06 && bg.l <= 0.09, `${page} ${JSON.stringify(bg)}`);
  for (const c of ["#d9b3ff", "#faf6ff", "#ddc9ff", "#ff73d8", "#a77cff", "#8ff0ff"]) {
    assert.ok(spread(mapColor(c, rules("dark-orange"))) <= 16, `${c} -> ${mapColor(c, rules("dark-orange"))} is not neutral`);
  }
  for (const c of ["#7a4dff", "#9b3dd6", "#5b2a9e", "#c02bb0"]) {
    const out = mapColor(c, rules("dark-orange"));
    const { h } = hsl(out);
    assert.ok(h >= 10 && h <= 16, `${c} -> ${out} has hue ${h}`);
    assert.ok(contrast(out, page) >= 4.5, `${c} -> ${out} contrast ${contrast(out, page).toFixed(2)}`);
  }
});

test("dark orange paints strong accent tints solid orange and leaves faint lines and text neutral", () => {
  const spread = (c) => { const [r, g, b] = c.match(/\d+/g).map(Number); return Math.max(r, g, b) - Math.min(r, g, b); };
  for (const c of ["rgba(167, 124, 255, 0.32)", "rgba(217, 179, 255, 0.44)", "rgba(225, 165, 255, 0.48)"]) {
    assert.equal(mapColor(c, rules("dark-orange")), "rgba(228, 74, 32, 0.95)", c);
  }
  for (const c of ["rgba(205, 166, 255, 0.24)", "rgba(217, 179, 255, 0.1)", "rgba(238, 228, 252, 0.82)", "rgba(250, 246, 255, 1)"]) {
    assert.ok(spread(mapColor(c, rules("dark-orange"))) <= 16, `${c} -> ${mapColor(c, rules("dark-orange"))} is not neutral`);
  }
});

test("a rule's alpha range matches on the colour's opacity, hex colours count as opaque, and minAlpha only ever raises it", () => {
  const rule = [{ alpha: [0.3, 0.6], set: { hue: 120 } }];
  assert.equal(mapColor("rgba(255, 0, 0, 0.5)", rule), "rgba(0, 255, 0, 0.5)");
  assert.equal(mapColor("rgba(255, 0, 0, 0.2)", rule), "rgba(255, 0, 0, 0.2)");
  assert.equal(mapColor("#ff0000", rule), "#ff0000");
  assert.equal(mapColor("rgb(255, 0, 0)", rule), "rgb(255, 0, 0)");
  const raise = [{ set: { minAlpha: 0.8 } }];
  assert.equal(mapColor("rgba(255, 0, 0, 0.3)", raise), "rgba(255, 0, 0, 0.8)");
  assert.equal(mapColor("rgba(255, 0, 0, 0.9)", raise), "rgba(255, 0, 0, 0.9)");
});

test("roon light turns the dark page white and its light text near-black", () => {
  assert.ok(hsl(light("#05020b")).l > 0.95, light("#05020b"));
  assert.match(light("rgba(13, 6, 25, 0.88)"), /^rgba\((2[3-5]\d), \1, \1, 0\.88\)$|^rgba\(2[3-5]\d, 2[3-5]\d, 2[3-5]\d, 0\.88\)$/);
  assert.ok(hsl(light("#faf6ff")).l < 0.06, light("#faf6ff"));
  assert.ok(hsl(light("#fff")).l < 0.02, light("#fff"));
  assert.match(light("rgba(255, 255, 255, 0.06)"), /^rgba\(0, 0, 0, 0\.06\)$/);
});

test("roon light makes light accents dark text, as Roon Dark makes them neutral, and mid accents a blue that reads on the page", () => {
  const spread = (hex) => { const c = hex.match(/[0-9a-f]{2}/g).map((v) => parseInt(v, 16)); return Math.max(...c) - Math.min(...c); };
  for (const textAccent of ["#d9b3ff", "#a77cff", "#ff73d8", "#ddc9ff"]) {
    const out = light(textAccent);
    assert.ok(spread(out) <= 8 && contrast(out, light("#05020b")) >= 7, `${textAccent} -> ${out}`);
  }
  for (const accent of ["#7a4dff", "#9b3dd6", "#5b2a9e", "#c02bb0"]) {
    const out = light(accent);
    assert.ok(Math.abs(hsl(out).h - 220) < 3, `${accent} -> ${out}`);
    assert.ok(contrast(out, light("#05020b")) >= 4.5, `${out} on the page has contrast ${contrast(out, light("#05020b")).toFixed(2)}`);
  }
});

test("roon light lifts the filters that darken the artwork backdrop and leaves light dimming alone", () => {
  const dir = publicDir();
  const css = "a{filter: blur(34px) saturate(1.18) brightness(0.48)} b{filter:brightness(.56)} c{filter: brightness(0.9)} d{filter: brightness(1.2)}";
  fs.writeFileSync(path.join(dir, "f.css"), css);
  const lightThemes = createThemes({ themesDir: THEMES_DIR, defaultTheme: "roon-light" });
  const out = lightThemes.render(dir, path.join(dir, "f.css"), Buffer.from(css), undefined).toString();
  assert.equal(out, "a{filter: blur(34px) saturate(1.18) brightness(1.1)} b{filter:brightness(1.1)} c{filter: brightness(0.9)} d{filter: brightness(1.2)}");
  assert.equal(themes.render(dir, path.join(dir, "f.css"), Buffer.from(css), "rh_theme=roon").toString(), css);
  fs.rmSync(dir, { recursive: true });
});

test("roon light keeps status colours recognisable and readable on white", () => {
  for (const [status, hueFrom, hueTo] of [["#ef767a", 345, 360], ["#3fbf6f", 130, 150], ["#ffcf7f", 30, 45]]) {
    const out = light(status), { h } = hsl(out);
    assert.ok(h >= hueFrom && h <= hueTo, `${status} -> ${out} hue ${h}`);
    assert.ok(contrast(out, light("#05020b")) >= 3, `${out} contrast ${contrast(out, light("#05020b")).toFixed(2)}`);
  }
});

test("greys are only remapped by themes that ask for it", () => {
  assert.equal(mapColor("#fff", rules("roon-light")), "#fff");
  assert.notEqual(mapColor("#fff", rules("roon-light"), { greys: true }), "#fff");
});

test("roon light switches the browser to its light colour scheme and ships its own art rules", () => {
  const dir = publicDir();
  fs.writeFileSync(path.join(dir, "scheme.css"), ":root{color-scheme: dark;--bg:#05020b}\nbody{color-scheme:dark}");
  const lightThemes = createThemes({ themesDir: THEMES_DIR, defaultTheme: "roon-light" });
  const out = lightThemes.render(dir, path.join(dir, "scheme.css"), fs.readFileSync(path.join(dir, "scheme.css")), undefined).toString();
  assert.doesNotMatch(out, /color-scheme: ?dark/);
  assert.equal(out.match(/color-scheme: light/g).length, 2);
  assert.match(themes.render(dir, path.join(dir, "scheme.css"), fs.readFileSync(path.join(dir, "scheme.css")), "rh_theme=roon").toString(), /color-scheme: dark/);
  const art = theme("roon-light").artRules;
  assert.ok(Array.isArray(art) && art.length, "art rules exist");
  assert.ok(art.every((rule) => !rule.set.invertLight), "artwork is never turned into a negative");
  fs.rmSync(dir, { recursive: true });
});

test("colour formats and alpha survive a remap and greys are untouched", () => {
  assert.match(mapColor("rgba(217, 179, 255, 0.12)", rules("copper")), /^rgba\(\d{1,3}, \d{1,3}, \d{1,3}, 0\.12\)$/);
  assert.match(mapColor("#a7f", rules("copper")), /^#[0-9a-f]{6}$/);
  for (const c of ["#fff", "#555", "rgba(255, 255, 255, 0.06)"]) assert.equal(mapColor(c, rules("roon")), c);
});

test("the original theme changes nothing", () => {
  assert.equal(mapColor("#d9b3ff", rules("original")), "#d9b3ff");
});

test("the theme cookie is read among other cookies and malformed values are ignored", () => {
  assert.equal(themeFromCookie("a=1; rh_theme=roon; b=2"), "roon");
  for (const header of [undefined, "", "a=1", "rh_theme=", "rh_theme=../etc", "rh_theme=Roon"]) assert.equal(themeFromCookie(header), null);
});

test("stylesheets are recoloured for the cookie's theme and other files are served as they are", () => {
  const dir = publicDir();
  const css = fs.readFileSync(path.join(dir, "styles.css"));
  const out = themes.render(dir, path.join(dir, "styles.css"), css, "rh_theme=copper").toString();
  assert.doesNotMatch(out, /#d9b3ff|#05020b/);
  assert.equal(themes.render(dir, path.join(dir, "styles.css"), css, "rh_theme=original").toString(), css.toString());
  assert.equal(themes.render(dir, path.join(dir, "styles.css"), css, undefined).toString(), css.toString());
  const js = fs.readFileSync(path.join(dir, "app.js"));
  assert.equal(themes.render(dir, path.join(dir, "app.js"), js, "rh_theme=copper"), js);
  fs.rmSync(dir, { recursive: true });
});

test("a theme's own artwork replaces the default file and cannot escape its folder", () => {
  const dir = publicDir();
  assert.equal(themes.assetPath(dir, "/assets/art.jpg", "rh_theme=copper"), path.join(dir, "themes", "copper", "assets", "art.jpg"));
  assert.equal(themes.assetPath(dir, "/assets/art.jpg", "rh_theme=roon"), null);
  assert.equal(themes.assetPath(dir, "/../secret.txt", "rh_theme=copper"), null);
  assert.equal(themes.assetPath(dir, "/assets/art.jpg", "rh_theme=nope"), null);
  fs.rmSync(dir, { recursive: true });
});

test("the default theme applies when no cookie is set", () => {
  const dir = publicDir();
  const copperDefault = createThemes({ themesDir: THEMES_DIR, defaultTheme: "copper" });
  const css = fs.readFileSync(path.join(dir, "styles.css"));
  assert.doesNotMatch(copperDefault.render(dir, path.join(dir, "styles.css"), css, undefined).toString(), /#d9b3ff/);
  assert.equal(copperDefault.assetPath(dir, "/assets/art.jpg", undefined), path.join(dir, "themes", "copper", "assets", "art.jpg"));
  assert.match(copperDefault.render(dir, path.join(dir, "styles.css"), css, "rh_theme=original").toString(), /#d9b3ff/);
  fs.rmSync(dir, { recursive: true });
});

test("graphite and brass makes the page Rouen's graphite, text its warm off-white and strong tints solid brass", () => {
  const page = hsl(mapColor("#05020b", rules("graphite-brass")));
  assert.ok(Math.abs(page.h - 216) < 6 && page.s <= 0.12 && page.l >= 0.09 && page.l <= 0.12, JSON.stringify(page));
  const text = hsl(mapColor("#faf6ff", rules("graphite-brass")));
  assert.ok(text.h >= 40 && text.h <= 60 && text.s <= 0.13 && text.l >= 0.89 && text.l <= 0.93, JSON.stringify(text));
  const tint = mapColor("rgba(167, 124, 255, 0.32)", rules("graphite-brass"));
  const [r, g, b, a] = tint.match(/[\d.]+/g).map(Number);
  const brass = hsl("#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join(""));
  assert.ok(Math.abs(brass.h - 39) < 3 && a >= 0.95, `${tint} ${JSON.stringify(brass)}`);
  for (const mid of ["#7a4dff", "#9b3dd6", "#5b2a9e", "#c02bb0"]) {
    const out = mapColor(mid, rules("graphite-brass"));
    assert.ok(Math.abs(hsl(out).h - 39) < 3, `${mid} -> ${out}`);
    assert.ok(contrast(out, mapColor("#05020b", rules("graphite-brass"))) >= 4.5, `${mid} -> ${out} contrast`);
  }
});

test("a theme's own stylesheet is appended to styles.css only, after the recolouring", () => {
  const dir = publicDir();
  fs.mkdirSync(path.join(dir, "themes", "graphite-brass"), { recursive: true });
  fs.writeFileSync(path.join(dir, "themes", "graphite-brass", "theme.css"), "body { font-family: \"Manrope\"; color: #d9b3ff; }");
  fs.writeFileSync(path.join(dir, "other.css"), "a { color: #d9b3ff; }");
  const served = themes.render(dir, path.join(dir, "styles.css"), fs.readFileSync(path.join(dir, "styles.css")), "rh_theme=graphite-brass").toString();
  assert.match(served, /font-family: "Manrope"; color: #d9b3ff; \}$/);
  assert.doesNotMatch(served.slice(0, served.indexOf("font-family")), /#d9b3ff/);
  assert.doesNotMatch(themes.render(dir, path.join(dir, "other.css"), fs.readFileSync(path.join(dir, "other.css")), "rh_theme=graphite-brass").toString(), /Manrope/);
  assert.doesNotMatch(themes.render(dir, path.join(dir, "styles.css"), fs.readFileSync(path.join(dir, "styles.css")), "rh_theme=copper").toString(), /Manrope/);
});

test("graphite and brass ships Manrope and Young Serif with their licence and uses them for body text and headings", () => {
  const dir = path.join(__dirname, "..", "public", "themes", "graphite-brass");
  assert.equal(theme("graphite-brass").stylesheet, "theme.css");
  for (const font of ["manrope.woff2", "young-serif.woff2"]) assert.ok(fs.statSync(path.join(dir, "fonts", font)).size > 10000, font);
  assert.match(fs.readFileSync(path.join(dir, "fonts", "LICENSE.txt"), "utf8"), /SIL Open Font License/);
  const css = fs.readFileSync(path.join(dir, "theme.css"), "utf8");
  assert.match(css, /@font-face \{ font-family: "Manrope"; src: url\("\/themes\/graphite-brass\/fonts\/manrope\.woff2"\)/);
  assert.match(css, /@font-face \{ font-family: "Young Serif"; src: url\("\/themes\/graphite-brass\/fonts\/young-serif\.woff2"\)/);
  assert.match(css, /body \{[^}]*font-family: "Manrope"/);
  assert.match(css, /h1, h2[^{]*\{[^}]*font-family: "Young Serif"/);
});

test("graphite and brass fills the selected pill in every pill group, Lyrion's tabs included, with solid brass and dark text, and leaves cards alone", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "themes", "graphite-brass", "theme.css"), "utf8");
  const groups = ":is(.lyrionChoices, .lyrionTabs, .viewTabs, .secondaryNavItems, .lyrionCenterViews, .dbViewSwitch, .tidalLibraryFilters) button";
  const state = ':is(.active, [aria-pressed="true"], [aria-current="page"], [aria-selected="true"])';
  assert.ok(css.includes("@layer pills {"), "brass pills share the pills layer");
  const rule = (suffix) => css.match(new RegExp(`${(groups + state + suffix).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`))?.[1];
  const solid = rule("");
  assert.ok(solid, "selected pill rule");
  const value = (block, prop) => block.match(new RegExp(`\\n\\s*${prop}: ([^;]+?) !important;`))?.[1];
  assert.deepEqual(["background", "border-color", "color"].map((p) => value(solid, p)), ["#c9a45c", "#c9a45c", "#17191c"]);
  const hover = rule(":hover");
  assert.ok(hover, "selected pill hover rule");
  for (const fill of [value(solid, "background"), value(hover, "background")]) assert.ok(contrast(fill, "#17191c") >= 4.5, `${fill} on #17191c`);
  assert.doesNotMatch(css, /scoringModeCard/);
});
