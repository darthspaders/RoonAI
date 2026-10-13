# SoundSpectrum HLS provider


## Permanent native clock and 4K120 verification — October 12, 2026

WhiteCap, Aeon and G-Force now use the installed external high-resolution clock automatically on ordinary standalone launch. No streaming session or clock toggle is required. Exact-build identity, single ownership, UI-thread restoration, shutdown and automatic watcher recovery are guarded and tested. WhiteCap/Aeon measured approximately 120 native fps; G-Force varied around 110–120 with scene/render-dispatch cost and remains on the high-resolution clock. Vendor binaries and saved preferences are preserved.

The separate approximately 83 fps capture/encode limit was isolated to the NVENC preset-dependent path. The production native helper now uses P4 at 120 fps and keeps P5 at 60. Exact 3840×2160 WhiteCap production capture/encode measured 119.77/119.83 fps with zero duplicates; the live WebCodecs browser decoded/drew approximately 119–121 fps, including expanded visuals. The 60 fps regression and 116 focused tests passed. Physical scanout, tablet output, all-scene G-Force 120 and long soak remain unverified. No app/MCP restart was needed; the rebuilt helper loaded in fresh sessions. Test streaming is stopped; the permanent watcher remains active. See engineering report and operational limits (private installation record; [published status and operating limits](../../docs/october-2026-update.md)).

Earlier all-products-64, no-permanent-adapter, production-capture-unchanged and end-to-end-unfinished statements below describe historical revisions.

## Historical 4K120 WebCodecs option — October 12, 2026, before clock/preset fix

Installed and loaded a 60/120 fps selector for both players, keeping exact 4K. Native helper v3 and provider carry frame rate through session identity/caps; 120 never manufactures repeated frames. Live diagnostics explicitly warn when stages miss 120. **Actual sustained 4K120 is not achieved:** Aeon, G-Force and WhiteCap delivered about 64 fresh/encoded/drawn fps, with about 144 browser repaint callbacks. 60 fps regression remains working. 294 focused tests and 501-file syntax check pass; native build and live browser verified. No OBS/audio changes. Test sessions stopped; MERT backfill resumed. No new staging/commit/push. Earlier fixed-60/provider-unchanged claims below describe the prior revision. See current implementation, activation, evidence and limitations (private installation record; [published status and operating limits](../../docs/october-2026-update.md)).


## WebCodecs recovery revision — October 10, 2026

The optional WebCodecs consumer now separates a 750 ms default playback target
from its MB memory ceiling and adds bounded HTTP retry/keyframe recovery. This
changes only that consumer; the HLS receiver/provider/native encoder baseline
hashes are unchanged. 533 focused tests pass and the PC 600 Mbps target test
ran near 60 drawn fps for roughly two minutes with about one second ahead.
Tablet confirmation remains pending. See the WebCodecs operating guide (private installation record; [published status and operating limits](../../docs/october-2026-update.md))
for limits and activation status. HLS buffering described below is unchanged.

## Optional WebCodecs consumer — October 10, 2026

The requested WebCodecs prototype (private installation record; [published status and operating limits](../../docs/october-2026-update.md))
is loaded in the main app. It consumes this provider's authenticated fMP4 stream
through a separate worker/canvas receiver. This provider/native encoder and
moq:false configuration are unchanged. Local TLS is provided by the main app;
no MediaMTX transport change or dependency installation. Earlier research-only
notes below are historical. Initial tablet 60 Mbps WebCodecs playback/fullscreen is confirmed near 60 fps;
high-rate and long-duration tablet performance remain unverified.

## WebCodecs / MoQ feasibility, not activation — October 10, 2026

See research report (private installation record; [published status and operating limits](../../docs/october-2026-update.md)).
The installed MediaMTX v1.21.1 includes MoQ, but this provider's generated config
keeps `moq: false`. No runtime code/config, dependencies, certificates, services
or playback were changed during research. A future separate trial can evaluate
WebCodecs compressed buffering and optional MediaMTX transport while retaining
HLS. Maximum tablet decoder bitrate/level and sustained high-rate WebCodecs
performance remain unknown; do not interpret existing HLS results as MoQ tests.

## HLS empty-buffer startup fix - October 10, 2026, 19:38 UTC

Final PC trial completed: 64.219 seconds between first and last telemetry
samples, ending at media time 67.925 s / 59.992 fps, two dropped frames total,
then explicit owned-test Stop. Chrome quota recovery reduced the loading ceiling
to 1.407 s and actual forward buffer to 1.475 s despite 250 MB remaining selected.
Thus the selected reserve is not maintained under browser memory pressure; this
startup fix does not solve that independent limit or establish tablet smoothness.
Final app idle/zero viewers, no owned helpers, protected hashes and delay preserved;
local test buffer preference restored to 32 MB, temporary tabs/fixture servers
closed. The tablet's own preference was not changed. Final screenshot/metrics are
final-playback.png and final.json in the private evidence directory.


