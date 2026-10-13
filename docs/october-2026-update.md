# October 2026 source update and operating handoff

This source update incorporates the accumulated local work through October 13, 2026, while retaining the TIDAL API compatibility, Docker lock recovery, Lyrion library-reference and collapsible track-card fixes already on GitHub.

## Included changes

- MERT-v2 FullSong model-aware coverage and recovery, compatible Sonic Review neighbors, analyzed-source listening previews, blind review, identity diagnostics and review persistence. Legacy vectors remain stored; they do not count toward MERT coverage.
- Bounded exact-recording recovery, provenance and artwork checks; model-review backlog and catalog analysis tools. TIDAL/Roon remain playback identity authorities.
- Direct Windows capture, NVENC and WebCodecs at configurable 60/120 fps with separate capture, encode, decode and draw telemetry. Resolution stays 3840 x 2160. Stream target and device refresh are not proof of physical 120-fps presentation.
- A version-pinned external SoundSpectrum clock adapter with single ownership, ordinary-launch discovery, recovery and original-scheduler safety fallback. Installation is explicit; cloning the repository installs no DLL, scheduled task or vendor software. See the clock integration README.
- NASA observation-feed intake, source receipts and content rejection; stable photographs with conspicuous stellar flares, separated cloud-mask preparation, reviewed activation and wallpaper export. Broad press/event archive discovery is disabled by the observation policy. Metadata qualification is not a guarantee of visual classification.
- Transparent fullscreen transport container with individual button backgrounds; the seek strip remains available.

## Activation versus evidence

The publication checkout is a source snapshot. This publication did not restart the running app, deploy an MCP wrapper, rebuild a launcher, install native packages, change an audio route, operate a queue or start a visualizer. Machine-specific installation receipts and prior live diagnostics remain private.

Earlier installation evidence: 435 stable-photo scenes retained the large flares, with only Cosmic Cliffs and Horsehead using reviewed separated cloud interiors. The three-image tour also includes a stable Deep Field. The full remask pass ended with 235 flare-only results, 54 cloud candidates and 146 segmentation-gate failures. Of 54 candidates, two were already installed, 29 await native review, 19 were visually rejected and four were withheld for weak motion. Offline checks do not authorize additional installations. Intake remains paused on the development installation.

Native clock and 4K capture have measured near 120 fps in selected runs. Tablet drawing has measured below 120 despite a 120 Hz device mode; a later WhiteCap startup timeout also triggered the original-clock safety fallback. Sustained all-scene, end-to-end 120 fps is not established. Do not replace the safety gate or manufacture duplicate frames to claim success.

## Validation and portability

Publication validation: clean npm ci --ignore-scripts passed; npm run check passed for 696 JavaScript files; npm test passed 3,420 tests, failed zero, and explicitly skipped 11 external bridge-fixture tests (3,431 total). No native installation or end-to-end playback was performed in this publication pass.

Run npm ci, npm run check and npm test from a clean checkout. Python-backed stub tests accept RH_TEST_PYTHON pointing to a Python 3 executable. Eleven bridge integration tests require reviewed installed HQPlayerBridge original sources plus Perl; they report explicit skips when those external prerequisites are unavailable. Native capture/probe commands are deliberately separate from automatic unit-test discovery.

A subsequent fresh Windows checkout exposed Git auto-CRLF conversion of generated Darthspader text/SVG fixtures. Their paths now explicitly use LF in .gitattributes, preserving byte-for-byte generator reproducibility across checkouts. This changes repository checkout policy, not installed visualizer content.

The release integration retained current TIDAL collection-search and opaque-cursor semantics, updated stale fixtures to the MERT model, repaired extracted UI-test boundaries, and removed one test of a private one-off data-folder helper from the public snapshot. Databases, model/audio/image caches, credentials, native vendor binaries, local browser profiles and private handoff histories are excluded.

## Continuation

Before installing or resuming local jobs, inspect that installation's source hashes, ownership receipts and current process/API state. Keep original images and embeddings. Review new cloud candidates in the native renderer before activation; investigate clock startup timeouts and tablet presentation loss separately. Do not restart playback merely to validate a source publication. The standalone OAuth MCP checkout has no configured Git remote and is not published by this update.
