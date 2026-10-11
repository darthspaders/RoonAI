"use strict";

const fs = require("node:fs");
const path = require("node:path");

const THEME_COOKIE = /(?:^|;\s*)rh_theme=([a-z0-9-]+)(?:;|$)/;
const COLOR = /(?<=[\s:,("'])(#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(?:,\s*[\d.]+\s*)?\))/g;
const RECOLORED = new Set([".css", ".html"]);

function toHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function toRgb(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}

function remap([h, s, l], rules, { greys = false, alpha = 1 } = {}) {
  if (s < 0.08 && !greys) return null;
  for (const rule of rules) {
    const [hueFrom, hueTo] = rule.hue || [0, 360];
    const [lightFrom, lightTo] = rule.light || [0, 1];
    const [satFrom, satTo] = rule.sat || [0, 1];
    const [alphaFrom, alphaTo] = rule.alpha || [0, 1];
    if (h < hueFrom || h >= hueTo || l < lightFrom || l > lightTo || s < satFrom || s > satTo || alpha < alphaFrom || alpha > alphaTo) continue;
    const set = rule.set || {};
    const lightness = (set.invertLight ? 1 - l : l) + (set.addLight || 0);
    return [
      set.hue ?? h,
      Math.min(s, set.maxSat ?? 1),
      Math.min(set.maxLight ?? 1, Math.max(set.minLight ?? 0, lightness)),
      Math.max(alpha, set.minAlpha ?? 0)
    ];
  }
  return null;
}

function mapColor(color, rules, options) {
  let rgb, format, alpha = 1;
  if (color[0] === "#") {
    const hex = color.length === 4 ? [...color.slice(1)].map((c) => c + c).join("") : color.slice(1);
    rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    format = (c) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
  } else {
    const fn = color.slice(0, color.indexOf("("));
    const parts = color.slice(fn.length + 1, -1).split(",").map((p) => p.trim());
    rgb = parts.slice(0, 3).map(Number);
    if (parts[3] !== undefined) alpha = Number(parts[3]);
    format = (c, a) => `${fn}(${c.join(", ")}${parts[3] === undefined ? "" : `, ${a === alpha ? parts[3] : a}`})`;
  }
  const next = remap(toHsl(...rgb), rules, { ...options, alpha });
  return next ? format(toRgb(...next.slice(0, 3)), next[3]) : color;
}

function remapPixels(buffer, channels, rules, options) {
  for (let i = 0; i < buffer.length; i += channels) {
    const next = remap(toHsl(buffer[i], buffer[i + 1], buffer[i + 2]), rules, options);
    if (next) buffer.set(toRgb(...next), i);
  }
  return buffer;
}

function themeFromCookie(header) {
  const match = THEME_COOKIE.exec(String(header || ""));
  return match ? match[1] : null;
}

function loadThemes(themesDir) {
  const themes = new Map();
  for (const name of fs.readdirSync(themesDir).filter((n) => n.endsWith(".json")).sort()) {
    const theme = JSON.parse(fs.readFileSync(path.join(themesDir, name), "utf8"));
    themes.set(theme.id, {
      id: theme.id,
      label: theme.label,
      rules: theme.rules || [],
      greys: theme.greys === true,
      liftDarkening: theme.liftDarkening || null,
      scheme: theme.scheme === "light" ? "light" : "dark",
      stylesheet: typeof theme.stylesheet === "string" ? theme.stylesheet : ""
    });
  }
  return themes;
}

function createThemes({ themesDir, defaultTheme }) {
  const themes = loadThemes(themesDir);
  const fallback = themes.has(defaultTheme) ? defaultTheme : "original";
  const cache = new Map();

  function active(cookieHeader) {
    const chosen = themeFromCookie(cookieHeader);
    return themes.get(themes.has(chosen) ? chosen : fallback) || null;
  }

  function list() {
    return { themes: [...themes.values()].map(({ id, label }) => ({ id, label })), default: fallback };
  }

  function themeStylesheet(publicDir, theme, filePath) {
    if (!theme.stylesheet || path.basename(theme.stylesheet) !== theme.stylesheet) return "";
    if (path.resolve(filePath) !== path.resolve(publicDir, "styles.css")) return "";
    try {
      return fs.readFileSync(path.join(publicDir, "themes", theme.id, theme.stylesheet), "utf8");
    } catch {
      return "";
    }
  }

  function render(publicDir, filePath, data, cookieHeader) {
    const theme = active(cookieHeader);
    if (!theme || !theme.rules.length || !RECOLORED.has(path.extname(filePath))) return data;
    const key = `${theme.id}\0${filePath}`;
    const source = data.toString("utf8");
    const extra = themeStylesheet(publicDir, theme, filePath);
    const hit = cache.get(key);
    if (hit && hit.source === source && hit.extra === extra) return hit.output;
    let output = source.replace(COLOR, (m) => mapColor(m, theme.rules, { greys: theme.greys }));
    if (theme.scheme === "light") output = output.replace(/color-scheme:\s*dark/g, "color-scheme: light");
    if (theme.liftDarkening) {
      const { below, brightness } = theme.liftDarkening;
      output = output.replace(/brightness\(\s*([\d.]+)\s*\)/g, (m, value) => (Number(value) < below ? `brightness(${brightness})` : m));
    }
    if (extra) output = `${output}\n${extra}`;
    output = Buffer.from(output);
    cache.set(key, { source, extra, output });
    return output;
  }

  function assetPath(publicDir, safePath, cookieHeader) {
    const theme = active(cookieHeader);
    if (!theme) return null;
    const themeDir = path.join(publicDir, "themes", theme.id);
    const filePath = path.normalize(path.join(themeDir, safePath));
    const relativePath = path.relative(themeDir, filePath);
    if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) return null;
    try {
      return fs.statSync(filePath).isFile() ? filePath : null;
    } catch {
      return null;
    }
  }

  return { list, render, assetPath };
}

module.exports = { createThemes, mapColor, remapPixels, themeFromCookie };