The instrumented tablet retry requested 250 MB at 600 Mbps (3.333 s reserve)
and timed out with zero loaded bytes, zero buffer, readyState 0 and no frames.
The same startup failure was reproduced in the PC browser. Captured initial
MediaMTX playlists contain leading #EXT-X-GAP / #EXTINF:0.20000 / gap.mp4
placeholders before real segments. A large live-sync distance selects this
missing history; paused reserve-building then remains on the GAP with no media
loads. Browser tracing observed fragGap and aborted events. This differs from
the earlier playing-then-freezing trial, whose ultimate cause remains open.

The authenticated playlist proxy now removes only the relay's exact leading
GAP padding and advances MEDIA-SEQUENCE by the number removed. Real segment
URIs, timing, encoded bytes, resolution and bitrate are retained. Gaps after
real media begins remain intact. Consistent first-segment numbering is tested
as the upstream sliding window drops different amounts of padding. Existing
reference authorization and bounds remain in force. No buffer/delay settings
or encoder changes are part of this fix.

Correction to the intermediate investigation: TARGETDURATION:0 was initially
suspected. Installed hls.js already clamps it to at least 1 during parsing;
the temporary proxy normalization was removed. An early isolated parser fixture
also mishandled query strings and is not valid evidence of a duration failure.
Do not repeat the zero-duration-as-root-cause claim. Raw captured manifests
and the installed source identify the leading GAP startup issue instead.

285 related tests pass, including the GAP sequence/timing/preservation regression;
runtime source syntax and scoped whitespace checks pass. With the GAP correction,
a local real 4K60 WhiteCap Fluid / 600 Mbps target / 250 MB startup succeeded
and played near 60 fps. The final focused build (without duration normalization)
also started successfully, observed at 19:39:16 UTC with 3.693 s buffered,
59.9994 fps, no dropped frames, readyState 4 and 174.6 MB completed payload.
These are PC observations, not proof of tablet throughput or sustained 250 MB
capacity. Earlier PC playback also produced actual SourceBuffer quota errors;
hls.js reduced its loading ceiling to about 1.9-2.5 s while continuing playback.
That independent capacity limit may still affect larger buffers/refill.

Final supported guarded restart completed 19:38:45.319 UTC after the owned PC
trial stopped, idle/zero viewers. Loaded server and served assets verified;
current/saved delay 0/550 ms and seven protected file hashes preserved. Frontend
cache tag remains 20261010-hls-fill-diagnostics-1; this final change is server-side.
Temporary browser console tracing was removed. Private evidence and activation
receipts are in data/soundspectrum-hls/startup-empty-20261010/. No commits,
pushes, cloud changes or music playback/queue commands were issued.

## 250 MB tablet freeze investigation - October 10, 2026, 19:26 UTC

User reported that the 250 MB setting initially looked smooth despite the
frame-drop counter, then froze. Generation 7 at target 600 Mbps remained
server-running with capture about 64.5 fps and encoding 59.54 fps when checked.
Browser samples went from about 60 fps to 20.60, then stopped progressing at
3978 callbacks. At 19:21:36 UTC the browser released it as media-error; native
exited normally after requested cleanup. Generation 9 then had zero displayed
callbacks and another media-error at 19:22:22. There was no lease/background
expiry in these records. The user saw SoundSpectrum unavailable, then Filling
playback buffer on retry. Existing evidence does not identify quota, transport
starvation, decoder failure, or the precise refill timeout as root cause.

Changed diagnostics to preserve a failure snapshot before destroying the HLS
receiver. Heartbeats and final stop now report bounded numeric buffer depth,
requested MB, reserve seconds, hls.js loading ceiling, loaded payload bytes,
media time, readyState, drop count/percentage, paused/seeking state and a fixed
last-error category. Last error is historical context, not proof of causality.
Client and server each allowlist fields; arbitrary URLs/details are excluded.
Stop reasons distinguish hls-buffer-limit and hls-buffer-timeout from generic
media-error. Buffer failure headings now say Browser buffer limit reached or
Playback buffer could not fill, instead of hiding under SoundSpectrum unavailable.
No selected buffer, bitrate, visual-analysis delay or presentation was changed.
This is an observability/error-message correction, not a demonstrated freeze fix.

