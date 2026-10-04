"use strict";

// This fixture never runs the app server or loads the app's other client scripts.
// All browser requests are fulfilled from public/ or aborted before navigation.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const publicRoot = path.join(root, "public");
const fixtureOrigin = "http://rabbit-hole-browser.test";
const outputDir = process.env.RH_BROWSER_OUTPUT_DIR;
const viewports = [
  { name: "desktop", width: 1280, height: 900 },
  { name: "tablet", width: 1280, height: 800 },
  { name: "tablet-portrait", width: 800, height: 1280 },
  { name: "tablet-landscape", width: 1024, height: 768 },
  { name: "phone", width: 390, height: 844 }
];

// Retain the production function body, including its DOM and keyboard behavior.
// Quoted strings and comments must not make a nested callback look like the end.
function sourceFunction(source, name) {
  const expression = new RegExp(`(?:async\\s+)?function ${name}\\s*\\(`, "g");
  const matches = [...source.matchAll(expression)];
  assert.equal(matches.length, 1, `Expected one production ${name} function`);
  const start = matches[0].index;
  const body = source.indexOf("{", source.indexOf(")", start));
  let depth = 0;
  let quote = "";
  let lineComment = false;
  let blockComment = false;
  for (let index = body; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") { blockComment = false; index += 1; }
      continue;
    }
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "/" && next === "/") { lineComment = true; index += 1; continue; }
    if (character === "/" && next === "*") { blockComment = true; index += 1; continue; }
    if (character === '"' || character === "'" || character === "`") { quote = character; continue; }
    if (character === "{") depth += 1;
    if (character === "}" && --depth === 0) {
      const result = source.slice(start, index + 1);
      new Function(result); // Syntax-check extraction; do not execute it here.
      return result;
    }
  }
  throw new Error(`Cannot extract production ${name}`);
}

