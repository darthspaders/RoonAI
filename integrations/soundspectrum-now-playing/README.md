# G-Force now-playing companion

This optional companion gives the G-Force window owned by Rabbit Hole the exact
track metadata for its selected Roon HQPlayer zone or Lyrion player. It does not
open an audio stream, alter playback, or change audio devices.

On a new track, title and artist fade in for one second, remain for six seconds,
then fade out for two seconds. The real current artwork runs as one long-lived
G-Force Sprite. On track change, only this companion's Sprite is replaced. Its
size and motion use G-Force's native Sprite behavior. The same effects appear in
the existing captured phone/tablet video; there is no additional video stream.

Metadata reads follow only a running, leased, owned G-Force music-feed session.
Roon uses the paired core's cached exact zone; Lyrion uses the exact selected
player's read-only status. Artwork downloads are bounded to three seconds and
2 MiB, validate PNG/JPEG headers and dimensions, and use the paired core or
configured LMS. Opaque artwork references keep playback URLs and credentials
out of the native state. Radio artwork can be station branding rather than an
album cover. Missing artwork does not invent a cover.

Short metadata gaps preserve the current cover for up to 30 seconds. Pause,
seek and artwork refreshes do not repeat the title announcement. Stop, lost
viewer demand, source changes and stale private state clear only the owned
effects. An identical recording repeated versus a seek to its start cannot be
reliably distinguished from the available player metadata.

## Installation

Close G-Force Standalone, then run from the main app directory:

```powershell
node integrations/soundspectrum-now-playing/install.cjs install
node integrations/soundspectrum-now-playing/install.cjs status
```

The installed G-Force loader needs one independently owned file under Program
Files: `Packages/RabbitHole.NowPlaying.package/_package.py`. Windows may request
administrator approval for this file. The installer verifies the same Windows
user, reserves ownership before copying, and never modifies themes, categories,
preferences or other add-ons. Per-user Packages are not automatically loaded by
this installed version.

Restart Rabbit Hole after stopping its visuals cleanly. Then select G-Force and
the existing exact music-feed input and press Start visuals. The companion does
not automatically launch visuals or play music. An unrelated manually opened
G-Force instance and no-mic/microphone sessions are not assigned another zone's
metadata. The separate Roon Visualizer app on port 3788 is independent.

## Implementation and diagnostics

`src/server.js` has a removable optional attachment to `index.cjs`. The publisher
writes a small atomic `data/soundspectrum-now-playing/now-playing.json` with the
owned native PID, unique session, track key and bounded display fields. A native
Python worker reads it off the render thread, verifies private artwork hashes,
and swaps a small snapshot. Only the engine thread starts/stops the owned
Sprite and text overlay. The worker performs no HTTP requests or audio calls.
Python package registration uses the fixed private Windows root as
`file:///Volumes/<drive>/...`. G-Force's file-URI parser strips `file://` and
accepts the remaining internal volume path. The available entry must contain
exactly the one expected private hash image component. That canonical URI is
forwarded unchanged into native registration, as the vendor's external-Sprite
code does. The previous extra `ResolvePathname` check came from the unrelated
3D geometry API and blocked artwork; it is removed. Raw `file://C:/...`
availability was never proven; the previous stub assumption was incorrect. Artwork
failures suppress repeated attempts for that track/art signature while title
announcement and freshness continue independently.

The native worker writes bounded `native-status.json` to the same private
directory. It uses a small direct overwrite; diagnostic readers must tolerate
transient incomplete JSON. The publisher's authoritative state stays atomic.
`native-last-display.json` retains the latest accepted track/artwork attempt,
including its original PID/session/key/time, fixed outcome and component form.
It survives later idle status or Stop and is diagnostic history, never session
authority. Availability, component identity and display errors are distinguished.
The worker attempts a final flush on orderly Stop; abrupt process termination
can still interrupt this optional diagnostic.
The embedded Python reader uses a bounded private-schema parser, without `json`
or `ctypes`. `native-bootstrap.json` records package/hook and eligible engine
startup stages once, before frames; dependency failures use fixed names.
Matching PID/session and applied flags show that the package loaded
and native calls returned; they do not prove successful native config loading
or the appearance of rendered pixels. The text flag records owned invocation,
not continuing visibility after its nine-second fade finishes.
Metadata expires after eight seconds without a publisher heartbeat. Private
runtime state, artwork cache, installation manifests and backups are ignored by
Git. The bounded cache preserves edited files rather than overwriting them.

## Update or remove

With G-Force closed:

```powershell
node integrations/soundspectrum-now-playing/install.cjs update
node integrations/soundspectrum-now-playing/install.cjs remove
```

Updates keep private backups and only replace the exact owned hash. Removal
preserves edited or unowned files and retains private runtime data. Removing the
integration directory disables the optional server attachment at its next
restart, but run the guarded remover first to remove the installed native hook.
Native-only updates reload when G-Force closes and opens again; they do not
require a Rabbit Hole server restart.

## Offline verification

```powershell
node --test test/soundSpectrumNowPlaying.test.js integrations/soundspectrum-now-playing/provider.test.cjs integrations/soundspectrum-now-playing/install.test.cjs
python -B integrations/soundspectrum-now-playing/test_package_stub.py
```

Native stub tests additionally exercise worker/engine thread separation,
exact Sprite ownership, stale-state cleanup and text/album changes without
launching G-Force or touching audio. Real native rendering still requires a
controlled live Start after installation.

On October 6 the user confirmed the title fade and visible album artwork with
the final direct canonical URI flow. Fresh exact-owned native diagnostics also
matched with no error. Offline lifecycle checks verify persistence/replacement
and title suppression; a natural live track boundary and long session were not
observed in this bounded check. Stubs and invocation flags cannot prove pixels.

The installed scripting reference supplies the native commands. SoundSpectrum
also documents the scripting workflow in its
[G-Force scripting guide](https://www.soundspectrum.com/g-force/Documentation/scripting.html).