284 related tests passed, including preservation before cleanup, client/server
sanitization, expired-viewer rejection of final stats, and specific status and
stop reasons. Three edited runtime JS files passed syntax checks. First reload
was guarded out because a viewer was active; after explicit user Stop, supported
restart completed 19:26:22.703 UTC. Loaded backend and served frontend bytes
were verified. Current/saved delay 0/550 ms and seven protected file hashes were
preserved. Cache tag is 20261010-hls-fill-diagnostics-1. The user was asked to
refresh and repeat the same 250 MB setup once so the new metrics can identify
the limit. At this checkpoint that new physical-tablet result is pending.
Private receipts and filtered failure observations: data/soundspectrum-hls/
freeze-250mb-20261010/. No commits, pushes, music or cloud-route changes.

## HLS buffer choices through 1 GB - October 10, 2026, 19:14 UTC

Current selectable buffers are 1, 2, 4, 8, 16, 32, 50, 75, 100, 250, 500,
750 and 1000 MB. The last choice is labeled 1 GB (1,000 MB), using decimal
bytes. Default remains 32 MB and previous preferences remain valid. Roon and
Lyrion share/persist the selection; changing it does not restart the receiver.
The earlier 100 MB maximum described below is historical, superseded here.

Actual startup/refill still waits for contiguous video equal to MB * 8 / Mbps.
The receiver now supports 160 seconds plus loading margin at 1 GB / 50 Mbps;
its previous 60-second loading ceiling no longer prevents that target. A live
resize during filling renews the finite fill deadline (up to 330 seconds).
At 600 Mbps, 1 GB targets 13.33 seconds; at 300, 26.67; at 60, 133.33.
This adds transport delay without altering the analysis-delay controls.
Browser quota rejection during filling now stops with an explicit smaller-
buffer recovery message, and fill timeout has a separate actionable message.
The selected amount is a target, not guaranteed browser capacity or a hard
process-memory cap. A larger buffer cannot establish decoder/render capacity.

Server history covers the maximum selectable target even when a smaller
buffer is selected, allowing live increases: 71 segments at 600 Mbps through
804 at 50 Mbps, nominally about 1000-1075 MB of media after history fills.
This grows over time rather than preallocating 1 GB. Actual memory and segment
durations may differ. Provider and authenticated playlist proxy now allow
bounded 1 MiB manifests; reference validation, generation and lease checks
are unchanged. No video bitrate, resolution, cadence or backdrop changes.

Validation: 217 focused receiver, Stage, service and provider tests passed;
125 Stage tests passed after adding a specific quota/timeout recovery test
(218 distinct tests covered). Syntax checks passed for 480 JavaScript files.
Coverage includes 1 GB / 50 Mbps startup, live fill deadline changes, actual
installed hls.js config acceptance, quota cleanup/stale errors, preference
persistence, all bitrate history sizes, large authorized playlists and bounds.
An isolated Chromium low-payload synthetic check held playback until 13.826
seconds were queued at elapsed 13.004 seconds and finished at 60 fps. This
validates reserve logic, not physical 1 GB memory or tablet 600 Mbps capacity.
Live app settings were visually checked with 1 GB selected; that temporary
browser preference was restored to its prior 32 MB. No visuals were started
in the app and no music playback or queue was changed.

Activation: guarded supported restart completed 19:14:39.268 UTC, idle and
zero viewers. Current preview 0 ms and saved 550 ms were both preserved,
along with seven protected file hashes. The backend is loaded and frontend
served bytes match disk; cache tag 20261010-hls-1gb-1. Existing tablet tabs
must refresh. Physical tablet acceptance and 600 Mbps smoothness remain
unverified; do not call the frame-drop issue solved. Private validation is
under data/soundspectrum-hls/buffer-1gb-20261010/. No commits, pushes or
cloud-route changes were made.

## Playback reserve correction - October 10, 2026, 18:51 UTC

Implemented and loaded a concrete HLS buffer correction. Previously MB only
changed hls.js's loading budget, playback started immediately, LL-HLS followed
manifest hold-back, and server history was seven ~200 ms segments. This could
not provide the larger selected reserves, especially at lower bitrates.

The receiver now waits for contiguous forward video equal to selected MB *
8 / configured Mbps before playing. Actual empty-buffer waiting pauses and
refills to that target; decoder waiting with buffered video does not pause.
A live increase builds the larger reserve; lowering it can release the hold.
Startup/refill have bounded deadlines and generation-fenced cleanup. An
already ready frame stays ready through refill so Stage does not exit immersive
mode; startup says Filling playback buffer. PCM delay, foreground resolution,
encoder quality, and all backdrop/presentation geometry are unchanged. The
full-resolution immersive backdrop remains an unisolated performance suspect.