async function afterLayout(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function measurements(page) {
  return page.evaluate(() => {
    const panel = document.querySelector("#rabbitHolePanel");
    const opener = document.querySelector("#openRabbitHole");
    const rect = (element) => {
      const value = element.getBoundingClientRect();
      return { top: value.top, bottom: value.bottom, left: value.left, right: value.right, width: value.width, height: value.height };
    };
    return {
      hidden: panel.hidden,
      display: getComputedStyle(panel).display,
      expanded: opener.getAttribute("aria-expanded"),
      focus: document.activeElement.id,
      calls: window.fixtureGraphCalls,
      panel: rect(panel),
      opener: rect(opener),
      close: rect(document.querySelector("#closeRabbitHole")),
      regionRole: panel.getAttribute("role"),
      regionLabel: document.querySelector(`#${panel.getAttribute("aria-labelledby")}`)?.textContent,
      player: rect(document.querySelector(".player")),
      stageScroll: { left: document.querySelector(".player").scrollLeft, top: document.querySelector(".player").scrollTop },
      artwork: rect(document.querySelector(".player > .artStack")),
      seek: rect(document.querySelector(".player > .seekBlock")),
      viewport: { width: innerWidth, height: innerHeight },
      full: document.fullscreenElement?.classList.contains("player") || false
    };
  });
}

async function assertClosed(page, calls) {
  const result = await measurements(page);
  assert.equal(result.hidden, true, "Closed panel retains hidden");
  assert.equal(result.display, "none", "Closed panel is actually hidden by CSS");
  assert.equal(result.expanded, "false", "Disclosure reports collapsed");
  assert.equal(result.calls, calls, "Closing does not load the graph again");
}

async function assertOpened(page, mode, calls, baseline) {
  await page.waitForFunction((expected) => window.fixtureGraphLoads === expected, calls);
  await afterLayout(page);
  const result = await measurements(page);
  assert.equal(result.hidden, false, "Opening removes hidden");
  assert.notEqual(result.display, "none", "Production CSS must render the open panel");
  assert.ok(result.panel.width > 0 && result.panel.height > 0, "Open panel has a visible layout box");
  assert.equal(result.expanded, "true", "Disclosure reports expanded");
  assert.equal(result.calls, calls, "Each opening loads the mocked graph once");
  assert.equal(result.focus, "rabbitHolePanel", "Opening focuses the labeled region");
  assert.equal(result.regionRole, "region", "Panel is a nonmodal region");
  assert.ok(result.regionLabel?.trim(), "Panel region has a real accessible label");
  assert.ok(result.close.top >= Math.max(0, result.panel.top) - 1 && result.close.bottom <= Math.min(result.viewport.height, result.panel.bottom) + 1, "Open panel's Close control is visible without scrolling");
  assert.ok(result.close.left >= Math.max(0, result.panel.left) - 1 && result.close.right <= Math.min(result.viewport.width, result.panel.right) + 1, "Open panel's Close control is horizontally reachable");
  assert.ok(result.close.width >= 44 && result.close.height >= 44, "Close control has a touch target of at least 44 pixels");
  for (const region of ["artwork", "seek"]) {
    for (const edge of ["left", "top"]) {
      // Activating an offscreen phone control may legitimately scroll the stage.
      // Compare its layout coordinates independently of that scroll position.
      const before = baseline[region][edge] - baseline.player[edge] + baseline.stageScroll[edge];
      const after = result[region][edge] - result.player[edge] + result.stageScroll[edge];
      assert.ok(Math.abs(after - before) <= 1, `Opening preserves ${region} ${edge} placement within the stage (${before} -> ${after}; stage scroll ${JSON.stringify(baseline.stageScroll)} -> ${JSON.stringify(result.stageScroll)})`);
    }
    assert.ok(Math.abs(result[region].width - baseline[region].width) <= 1, `Opening preserves ${region} width`);
    assert.ok(Math.abs(result[region].height - baseline[region].height) <= 1, `Opening preserves ${region} height`);
  }
  if (mode === "regular") {
    assert.ok(result.panel.top >= result.seek.bottom - 1, "Inline graph follows the seek/transport rows");
  } else {
    assert.ok(Math.abs(result.player.height - baseline.player.height) <= 1, "Expanded graph does not resize the stage");
    assert.ok(result.panel.top >= -1 && result.panel.left >= -1, `Expanded graph starts inside the viewport (${JSON.stringify(result.panel)}; stage scroll ${JSON.stringify(result.stageScroll)})`);
    assert.ok(result.panel.bottom <= result.viewport.height + 1, "Expanded graph stays vertically bounded");
    assert.ok(result.panel.right <= result.viewport.width + 1, "Expanded graph stays horizontally bounded");
  }
  if (mode === "fullscreen") assert.equal(result.full, true, "Test uses actual browser fullscreen");
}

async function assertRestoredFocus(page) {
  const result = await measurements(page);
  assert.equal(result.focus, "openRabbitHole", "Closing restores disclosure focus");
  assert.ok(result.opener.height > 0 && result.opener.top >= -1 && result.opener.bottom <= result.viewport.height + 1, "Restored disclosure is vertically visible");
  assert.ok(result.opener.left >= -1 && result.opener.right <= result.viewport.width + 1, "Restored disclosure is horizontally visible");
}

async function screenshot(page, name) {
  if (!outputDir) return;
  const directory = path.resolve(outputDir);
  assert.ok(directory !== root && !directory.startsWith(`${root}${path.sep}`), "Browser captures belong outside the checkout");
  await fs.mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, `${name}.png`) });
}

