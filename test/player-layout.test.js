const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const memoryHtml = fs.readFileSync(path.join(root, 'public', 'memory.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');

test('now playing artwork and discovery badge are direct player grid items', () => {
  const nowIndex = html.indexOf('<div class="now">');
  const artIndex = html.indexOf('<div class="artStack">', nowIndex);
  const badgeIndex = html.indexOf('<div id="nowDiscoveryBadge"', artIndex);
  const toolsIndex = html.indexOf('<div id="nowDiscoveryTools"', badgeIndex);

  assert.ok(nowIndex >= 0);
  assert.ok(artIndex > nowIndex);
  assert.ok(badgeIndex > artIndex);
  assert.ok(toolsIndex > badgeIndex);
  assert.doesNotMatch(html.slice(toolsIndex, html.indexOf('</div>', toolsIndex)), /nowDiscoveryBadge/);
});

test('regular, maximized, and fullscreen geometry have explicit scoped owners', () => {
  assert.match(css, /\.player\.player--regular:not\(\.isMaximized\):not\(\.isFullWindow\) \{/);
  assert.match(css, /body\.playerMaximized \.player\.player--maximized\.isMaximized:not\(\.player--fullscreen\):not\(\.isFullWindow\) \{/);
  assert.match(css, /body\.playerFullWindow \.player\.player--fullscreen\.isFullWindow,/);
  assert.match(css, /Journey\/Playlist Builder is deliberately below it/);
  assert.doesNotMatch(css, /Black-glass theme experiment|fullscreen experiment|regression repair/);
});

test('desktop polish uses shared page headers and stays scoped to regular mode', () => {
  assert.equal((html.match(/class="panel [^"]*pageHero/g) || []).length, 7);
  assert.match(css, /Pass 6: regular desktop readability and proportion polish/);
  assert.match(css, /\.player\.player--regular:not\(\.isMaximized\):not\(\.isFullWindow\) \{/);
  assert.match(css, /grid-template-rows: 42px clamp\(470px, 58vh, 540px\) 58px 44px;/);
  assert.match(css, /\.player\.player--regular:not\(\.isMaximized\):not\(\.isFullWindow\) > \.now \{\s+overflow: auto;/);
  assert.match(css, /\.player\.player--regular:not\(\.isMaximized\):not\(\.isFullWindow\) \.nowInfo \{\s+height: auto;\s+min-height: 100%;/);
  assert.match(css, /\.player\.player--regular:not\(\.isMaximized\):not\(\.isFullWindow\) > \.nowDiscoveryTools \{\s+overflow: auto;/);
  assert.match(css, /\.player--fullscreen/);
});

test('desktop visual-system follow-up shares regular-view surfaces without touching player modes', () => {
  assert.match(css, /Pass 6 follow-up: regular desktop visual-system consistency/);
  assert.match(css, /@media \(min-width: 1100px\)/);
  assert.match(css, /--rh-desktop-surface:/);
  assert.match(css, /#queueView[\s\S]*#settingsView[\s\S]*\.isActive \.panel/);
  assert.match(css, /\.musicMemoryCard[\s\S]*\.tidalMixCard[\s\S]*background: var\(--rh-desktop-card\)/);
  assert.match(css, /\.musicMemoryArt[\s\S]*\.tidalMixArt/);
  assert.match(css, /:not\(\.scoringModeCard\)/);
  assert.match(memoryHtml, /main data-memory-item="synapse-memory"/);
  assert.match(css, /standalone Synapse Memory route in the same desktop system/);
  assert.match(css, /main\[data-memory-item="synapse-memory"\] > section/);
});

test('regular desktop inherits maximized artwork treatment while player modes remain scoped', () => {
  assert.match(css, /Pass 6 correction: regular player inherits the approved maximized artwork language/);
  assert.match(css, /\.player\.player--regular:not\(\.isMaximized\):not\(\.isFullWindow\)::before[\s\S]*?var\(--now-artwork-backdrop\) center \/ cover no-repeat;[\s\S]*?filter: blur\(28px\) saturate\(1\.08\) brightness\(0\.4\);[\s\S]*?opacity: 0\.76;/);
  assert.match(css, /\.player\.player--regular:not\(\.isMaximized\):not\(\.isFullWindow\) > \.artStack::before,[\s\S]*?display: none;/);
  assert.match(css, /\.player\.player--regular:not\(\.isMaximized\):not\(\.isFullWindow\) \.cover[\s\S]*?background-color: transparent;[\s\S]*?opacity: 0\.75;[\s\S]*?box-shadow: none;/);
  assert.match(css, /body\.playerMaximized[\s\S]*?filter: blur\(28px\) saturate\(1\.08\) brightness\(0\.4\);[\s\S]*?opacity: 0\.76;/);
  assert.match(css, /body\.playerFullWindow[\s\S]*?var\(--now-artwork-backdrop\) center \/ cover no-repeat;[\s\S]*?filter: blur\(6px\) saturate\(0\.92\) brightness\(0\.56\);/);
  assert.match(css, /--rh-desktop-surface: linear-gradient\(145deg, rgba\(12, 13, 17, 0\.94\), rgba\(3, 4, 7, 0\.97\)\);/);
  assert.match(css, /body:not\(\.playerFullWindow\):not\(\.playerMaximized\) \{[\s\S]*?linear-gradient\(180deg, #07080b 0%, #0b0c11 48%, #030407 100%\);/);
  assert.match(css, /linear-gradient\(145deg, rgba\(23, 24, 29, 0\.86\), rgba\(5, 6, 9, 0\.95\)\) padding-box/);
});

test('regular desktop seek styling and width polish stay isolated from approved player modes', () => {
  const polishStart = css.indexOf('Pass 6: regular desktop seek consistency and width/readability polish.');
  const polishEnd = css.indexOf('/* Regular player color normalization:');
  const polish = css.slice(polishStart, polishEnd);

  assert.match(polish, /\.player\.player--regular:not\(\.isMaximized\):not\(\.isFullWindow\)[\s\S]*?#seekSlider[\s\S]*?height: 6px;[\s\S]*?background: linear-gradient\(to right, var\(--accent\) 0 var\(--seek-progress\), rgba\(217, 179, 255, 0\.22\)/);
  assert.match(polish, /#seekSlider::\-webkit-slider-thumb[\s\S]*?width: 16px;[\s\S]*?height: 16px;[\s\S]*?box-shadow: 0 0 0 3px rgba\(217, 179, 255, 0\.12\)/);
  assert.match(polish, /#seekSlider::\-moz-range-progress[\s\S]*?height: 6px;[\s\S]*?background: var\(--accent\);/);
  assert.match(polish, /body:not\(\.playerFullWindow\):not\(\.playerMaximized\) \.shell[\s\S]*?width: min\(1760px, calc\(100vw - 32px\)\);/);
  assert.match(polish, /@media \(min-width: 1440px\)[\s\S]*?--rh-left-rail: clamp\(300px, 19vw, 348px\);[\s\S]*?--rh-right-rail: clamp\(320px, 20vw, 372px\);[\s\S]*?grid-template-rows: 46px clamp\(500px, 62vh, 620px\) 68px 50px;/);
  assert.doesNotMatch(polish, /body\.playerMaximized|body\.playerFullWindow/);
  assert.match(css, /body\.playerMaximized[\s\S]*?#seekSlider/);
  assert.match(css, /body\.playerFullWindow[\s\S]*?#seekSlider/);
});

test('regular desktop correction uses the viewport and a dedicated bottom transport band', () => {
  const correctionStart = css.indexOf('Pass 6 correction: use the full desktop viewport and restore a dedicated transport band.');
  const correctionEnd = css.indexOf('/* Regular player color normalization:');
  const correction = css.slice(correctionStart, correctionEnd);

  assert.match(correction, /body:not\(\.playerFullWindow\):not\(\.playerMaximized\) \.shell[\s\S]*?width: min\(2200px, calc\(100vw - 48px\)\);/);
  assert.match(correction, /--rh-left-rail: clamp\(340px, 20vw, 420px\);/);
  assert.match(correction, /--rh-right-rail: clamp\(360px, 21vw, 460px\);/);
  assert.match(correction, /grid-template-rows: 46px clamp\(500px, 64vh, 700px\) 82px 28px 70px;/);
  assert.match(correction, /> \.controls \{[\s\S]*?grid-row: 3;[\s\S]*?padding-top: 10px;/);
  assert.match(correction, /> \.seekBlock \{[\s\S]*?grid-row: 5;[\s\S]*?padding-top: 10px;[\s\S]*?padding-bottom: 4px;/);
  assert.doesNotMatch(correction, /body\.playerMaximized|body\.playerFullWindow|player--fullscreen/);
});

test('regular desktop seek bar ends on the approved fullscreen track treatment', () => {
  const correctionStart = css.indexOf('Pass 6 correction: final desktop expansion and exact fullscreen seek treatment for regular mode.');
  const correctionEnd = css.indexOf('/* Regular player color normalization:');
  const correction = css.slice(correctionStart, correctionEnd);

  assert.match(correction, /width: min\(2400px, calc\(100vw - 32px\)\);/);
  assert.match(correction, /--rh-left-rail: clamp\(350px, 20vw, 440px\);/);
  assert.match(correction, /--rh-right-rail: clamp\(370px, 21vw, 480px\);/);
  assert.match(correction, /grid-template-rows: 46px clamp\(520px, 66vh, 740px\) 88px 32px 76px;/);
  assert.match(correction, /#seekSlider \{[\s\S]*?height: 4px;[\s\S]*?min-height: 4px;[\s\S]*?box-shadow: none;/);
  assert.match(correction, /#seekSlider::\-webkit-slider-thumb[\s\S]*?width: 0;[\s\S]*?height: 0;[\s\S]*?background: transparent;[\s\S]*?box-shadow: none;/);
  assert.match(correction, /#seekSlider::\-moz-range-track[\s\S]*?height: 4px;[\s\S]*?background: rgba\(217, 179, 255, 0\.22\);/);
  assert.match(correction, /#seekSlider::\-moz-range-progress[\s\S]*?height: 4px;[\s\S]*?background: var\(--accent\);/);
  assert.doesNotMatch(correction, /body\.playerMaximized|body\.playerFullWindow|player--fullscreen/);
});

test('regular desktop visual consistency cleanup keeps nav signature and controls restrained', () => {
  const cleanupStart = css.indexOf('Pass 6 cleanup: regular desktop iridescent navigation and restrained control surfaces.');
  const cleanupEnd = css.indexOf('/* Regular player color normalization:');
  const cleanup = css.slice(cleanupStart, cleanupEnd);

  assert.match(cleanup, /body:not\(\.playerFullWindow\):not\(\.playerMaximized\) \.viewTabs\.primaryNav button\.active[\s\S]*?rgba\(143, 240, 255, 0\.16\)[\s\S]*?rgba\(24, 25, 38, 0\.7\)[\s\S]*?rgba\(255, 115, 216, 0\.14\)/);
  assert.match(cleanup, /--rh-desktop-control-surface: linear-gradient\(145deg, rgba\(22, 23, 28, 0\.86\), rgba\(5, 6, 9, 0\.95\)\);/);
  assert.match(cleanup, /body:not\(\.playerFullWindow\):not\(\.playerMaximized\) :is\([\s\S]*?input:not\(\[type="checkbox"\]\)[\s\S]*?select[\s\S]*?textarea[\s\S]*?background:[\s\S]*?var\(--rh-desktop-control-surface\)/);
  assert.match(cleanup, /:focus[\s\S]*?border-color: var\(--rh-desktop-control-focus\)[\s\S]*?0 0 20px rgba\(217, 179, 255, 0\.1\)/);
  assert.match(cleanup, /:is\(button, \.buttonLink\):not\(\.viewTabs button\):not\(\.secondaryNavItems button\)[\s\S]*?min-height: 38px;[\s\S]*?var\(--rh-desktop-control-surface\)/);
  assert.match(cleanup, /:is\(button, \.buttonLink\):not\(\.viewTabs button\):not\(\.secondaryNavItems button\):hover[\s\S]*?rgba\(217, 179, 255, 0\.34\)/);
  assert.doesNotMatch(cleanup, /body\.playerMaximized|body\.playerFullWindow|player--fullscreen/);
});

test('regular desktop transport mirrors the approved seek metadata relationship and fits viewport height', () => {
  const correctionStart = css.indexOf('Pass 6 correction: align regular transport metadata to the player seek band and fit desktop height.');
  const correctionEnd = css.indexOf('/* Regular player color normalization:');
  const correction = css.slice(correctionStart, correctionEnd);

  assert.match(correction, /--rh-regular-stage-height: clamp\(440px, min\(60vh, calc\(100vh - 400px\)\), 660px\);/);
  assert.match(correction, /grid-template-rows: 40px var\(--rh-regular-stage-height\) 70px 18px 62px;/);
  assert.match(correction, /> \.controls \{[\s\S]*?grid-row: 3;[\s\S]*?gap: 5px var\(--rh-rail-gap\);/);
  assert.match(correction, /> \.seekBlock \{[\s\S]*?grid-row: 5;[\s\S]*?grid-template-rows: 18px 4px 16px;[\s\S]*?padding-top: 0;/);
  assert.match(correction, /> \.seekBlock \.playerMeta \{[\s\S]*?display: grid;[\s\S]*?grid-template-columns: var\(--rh-left-rail\) minmax\(0, 1fr\) var\(--rh-right-rail\);/);
  assert.match(correction, /> \.seekBlock #playState \{[\s\S]*?grid-column: 1;[\s\S]*?text-align: left;/);
  assert.match(correction, /> \.seekBlock #queueInfo \{[\s\S]*?grid-column: 2;[\s\S]*?text-align: center;/);
  assert.match(correction, /> \.seekBlock \.seekTimes \{[\s\S]*?position: absolute;[\s\S]*?top: 4px;[\s\S]*?right: 0;/);
  assert.match(correction, /#seekPosition::after \{[\s\S]*?content: " — ";/);
  assert.doesNotMatch(correction, /body\.playerMaximized|body\.playerFullWindow|player--fullscreen/);
});

test('tablet layout reflows regular surfaces without changing phone or fullscreen modes', () => {
  const tabletStart = css.indexOf('Pass 7: tablet layout — reflow regular surfaces without changing phone or player modes.');
  const tabletEnd = css.indexOf('/* Regular player color normalization:');
  const tablet = css.slice(tabletStart, tabletEnd);

  assert.match(tablet, /@media \(min-width: 700px\) and \(max-width: 1099px\)/);
  assert.match(tablet, /@media \(min-width: 700px\) and \(max-width: 1099px\),[\s\S]*?\(min-width: 700px\) and \(pointer: coarse\) and \(hover: none\)/);
  assert.match(tablet, /\.viewTabs\.primaryNav \{[\s\S]*?grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/);
  assert.match(tablet, /\.secondaryNavItems \{[\s\S]*?overflow-x: auto/);
  assert.match(tablet, /\.secondaryNavItems button \{[\s\S]*?min-height: 44px;/);
  assert.match(tablet, /:is\(button, \.buttonLink\) \{[\s\S]*?min-height: 44px;[\s\S]*?touch-action: manipulation;/);
  assert.match(tablet, /@media \(min-width: 700px\) and \(max-width: 899px\) and \(orientation: landscape\),[\s\S]*?grid-template-columns: minmax\(0, 0\.86fr\) minmax\(0, 1\.14fr\);/);
  assert.match(tablet, /grid-template-rows: 42px var\(--rh-tablet-stage-height\) auto 72px 62px;/);
  assert.match(tablet, /@media \(min-width: 900px\) and \(max-width: 1099px\) and \(orientation: landscape\)[\s\S]*?grid-template-columns: var\(--rh-left-rail\) minmax\(0, 1fr\) var\(--rh-right-rail\);/);
  assert.match(tablet, /grid-template-rows: 42px var\(--rh-tablet-stage-height\) 72px 18px 62px;/);
  assert.doesNotMatch(tablet, /@media \(max-width: 699px\)/);
  assert.doesNotMatch(tablet, /body\.playerMaximized|body\.playerFullWindow|player--fullscreen/);
  assert.doesNotMatch(tablet, /TEMP DIAGNOSTIC/);
});

test('tablet correction simplifies chrome and fits regular player height without changing other modes', () => {
  const correctionStart = css.indexOf('Pass 7 correction: tablet header simplification and regular-player height fit.');
  const correctionEnd = css.indexOf('/* Regular player color normalization:');
  const correction = css.slice(correctionStart, correctionEnd);

  assert.match(correction, /\.appHeader \{[\s\S]*?border: 0;[\s\S]*?background: transparent;[\s\S]*?box-shadow: none;/);
  assert.match(correction, /\.secondaryNav \{[\s\S]*?border: 0;[\s\S]*?background: transparent;[\s\S]*?box-shadow: none;/);
  assert.match(correction, /\.topbar \{[\s\S]*?padding: 5px;/);
  assert.match(correction, /grid-template-rows: 38px var\(--rh-tablet-stage-height\) auto 60px 52px;/);
  assert.match(correction, /grid-template-rows: 38px var\(--rh-tablet-stage-height\) 60px 12px 52px;/);
  assert.match(correction, /\.nowFeedback \.feedbackRail \{[\s\S]*?grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
  assert.match(correction, /\.nowTidalPlaylistTargets \{[\s\S]*?grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
  assert.match(correction, /\.feedbackButton,[\s\S]*?\.nowTidalPlaylistCreate button[\s\S]*?min-height: 44px;/);
  assert.doesNotMatch(correction, /@media \(max-width: 699px\)/);
  assert.doesNotMatch(correction, /body\.playerMaximized|body\.playerFullWindow|player--fullscreen/);
});

test('tablet correction 2 leaves controls without full-width chrome and bounds the regular player to the viewport', () => {
  const correctionStart = css.indexOf('Pass 7 correction 2: tablet controls-only chrome and viewport-fit player.');
  const correctionEnd = css.indexOf('/* Regular player color normalization:');
  const correction = css.slice(correctionStart, correctionEnd);

  assert.match(correction, /:is\(\.topbar, \.viewTabs\.primaryNav, \.secondaryNav\) \{[\s\S]*?border: 0;[\s\S]*?background: transparent;[\s\S]*?box-shadow: none;/);
  assert.match(correction, /\.viewTabs\.primaryNav \{[\s\S]*?display: flex;[\s\S]*?width: max-content;[\s\S]*?padding: 0;/);
  assert.match(correction, /\.secondaryNavShell \{[\s\S]*?width: max-content;[\s\S]*?max-width: 100%;/);
  assert.match(correction, /--rh-tablet-player-height: min\(760px, calc\(100dvh - 180px\)\);[\s\S]*?height: var\(--rh-tablet-player-height\);[\s\S]*?overflow: hidden;/);
  assert.match(correction, /grid-template-rows: 34px minmax\(320px, 1fr\) 52px 48px;/);
  assert.match(correction, /grid-template-columns: minmax\(0, 1fr\) minmax\(280px, 0\.82fr\);[\s\S]*?grid-template-areas:[\s\S]*?"badge badge"[\s\S]*?"main tools"[\s\S]*?"controls controls"[\s\S]*?"seek seek"/);
  assert.match(correction, /grid-template-rows: 34px minmax\(360px, 1fr\) 52px 48px;/);
  assert.match(correction, /grid-template-columns: minmax\(0, 1fr\) minmax\(300px, 0\.46fr\);[\s\S]*?grid-template-areas:[\s\S]*?"badge badge"[\s\S]*?"main tools"[\s\S]*?"controls controls"[\s\S]*?"seek seek"/);
  assert.doesNotMatch(correction, /@media \(max-width: 699px\)/);
  assert.doesNotMatch(correction, /body\.playerMaximized|body\.playerFullWindow|player--fullscreen/);
});

test('tablet custom composition uses functional zones without nested scrolling', () => {
  const customStart = css.indexOf('Pass 7 custom tablet composition: functional zones, artwork-first stage, and full-width transport.');
  const customEnd = css.indexOf('/* Regular player color normalization:');
  const custom = css.slice(customStart, customEnd);

  assert.match(custom, /--rh-tablet-meta-zone: clamp\(220px, 25%, 290px\);[\s\S]*?--rh-tablet-utility-zone: clamp\(280px, 28%, 340px\);/);
  assert.match(custom, /grid-template-columns: minmax\(0, var\(--rh-tablet-meta-zone\)\) minmax\(0, 1fr\) minmax\(0, var\(--rh-tablet-utility-zone\)\);/);
  assert.match(custom, /grid-template-areas:[\s\S]*?"badge badge badge"[\s\S]*?"now art tools"[\s\S]*?"controls controls controls"[\s\S]*?"seek seek seek"/);
  assert.match(custom, /> \.now \{[\s\S]*?grid-area: now;[\s\S]*?height: auto;[\s\S]*?overflow: visible;/);
  assert.match(custom, /> \.nowDiscoveryTools \{[\s\S]*?grid-area: tools;[\s\S]*?height: auto;[\s\S]*?overflow: visible;/);
  assert.match(custom, /\.nowFeedback \.feedbackRail \{[\s\S]*?grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
  assert.match(custom, /\.nowDiscoveryActions \{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(custom, /> \.controls \{[\s\S]*?grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);[\s\S]*?grid-template-areas: "prev play next stop";/);
  assert.doesNotMatch(custom, /overflow: auto/);
  assert.doesNotMatch(custom, /body\.playerMaximized|body\.playerFullWindow|player--fullscreen/);
});

test('regular artwork lane retains one translucent cover over one atmospheric copy', () => {
  assert.match(css, /> \.artStack::before \{/);
  assert.match(css, /background: var\(--now-artwork-backdrop\) center \/ cover no-repeat;/);
  assert.match(css, /filter: blur\(9px\) saturate\(1\.08\) brightness\(0\.5\);/);
  assert.match(css, /\.cover \{[\s\S]*?opacity: 0\.7;/);
  assert.equal((html.match(/<div class="cover" id="cover"><\/div>/g) || []).length, 1);
});

test('regular player keeps maximized typography and stacked utility alignment', () => {
  const repairStart = css.indexOf('Pass 6 regular parity: regular mode mirrors the approved maximized');
  const repairEnd = css.indexOf('/* Pass 7 correction: regular tablet geometry is owned by one explicit');
  const repair = css.slice(repairStart, repairEnd);

  assert.doesNotMatch(repair, /\.player\.player--regular:not\(\.isMaximized\):not\(\.isFullWindow\) \*,[\s\S]*?color: var\(--accent\) !important;/);
  assert.match(repair, /\.nowInfo #nowTitle \{[\s\S]*?font-size: clamp\(18px, 1\.55vw, 22px\);[\s\S]*?line-height: 1\.06;/);
  assert.match(repair, /\.nowInfo #nowSubtitle \{[\s\S]*?font-size: clamp\(13px, 1\.15vw, 16px\);/);
  assert.match(repair, /\.nowFeedback \.feedbackRail \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(repair, /\.nowDiscoveryActions \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(repair, /\.nowTidalPlaylistGroup \{[\s\S]*?margin-top: 8px;[\s\S]*?padding-top: 5px;/);
  assert.doesNotMatch(repair, /body\.playerMaximized|body\.playerFullWindow|player--fullscreen/);
});

test('touch-screen tablet owner uses the body marker without viewport sizing assumptions', () => {
  const ownerStart = css.indexOf('Pass 7 correction: regular tablet geometry is owned by one explicit');
  const ownerEnd = css.indexOf('/* Regular player color normalization:');
  const owner = css.slice(ownerStart, ownerEnd);

  assert.equal(css.includes('Pass 7 touch-screen tablet owner:'), false);
  assert.match(app, /navigator\?\.maxTouchPoints/);
  assert.match(app, /hasTouchScreen/);
  assert.match(owner, /body\.hasTouchScreen:not\(\.playerFullWindow\):not\(\.playerMaximized\) \.shell/);
  assert.doesNotMatch(owner, /100dvh|100vh|100vw|rh-touch-tablet-chrome|rh-touch-tablet-height/);
  assert.doesNotMatch(owner, /pointer: coarse|hover: none|body\.playerMaximized|body\.playerFullWindow|player--fullscreen/);
});

test('regular touch tablet sizing is owned by one explicit landscape media rule', () => {
  const ownerStart = css.indexOf('Pass 7 correction: regular tablet geometry is owned by one explicit');
  const ownerEnd = css.indexOf('/* Regular player color normalization:');
  const owner = css.slice(ownerStart, ownerEnd);

  assert.match(owner, /@media \(min-width: 700px\) and \(orientation: landscape\)/);
  assert.doesNotMatch(owner, /@media \(min-width: 700px\) and \(max-width: 1920px\)/);
  assert.match(owner, /body\.hasTouchScreen:not\(\.playerFullWindow\):not\(\.playerMaximized\) #playerView \.layout:has\(> \.player\.player--regular:not\(\.isMaximized\):not\(\.isFullWindow\)\)/);
  assert.match(owner, /height: auto;[\s\S]*?max-height: none;[\s\S]*?overflow: visible;/);
  assert.match(owner, /grid-template-rows: 48px minmax\(360px, auto\) 94px 48px;/);
  assert.match(owner, /--rh-touch-tablet-tools: clamp\(300px, 24vw, 318px\);/);
  assert.match(owner, /grid-template-areas:[\s\S]*?"\. badge viewControls"[\s\S]*?"now art tools"[\s\S]*?"controls controls controls"[\s\S]*?"seek seek seek"/);
  assert.match(owner, /\.nowDiscoveryBadge \{[\s\S]*?justify-self: stretch;[\s\S]*?justify-content: center;/);
  assert.match(owner, /\.cover \{[\s\S]*?opacity: 0\.62 !important;/);
  assert.match(owner, /\.nowDiscoveryTools :is\([\s\S]*?\.nowFeedback,[\s\S]*?\.nowDiscoveryActions,[\s\S]*?\.nowTidalPlaylistGroup[\s\S]*?width: 100%;/);
  assert.match(owner, /\.nowFeedback \.feedbackRail \{[\s\S]*?width: calc\(100% - 32px\);/);
  assert.match(owner, /> \.nowDiscoveryTools \{[\s\S]*?align-content: start;[\s\S]*?gap: 2px;/);
  assert.match(owner, /> \.nowDiscoveryTools \.nowFeedback \.feedbackRail \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(owner, /> \.nowDiscoveryTools \.nowDiscoveryActions \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(owner, /> \.nowDiscoveryTools \.feedbackButton \{[\s\S]*?min-height: var\(--rh-touch-tablet-control-height\);[\s\S]*?font-size: 13px;[\s\S]*?white-space: normal;/);
  assert.match(owner, /> \.nowDiscoveryTools \.feedbackButton \{[\s\S]*?height: var\(--rh-touch-tablet-control-height\);[\s\S]*?max-height: var\(--rh-touch-tablet-control-height\);[\s\S]*?padding-block: 0;[\s\S]*?line-height: 1;/);
  assert.match(owner, /body\.hasTouchScreen[\s\S]*?\.nowDiscoveryActions \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(owner, /\.nowDiscoveryActions::before,[\s\S]*?\.nowTidalPlaylistGroup::before \{[\s\S]*?grid-column: 1 \/ -1;[\s\S]*?width: 100%;/);
  assert.match(owner, /\.nowTidalPlaylistTargets \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(owner, /\.nowTidalPlaylistTarget \{[\s\S]*?grid-template-columns: 18px minmax\(0, 1fr\);[\s\S]*?min-height: var\(--rh-touch-tablet-select-height\);/);
  assert.match(owner, /\.nowTidalPlaylistTargets \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);[\s\S]*?gap: 0;[\s\S]*?width: calc\(100% - 32px\);/);
  assert.match(owner, /\.nowTidalPlaylistCreate \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);[\s\S]*?gap: 0;[\s\S]*?width: calc\(100% - 32px\);/);
  assert.match(owner, /\.nowTidalPlaylistCreate button \{[\s\S]*?width: 100%;[\s\S]*?white-space: nowrap;/);
  assert.match(owner, /> \.controls \{[\s\S]*?grid-template-columns: var\(--rh-left-rail\) minmax\(0, 1fr\) var\(--rh-right-rail\);[\s\S]*?grid-template-rows: 44px 44px;[\s\S]*?grid-template-areas:[\s\S]*?"prev \. next"[\s\S]*?"play \. stop"/);
  assert.match(owner, /> \.controls button \{[\s\S]*?min-height: 44px;/);
  assert.match(owner, /\.nowDiscoveryActions \{[\s\S]*?width: calc\(100% - 32px\) !important;[\s\S]*?max-width: none;[\s\S]*?align-self: center;/);
  assert.match(owner, /\.nowDiscoveryActions button \{[\s\S]*?height: var\(--rh-touch-tablet-control-height\);[\s\S]*?max-height: var\(--rh-touch-tablet-control-height\);/);
  assert.match(owner, /\.nowTidalPlaylistTarget select, \.nowTidalPlaylistCreate input, \.nowTidalPlaylistCreate button\) \{[\s\S]*?height: var\(--rh-touch-tablet-select-height\);[\s\S]*?max-height: var\(--rh-touch-tablet-select-height\);/);
  assert.match(owner, /--rh-touch-tablet-control-height: 31px;[\s\S]*?--rh-touch-tablet-select-height: 24px;/);
  assert.doesNotMatch(owner, /rgb\(0, 255, 0\)|selector probe/);
  assert.doesNotMatch(owner, /#ffe600|#39ff14|#ff00ff/);
  assert.doesNotMatch(owner, /100dvh|100vh|100vw|rh-regular-layout|cqw|container:/);
  assert.doesNotMatch(owner, /body\.playerMaximized|body\.playerFullWindow|player--fullscreen/);
});

test('phone regular player reserves mode controls and keeps transport readable', () => {
  const phoneStart = css.indexOf('Phase 8 phone owner: keep Regular Now Playing single-column');
  assert.ok(phoneStart >= 0);
  const completionStart = css.indexOf('Phase 8 phone completion: all phone surfaces');
  assert.ok(completionStart > phoneStart);
  const phone = css.slice(phoneStart, completionStart);

  assert.match(phone, /@media \(max-width: 699px\)/);
  assert.match(phone, /:is\(\.view, \.secondaryNav\) :is\([\s\S]*?button,[\s\S]*?select,[\s\S]*?min-height: 44px;/);
  assert.match(phone, /grid-template-areas:[\s\S]*?"viewControls"[\s\S]*?"badge"[\s\S]*?"now"[\s\S]*?"art"[\s\S]*?"tools"[\s\S]*?"controls"[\s\S]*?"seek"/);
  assert.match(phone, /> \.playerViewControls \{[\s\S]*?position: static;[\s\S]*?grid-area: viewControls;/);
  assert.match(phone, /> \.nowDiscoveryBadge \{[\s\S]*?grid-area: badge;[\s\S]*?justify-content: center;/);
  assert.match(phone, /> \.nowDiscoveryTools \{[\s\S]*?display: grid;[\s\S]*?grid-template-areas:[\s\S]*?"feedback"[\s\S]*?"actions"[\s\S]*?"playlist"/);
  assert.match(phone, /> \.controls \{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);[\s\S]*?"prev next"[\s\S]*?"play stop"/);
  assert.match(phone, /button\[data-control="playpause"\] \{ grid-area: play; \}/);
  assert.match(phone, /> \.controls button \{[\s\S]*?min-height: 44px;/);
  assert.doesNotMatch(phone, /body\.playerMaximized|body\.playerFullWindow|player--fullscreen/);
});

test('phone memory route gets a full-width touch-friendly shell', () => {
  assert.match(memoryHtml, /styles\.css\?v=20260909-phone-complete-03/);
  assert.match(css, /main\[data-memory-item\] \{[\s\S]*?width: 100%;[\s\S]*?max-width: none;[\s\S]*?padding: 12px;/);
  assert.match(css, /main\[data-memory-item\] :is\([\s\S]*?button,[\s\S]*?select,[\s\S]*?min-height: 44px;/);
  assert.match(css, /main\[data-memory-item\] > a \{[\s\S]*?display: inline-flex;[\s\S]*?min-height: 44px;/);
  assert.match(css, /body:not\(\.playerFullWindow\):not\(\.playerMaximized\) \.jumpTop \{[\s\S]*?min-height: 44px;[\s\S]*?touch-action: manipulation;/);
});

test('phone completion shares the visual owner across surfaces and player modes', () => {
  const completionStart = css.indexOf('Phase 8 phone completion: all phone surfaces');
  assert.ok(completionStart >= 0);
  const completion = css.slice(completionStart);

  assert.match(completion, /body:not\(\.playerFullWindow\):not\(\.playerMaximized\) :is\(\.appHeader, \.topbar, \.secondaryNav\)/);
  assert.match(completion, /body\.playerMaximized[\s\S]*?grid-template-areas:[\s\S]*?"viewControls"[\s\S]*?"badge"[\s\S]*?"now"[\s\S]*?"art"[\s\S]*?"tools"[\s\S]*?"controls"[\s\S]*?"seek"/);
  assert.match(completion, /body\.playerFullWindow[\s\S]*?\.player--fullscreen\.isFullWindow/);
  assert.match(completion, /\.player\.player--fullscreen:fullscreen[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(completion, /\.player\.player--fullscreen:-webkit-full-screen[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(completion, /\.player\.player--fullscreen:-webkit-full-screen[\s\S]*?min-height: 44px;/);
});

test('primary metadata row participates in normal grid flow', () => {
  assert.match(css, /\.sourceRow\.sourcePrimary \{[\s\S]*?overflow: visible;[\s\S]*?white-space: normal;/);
});

test('maximized gives rails a dedicated transport spacer and fills the right rail', () => {
  assert.match(css, /Maximized player geometry\.[\s\S]*?--rh-left-rail: clamp\(320px, 26vw, 352px\);[\s\S]*?--rh-right-rail: clamp\(320px, 25vw, 344px\);[\s\S]*?grid-template-rows: 46px minmax\(0, 1fr\) 14px 64px 46px;/);
  assert.match(css, /player--maximized[\s\S]*?> \.artStack \{[\s\S]*?grid-row: 2;/);
  assert.match(css, /player--maximized[\s\S]*?> \.nowDiscoveryTools \{[\s\S]*?grid-row: 2;/);
  assert.match(css, /player--maximized[\s\S]*?> \.now \{[\s\S]*?grid-row: 2;/);
  assert.match(css, /Maximized player geometry\.[\s\S]*?> :is\(\.now, \.nowDiscoveryTools\) \{[\s\S]*?height: 100%;/);
  assert.match(css, /Maximized player geometry\.[\s\S]*?\.nowTidalPlaylistGroup \{[\s\S]*?width: calc\(100% - 32px\);[\s\S]*?align-self: center;/);
  assert.match(css, /Maximized player geometry\.[\s\S]*?:is\(\.feedbackButton, \.nowDiscoveryActions button\) \{[\s\S]*?min-height: 34px;[\s\S]*?font-size: 14px;/);
});

test('fullscreen rails occupy the artwork row and fit their content above the transport spacer', () => {
  assert.match(css, /True fullscreen geometry\.[\s\S]*?grid-template-rows: 46px minmax\(0, 1fr\) 12px 104px 46px;/);
  assert.match(css, /True fullscreen geometry\.[\s\S]*?--rh-right-rail: clamp\(348px, 28\.25vw, 362px\);/);
  assert.match(css, /True fullscreen geometry\.[\s\S]*?--rh-stage-shift: 58px;/);
  assert.match(css, /player--fullscreen[\s\S]*?> \.now[\s\S]*?grid-row: 2;/);
  assert.match(css, /player--fullscreen[\s\S]*?> \.artStack[\s\S]*?grid-row: 2;/);
  assert.match(css, /player--fullscreen[\s\S]*?> \.nowDiscoveryTools[\s\S]*?grid-row: 2;/);
  assert.match(css, /player--fullscreen[\s\S]*?> \.playerViewControls,[\s\S]*?position: relative;[\s\S]*?grid-column: 3;[\s\S]*?grid-row: 1;[\s\S]*?justify-self: center;/);
  assert.match(css, /player--fullscreen[\s\S]*?> :is\(\.now, \.nowDiscoveryTools\),[\s\S]*?align-self: start;[\s\S]*?height: auto;[\s\S]*?margin-top: calc\(10px \+ var\(--rh-stage-shift\)\);/);
  assert.match(css, /player--fullscreen[\s\S]*?> \.nowDiscoveryTools,[\s\S]*?padding: 28px 28px 14px;[\s\S]*?background: transparent;[\s\S]*?box-shadow: none;/);
  assert.match(css, /player--fullscreen[\s\S]*?\.nowTidalPlaylistGroup,[\s\S]*?margin-top: 10px;/);
  assert.match(css, /player--fullscreen[\s\S]*?\.nowDiscoveryActions,[\s\S]*?width: calc\(100% - 24px\);[\s\S]*?gap: 8px;/);
  assert.match(css, /player--fullscreen[\s\S]*?\.nowFeedback \.feedbackRail,[\s\S]*?width: calc\(100% - 24px\);[\s\S]*?gap: 8px;/);
  assert.match(css, /player--fullscreen[\s\S]*?\.nowFeedback::before,[\s\S]*?margin-left: 12px;/);
  assert.match(css, /player--fullscreen[\s\S]*?:is\(\.feedbackButton, \.nowDiscoveryActions button\),[\s\S]*?min-height: 38px;[\s\S]*?font-size: 15px;/);
  assert.match(css, /player--fullscreen[\s\S]*?> \.controls button,[\s\S]*?width: calc\(var\(--rh-right-rail\) - 80px\);[\s\S]*?min-height: 38px;[\s\S]*?font-size: 15px;/);
  assert.match(css, /player--fullscreen[\s\S]*?> \.controls,[\s\S]*?align-content: start;[\s\S]*?transform: translateY\(-33px\);/);
  assert.match(css, /player--fullscreen[\s\S]*?> \.seekBlock,[\s\S]*?grid-row: 5;[\s\S]*?transform: translateY\(-16px\);/);
  assert.match(css, /player--fullscreen[\s\S]*?#queueInfo,[\s\S]*?top: -42px;[\s\S]*?left: calc\(var\(--rh-left-rail\) \+ var\(--rh-rail-gap\)\);[\s\S]*?right: calc\(var\(--rh-right-rail\) \+ var\(--rh-rail-gap\)\);[\s\S]*?text-align: center;/);
  assert.match(css, /player--fullscreen[\s\S]*?> \.seekBlock \.seekTimes,[\s\S]*?display: flex;[\s\S]*?grid-row: 3;[\s\S]*?justify-self: end;/);
  assert.match(css, /player--fullscreen[\s\S]*?#seekPosition::after,[\s\S]*?content: " — ";/);
  assert.match(css, /player--fullscreen[\s\S]*?#seekSlider,[\s\S]*?--seek-progress: 0%;[\s\S]*?-webkit-appearance: none;/);
  assert.match(css, /#seekSlider::-webkit-slider-thumb,[\s\S]*?-webkit-appearance: none;[\s\S]*?width: 0;[\s\S]*?height: 0;/);
  assert.match(css, /#seekSlider::-moz-range-thumb,[\s\S]*?width: 0;[\s\S]*?height: 0;/);
  assert.match(css, /feedbackButton:is\(\.active, \[aria-pressed="true"\]\)[\s\S]*?background: rgba\(255, 255, 255, 0\.06\) !important;/);
  assert.match(css, /actionAcknowledged[\s\S]*?background: rgba\(255, 255, 255, 0\.1\) !important;/);
  assert.match(css, /player--fullscreen\.isFullWindow \*,[\s\S]*?player--fullscreen:fullscreen \*,[\s\S]*?color: var\(--accent\) !important;/);
});

test('fullscreen left rail owns its wider transparent typography and stacked system geometry', () => {
  assert.match(css, /True fullscreen geometry\.[\s\S]*?--rh-left-rail: clamp\(372px, 29vw, 416px\);/);
  assert.match(css, /player--fullscreen[\s\S]*?> \.now \{[\s\S]*?padding: 16px 16px 14px;[\s\S]*?background: transparent;/);
  assert.match(css, /player--fullscreen[\s\S]*?#nowTitle[\s\S]*?font-size: clamp\(25px, 2vw, 30px\);/);
  assert.match(css, /player--fullscreen[\s\S]*?#nowSubtitle[\s\S]*?font-size: clamp\(18px, 1\.5vw, 21px\);/);
  assert.match(css, /player--fullscreen[\s\S]*?\.now \.sourceRow[\s\S]*?grid-template-columns: 132px minmax\(0, 1fr\);[\s\S]*?gap: 12px;/);
  assert.match(css, /player--fullscreen[\s\S]*?\.now \.sourceLabel[\s\S]*?font-size: 15px;[\s\S]*?line-height: 1\.25;[\s\S]*?text-align: left;/);
  assert.match(css, /player--fullscreen[\s\S]*?\.now \.sourceValue[\s\S]*?font-size: 16px;[\s\S]*?line-height: 1\.3;[\s\S]*?text-align: left;/);
  assert.match(css, /player--fullscreen[\s\S]*?\.nowInfo \.nowSourceFormat[\s\S]*?margin-top: clamp\(56px, 7vh, 68px\);[\s\S]*?margin-left: 0;/);
  assert.match(css, /player--fullscreen[\s\S]*?\.pcTempOverlay[\s\S]*?grid-template-columns: minmax\(0, 1fr\);[\s\S]*?"cpu"[\s\S]*?"gpu"[\s\S]*?margin-top: clamp\(24px, 3\.5vh, 30px\);/);
  assert.match(css, /\.pcTempChipCpu[\s\S]*?grid-area: cpu;/);
  assert.match(css, /\.pcTempChipGpu[\s\S]*?grid-area: gpu;/);
  assert.match(css, /player--fullscreen[\s\S]*?\.pcTempChip :is\(span, strong\)[\s\S]*?font-size: 17px;/);
  assert.match(css, /\.fullscreenConnectionStatus \.statusPill[\s\S]*?font-size: 16px;/);
  assert.match(css, /player--fullscreen[\s\S]*?\.fullscreenConnectionStatus \.statusPill[\s\S]*?text-align: left;/);
});

test('maximized and fullscreen keep their atmospheric artwork copies independently scoped', () => {
  assert.match(css, /player--maximized\.isMaximized[^\{]*\)::before \{[\s\S]*?var\(--now-artwork-backdrop\) center \/ cover no-repeat;/);
  assert.match(css, /player--maximized[\s\S]*?> \.artStack::before \{[\s\S]*?display: none;/);
  assert.match(css, /player--fullscreen\.isFullWindow::before,[\s\S]*?inset: -2\.5%;[\s\S]*?var\(--now-artwork-backdrop\) center \/ cover no-repeat;[\s\S]*?filter: blur\(6px\)[\s\S]*?opacity: 0\.6;/);
  assert.match(css, /player--fullscreen[\s\S]*?> \.artStack::before,[\s\S]*?display: none;/);
  assert.match(css, /player--fullscreen[\s\S]*?> \.artStack::after,[\s\S]*?display: none;/);
  assert.doesNotMatch(css, /transparency-test-backdrop/);
  assert.match(css, /player--fullscreen[\s\S]*?> \.artStack[\s\S]*?transform: translateY\(var\(--rh-stage-shift\)\);/);
  assert.match(css, /player--fullscreen[\s\S]*?\.cover[\s\S]*?width: min\(calc\(98cqw - 8px\), calc\(98cqh - 8px\)\);[\s\S]*?background-image: none !important;[\s\S]*?opacity: 1;[\s\S]*?box-shadow: none;/);
  assert.match(css, /player--fullscreen[\s\S]*?\.cover::before[\s\S]*?background-image: var\(--now-artwork-backdrop\), url\("\/assets\/rabbit-hole-fallback\.jpg"\);[\s\S]*?filter: none;[\s\S]*?opacity: 0\.5;/);
  assert.match(css, /player--fullscreen[\s\S]*?> \.nowDiscoveryBadge[\s\S]*?transform: translateY\(calc\(clamp\(8px, 1\.5vh, 12px\) \+ var\(--rh-stage-shift\)\)\);/);
});

test('regular player keeps its text hierarchy purple without changing fullscreen color ownership', () => {
  assert.match(css, /Regular player color normalization:[\s\S]*?\.player\.player--regular:not\(\.isMaximized\):not\(\.isFullWindow\) \.nowInfo #nowTitle,[\s\S]*?\.nowInfo #nowSubtitle,[\s\S]*?\.nowSourceFormat,[\s\S]*?\.pcTempChip :is\(span, strong\),[\s\S]*?\.seekBlock \.playerMeta,[\s\S]*?color: var\(--accent\) !important;/);
  assert.match(css, /Regular player color normalization:[\s\S]*?\.fullscreenConnectionStatus \.statusPill,[\s\S]*?\.seekBlock \.seekTimes/);
  assert.match(html, /href="\/styles\.css\?v=[^"]+"/);
});

test('all player modes reserve an eight-row metadata window', () => {
  assert.match(css, /Static metadata window:[\s\S]*?\.player:is\(\.player--regular, \.player--maximized, \.player--fullscreen\) \.nowInfo \.nowSourceFormat[\s\S]*?display: grid;[\s\S]*?\.nowSourceFormat\[hidden\][\s\S]*?display: grid !important;[\s\S]*?min-height: calc\(8 \* 1\.3em \+ 7 \* 7px\);/);
  assert.match(css, /body\.playerMaximized[\s\S]*?\.nowInfo \.nowSourceFormat \{\s+min-height: calc\(8 \* 1\.2em \+ 7 \* 4px\);/);
  assert.match(css, /body\.playerFullWindow[\s\S]*?\.nowInfo \.nowSourceFormat,[\s\S]*?\.player--fullscreen:fullscreen \.nowInfo \.nowSourceFormat,[\s\S]*?min-height: calc\(8 \* 1\.3em \+ 7 \* 5px\);/);
});

test('player mode classes are synchronized by JavaScript', () => {
  assert.match(app, /classList\.toggle\("player--regular"/);
  assert.match(app, /classList\.toggle\("player--maximized"/);
  assert.match(app, /classList\.toggle\("player--fullscreen"/);
  assert.match(app, /slider\.style\.setProperty\("--seek-progress"/);
  assert.match(app, /function acknowledgeFullscreenAction\(button\)/);
  assert.match(app, /window\.setTimeout\(\(\) => button\.classList\.remove\("actionAcknowledged"\), 360\)/);
});