Full-segment HLS reception replaces low-latency part consumption; explicit
live safety distance and one-times playback accompany the reserve. Gap/live-
window recovery may still seek; no never-skip guarantee is made. Server history
covers the largest 100 MB selection at the stream bitrate plus four segments:
11 segments at 600 Mbps, 84 at 50 Mbps. Target-rate media storage is roughly
100-175 MB, not a hard process-memory cap. Receiver loading allows two segments
beyond the reserve. Startup adds real transport delay; large low-bitrate buffers
can intentionally wait ~16 seconds. This does not alter the analysis-delay
setting or promise original end-to-end music synchronization.

Validation: 1,006 related tests and 480 JS syntax checks passed initially;
149 receiver/Stage/UI tests passed after the ready-during-refill and startup
message refinements (a null-receiver guard caught by tests was repaired).
53 focused provider/receiver checks include seven new reserve/lifecycle checks
and a history-range check over every bitrate 50-600. Real installed hls.js was
used in isolated Chromium synthetic-video checks: 1.33 s reserve started with
1.364 s, exhausted during an injected three-second delivery interruption,
refilled and resumed with 1.520 s; final ~59.99 fps. The 16 s reserve held
playback until 16.407 s was queued at elapsed 16.014 s, then played ~59.99 fps.
These 640x360, low-payload fixtures validate buffering, not 600 Mbps/tablet
capacity. The final real-browser repeat also passed: refill retained the ready video
view and resumed at >=1.33 s reserve, finishing at 60 fps. Temporary fixture
servers and browser tabs were closed; no owned native/provider helpers remain.

Actual native provider with the longer history passed a separate 30.6 s media
sample: 1,836 frames, exactly 60 HLS fps, 16/17 ms timestamps, zero gaps,
overlaps, PTS errors, pool or appsrc drops; ~580.64 Mbps actual media payload
at target 600. Helper counted 55 repeated images (~2.99%); unique-picture
60 fps is not claimed. Owned provider/native cleanup, Standalone byte-exact
restoration, protected settings and app idle state passed. Global preference
bytes changed only within the existing allowed runtime-counter policy.

Supported guarded restart completed 18:51:47.890 UTC, idle/zero viewers;
current/saved delay 550/550 ms was preserved with seven protected hashes.
Final served assets matched disk at 18:53:36.246 UTC. Cache tag is
20261010-hls-reserve-1; existing tablet tabs must refresh to load it. No new
physical tablet trial has validated these changes. Do not call the overall
600 Mbps frame-drop issue solved. Next user-facing check should be one fixed
setup, only after these PC checks, without another series of bitrate requests.
Private evidence: data/soundspectrum-hls/buffer-reserve-20261010/ contains
pre-change backups, tests, browser receipts/assertions, activation.json and
served-final.json. Native receipt is cadence-20261010/native-hls-cfr-1791658327229.json.
No commits, pushes, music playback changes or cloud route changes were made.

## Tablet stream-specific decoder evidence - October 10, 2026, 18:36 UTC

User supplied the Rabbit Hole media-internals player created at
18:36:31.620493 UTC. It selected MediaCodecVideoDecoder and created
c2.mtk.avc.decoder with is_software_codec=0 and platform decoder=true:
hardware H.264 High level 5.2 at 3840x2160 is confirmed for this player.
No fallback or fatal decode/pipeline error appears. Target bitrate is absent;
the user was asked which bitrate and whether drops were visible. Do not
extend this evidence to the earlier High 6.1 / 600 Mbps trial.

The approximately 12.43-second player teardown matches server generation 9
user-stop at 18:36:43.336 UTC. One server windowed/tablet performance sample
was 60 fps at 18:36:34.891 UTC, not a whole-run or zero-drop result. An earlier
generation 7 lease expiry at 18:36:09.336 UTC is a different session. The log
has initial seek 1.155 s and another target 6.5 s at elapsed 5.609 s; seek
cause/jump magnitude is not captured. Local receiver code does not assign
video.currentTime and leaves recovery/live seeks to hls.js; it enables
lowLatencyMode and has no explicit liveSyncDuration or prebuffer gate.

Chromium's report-linked video_renderer_impl.cc uses live-stream liveness
to enable renderer low-delay mode, making one decoded frame sufficient for
BUFFERING_HAVE_ENOUGH. That is separate from hls.js lowLatencyMode, the
MediaCodec low_delay_=0 field, our analysis-delay slider, and HLS byte budget.
HAVE_ENOUGH does not establish a filled 100 MB reserve or uninterrupted
network delivery. Coded-size-alignment warning did not prevent startup.
Read-only code/log/source analysis; no production changes/restart. Next:
identify the supplied trial, then isolate fixed-mode delay and actual HLS
playback reserve versus fullscreen composition. Existing fixes remain loaded.
Source: https://raw.githubusercontent.com/chromium/chromium/8eaafabb47f12210d524f648b78bce074fa3c83e/media/renderers/video_renderer_impl.cc

