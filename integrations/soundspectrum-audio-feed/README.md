# SoundSpectrum music feed experiment

This optional integration copies the FLAC bytes that Lyrion's HQPlayerBridge is
already sending to HQPlayer. An independent decoder converts the copy to PCM
and sends it only to the verified SoundSpectrum Audio Cable. Aeon, G-Force and
WhiteCap can then respond to the selected player's music without a microphone.
The playback branch still sends the original bytes to HQPlayer and its existing
Dreamus ASIO/DSD512 output. There is no second reader of `/stream.mp3` or `/hqp/`,
ASIO proxy, default-device change, playback command or queue change.

The feed is **off by default**. Enabling its local setting makes the input
available; it does not start a decoder or audio writer. Choose the Lyrion player,
select **Music feed (experimental)** under the visualizer's **Audio input**, and
press **Start visuals** explicitly. Stop visuals or leave the view to release
the feed. Saved selections never start it automatically.

## Supported playback

The tap supports HQPlayerBridge's **tier-4 FLAC player stream**, including the
current native SiriusXM channel route, before HQPlayer processes that signal.
The current observed source is 44.1 kHz / 24-bit FLAC. The visualization copy is
44.1 kHz stereo PCM; that conversion does not replace the playback signal.

Roon playback, music started directly in HQPlayer, local-file download tiers
and service-direct tiers do not pass through this hook. Their visuals may wait
for a supported stream; the integration does not change those routes to obtain
audio. The source is the server's outgoing stream, so timing against the DAC is
approximate and depends on player buffering. This is not a DAC-clock signal.

## Review and setup

Run these commands from the main Rabbit Hole directory. The read-only plan
verifies the installed HQPlayerBridge **1.0.40** and exact reviewed source hashes:

```powershell
node integrations/soundspectrum-audio-feed/install-bridge.cjs --plan
node integrations/soundspectrum-audio-feed/manage.cjs --status
node --test integrations/soundspectrum-audio-feed/bridge.test.cjs
node --test integrations/soundspectrum-audio-feed/feed.test.cjs integrations/soundspectrum-audio-feed/audio-output.test.cjs
```

Install the small optional helper and its marked source hooks:

```powershell
node integrations/soundspectrum-audio-feed/install-bridge.cjs --install
```

The installer preserves full original files and SHA-256 ownership records in
private `data/soundspectrum-audio-feed/bridge-backups` and
`bridge-manifest.json`. It refuses unexpected versions, source changes or an
unowned existing helper. It does not restart any service.

A **one-time Lyrion restart is required** to load the installed Perl helper and
briefly interrupts playback. Schedule that step for when the interruption is
acceptable. Rabbit Hole's `npm run restart` restarts Rabbit Hole/MCP only; it does
not load the Lyrion helper. The read-only Lyrion query `rhaudiofeed status` reports
the actual loaded helper rather than treating files on disk as a running feed.

Enable the local experiment after the dedicated cable and runtime checks pass:

```powershell
node integrations/soundspectrum-audio-feed/manage.cjs --enable
node integrations/soundspectrum-audio-feed/manage.cjs --status
```

This discovers and records only the exact SoundSpectrum Audio Cable pair. Its
recording endpoint must have Windows **Listen to this device** off; unknown
identity, a missing device or unsafe Listen settings leave the feed unavailable.
The tool does not alter Windows settings to pass these checks.

Refresh the player and audio-input inventory, then start the music feed through
the UI. Use the shared **Visuals & audio** 0–5000 ms control for timing: Current
previews, Save persists, and Reset to 0 previews until saved. Default is zero;
preserve the user's selection rather than applying a universal preset.

The former private 0–30000 ms decoder-onset setting remains readable for
compatibility but is superseded. The shared PCM stage applies once after pacing
and before the visual cable. Native visuals and main-browser visualization video
therefore share the delay; the video transport adds no second delay. `/remote`
is the separate ratings page, with no delay editor. Audible playback remains unchanged. See the
global delay reference (private installation record; [published status and operating limits](../../docs/october-2026-update.md)).

## Failure and shutdown

Playback never waits for this receiver. The Perl side uses nonblocking loopback
UDP with no retry queue; the receiver uses bounded buffers. Sequence loss,
decoder/writer failure, stale demand, a different player or an unsafe cable
ends the visualization copy. The original playback bytes and ASIO output keep
their existing path. Additional decoding/rendering still uses CPU and memory;
long-session resource and synchronization behavior require listening checks.

The PCM writer follows monotonic elapsed time, so normal Windows timer jitter
does not accumulate a fixed-frame pacing error. Catch-up writes are capped at
100 ms. After a large callback gap it discards only available stale copy PCM,
accounts for elapsed frame debt and recovers; `droppedPcmFrames` reports these
visualization-only drops. Generation and configured delay timing reset together.

