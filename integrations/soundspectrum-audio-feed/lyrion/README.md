# Optional HQPlayerBridge side copy

`AudioTap.pm` is installed as `RabbitHoleAudioTap.pm` beside the reviewed
HQPlayerBridge 1.0.40 sources. Four small marked insertions in `Player.pm` and
`Stream.pm` load it once, remember the current stream format, copy each already
requested chunk, and end the copy when that stream closes. The original scalar
reference, chunk queue, playback connection and source URL remain unchanged.

The helper supports only the explicitly selected player's tier-4 FLAC stream.
Local-file download and direct-service tiers bypass this hook. It reports its
loaded/configured state through the read-only Lyrion query `rhaudiofeed status`.
The response contains no source URL, token or port.

Demand is a private, bounded JSON file read by a regular Lyrion timer once per
second, never inside `nextChunk`:

```json
{
  "version": 1,
  "port": 49152,
  "token": "64 lowercase hexadecimal characters",
  "playerId": "aa:bb:cc:dd:ee:ff",
  "expiresAt": 1791043200000
}
```

The receiver binds an ephemeral port on `127.0.0.1`; the helper always sends to
that numeric loopback address. Each nonblocking datagram has a JSON header of
at most 1024 bytes, one newline, and at most 32768 binary payload bytes. Headers
have `v`, `token`, `playerId`, `generation`, `sequence`, `type` and `format`.
`type` is `begin`, `data` or `end`; format is `flac`. Begin uses sequence 0; each
following packet increments it. A receiver must reject sequence gaps and end
that analysis generation. There is no sender queue, retry or playback wait.
Socket failure only disables the copy for one second.

The helper retains at most a 42-byte FLAC header and small format context per
stream. A late viewer can join using that streaming header and the next FLAC
frame. It captures the actual source STREAMINFO when available, with its
original block sizes, while clearing total samples and MD5 for the partial
stream. If a usable header is unavailable, the helper waits for a new stream.
No audio buffer or client object is retained.

From the main app directory, review without changing the installed plugin:

```powershell
node integrations/soundspectrum-audio-feed/install-bridge.cjs --plan
node --test integrations/soundspectrum-audio-feed/bridge.test.cjs
```

`--install` verifies exact source SHA-256 hashes and version, records originals
and ownership in ignored `data/soundspectrum-audio-feed`, and installs the
optional helper. It never restarts Lyrion. A one-time Lyrion restart is required
to load it and briefly interrupts playback. The main app's restart does not
restart Lyrion.

`--uninstall` removes only the recorded marker blocks and exact owned helper
files, preserving unrelated subsequent source edits. It refuses changed owned
blocks/files instead of restoring an old whole-file snapshot. It also does not
restart Lyrion. Turning off the feed removes its demand; the cached demand
expires even if the main app exits unexpectedly.

The offline Perl harness replaces framework calls with stubs. Tests exercise
the actual reviewed `nextChunk` and `closeStream` methods, including helper
absence/errors, packet failures, exact byte identity, selected-player demand,
configuration rejection and real FFmpeg decoding after a mid-frame late join.
