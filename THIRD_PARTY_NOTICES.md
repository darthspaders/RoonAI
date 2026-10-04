# Third-party software and services

Rabbit Hole's authored source is licensed under [Apache-2.0](LICENSE).
That license does not replace the terms of its dependencies, external programs,
models, music services or content.

## Node dependencies

RoonLabs' Node API packages are installed from their repositories and carry
their own Apache-2.0 licenses:
[node-roon-api](https://github.com/RoonLabs/node-roon-api/blob/master/LICENSE),
[node-roon-api-browse](https://github.com/RoonLabs/node-roon-api-browse),
[node-roon-api-status](https://github.com/RoonLabs/node-roon-api-status), and
[node-roon-api-transport](https://github.com/RoonLabs/node-roon-api-transport).

The WebSocket dependency carries the
[ws MIT license](https://github.com/websockets/ws/blob/master/LICENSE).
Dependency license files remain part of their npm installations.

## Optional external programs

- [SoundSpectrum](https://www.soundspectrum.com/) Aeon, G-Force, WhiteCap and
  Audio Cable are separately installed products. This repository includes
  integration helpers, not their executables, presets, installers or license keys.
- [HQPlayer](https://www.signalyst.com/) and Lyrion plugins are installed separately.
  Optional patch helpers work against reviewed installed source and retain
  private backups; they do not distribute a complete copy of those plugins.
- FFmpeg/FFprobe use their own licenses. The exact build can include LGPL or GPL
  components; see the [FFmpeg license information](https://ffmpeg.org/legal.html).
  The Docker build installs distribution packages rather than storing binaries
  in this source repository.
- The Windows capture setup downloads a pinned official GStreamer runtime into
  ignored local data. GStreamer and its plugins retain their own licenses;
  see [GStreamer licensing](https://gstreamer.freedesktop.org/documentation/frequently-asked-questions/licensing.html).

## Optional learned models

Model checkpoints and third-party model implementation code are not bundled.
The registry records model identifiers, pinned revisions and approved code
checksums; downloading a model is an explicit setup step.

Essentia and its pretrained models have separate terms. The
[Essentia licensing page](https://essentia.upf.edu/licensing_information.html)
describes the library's AGPLv3/commercial options and the pretrained models'
CC BY-NC-ND 4.0/proprietary options.

MERT-family model cards include noncommercial terms; for example
[MERT-v2-FullSong](https://huggingface.co/m-a-p/MERT-v2-FullSong) declares
CC BY-NC 4.0. Check the license supplied with each pinned model, including base
models and adapters. Rabbit Hole's source license does not grant model rights.

## Content and protocol references

TIDAL, SoundCloud, SiriusXM and other services require the user's own account
or developer configuration where applicable. Account credentials, subscriber
tokens, audio caches and personal listening data stay under private local
configuration/data paths and are not included in this repository.

Protocol references for the independently written adapters are documented in
their integration guides. HQPlayer visualization uses
[Signalyst control sources](https://www.signalyst.eu/bins/hqp-control-601-src.zip)
and the [HQPTuner protocol notes](https://github.com/ohshitgorillas/hqptuner/blob/main/docs/protocol.md#7-metering-side-channel)
as references. SiriusXM adapters reference
[aiosxm](https://github.com/MizterB/aiosxm); that Python library is not bundled
or a Rabbit Hole runtime dependency.