## Tablet Chrome GPU report - October 10, 2026, 18:36 UTC

User-supplied chrome://gpu report identifies SM-X920, Android 16, Chrome
154.0.8037.126 and Mali-G720-Immortalis MC12. Hardware video decode,
compositing and canvas are enabled; GPU process crash count is zero.
H.264 High decoding advertises up to 8192x4320, but no decode bitrate or
frame-rate limit is supplied. The 4K/120 entries are ENCODING capabilities;
do not interpret them as playback guarantees or proof of 600 Mbps support.
Four ImageReaderGLOwner no-buffer-available errors are present, without
player identity or event timestamps. The report-linked Chromium revision
maps this message to AMEDIA_IMGREADER_NO_BUFFER_AVAILABLE, distinct from
MAX_IMAGES_ACQUIRED. This is an Android image-reader queue, not the HLS
byte budget or analysis-delay ring. It does not establish packet loss,
insufficient HLS memory, delay causality, or a decoder-capacity limit.
Next evidence: the Rabbit Hole player entry in chrome://media-internals
for an affected trial (decoder/platform-decoder properties and event log),
alongside a fixed-mode delay comparison. General hardware acceleration does
not confirm the selected decoder for this specific stream. Read-only report
analysis and primary-source verification only; no runtime/code/settings
changes or restart. Prior activation remains unchanged.
Source: https://raw.githubusercontent.com/chromium/chromium/8eaafabb47f12210d524f648b78bce074fa3c83e/gpu/command_buffer/service/image_reader_gl_owner.cc

## Physical tablet after pacing update — October 10, 2026

The v2 trial still has substantial receiver-side frame loss: the user's
600 Mbps / 100 MB screenshot shows 31.4 video fps, 15.8% drops over 1.1 s,
941 cumulative drops and 1.10 s buffered. Do not call pacing a tablet fix or
infer a regression from two short screenshot intervals. At 18:25:17 UTC,
the active generation-1 sender reported roughly 60 encoded fps and a
598.276 Mbps H.264 payload sample over 1.011 s. This narrows the remaining
problem to delivery/receiver processing; decoder saturation is not proven.

The user completed the 60 Mbps / 100 MB comparison: seven short-window
physical tablet samples measured 59.02-60.00 fps over about 96.6 seconds,
including ordinary and immersive modes. This does not establish zero drops.
The user then selected 300 Mbps (generation 5). Fifteen collected samples
ranged 54.20-60.07 fps: the lower samples occurred in immersive mode, while
later windowed samples were near 60 fps. Neither sustained flawless 300 Mbps
nor the cause of the 600 Mbps failure is established.

The live 300 Mbps manifest signaled H.264 High 5.2 (avc1.640034), while the
private v2 600 Mbps target receipt signaled High 6.1 (avc1.64003d). Decoder
selection/fallback is unobserved; do not force an incorrect lower level.
Read-only comparison observers completed; no observer remains running.
Private receipts: tablet-60mbps-viewer-samples.json,
tablet-300mbps-viewer-samples.json and bitrate-comparison-1791657028187.json
under data/soundspectrum-hls/cadence-20261010/.

The user raised visual delay as a possible cause and changed it during the
300 Mbps session: 767/1320 ms initially, 0/0 observed at 18:29:56 UTC,
808/808 at 18:30:18 UTC, then 0/0 (revision 7) at the latest read near
18:32 UTC. Do not restore old values over these user changes. The 808 ms
period also included a near-60-fps windowed tablet sample. Presentation mode
changed during the comparison, so the evidence does not isolate delay.
Code inspection confirms delay operates on paced music-analysis PCM before
native rendering, with a bounded 882,000-byte ring, not a video sleep/queue.
Increasing delay inserts analysis silence; decreasing skips queued analysis.
All 25 existing PCM/feed/settings delay tests passed in this follow-up; these
mocked timing tests do not rule out live interaction or tablet frame loss.
Next: compare delay 0 versus a nonzero value at identical bitrate, buffer
and presentation mode, allowing the transition to settle, and match receiver
FPS/drop intervals. The user was asked whether zero delay visibly recovered
FPS and at which bitrate. No production code, settings, music playback or
service restart was changed by the agent during this follow-up. Loaded v2
remains active; generation 5 was still running at 300 Mbps at the latest read.

## Tablet frame-pacing follow-up — October 10, 2026

The refreshed physical tablet screenshot confirms 51.3 video fps, 12.7%
video-frame drops over 1.2 seconds and 1,295 cumulative drops at HLS 600 Mbps /
100 MB, with 0.86 seconds buffered. The user explicitly stopped generation 3;
this was not a new timeout. Corrected tablet metrics are now observed, but
stable tablet 60 fps is not established.

