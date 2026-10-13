#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { remapPixels } = require("../src/uiThemes");

const ROOT = path.join(__dirname, "..");
const ART = ["assets/rabbit-hole-fallback.jpg"];

function recolor(source, target, rules) {
  const [width, height] = execFileSync("identify", ["-format", "%w %h", source], { encoding: "utf8" }).trim().split(" ");
  const raw = execFileSync("convert", [source, "-depth", "8", "rgb:-"], { maxBuffer: 1 << 28 });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  execFileSync("convert", ["-size", `${width}x${height}`, "-depth", "8", "rgb:-", "-strip", "-quality", "75", target], {
    input: remapPixels(raw, 3, rules)
  });
}

for (const name of fs.readdirSync(path.join(ROOT, "src", "themes")).filter((n) => n.endsWith(".json"))) {
  const theme = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "themes", name), "utf8"));
  const rules = theme.artRules || theme.rules;
  if (!rules.length) continue;
  for (const art of ART) {
    const target = path.join(ROOT, "public", "themes", theme.id, art);
    recolor(path.join(ROOT, "public", art), target, rules);
    console.log(`rendered ${path.relative(ROOT, target)}`);
  }
}
