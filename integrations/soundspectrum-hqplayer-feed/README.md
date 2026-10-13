# Optional HQPlayer music analysis

Read popup operations (private installation record; [published status and operating limits](../../docs/october-2026-update.md))
for the freshly served, live-browser-verified popup fixes. Explicit popup Start
can enter Visualizer from Artwork; idle open/Refresh stays passive. Closing
settings after Start retains the viewer. This user-gesture correction preserves
this adapter’s genuine availability, ownership, audio and session gates.

This removable integration feeds Aeon, G-Force and WhiteCap from HQPlayer's
analysis data when a pinned Roon HQPlayer zone is playing. It is disabled by
default and starts only with **Start visuals**. Import and inspection do not
open a monitoring connection or audio device. Roon and Lyrion keep separate
identities; this module does not depend on the optional Lyrion feed folder.

The observer only receives bytes from `127.0.0.1:4322`. It never sends a
handshake, enables metering, opens HQPlayer control port 4321, changes the
ASIO/DSD route or reads the Roon playback socket. A root-supplied guard requires
the exact pinned Roon zone, its single pinned output and current playing state
at Start. In the main Rabbit Hole browser, an existing session can wait silently
through a verified loading/paused/stopped track gap for up to 30 seconds, keeping
its renderer and viewer leases. The native companion supplies its separate strict
active transport guard. The first
gap deadline survives state flapping and clears only after playing returns and
fresh valid analysis arrives. Connection, source identity, settings and cable
checks continue during that wait. Unsupported zones/states, disabled settings,
unverified cables, expired recovery or process failures close this disposable feed.
See track-transition recovery (private installation record; [published status and operating limits](../../docs/october-2026-update.md)).

## Abandoned ownership recovery — October 10, 2026

**SoundSpectrum startup recovery: both ownership guards loaded; WhiteCap native/server Start verified, remaining live checks pending.**
The prior 06:38 UTC restart left an abandoned HQPlayer analysis owner while
generation 13/one viewer had been active. Explicit Starts at 06:43–06:44 UTC
failed at that owner check before any native/capture process existed. All
recorded parent/writer/analysis PIDs were absent. Verified unchanged-record
cleanup at 06:47:24 UTC and filesystem-only acquire/remove at 06:47:43 UTC
removed only the abandoned owner; that probe opened no socket/audio. The
HQPlayer guard was loaded at 06:58:32 UTC. Real analysis then worked, exposing
a second abandoned OBS owner.lock/owner.json with parent/OBS/relay absent;
verified cleanup at 07:02:28 UTC removed only those unchanged ownership files.

Both durable guards are installed and loaded. Recovery runs only during explicit
Start for complete recognized records. Two probe rounds must confirm parent and
both helpers absent; bounded regular one-link file bytes/identity must match.
Live/reused, denied, unknown, malformed/partial, linked or changed/recreated
ownership and unknown recovery markers remain blocked. Exclusive recovery
mutexes, cancellation, fresh-claim preservation and claimed-token cleanup fence
deletion/retry. Recovery performs no passive cleanup, age inference, process
termination or changes to source pins, audible HQPlayer/DAC settings, user visual
delay or queue. No playback commands were issued.

Final targeted tests pass 377/377: HQ 103, OBS 92, existing core/helper/UI 182;
these form one aggregate, not additional counts to older stage receipts.
Syntax passes 476 JS plus four changed CJS files (HQ index/lifecycle and OBS
index/test). The supported restart at 2026-10-10T07:11:07.8304437Z loaded the
final guard/diagnostic sources: main connected/MCP healthy, targets [60, 600],
WebRTC 60 Mbps/runtime unchanged, Current/Saved 1560/1560 ms preserved,
21 protected hashes/eight independent process identities unchanged;
idle/zero clients/no SRT 8891 listener after load.

