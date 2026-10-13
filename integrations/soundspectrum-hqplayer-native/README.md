# HQPlayer input for native G-Force

This optional, removable add-on adds **HQPlayer (analysis feed)** to G-Force
Standalone's **Settings → Audio Input Source** menu. Selecting it starts a small
local companion and selects the existing dedicated SoundSpectrum Audio Cable.
The raw cable, microphone and built-in generator options remain available.

The companion reuses Rabbit Hole's configured HQPlayer analysis adapter and exact
Roon zone/output pins. Rabbit Hole must be running and connected to Roon. Its
current loopback status supplies playback facts; the companion does not pair
another extension or send playback commands. No browser viewer is needed.

## Install and use

From this folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-windows.ps1 -Action install
```

Approve the Windows administrator prompt for the new owned package under
Program Files. Installation does not change G-Force preferences, factory files,
the Darthspader theme, Windows sound defaults or HQPlayer output settings.
The menu addition loads when G-Force next starts.

1. Keep music playing in the configured Roon HQPlayer zone.
2. Stop browser visuals in Rabbit Hole or Roon Visualizer, then open G-Force
   Standalone directly. Other applications must release their visualizer feed.
3. Open **Settings → Audio Input Source → HQPlayer (analysis feed)**.
4. To return to another input, select that input. To stop the companion, close
   G-Force. Music continues on its existing route.

The selected physical source is still **Stereo Out (SoundSpectrum Audio Cable)**.
The add-on keeps that exact identity and disables G-Force's automatic search for
another source when this logical input is selected. The right-click native device
submenu retains the physical cable name; use Settings for the HQPlayer option.

If the initial selection happens while its exact connected zone is paused or
stopped, it waits for that zone to play, then starts once. Changing inputs,
settings, output/grouping, connection or ownership cancels that pending choice.
After a feed has started, a pause, Roon disconnect, changed/grouped output, stale
analysis or unsafe cable setting stops it; select HQPlayer again to retry after
resolving the cause. The native frame watch shows each matching status/error
once automatically; Settings shares the same duplicate check. Selecting another
source releases only this add-on's feed, never a browser application's owner.

## How it works

The original package wraps the existing native menu callbacks and appends one
logical option. It uses the factory source chooser for other devices. A fixed
private launcher runs the local Node companion in the background; source choices
do not become shell commands. Imports, installation and native startup do not
open an analysis connection. Only selecting HQPlayer starts the companion.

The reused adapter receives analysis from `127.0.0.1:4322`, derives a bounded
visualization signal and sends it to the verified cable. It does not open control
port 4321, consume HQPlayerBridge's playback stream or change the ASIO/DSD route.
The derived signal is approximate and is not aligned to the DAC. See the
[existing analysis adapter](../soundspectrum-hqplayer-feed/README.md).

The companion verifies the exact native G-Force executable, PID and start time,
and stops its own adapter when that instance closes or changes. It refuses known
Rabbit Hole, Roon Visualizer and Lyrion owners; if another owner appears later it
stops its own feed. The older applications have separate locks, so this check is
not an atomic lock shared by every application. Stop other visualizer sessions
before using the native input. Unknown or stale locks are left for review.

## Shared visual delay

The companion reads the main app's global Current delay before its one feed
starts and refreshes it through the existing approximately one-second active
tick. The read is bounded to loopback, 4096 bytes and a two-second deadline.
Failure keeps the last confirmed value, or zero if none was confirmed, and
records confirmed/unknown privately. Stop or a new request cancels stale reads;
no extra polling interval, metering consumer, writer or renderer is started.

The shared 0–5000 ms control delays disposable PCM before the cable and affects
the native picture as well as the main visualizer's already delayed browser
video. The separate `/remote` ratings page has no delay editor. Save persists;
Reset to 0 is a preview until saved. The default is zero, with no automatic
preset or audible-output change. The companion's existing strict active
transport and ownership rules remain unchanged. See the
global delay reference (private installation record; [published status and operating limits](../../docs/october-2026-update.md)).
The October 9 installed tests cover this path synthetically; a new live native
session and physical synchronization were not started for activation.

## Update and remove

```powershell
powershell -ExecutionPolicy Bypass -File .\install-windows.ps1 -Action update
powershell -ExecutionPolicy Bypass -File .\install-windows.ps1 -Action remove
```

Stop the companion by closing G-Force before removal. The installer owns only
`Packages/RabbitHole.HQPlayerInput.package/_package.py` and its generated private
launcher. Removal verifies hashes and preserves edited files. Its ownership
record, request/status, backups and logs live under ignored Rabbit Hole `data/`.
No app imports this folder; remove the native package before deleting its source.

## Verification

All 71 focused offline checks pass: 35 controller, 12 installer and 24 native
package tests. JavaScript and PowerShell syntax checks pass. The tests cover
explicit selection, exact zone/output pins, cancellation, source switching,
native generation changes, owner preservation and removable installation.

Windows installation succeeded on the October 5 retry: two owned files installed,
both source/manifest hashes verified, and G-Force preferences unchanged. The user
subsequently verified the menu option and reported the request toast without
reactivity. Its initial status was blocked on the zone not playing; a later
explicit selection reported receiving. A bounded 6.814-second shared capture of
the exact cable measured non-silent RMS from -31.686 to -15.834 dBFS and a
-3.750 dBFS peak, preserving both owner records and native preferences. No extra
HQPlayer meter/control connection or audio output was opened for that check.

The initial-paused-choice controller fix loaded with a later user-started helper.
The native package's automatic-feedback revision remains prepared but not
installed; that separate package update needs G-Force closed and Windows
administrator approval.

### Analysis output fell behind

**Current incident:** a real Windows blue screen occurred on the user's next
native HQPlayer launch after this source revision. The main analysis feed was
initially disabled. Microsoft CDB on its copied dump places the fault inside the Intel
graphics driver with GStreamer's plugin scanner as the current process. Audio
startup previously exposed the full video plugin directory. The revised adapter
uses only five audio/core plugins in a private directory and registry, with
sequential inspection. The exact triggering plugin and driver failure reason
remain unknown. The subsequently approved metadata-only check passed all six
isolated element queries with only five private audio plugin paths in its traces;
the live scanner startup passed, while audio delivery/native response remain
untested for this correction. See the crash investigation (private installation record; [published status and operating limits](../../docs/october-2026-update.md)).
Do not treat offline checks or earlier cable measurements as live validation.

The user subsequently approved recovery and a live test. The verified dead
companion's control files were archived, preserving both the original crash
evidence and the request from the user's closed native instance. Main/MCP were
reloaded to replace their old in-memory adapter, and the existing exact feed
configuration was enabled without changing its other fields or starting audio.
A fresh native HQPlayer selection is required. A two-minute background watch
observed no new native session; visual reaction remains pending.

This error is the analysis adapter's protective shutdown after output pressure.
The earlier implementation inferred a continuous blockage from timer samples;
it did not track writer completion/drain progress. The correction tracks that
progress, discards obsolete visualizer PCM during pressure, and lets queued I/O
run once before an overdue check after a delayed timer. A genuinely stalled
writer still fails after two seconds without progress.

The companion also saves bounded, correlated measurements in private
`data/soundspectrum-hqplayer-native/feed-diagnostic.json`. Active measurements
coalesce; a terminal failure survives Stop until a new active session replaces
it. Diagnostic writes cannot block the feed's safety/status work. Records omit
routes, raw stderr, owner tokens and source metadata.

For the native input, close and reopen G-Force, then select **HQPlayer (analysis
feed)** again to load these JavaScript changes. They need no package installation
or administrator prompt. Already running web services keep their loaded adapter
until their own restart; this native reload does not restart them.

A later bounded shared read of the exact cable measured non-silent RMS from
-26.673 to -19.367 dBFS and a -10.806 dBFS peak over 200 buffers/8.123 seconds,
with owner records and native preferences unchanged. No audio output or additional
HQPlayer connection was opened. The old screenshot establishes the shutdown
trigger; it cannot retrospectively distinguish a driver stall from delayed
scheduling. Cable levels alone do not prove G-Force's actual input processing.