async function checkCase(browser, html, client, viewport, mode) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    hasTouch: viewport.name !== "desktop",
    reducedMotion: "reduce",
    serviceWorkers: "block"
  });
  context.setDefaultTimeout(5000);
  const forbiddenRequests = [];
  const pageErrors = [];
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== fixtureOrigin || request.method() !== "GET" || url.pathname.startsWith("/api/")) {
      if (url.pathname.startsWith("/api/") || request.method() !== "GET") forbiddenRequests.push(request.url());
      return route.abort("blockedbyclient");
    }
    if (url.pathname === "/") return route.fulfill({ status: 200, contentType: "text/html", body: html });
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const filename = path.resolve(publicRoot, relative);
    if (!filename.startsWith(`${publicRoot}${path.sep}`) || !/\.(?:css|png|jpe?g|gif|webp|svg|ico|woff2?)$/i.test(filename)) {
      return route.abort("blockedbyclient");
    }
    try {
      const body = await fs.readFile(filename);
      return route.fulfill({ status: 200, body, ...(filename.endsWith(".css") ? { contentType: "text/css" } : {}) });
    } catch {
      return route.abort("blockedbyclient");
    }
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    await page.goto(`${fixtureOrigin}/`, { waitUntil: "load", timeout: 10000 });
    await page.addScriptTag({ content: client });
    await page.evaluate((nextMode) => {
      const player = document.querySelector(".player");
      const tools = document.querySelector("#nowDiscoveryTools");
      document.body.classList.toggle("hasTouchScreen", navigator.maxTouchPoints > 0 || "ontouchstart" in window);
      tools.hidden = false;
      // A recognized now-playing track always renders this feedback rail. Empty
      // initial HTML would leave the tools grid in a state the app never shows.
      const feedbackRail = document.createElement("div");
      feedbackRail.className = "feedbackRail";
      for (const [value, label] of [["love", "Love"], ["like", "Like"], ["ok", "Okay"], ["dislike", "Dislike"], ["never", "Never Again"]]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `feedbackButton ${value}`;
        button.dataset.nowFeedback = value;
        button.dataset.nowIndex = "0";
        button.setAttribute("aria-pressed", "false");
        button.textContent = label;
        feedbackRail.append(button);
      }
      document.querySelector("#nowFeedback").replaceChildren(feedbackRail);
      document.querySelector("#nowTitle").textContent = "Synthetic browser fixture";
      player.classList.remove("player--regular", "player--maximized", "player--fullscreen", "isMaximized", "isFullWindow");
      player.classList.add(`player--${nextMode}`);
      // Fullscreen enters through maximized mode; production retains both flags.
      document.body.classList.toggle("playerMaximized", nextMode !== "regular");
      document.body.classList.toggle("playerFullWindow", nextMode === "fullscreen");
      if (nextMode === "maximized") player.classList.add("isMaximized");
      if (nextMode === "fullscreen") {
        player.classList.add("isMaximized", "isFullWindow");
        document.querySelector("#togglePlayerFull").addEventListener("click", () => {
          player.requestFullscreen().catch((error) => { window.fixtureFullscreenError = error.message; });
        });
      }
    }, mode);
    if (mode === "fullscreen") {
      await page.locator("#togglePlayerFull").click();
      await page.waitForFunction(() => document.fullscreenElement?.classList.contains("player"));
    }
    await afterLayout(page);
    await assertClosed(page, 0);
    const baseline = await measurements(page);
    await screenshot(page, `${mode}-${viewport.name}-closed`);

    const opener = page.locator("#openRabbitHole");
    await opener.click();
    await afterLayout(page);
    await assertOpened(page, mode, 1, baseline);
    await screenshot(page, `${mode}-${viewport.name}-open`);
    // The disclosure's own second activation must close without a new request.
    // Overlays offer their real, reachable Close button and Escape below; their
    // original opener can be covered while the region is in front of the stage.
    if (mode === "regular") await opener.click();
    else await opener.evaluate((element) => element.click());
    await afterLayout(page);
    await assertClosed(page, 1);

    await opener.click();
    await afterLayout(page);
    await assertOpened(page, mode, 2, baseline);
    const last = page.locator("[data-fixture-last]");
    await last.scrollIntoViewIfNeeded();
    await afterLayout(page);
    const reachable = await last.evaluate((element) => {
      const bottom = element.getBoundingClientRect();
      const panel = document.querySelector("#rabbitHolePanel").getBoundingClientRect();
      return bottom.height > 0 && bottom.top >= Math.max(0, panel.top) - 1 && bottom.bottom <= Math.min(innerHeight, panel.bottom) + 1;
    });
    assert.equal(reachable, true, "Graph bottom is reachable through actual scrolling");
    await screenshot(page, `${mode}-${viewport.name}-bottom`);
    await page.locator("#closeRabbitHole").click();
    await afterLayout(page);
    await assertClosed(page, 2);
    await assertRestoredFocus(page);

    await opener.click();
    await afterLayout(page);
    await assertOpened(page, mode, 3, baseline);
    await page.keyboard.press("Escape");
    await afterLayout(page);
    await assertClosed(page, 3);
    await assertRestoredFocus(page);
    if (mode === "fullscreen") assert.equal((await measurements(page)).full, true, "Panel Escape preserves browser fullscreen");
    assert.deepEqual(pageErrors, [], "Fixture has no client errors");
    assert.deepEqual(forbiddenRequests, [], "No app API or action request was attempted");
    console.log(`Passed ${mode} ${viewport.name} ${viewport.width}x${viewport.height}: disclosure, scrolling, close and Escape`);
  } catch (error) {
    await screenshot(page, `${mode}-${viewport.name}-failure`).catch(() => {});
    const diagnostic = await page.evaluate(() => {
      const selectors = [".player", ".player > .playerViewControls", ".player > .now", ".player > .artStack", ".player > .nowDiscoveryTools", ".player > .controls", ".player > .seekBlock", "#openRabbitHole"];
      return Object.fromEntries(selectors.map((selector) => {
        const element = document.querySelector(selector);
        const css = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return [selector, {
          gridAreas: css.gridTemplateAreas, gridRows: css.gridTemplateRows, gridColumns: css.gridTemplateColumns,
          gridArea: css.gridArea, gridRow: css.gridRow, gridColumn: css.gridColumn,
          position: css.position, transform: css.transform, zIndex: css.zIndex,
          rect: { top: box.top, left: box.left, bottom: box.bottom, right: box.right, width: box.width, height: box.height },
          scroll: { top: element.scrollTop, left: element.scrollLeft, height: element.scrollHeight, width: element.scrollWidth }
        }];
      }));
    }).catch(() => null);
    if (diagnostic) console.error(JSON.stringify({ case: `${mode}-${viewport.name}`, diagnostic }));
    throw new Error(`${mode} ${viewport.name} ${viewport.width}x${viewport.height}: ${error.message}`, { cause: error });
  } finally {
    await context.close();
  }
}