The shared WASAPI writer uses `sync=false`: Node already paces this disposable
copy, while raw-parser timestamps advance only for submitted samples. After a
callback gap those timestamps can lag the hardware and cause subsequent PCM to
be discarded. The hardware buffer still controls output consumption. A bounded
exact-cable test with a 700 ms gap reproduced silence at `sync=true` and restored
nonzero output after the same gap at `sync=false`.

`decodedSignal` measures PCM returned by the separate decoder; `submittedSignal`
measures PCM handed to the writer. Byte counters establish transport activity,
and these amplitude meters distinguish music from silence at those two stages.
Neither establishes sound at the recording endpoint: verify that separately
with the exact SoundSpectrum cable capture or Windows endpoint meter.

Disable the experiment without uninstalling it:

```powershell
node integrations/soundspectrum-audio-feed/manage.cjs --disable
```

An active copy closes at its next safety check. Private demand expires even
after an unexpected app exit. Microphones and the three native no-mic generator
choices remain available.

The receiver takes an exclusive private owner lock at
`data/soundspectrum-audio-feed/demand.json.owner`. A crash can leave that file
behind; there is **no automatic stale-lock recovery**. A later start refuses the
lock rather than competing with another owner. Before manually removing only
that owner file, check its `ownerPid`, confirm that owner process has exited and
that no other music-feed session is running. An expired demand alone does not
prove ownership is safe to remove. If ownership cannot be established, leave
the lock in place and keep using another visualizer input.

Before a planned Rabbit Hole main-service restart, **stop all music-feed
viewers** and wait for the copy to close. Alternatively run `manage.cjs --disable`
and wait for its safety check and owned-process cleanup before restarting; after
reload, run `manage.cjs --enable` only if the feed was previously enabled. This
prevents a forced restart from leaving its exclusive owner file behind. Restart
does not automatically recover a stale lock or restart visuals.

## Remove the experiment

1. Stop its visuals in Rabbit Hole, then run `manage.cjs --disable` above.
2. Remove only the owned bridge additions:

   ```powershell
   node integrations/soundspectrum-audio-feed/install-bridge.cjs --uninstall
   ```

3. Restart Lyrion at an acceptable time to unload the Perl helper. This briefly
   interrupts playback, just as loading it does.
4. After uninstalling, remove only
   `integrations/soundspectrum-audio-feed` if the experiment is no longer wanted.
   Restart Rabbit Hole to release any loaded integration code.
5. After confirming the owned bridge hooks are removed, its private
   `data/soundspectrum-audio-feed` folder can also be removed. Keep the backups
   until that confirmation. Do not delete Rabbit Hole's broader `data` folder.

Uninstall strips the exact recorded marker blocks and exact owned helper files.
It preserves unrelated edits made after installation. If those owned additions
were changed, it refuses automatic removal instead of restoring an old complete
plugin file. Plugin updates may require reviewing a new integration version;
the installer never patches an unreviewed update automatically.

For transport details and the offline Perl fixture, see [lyrion/README.md](lyrion/README.md).

## Recorded validation

The initial deployment passed 97 focused tests, 343 main JavaScript syntax checks and
explicit syntax checks for seven optional CJS files. The optional feed/output
tests live inside this removable folder; their relocated 24-test scope passed.
All three visualizers received copied/decoded bytes during bounded live
checks: G-Force for over two minutes, WhiteCap for about 45 seconds and Aeon for
about two minutes. Copy buffers stayed roughly 142–350 KB; desktop stalls
recorded visualization PCM drops while the feed kept running.
Those checks established transport activity; they did not establish nonzero
cable output or visible reaction to music. Later endpoint testing identified
the timestamp-gap issue described above.

Stopping the last viewer was verified to release copy buffers, owner/demand
files and owned decoder/writer children. Original SiriusXM playback retained
its one queue item and HQPlayer DSD512 output. CLI disable/re-enable was checked
while idle: availability went false then true with no autostart. That check
did not establish CLI shutdown during an active feed. That initial run left the feature enabled
and available with zero viewers; explicit Start visuals is still required.
These checks do not establish long-session performance or exact synchronization.

The subsequent silence correction passed 100 focused tests, the same 343 main
syntax checks and seven optional CJS checks. A controlled 700 ms output gap
reproduced the silent cable with `sync=true` and retained signal with `sync=false`.
After a clean Rabbit Hole/MCP reload, all three native visualizers opened the
exact recording endpoint and received measurable music. Capture endpoint peaks
were 0.707 for Aeon, 0.543 for G-Force and 0.181 for WhiteCap, with active,
unmuted native capture sessions and twelve distinct video frames each. Aeon and
WhiteCap retained signal after startup pacing drops. An independent eight-second
cable PCM capture measured RMS -23.28 dBFS; another capture of the user's resumed
session measured -16.01 dBFS. No captured PCM was saved. HQPlayer remained in
playing state at DSD512 with the same one-item Lyrion queue. QA leases were
released, and the user's subsequently resumed music-feed viewer was preserved.
