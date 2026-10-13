# SoundSpectrum window capture

The main app launches an installed SoundSpectrum Standalone renderer with a
built-in Sound Generator preset or an explicitly selected PC microphone.
This helper captures only that renderer's window client area.
It never captures the desktop or opens an audio input/output.

Run `powershell -ExecutionPolicy Bypass -File scripts/soundspectrum-setup.ps1`
once to extract the official GStreamer 1.26.11 MSVC runtime into
the app's ignored `data/soundspectrum-gstreamer/1.26.11`. The SHA-256 is checked against
the upstream checksum. Read-only extraction of the MSI's embedded cabinets does
not execute installation or alter machine PATH. `RH_SOUNDSPECTRUM_GST` can override the runtime
directory or point directly to `gst-launch-1.0.exe`.
After checking every required plugin, setup saves the exact executable path in
the app's ignored `data/soundspectrum-runtime.json`. Discovery uses this local
file even if the background task inherited a missing or different AppData
environment. An explicit `RH_SOUNDSPECTRUM_GST` override takes precedence.
The workspace location also keeps the runtime visible to the background task
when a packaged desktop app virtualizes writes under LocalAppData. Older local
runtime copies remain available and are not moved or deleted during migration.

`node scripts/soundspectrum-capture.cjs --probe` reports JSON readiness without
launching a visualizer or capturing anything.

The preferred server integration imports `buildCaptureCommand` and directly
spawns its `command`, `args` and `env`. Pass `windowHandle`, optional `width`,
`height`, `fps`, and `quality`. Defaults are 800×450, 15 fps, JPEG quality 72.
Binary stdout is multipart JPEG with boundary `rabbit-hole-soundspectrum`.
Diagnostics are on stderr. No audio is included.

The caller must validate that the HWND belongs to the expected standalone
executable and owned process before starting capture. Keep the window restored
and rendering; minimize/hide/desktop locking may stop frame delivery. Windows
Graphics Capture uses the window's own surface when other windows cover it.
There is deliberately no desktop-capture fallback. Disconnect or stalled-viewer
handling belongs to the server, which should terminate capture when unused.

The pipeline scales on D3D11 before copying a small NV12 frame for JPEG encoding.
The conversion explicitly uses full-range YUV so JPEG colors and black levels
match the window instead of inheriting limited-range video levels.
Its queues keep at most one frame and drop late frames. This limits latency and
resource use; visualizer, GPU capture, JPEG encoding and network still add load.
This MJPEG route works through the authenticated HTTP connection, including
tablet browsers, without WebRTC ICE/TURN infrastructure. It uses more bandwidth
than compressed video and does not provide native GPU rendering on the tablet.

Local verification used a test-owned WinForms window with an 800×450 client and
four solid color quadrants. Windows Graphics Capture produced an 800×450 JPEG
without the surrounding title bar; FFmpeg decoded red, green, blue, and yellow
samples within two levels of the original RGB colors. Synthetic GPU scaling and
JPEG multipart stdout also passed. These checks do not verify a SoundSpectrum
renderer, its microphone, or its audio performance during listening.

Primary references:

- https://gstreamer.freedesktop.org/data/pkg/windows/1.26.11/msvc/
- https://gstreamer.freedesktop.org/documentation/d3d11/d3d11screencapturesrc.html
- https://gstreamer.freedesktop.org/documentation/jpeg/jpegenc.html
- https://gstreamer.freedesktop.org/documentation/multipart/multipartmux.html