A timestamp audit of the earlier successful average-60-fps HLS sample found
6–42 ms frame durations. Drop-only videorate preserves input timestamps.
The compiled v2 helper uses constant-rate pacing, starts at the first frame,
limits frame repetition to input gaps of at most 50 ms, and disables end-of-
stream repetition. Repeats are counted separately; unique-picture 60 fps is
not claimed. GPU capture, 4K encoding, bitrate choices and PCM delay are unchanged.

The bounded 600 Mbps target provider trial passed: 1,842 samples over 30.700 s,
exactly 60 HLS fps, all sample durations 16 or 17 ms after RTMP millisecond
quantization, no gaps/overlaps/backward timestamps, and 38 pacing repeats
(2.066% of the helper interval). Observed video payload was about 480 Mbps;
this is not a sustained 600 Mbps network result. All owned cleanup and original
Standalone restoration passed; seven protected hashes and Current/Saved
767/1320 ms were preserved. Validation: 527 focused tests and 480 JS syntax
checks passed; native build was warning-free.

The provider update was loaded through the supported restart at
2026-10-10T18:18:49.706Z. Both services are healthy; seven protected hashes
and Current/Saved 767/1320 ms (revision 1, new instance) match. The v2 helper
was executed in the bounded provider trial; the next app Start uses it.
Physical tablet comparison of v2 remains pending. See the HLS operational
report for receipts and limits.

This provider targets 3840×2160, 60 fps H.264 low-latency HLS for the Rabbit Hole
visualizer, with an integer target bitrate from 50 through 600 Mbps. Native
capture, encoded cadence and delivered bitrate must be measured separately. The app
owns source selection, its existing visual delay, viewer leases, and native
window lifetime. HLS alone temporarily requests native target 120 with exact
Standalone backup/restoration; it preserves saved app settings, music playback,
audio routing and the existing OBS/MediaMTX session.

See the HLS operational record (private installation record; [published status and operating limits](../../docs/october-2026-update.md)) for
current activation, app/browser validation, and tablet limitations. Source files
and synthetic validation do not establish that the application loaded the
change or that a tablet decoded it successfully.

Earlier October 10 FPS checkpoint (superseded above): production code and the compiled helper
are **installed and loaded at 17:46:23.243 UTC** through the supported restart.
Both services are healthy, the API exposes fresh FPS fields, and seven protected
hashes match. The PC 600 Mbps / 100 MB Fluid trial passed 304.990 seconds;
59 short-window encoded-rate samples averaged 59.9571 fps, not a whole-run
frame-count rate. Final UI showed 60.0 video fps / 0.0% drops over 1.1 seconds /
138 cumulative drops since Start. Physical tablet validation remains pending.
A controlled 4K GPU source at
about 60 fps reproduced the original WGC output near 44 fps. Direct WGC showed
44.0638 distinct timestamps/s at its measured default 16 ms update interval,
versus 56.5737 at 1 ms; WhiteCap at 1 ms reached 56.6831 with native target 60
and 64.0050 with private target 120. Distinct timestamps do not establish unique
pictures or physical scanout. D3D12 cached-image capture was rejected for
backward timestamps. Sync, resolution and process timer trials are retained
in the operational report; no global timer/display/driver change was adopted.

The final 400 Mbps production-provider trial measured 64.0347 capture fps,
59.9876 encoded fps / 399.8155 Mbps and 60.0078 HLS fps / 400.2205 Mbps:
1,842 distinct PTS/DTS samples over 30.696 seconds, no gaps/overlaps/duplicates/
errors or pool/appsrc drops. The earlier failed synchronous-sampler attempt is
preserved. Source validation passes 526 SoundSpectrum/provider tests, 23 native
protocol tests and 480 JS syntax checks; the helper rebuild is reproducible.
This validates the production provider in a bounded private harness; the PC
result above is separate, and physical tablet performance remains unverified.
HLS-native target handling supports all three
products; only WhiteCap was measured.
Original Standalone, seven protected hashes, Current/Saved 767/1320 ms delay
and idle generation 48 / zero viewers were preserved. Global bookkeeping and
an earlier unattributed hash difference are documented; do not restore an old
licensing file. Activation preserved Current/Saved 767/1320 ms with revision 1
in the new instance, initially idle generation 0/zero viewers. The PC trial used
generation 1; exact UI Stop/cleanup at 17:53:24.697 UTC ended idle 2/0 with no
ownership/native processes, seven hashes matching and byte-exact Standalone.
PC selection returned to 600 Mbps / 32 MB and its temporary viewport/player
mode was restored. Production stays 4K; UI geometry limitations and the app-CSS
Full Window scope are retained in the operational report, with no layout edits.