async function main() {
  const playwright = require(process.env.RH_BROWSER_PLAYWRIGHT_MODULE || "playwright");
  const originalHtml = await fs.readFile(path.join(publicRoot, "index.html"), "utf8");
  const html = originalHtml.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "");
  assert.doesNotMatch(html, /<script\b/i, "No other production script runs in this fixture");
  const app = await fs.readFile(path.join(publicRoot, "app.js"), "utf8");
  const client = `
    const $ = (selector) => document.querySelector(selector);
    const state = { nowTrack: { title: "Fixture track", artist: "Fixture artist", tidalId: "fixture-only" } };
    window.fixtureGraphCalls = 0;
    window.fixtureGraphLoads = 0;
    async function loadRabbitHole() {
      window.fixtureGraphCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      const sections = Array.from({ length: 24 }, (_, index) =>
        '<section class="rabbitDepth"><h3>Fixture depth ' + (index + 1) + '</h3>' +
        '<p>Isolated synthetic graph content for a scrolling regression.</p>' +
        '<button type="button"' + (index === 23 ? ' data-fixture-last' : '') + '>Fixture action ' + (index + 1) + '</button></section>'
      );
      $("#rabbitHoleContent").innerHTML = sections.join("");
      window.fixtureGraphLoads += 1;
    }
    ${sourceFunction(app, "setRabbitHolePanelOpen")}
    ${sourceFunction(app, "bindRabbitHolePanel")}
    bindRabbitHolePanel();
  `;
  const browser = await playwright.chromium.launch({
    headless: true,
    ...(process.env.RH_BROWSER_EXECUTABLE ? { executablePath: process.env.RH_BROWSER_EXECUTABLE } : {}),
    args: ["--disable-background-networking", "--disable-component-update", "--disable-sync"]
  });
  try {
    const failures = [];
    for (const mode of ["regular", "maximized", "fullscreen"]) {
      for (const viewport of viewports) {
        try {
          await checkCase(browser, html, client, viewport, mode);
        } catch (error) {
          failures.push(error);
          console.error(error.message);
        }
      }
    }
    if (failures.length) throw new AggregateError(failures, `${failures.length} browser layout case(s) failed`);
    console.log(`Browser regression passed: ${viewports.length * 3} isolated real-CSS layouts; no live services or playback.`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
