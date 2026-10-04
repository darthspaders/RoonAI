# Optional HQPlayer music analysis

This removable integration feeds Aeon, G-Force and WhiteCap from HQPlayer's
analysis data when a pinned Roon HQPlayer zone is playing. It is disabled by
default and starts only with **Start visuals**. Import and inspection do not
open a monitoring connection or audio device. Roon and Lyrion keep separate
identities; this module does not depend on the optional Lyrion feed folder.

The observer only receives bytes from `127.0.0.1:4322`. It never sends a
handshake, enables metering, opens HQPlayer control port 4321, changes the
ASIO/DSD route or reads the Roon playback socket. A root-supplied guard requires
the exact pinned Roon zone, its single pinned output and current playing state
at Start and during the session. Any unsupported zone, disabled setting,
unverified cable, stale data or process failure closes this disposable feed.

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
IPC channel, but crash cleanup has not been validated. Before removing a stale
lock, verify both the recorded parent and its owned children have exited; launch
times are diagnostic hints, not authority to kill a reused PID. There is no
automatic stale-lock stealing or unknown-process termination. The main service also
allows only one source/writer and stops the previous adapter before switching.

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
are bounded. A lost socket gets at most three retries; failures affect only the
visualizer. No long-session or zero-impact guarantee is made.

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
copied.