The metrics frontend is separately served and PC-verified at cache tag
`20261010-hls-frame-counters-1`, with 154 focused tests plus syntax/whitespace
passing. It separates compositor fps, callback cadence, interval video-drop
percentage and cumulative video drops. Earlier PC generation 47 showed 43.7 then
38.7 video fps; corrected tablet metrics were then unobserved. Earlier five-minute
callback-count evidence establishes continuity, not 60 fps. See the linked
operational report for all receipts, limitations and final activation status.

The app treats successful current visible HLS media delivery as viewer demand.
Only nonzero media bytes renew an existing live lease; manifests, pending
preloads and hidden/stopped/expired viewers cannot extend it. This policy is
implemented by the app's HLS proxy, not by this provider's relay. Browser
heartbeat retry additionally requires recent frame presentation. See the
operational record for the physical timeout evidence and loaded fix status.

## Capture and relay

The owned `hls-wgc-2` helper uses direct WGC with verified 1 ms MinUpdateInterval
and the pinned GStreamer 1.26.11 runtime. Held owner/native process identities,
start ticks, lineage and exact title/class/4K window checks fence capture.
GPU textures remain on one D3D11 device; an eight-buffer pool and two-buffer
leaky appsrc bound queued work. Constant-rate conversion schedules 60 frames per second; short source gaps
(up to 50 ms) can repeat a captured image. Repeats are counted separately, and
there is no end-of-stream repetition. Uniform timestamps do not prove 60
unique pictures per second. D3D11 conversion feeds NVENC H.264 High profile with no B frames or
lookahead and a 12-frame GOP. FLV muxing and `rtmp2sink` send the encoded stream
over authenticated loopback TCP to a separately owned MediaMTX v1.21.1 process.
The RTMP sender uses 64 KiB chunks; its 128-byte default failed to establish
publishing at 600 Mbps in the bounded synthetic check. No additional video
encoding occurs in the relay. The target bitrate is an encoder request; the
observed bitrate remains content dependent.

The helper accepts bounded private stdin configuration; tokens do not appear
in its command line or numeric stdout protocol. Build/source/executable hashes
and runtime version are checked before launch. Stop, owner loss and invalid
window/timestamps close the exact helper; an eight-second self-only teardown
watchdog supplements the provider's identity-checked fallback. Service capture
and encoded FPS are cached, same-generation and unavailable after six seconds;
capture timestamps, encoded access units and browser presentation remain
distinct measurements. Native target 120 stays within the installed vendor's
20–120 range and is restored from an exact backup at Stop; Global Sync and
quality are unchanged.

The relay exposes only ephemeral loopback RTMP, HLS and API listeners. Its HLS
configuration requests 100 ms parts and 200 ms segments, retains seven segments,
caps each segment at 64 MB, and uses a 256-entry write queue. Actual segment and
part durations depend on encoded frame/IDR timing. A private `hlsCDNSecret`
Bearer channel lets the provider retrieve manifests and fragments without the
relay's browser cookie/session redirects. Neither those credentials nor the
private ingest address is returned to the browser.

The default player buffer target is **32,000,000 bytes (32 MB)**, with choices
1/2/4/8/16/32/50/75/100 MB. Changing this byte target does not force an initial
wait or change the low-latency live position. It is not a limit on the
combined memory used by the encoder, relay, HTTP transfers, or decoded GPU
frames. Relay retention, its current segment, and its write queue are separate
server-side bounds. At 600 Mbps, 100 ms of compressed video is approximately
7.5 MB. HLS.js configuration and actual decoded frame memory belong to the
browser implementation.

The pinned native `rtspclientsink` route was investigated first and exited with
Windows stack-overflow status `0xC00000FD` during synthetic publishing at both
50 and 600 Mbps. This provider uses the validated RTMP ingest route; it does not
patch or replace that shared runtime. The stack overflow's internal cause was
not established.

Primary runtime references:

