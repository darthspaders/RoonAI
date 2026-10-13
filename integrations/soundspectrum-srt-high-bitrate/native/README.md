# Isolated GStreamer SRT listener repair

This directory preserves the GStreamer 1.26.11 SRT plugin sources and their
LGPL license. `upstream-manifest.json` records the original download URLs and
SHA-256 hashes. `prepare.cjs` verifies every original file before applying a
strict, listener-only patch into the ignored private build directory.

The original listener closes a caller whenever `srt_sendmsg2` fails, including
the recoverable `SRT_EASYNCSND` send-buffer-full condition. The local helper
waits on that caller's existing writable/error epoll for at most 100 ms per
wait, checks cancellation, and retries the same packet. It does not advance or
discard the packet while waiting. Genuine send/poll/socket errors retain the
original caller-removal path. Cancellation returns through existing cleanup.
Because the listener retains its socket lock while waiting, unlock now cancels
before taking that lock, then retains upstream's cancellation/signal sequence
inside the lock. This lets Stop wake a full-buffer wait without a lock cycle.
Caller-mode sends, receiver behavior, encryption and codec configuration are
unchanged. This is a local repair, not an upstream release.

Revision 2 also retries the same send after each epoll timeout, even when no
writable event arrives. Revision 1 waited indefinitely inside epoll in that
case. In pinned [libsrt 1.5.4's send implementation](https://github.com/Haivision/srt/blob/v1.5.4/srtcore/core.cpp#L6167),
`sendmsg2` performs negotiated too-late packet eviction before checking buffer
space. Preventing subsequent sends could therefore prevent that recovery when
ACKs stopped. A 100 ms timeout now returns to the send attempt, preserving
cancellation and the original packet pointer/length. Existing libsrt policy
decides whether already-buffered stale packets can be discarded.

Prolonged waits produce `RH_SRT_WAIT` numeric JSON after one second and at most
once per second per blocked send. It reports elapsed wait, stats availability,
socket state, send-buffer bytes/age, packets in flight/flow window, cumulative
ACK/NAK/retransmit/drop counts and unique bytes sent. No address, socket handle,
connection URL or key is emitted. Stats are read directly from the already-owned
socket, without the public GStreamer stats getter's mutex or caller-removal side
effects. These are sender observations, not tablet decode measurements. Brief
waits that recover before one second deliberately produce no warning.

The native regression executable covers immediate success, full-buffer recovery,
timeout recovery without writable events, repeated waits/retries, genuine
send/poll/socket failure, cancellation before send or during a wait, bounded
warning frequency, and failed stats reads without changing send behavior.
Its socket and cancellation boundaries are synthetic. All 13 cases passed with
the local compiler, including warnings-as-errors.
The generated enum registration files mirror the two enums in the pinned
`gstsrt-enums.h`; upstream normally generates these through Meson.

Run `build.ps1 -SdkRoot <GStreamer 1.26.11 x64 developer root>` with the existing
MSVC 2019 x64 compiler. The SDK root must contain `include`, `lib` and the
GStreamer/GLib/SRT development files. The supported private preparation uses
the official 1.26.11 developer MSI; extraction does not install it system-wide.

Build output goes only to `data/soundspectrum-srt-high-bitrate/patched-plugin/`:
`gstsrt.dll`, a strict hash manifest, a private build receipt and generated
sources/compiler response files under `build/`. The plugin reports version
`1.26.11.2`, local revision `listener-backpressure-2`. The shared bundled runtime
DLL is never overwritten. Activation must use the independent SRT helper's
private plugin path and registry after manifest/hash/version checks.

After building, run
`node integrations/soundspectrum-srt-high-bitrate/native/validate-stop.cjs`
from the application root for the actual Stop regression. It checks the private
DLL hash and loaded version, sets the private plugin path and validation
registry while retaining the original runtime's system plugin directory, and
chooses an ephemeral loopback port. Its real peer connects without reading.
The test waits until the repair observes an actual full send buffer, then sets
the GStreamer pipeline to NULL and joins the producer. Stop must complete in
under two seconds; an external 15-second process bound handles a regression.
It records a private receipt and verifies the shared runtime DLL stayed intact.
Revision 2 passed in **31.411 ms**, with its exact compiled DLL hash verified.
This exercised real socket, mutex and cancellation behavior, separately from
the synthetic boundary cases. The revision-1 historical runs passed in
31.236 ms and 31.179 ms.

Run `node integrations/soundspectrum-srt-high-bitrate/native/validate-recovery.cjs`
for the real ACK-suppression regression. Its loopback UDP proxy suppresses only
receiver-to-sender ACK control packets for 3.2 seconds while the receiver drains;
other traffic continues. It measures new accepted appsrc messages and newly
received sequence-tagged payloads, so retransmissions cannot masquerade as
progress. A direct libsrt stats read independently checks sender late drops.
The receiver must remain connected and cleanup must finish within two seconds.
The runner verifies the loaded plugin's exact version/path/hash and bounds the
whole native child to 15 seconds. No visualizer, capture, audio or application
session is started.

To compare an archived revision-1 plugin with the same compiled harness, pass
`--baseline=listener-backpressure-1-YYYYMMDDTHHMMSSZ`; that directory must exist
under private `data/soundspectrum-srt-high-bitrate/plugin-archive/`, with its
original DLL and hash manifest. Archive outside the active plugin search path.
The actual 2026-10-10 comparison suppressed ACKs for 3.207 seconds: revision 1
accepted and received **zero** new messages, with zero sender drops. Revision 2
accepted and received **178** new messages while ACKs remained suppressed and
reported **178** sender late drops. Both peers stayed connected; cleanup took
62.280 ms and 62.357 ms respectively. The shared runtime DLL was unchanged.

This demonstrates and repairs the bounded no-ACK stall. It does not prove that
all physical-tablet freezes have the same cause. A subsequent tablet trial and
the new sender observations are required to establish that outcome.

Earlier, an isolated synthetic 4K60/NVENC test ran revision 1 against the
original, unpatched receiver for **310.887 seconds**, retaining the 600 Mbps
encoder target, 250 ms latency and default receive buffers. It parsed and decoded
17,963 frames. The 309.884-second sampled period after startup contained no empty
one-second decode buckets; measured means were 579.538 Mbps received H.264 and
57.967 decoded frames per second. Both endpoints stayed alive until owned cleanup,
with no recorded transport/decode errors. Loaded process modules confirmed only
the sender used the isolated DLL. This verifies sustained local receipt and
decode at one-second measurement resolution, not physical-tablet playback or
millisecond-scale frame-gap bounds. Earlier unpatched trials failed in 7–30
seconds with the send-buffer-full caller removal.

Current validation and activation status belong in the integration's parent
README and current session handoff. Compilation or a synthetic regression pass
does not establish loaded activation, sustained media receipt or tablet playback.