Actual WhiteCap Start at 07:11:16–23 UTC succeeded with the native window and
server OBS/WebRTC publisher, 230 HQ analysis frames and 942,076 PCM bytes. Its
recorded main plus two HQ helpers were present during the feed. Owned Stop
returned idle/zero clients with no leftover owners. This is native/server proof,
not browser decoded frames, physical tablet reception, 600 Mbps native delivery
or freeze repair. The earlier OBS failure before scene setup was not reproduced
after final load; its cause remains unconfirmed. No speculative readiness change
was made; diagnostics expose fixed stage/whitelisted request/numeric status only.
The Aeon follow-up stopped before mutation because the exact Roon zone was no
longer playing. Additional Aeon/G-Force live checks await resumed music.

Final passive verification at 2026-10-10T07:13:42.5127586Z found Aeon, G-Force
and WhiteCap available, HQ input available, idle/zero clients/no error, no HQ or
OBS ownership/recovery files, and all nine loaded source hashes still matching.
Main/MCP stayed healthy, WebRTC 60 Mbps and Current/Saved 1560/1560 ms stayed
intact; the exact Roon zones were paused/stopped. Available is not a live check
of all three visualizers. Preserve SRT 600 design/proofs and saved settings.
See [HQPlayer ownership](#setup-and-removal) and [OBS ownership/startup](../soundspectrum-obs-webrtc/README.md) for operations.

## Global visual delay

Visuals & audio controls one shared 0–5000 ms music-feed PCM delay. Current is
the live preview; Save persists and Reset to 0 previews without overwriting Saved.
The default is zero. Preserve a later user selection; no automatic 2500 ms preset.
This adapter delays its disposable PCM after pacing and before the cable writer,
so native and main-browser visualization images share the effect. The browser
video transport adds no second delay; the separate `/remote` ratings page has
no delay editor or visualizer video.
Audible HQPlayer/DAC/Dragon output and microphone/generator inputs are unchanged.
Natural loading boundaries retain the delayed ending; Stop/failure clears queued
samples but keeps the chosen value. See the delay reference (private installation record; [published status and operating limits](../../docs/october-2026-update.md)).

October 9 activation loaded the route, verified at Current/Saved 0 with no saved
file. Browser +10 and Reset previews passed without Save or a live audio source.
Installed 378 focused checks and synthetic adapter timing cases passed; physical
audio/display synchronization and natural live transitions remain unverified.

## Setup and removal

From the main application directory, inspect or explicitly configure it:

```powershell
node integrations/soundspectrum-hqplayer-feed/manage.cjs --status
node integrations/soundspectrum-hqplayer-feed/manage.cjs --enable --zone <exact-Roon-zoneId> --output <exact-Roon-outputId>
node integrations/soundspectrum-hqplayer-feed/manage.cjs --disable
```

The first enable requires both IDs; later enable can preserve the pinned IDs.
Names are only onboarding hints. Settings are private and ignored under
`data/soundspectrum-hqplayer-feed/settings.json`. Enable copies the existing
dedicated SoundSpectrum cable route once if available, otherwise discovers
only the exact SoundSpectrum pair, then verifies it. It never installs a driver
or changes Windows Listen/default settings. The capture endpoint must have
Windows **Listen to this device** disabled. No microphone is required.

The reviewed exact-device shared-WASAPI writer and read-only endpoint helper are
copied into this folder. The writer accepts only 44.1 kHz stereo S16LE and has
no default-device fallback. It uses `sync=false` because this supervisor already
paces samples; stale raw-parser timestamps would otherwise silently discard
audio after skipped callback gaps. Existing GStreamer is required.

Audio startup uses a separate private plugin directory containing only the five
required audio/core plugins. The inspectors and writer share that environment,
with default plugin paths disabled, a pinned scanner and a separate registry.
Six element checks run sequentially. A frozen manifest pins the 21 reviewed
GStreamer 1.26.11 executable/plugin/dependency files. File hashes and directory
membership are checked before warm probes too; extra plugins, changed files,
links and unreviewed runtimes are refused. The stage lives under ignored
`data/soundspectrum-hqplayer-feed/audio-runtime/`.
Importing this module does not prepare or execute that runtime.

This isolates an October 5 startup exposure: the previous audio checks reused
the broad video-capture plugin environment, and the user's Windows crash dump
records the Intel graphics driver faulting while GStreamer's plugin scanner was
running. The exact triggering plugin and driver failure reason remain unknown.
After the user-approved recovery, the feed is enabled again for an explicit
native live test; enabling settings does not start an audio stream.
Adapter offline checks cover isolated startup, exact routing and bounded feed
lifecycle. The real five-plugin stage has been prepared
without executing GStreamer. Subsequently, the user-approved metadata-only
startup check passed all six element queries in 383 ms and verified only the
five private audio DLLs in the scan/load traces. No audio stream was opened.
The user subsequently reported working main-browser visuals without a Windows
crash. Native Standalone delivery and sustained operation remain separate
verification limits; that report does not establish future kernel safety.
See the crash investigation (private installation record; [published status and operating limits](../../docs/october-2026-update.md)).
This correction is scoped to this HQPlayer adapter; other integrations and the
video capture environment keep their existing independent runtime configuration.

For removal, disable the feed, stop its viewers and await cleanup before
removing `integrations/soundspectrum-hqplayer-feed/`. The base application treats
the folder as optional. Its tests live here so removal leaves no broken test
imports. After confirming no active owner, its private data folder can also be
removed. Restart Rabbit Hole with `npm run restart` after removing the folder
to unload the optional module. No Lyrion, Roon or HQPlayer restart is needed.

`owner.json` is exclusively created for one active module owner and records its
writer/analysis child PIDs, executable paths, arguments and launch times. Stop
removes only the matching token after its children close. If bounded cleanup
times out, those exact handles remain available for a subsequent Stop retry and
the lock remains. A parent crash normally closes the writer pipe and the analysis
IPC channel. A restart can leave the private record after all recorded
processes exited; the October 10 diagnosis proved that abandoned-record case.
Guarded recovery is installed and loaded for explicit Start only as of
06:58:32 UTC October 10. Before any cleanup, validate the recognized
record, prove parent and every recorded child absent, and recheck unchanged
bytes. Live PIDs, permission errors, unknown identity, malformed/changing records
remain blocked. Launch times are diagnostic hints, never authority to kill a
reused PID. Import/inspect cannot recover ownership or open audio. Recovery
removes only proven abandoned ownership, not processes or source/settings.
The main service still allows only one source/writer and stops the previous
adapter before switching. A lock-only probe does not establish real audio,
native visualization or tablet streaming success.

The loaded guard requires a complete strict version-1 `roon-hqplayer` record,
a valid 48-hex ownership token and distinct valid parent/writer/analysis PIDs.
Only an `ESRCH` process probe is definitive absence; live PIDs, `EPERM` and
unknown failures remain blocked. Two probes must prove all three absent, with
an unchanged regular one-link file, exact bytes and identity; symlinks, junctions,
hardlinks and changed/recreated records remain blocked. Start cancellation is
checked before deletion/retry. A separate exclusive `wx` `owner.json.recovery`
mutex fences competing recoverers. Its cleanup requires matching token and file
identity. An existing or
unverifiable recovery marker is preserved and blocks recovery; this does not
introduce age-based cleanup or recovery of the recovery marker itself.
Ordinary exclusive ownership winners are preserved; Stop removes only a token
this adapter actually claimed, so a failed foreign claim cannot be stolen.
The frozen adapter suite passes 103/103, including 56 lifecycle cases and 13 new
ownership tests with matrix subcases; these are nested counts, not additive.
The guard is loaded; subsequent actual Start delivered analysis/PCM successfully.
The subsequent WhiteCap native/server publication check passed after the final
OBS guard load. Physical tablet reception and Aeon/G-Force live checks remain
separate verification limits, with the latter waiting for the user to resume
the exact configured Roon zone.

## Signal, bounds and limits

The version-1 little-endian protocol contains levels and real/imaginary
half-spectrum arrays. It has no source timestamp or wire sequence. A local
sequence tracks dropped frames. Supported input is mono/stereo with a bounded
power-of-two transform, finite coefficients and validated rate/hop metadata.
Format changes, skipped frames and reconnects reset overlap.
Recognizable complete layouts with temporarily unusable timing/format metadata
are discarded, clearing derived PCM/history. Recovery is limited to 16 frames
or 500 ms, and scalar rejected-header diagnostics remain in status. Unknown
version/channel/bin layouts fail immediately; arbitrary bytes are never scanned
to guess a new frame boundary.
Desktop also emits a valid transform layout with `sourceBits=0` between tracks.
This descriptive field does not alter the float-array encoding. That exact case
is accepted as an inactive source: its payload remains fully validated, held
nonzero spectra are forced to silence, prior PCM/history is cleared, and status
shows waiting. A supported known bit depth resumes synthesis with fresh overlap.
Inactive-source recovery is separately limited to 30 seconds; other unusable
metadata still has the strict 16-frame/500-ms limit. Diagnostics count zero-bit
frames and expose the scalar inactive header and current duration.

A separate Node child at below-normal process priority performs inverse FFT,
conservative overlap synthesis and linear resampling. Higher-rate spectra are
tapered above 20 kHz and removed at 22.05 kHz before downsampling to prevent
ultrasonic energy aliasing into the visual signal. A smoothed, capped level
adjustment uses reported RMS in dBFS, with headroom and zero-signal gating. The
analysis window/scaling are undocumented. This is a **derived signal for
visualization**, not bit-perfect recovered audio. Visual timing is approximate;
the conversion is not aligned to the DAC. Native DSD input may not provide usable
meter data; PCM input with DSD output is the initially verified route. The
integration does not enable matrix processing to work around missing analysis.

Receive storage is capped at 1 MiB. One work batch is in flight and pending work
is limited to 12 frames, 250 ms and 1 MiB; old work is discarded. Normal TCP
bursts can therefore retain consecutive hops without unbounded history. PCM is
bounded to one second and trimmed to 250 ms, with at most 100 ms submitted per
timer tick. Output backpressure, worker startup/work deadlines and stale input
are bounded. A lost socket gets at most three retries per unrecovered outage.
Three seconds of fresh valid noninactive PCM, with no gap over 1.5 seconds and
recent successful safety checks, resets that budget; a single packet does not.
Failures affect only the visualizer. No long-session or zero-impact guarantee is made.

Output pressure tracking uses the owned writer's completion/drain events and
observed queue progress. While blocked, obsolete queued visualizer PCM is
discarded and pacing is rebased. An overdue check after a delayed timer yields
one event-loop turn to pending I/O before deciding whether the same writer has
actually stopped making progress. A sustained two-second output stall still
stops this feed. Delayed checks cannot renew that deadline indefinitely.

The retained `outputDiagnostic` snapshot records bounded progress, backlog,
discard and timer-gap counters plus fixed output error categories. It contains
no raw audio, raw stderr, endpoint paths or device IDs. These counters distinguish
the helper's scheduling and pipe progress; they do not prove native visualizer
response or identify every possible driver failure.

Status includes analysis counters, dropped-frame/overlap-reset counters,
buffered bytes and derived/submitted scalar RMS/peak measurements. Derived
metrics describe worker output; submitted metrics describe bytes accepted by
the owned writer's stdin, including underrun silence. Neither establishes
actual endpoint delivery. Cable capture and native renderer response must be
verified separately during authorized deployment. No raw audio is retained.

Offline tests:

```powershell
node --test integrations/soundspectrum-hqplayer-feed/*.test.cjs
```

Protocol references: [Signalyst's Control source](https://www.signalyst.eu/bins/hqp-control-601-src.zip),
[HQPTuner's metering reader](https://github.com/ohshitgorillas/hqptuner/blob/main/hqptuner/engine/meterfeed.py)
and [its empirical protocol notes](https://github.com/ohshitgorillas/hqptuner/blob/main/docs/protocol.md#7-metering-side-channel).
The protocol facts were independently implemented; no third-party DSP code is
copied. See the main
investigation report (private installation record; [published status and operating limits](../../docs/october-2026-update.md))
for the bounded receive-only probe and its limits.
The implementation report (private installation record; [published status and operating limits](../../docs/october-2026-update.md))
records deployment, actual endpoint/renderer checks, removal and current limits.
