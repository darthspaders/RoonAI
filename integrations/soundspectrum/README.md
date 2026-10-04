# Optional SoundSpectrum window capture

This integration requires a Windows desktop installation of SoundSpectrum.
Install Aeon, G-Force and/or WhiteCap separately and initialize their Standalone
preferences by running each installed product once.
SoundSpectrum software, presets, Audio Cable and licenses are not bundled.

Rabbit Hole launches an installed renderer with one explicitly selected input:
a physical microphone, a built-in no-mic generator, or an available optional
music feed. It captures only the verified renderer window's client area.
The capture helper has no desktop-capture fallback.

## Capture runtime setup

From the Rabbit Hole directory:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/soundspectrum-setup.ps1
node scripts/soundspectrum-capture.cjs --probe
```

Setup extracts the pinned official GStreamer 1.26.11 MSVC runtime into ignored
`data/soundspectrum-gstreamer/1.26.11`, checking the upstream SHA-256.
Read-only MSI extraction does not run an installer or alter machine PATH.
Setup records the verified executable in ignored
`data/soundspectrum-runtime.json`.
`RH_SOUNDSPECTRUM_GST` can override the directory or executable path.

The renderer must remain restored and rendering. Minimizing its window or
locking the Windows session can stop frame delivery. Capture uses Windows
Graphics Capture, including when another window covers the renderer.

Linux containers do not provide the native Windows renderer/capture.
Basic Roon and Lyrion playback can run without this optional integration.

## Inputs and optional music feeds

All three renderer products have Fluid, High Energy and Chill no-mic choices.
These are native generated inputs, not reactions to the currently playing song.
Microphone availability depends on the Windows input inventory.

Optional music input setup/removal is documented separately:

- [Lyrion HQPlayerBridge side copy](../soundspectrum-audio-feed/README.md)
- [Roon/HQPlayer analysis feed](../soundspectrum-hqplayer-feed/README.md)

Both require the verified SoundSpectrum Audio Cable and explicit Start visuals.
Saved choices and status reads do not start a renderer or audio feed.

## Transport and limits

D3D11 scales the captured window before JPEG encoding. Queues retain at most
one pending frame and drop stale work.
The primary browser transport uses acknowledged WebSocket JPEG frames; the
multipart-JPEG HTTP path is a fallback. A slow viewer can skip frames instead
of accumulating an unbounded delay.

Rendering, GPU capture, encoding and networking add resource load and latency.
This is streamed window video rather than native tablet GPU rendering.
It does not guarantee continuous 30 fps, precise music/DAC synchronization or
performance on every tablet/network.

No raw microphone/music recording is stored by this capture integration.
Account/runtime settings remain private under ignored `data/`.

References: [GStreamer Windows runtime](https://gstreamer.freedesktop.org/data/pkg/windows/1.26.11/msvc/),
[Windows capture source](https://gstreamer.freedesktop.org/documentation/d3d11/d3d11screencapturesrc.html),
[JPEG encoder](https://gstreamer.freedesktop.org/documentation/jpeg/jpegenc.html),
and [multipart muxer](https://gstreamer.freedesktop.org/documentation/multipart/multipartmux.html).
