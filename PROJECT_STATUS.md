# The Rabbit Hole — project status

Updated 2026-10-04.

Rabbit Hole provides independent Roon and Lyrion playback paths in a local Node.js
web application at `http://localhost:3777`. The GitHub repository is named
RoonAI; the application is called The Rabbit Hole.

## Available integrations

- Roon extension pairing, zones, transport, queues, verified discovery and ratings.
- Lyrion players, source browsing/search, favorites, now playing, queues and transport.
- SiriusXM live metadata, show episodes, artist stations and Xtra channels.
- Separate SoundCloud OAuth for exact-track playlist management.
- TIDAL verification, optional profile OAuth, playlists and profile mixes.
- Local or hosted language models, metadata enrichment and local music memory.
- Local-library inventory and optional metadata review/tag-writing tools.
- Optional Sonic Review and versioned audio embeddings.
- Optional Windows SoundSpectrum integration for Aeon, G-Force and WhiteCap.

The built-in HTTP MCP endpoint exposes the Lyrion/SoundCloud/SiriusXM actions.
A separately installed OAuth wrapper is optional and has its own configuration.

## Installation and current limits

See [README](README.md), [Lyrion setup](docs/lyrion.md) and
[Linux/Docker setup](docs/linux-docker.md). A new installation creates its own
private runtime data; no account connections, playback state or listening history
are included in this repository.

Native SoundSpectrum rendering and its audio cable require a Windows desktop
installation. Optional HQPlayer analysis is a derived visualization signal with
approximate timing. It does not guarantee exact synchronization to the DAC.
See the [integration guides](integrations/soundspectrum/README.md).

SiriusXM web endpoints can change. Long on-demand episodes use a loopback relay
with limited seeking; artist/Xtra tracks use validated completed files.
Those relays currently require Lyrion and Rabbit Hole on the same host/network
namespace. See [SiriusXM playback](SIRIUSXM_ON_DEMAND.md).

Sonic analysis is opt-in, requires its own runtime/model setup, and does not
create authority to queue an unverified track. Read the
[recommendation guide](docs/recommendation-engine-v2.md) and
[third-party notices](THIRD_PARTY_NOTICES.md).