- [GStreamer rtmp2sink properties](https://gstreamer.freedesktop.org/documentation/rtmp2/rtmp2sink.html)
- [MediaMTX v1.21.1 configuration](https://github.com/bluenviron/mediamtx/blob/v1.21.1/mediamtx.yml)
- [MediaMTX v1.21.1 HLS HTTP authorization/session handling](https://github.com/bluenviron/mediamtx/blob/v1.21.1/internal/servers/hls/http_server.go)

## Service contract and ownership

`createIntegration()` returns `inspect()`/`capability()`,
`start({ nativeIdentity, generation, isCurrent, observeWindow, onReady,
onFailure, profile })`, `stop()`, `snapshot()`/`status()`, and
`readAsset(name, { generation, query, range, signal })`.

`inspect()` is passive and caches pinned-version/element probes for 30 seconds.
`start()` requires a current generation and an exact PID, executable, process
start ticks, owned window title/class/handle and 4K client dimensions. Readiness
requires encoded bytes and a parsed media playlist containing actual media;
a listening port alone is insufficient. A periodic check fences native identity
and fails when the encoder has produced no fresh bytes for six seconds.

`readAsset()` returns `{ statusCode, contentType, headers, body }`. Manifest bodies
are bounded to 64 KiB; media bodies are streamed. Asset basenames, a single HTTP
byte range, and the three LLHLS query keys `_HLS_msn`, `_HLS_part`, `_HLS_skip`
are validated. The service must authorize the live viewer/generation before and
after its await and rewrite playlist lines and `URI="..."` attributes through
the same authorized app route. A stop aborts in-flight upstream requests.

Private runtime state is under `data/soundspectrum-hls`. The exclusive ownership
record includes the parent process identity and a random generation marker.
Helpers are identified with executable, PID, start ticks and their exact unique
command-line marker. An explicit new start may recover matching helpers from a
dead parent; it skips reused PIDs and refuses a live owner. Inspection does not
perform recovery. Stop attempts capture first and then the private relay,
retaining ownership on incomplete cleanup so the service can retry. Shared
MediaMTX processes and the native window are never stopped by this provider.

## Validation

Run the injected unit suite without native capture or playback:

```powershell
node --test integrations/soundspectrum-hls/index.test.cjs
```

The 16 tests cover profile bounds, private transport configuration, passive
probe caching, native identity, parsed readiness, media streaming and fencing,
child failure, exact orphan recovery, and retry after a termination failure.

The explicit synthetic harness starts only its own short-lived loopback relay
and synthetic D3D11/NVENC encoder. It retains the earlier exported pipeline and
relay configuration, replacing the WGC source; it does not validate the new
direct-WGC helper. The production-provider receipt above covers that path.
The earlier synthetic harness writes scrubbed receipts
under ignored `data/soundspectrum-hls-validation`, fetches completed parts and
checks that their media sequence advances for at least 20 seconds after the
first fetched part. It then closes both own children and removes its private
relay configuration.

```powershell
node integrations/soundspectrum-hls/validate.cjs --run --rate=50
node integrations/soundspectrum-hls/validate.cjs --run --rate=600
```

This is a synthetic encoder/muxer and sampled HTTP-part test, not continuous
600 Mbps HTTP receiver throughput, native visual capture, or browser/tablet
decoding validation. The operational record owns the latter results.

On 2026-10-10 the final 256-entry queue configuration passed both bounded runs,
with no native errors or muxer frame-drop warnings and both owned children
confirmed exited. Each run fetched 21 advancing, completed 100 ms parts over
more than 20 seconds. The 600 Mbps run produced 1,351 encoded frames, averaged
599.52 Mbps across the sampled encoder intervals, and fetched a largest part of
7,874,576 bytes. The 50 Mbps run produced 1,340 encoded frames and fetched a
largest part of 1,079,405 bytes. Manifests advertised `avc1.64003d` (H.264 High,
level 6.1) at 600 Mbps and `avc1.640034` (High, level 5.2) at 50 Mbps, both 4K60.
Decoder support for those profiles/levels must be observed on each target.

An earlier 64-entry queue trial discarded startup frames; it is not the final
configuration. Private receipts retain that diagnostic history. Final clean
receipts are `data/soundspectrum-hls-validation/1791633953991/receipt.json`
(600 Mbps) and `data/soundspectrum-hls-validation/1791634006011/receipt.json`
(50 Mbps). The installed-runtime passive probe returned available in 1.46 s;
the 16 unit tests, JavaScript syntax checks, and whitespace check passed. The
provider does not itself activate or restart the main app.

## Tablet frame-clock diagnostic

Open `/soundSpectrumCadence.html` on the existing trusted Rabbit Hole HTTPS origin. Run explicitly in a visible tab; copy the four-row report after 32 seconds. This compares main/worker normal/low-latency/WebGL clocks at 4K with simple drawing, without consuming the stream or changing settings. Hiding the page cancels the test. Results identify the next boundary; they do not certify video delivery or display scanout. See the current permanent-clock engineering report for actual PC evidence and pending tablet results.

Tablet diagnostics update: browser heartbeats now retain wcTargetFps, wcPresentationHz and wcStreamFps alongside decode/draw rates. These fields load on the next main-page refresh; the existing server accepts them without restart. They distinguish a 120 target from 60 repaint opportunities. Tablet sustained 120 remains unverified; see the current engineering report.
