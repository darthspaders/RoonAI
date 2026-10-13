# WhiteCap floating current artwork

October 11 follow-up: the installed companion recognizes the explicit per-process
NASA layer rotation owner. When **NASA layers · 3 backgrounds** is selected in
Visuals & audio, it continues artwork handling but neither selects nor restores
Background entries/slideshow state; the separate pilot package owns those three
backgrounds. Ordinary launches keep the all-background behavior described below.
Startup/custom-theme files are unchanged. The added ownership tests pass, the
owned companion update is installed, and both launch choices were native-observed.
See selector activation, evidence and maintenance (private installation record; [published status and operating limits](../../docs/october-2026-update.md)).

Optional native artwork layer, attached by `src/server.js`. Select WhiteCap
with HQPlayer music analysis or the owned Lyrion music feed, then Start visuals.
The exact current cover drifts horizontally and vertically; changing scale and
brightness simulate approaching/receding depth. Smoothed native bass energy adds
a small pulse. WhiteCap's foreground patterns remain in front of the cover.
The ordinary native backgrounds rotate underneath every 20 seconds with two-second
crossfades. The cycle includes every available, non-special-use registered Background,
independent of the current theme's category filter. Each is visited once before wrapping. Native entries retain sorted order; the
NASA package contributes ordinary Background entries evenly interleaved (originally
19 photos among 83 native backgrounds; the normal NASA pool has since reached 412).
Unavailable and special-use entries (including the artwork
itself) are excluded. Image-based backgrounds still require their normal image files.
This uses one textured quad and one current texture, with no new audio consumer,
browser overlay, receiver or encoder changes. Existing delay applies normally.

The metadata bridge shares the G-Force companion's source/ownership validation,
but has its own PID-bound state and cache under `data/soundspectrum-whitecap-artwork`.
Only the explicitly selected live music-feed zone/player is eligible. Track changes
clear the old cover before fetching the new one. Missing covers draw nothing.
The native reader checks freshness, file type/size/hash and PID off the render
thread. In ordinary mode, inactive or stale sessions restore the previous background and slideshow;
a manual native background selection stops our rotation for that session while
keeping the artwork. No factory files are edited.
The new entry has the special-use flag so normal WhiteCap random backgrounds do
not select it outside Rabbit Hole. Its independently owned SceneInstance renders
after the Background group and before the foreground, with balanced matrix stacks;
it is never restarted by background crossfades. Ordinary background slideshow is
temporarily held while this all-background cycle runs and restored on release.
There is no webpage rotation-speed/on/off control yet.

## Install and remove

From the main repository, with WhiteCap closed:

```powershell
node integrations/soundspectrum-whitecap-artwork/install.cjs install
node integrations/soundspectrum-whitecap-artwork/install.cjs
node integrations/soundspectrum-whitecap-artwork/install.cjs remove
```

The installer owns exactly two files in `RabbitHole.WhiteCapArtwork.package`,
records hashes, backs up owned updates and refuses edited/unowned files and linked
paths. Removal preserves private metadata and backups. Server attachment readiness
is checked at app startup: an initial installation/removal needs the ordinary
idle-guarded app reload; native package updates load on the next WhiteCap Start.

WhiteCap's image API needs `file:///C:/...` (UTF-8 bytes), unlike the G-Force
external-Sprite registration VFS form. Texture size has three components: inspect
width and height only. These differences were established in the native engine.

Private `native-status.json` reports PID/freshness, loaded state, frames, smoothed
audio/depth in thousandths, and a bounded phase/error class. Readers must tolerate
a transient partial diagnostic write; authoritative metadata is atomic. No titles,
paths, source URLs or credentials are included in native diagnostics.

## Validation and limits

See activation record (private installation record; [published status and operating limits](../../docs/october-2026-update.md)).
Run `node --test integrations/soundspectrum-whitecap-artwork/index.test.cjs` with
`RH_TEST_PYTHON` set to a working Python 3 interpreter for the native stub checks.
Python stubs cover geometry/audio/track freshness/restoration; actual rendering
requires the installed WhiteCap Python 2 engine. Roon/HQPlayer was checked live;
Lyrion source gating is tested but its new background has not been checked live.
The effect simulates depth with scale, not scene-geometry occlusion. Long tablet
stability and subjective motion/brightness remain user validation.

## Radio artwork bridge

The WhiteCap Roon/HQPlayer attachment reuses Rabbit Hole's keyed radio/display
artwork caches. A matching bridged song cover replaces the raw station image;
unresolved songs retain the station fallback. Downloads read only bounded raster
objects from the configured bridge listener, without changing bridge settings or
starting extra metadata/audio jobs. Old-song downloads are rejected before and
after the fetch. Lyrion/SiriusXM retains its separate existing artwork path.
An app reload is needed for this server/provider update; no native reinstall is
needed. See the activation record for loaded and live-observed status.
