# The Rabbit Hole

Rabbit Hole is a local music discovery and playback assistant for **Roon and
Lyrion Music Server (LMS)**. Run it on your network and open its browser interface
at `http://localhost:3777`, or use your server's LAN address from a tablet.

Roon and Lyrion have independent players, queues and source identities. Rabbit
Hole can control an existing Lyrion → HQPlayerBridge → HQPlayer setup; it does
not replace that audio route. Lyrion controls also work without pairing Roon.

## What is included

- Roon extension pairing, zone selection, now playing, transport and queue controls.
- An independent Lyrion interface with Now playing, Channels, Shows, Artist
  stations, Xtra channels, Sources and Queue views.
- Browsing and playback through your installed LMS plugins, including local
  libraries, internet radio and supported streaming services.
- SiriusXM live-channel favorites and metadata, plus authenticated shows,
  artist stations and Xtra channels. These optional features need the matching
  subscription and configuration.
- Exact SoundCloud discovery/playback through LMS, with a separate SoundCloud
  account connection for playlist management.
- Verified discovery, ratings, history, saved candidates, TIDAL profile playlists
  and mixes, artwork, catalogue enrichment, and CSV/M3U exports.
- Local Ollama, LM Studio or OpenAI-compatible model support. **Synapse** is the
  optional OpenAI reasoning layer; it uses the same verified playback tools.
- A server-side MCP endpoint at `/mcp`, including independent Lyrion,
  SoundCloud and SiriusXM tools.
- Optional SoundSpectrum Aeon, G-Force and WhiteCap integration on Windows,
  including native no-mic presets and separately configured music-analysis feeds.

Provider credentials are optional for basic player controls. Subscription
services and playlist writes need their respective accounts and plugins.

TIDAL catalogue search uses the current public API. Some older personal Mixes
and legacy search endpoints require access that third-party developer apps may
not have; an access-tier error cannot be fixed by changing the search URL.

## Requirements

- **Node.js 24 recommended; minimum 22.13.0.** Current database features use
  built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html), which became
  available without a flag in Node 22.13.0.
- Roon Server on your LAN for the Roon path, and/or LMS with a connected player
  for the Lyrion path.
- An LLM server or configured cloud provider for model-assisted discovery.
- FFmpeg for optional SiriusXM on-demand/artist/Xtra audio and sonic analysis.
  The supplied Docker image includes FFmpeg and FFprobe.

The native SoundSpectrum renderer requires licensed Standalone apps and a
Windows desktop. It is optional and unavailable in the Linux Docker image.
Learned sonic models and Python/CUDA runtimes are separate optional installations.

## Linux / Docker / Unraid

```sh
git clone https://github.com/darthspaders/RoonAI.git
cd RoonAI
cp .env.example .env
# Edit .env: set LYRION_URL to your LMS HTTP address and configure your model.
docker compose up -d --build
```

Open `http://YOUR_SERVER_IP:3777`. Choose **Lyrion** and a connected player to
browse sources or use transport controls. For Roon, enable **The Rabbit Hole**
in **Roon → Settings → Extensions**, then select a zone in Rabbit Hole.

The supplied Compose file uses Linux host networking for Roon discovery and
loopback audio relays, and a persistent volume for private data and Roon pairing.
See [Linux, Docker and Unraid setup](docs/linux-docker.md) for LMS authentication,
network topology, data migration and an existing `node:22-slim` installation.

## Run directly with Node

```sh
npm ci
npm run start:app
```

First copy `.env.example` to `.env` (`cp` on Linux; `Copy-Item` in PowerShell).
The app-only command works from this repository alone on Linux or Windows.

`npm start` is the separate **combined service supervisor**: it also requires
the `rabbit-hole-mcp` repository beside this checkout. Use it only when that
independent MCP wrapper has been installed. The Docker image starts the app
directly and needs no sibling repository.

Windows combined background startup is available with
`scripts/background-task.ps1`; `npm run restart` uses Windows PowerShell and
the installed combined-service task. App-only users restart their Node process;
Docker users use `docker compose up -d` after changing `.env`, so the container
receives the updated environment.

## Configure the players

For LMS on the same Linux host as a host-network Rabbit Hole container:

```env
PORT=3777
HOST=0.0.0.0
LYRION_URL=http://127.0.0.1:9000
# Set these only when LMS requires HTTP authentication:
LYRION_USERNAME=
LYRION_PASSWORD=
```

For basic playback against another LMS host, use its reachable HTTP address.
LMS plugin logins stay configured in LMS. Rabbit Hole's separate SiriusXM
on-demand relay currently requires LMS to share the Rabbit Hole host's loopback
network; [the Lyrion guide](docs/lyrion.md) explains the distinction.

For local Ollama discovery:

```env
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=YOUR_INSTALLED_MODEL
AI_MODE=local
```

For LM Studio or another OpenAI-compatible local server:

```env
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=http://127.0.0.1:1234/v1
LLM_MODEL=YOUR_SERVED_MODEL_NAME
LLM_API_KEY=
AI_MODE=local
```

Use a reachable LAN address when the model runs on another computer. Optional
provider keys, TIDAL OAuth, Synapse model tiers and limits are documented in
`.env.example` and available in Settings. Controls do not require a running LLM.

## Guides

- [Lyrion players, plugin playback and HQPlayerBridge](docs/lyrion.md)
- [Linux, Docker and Unraid](docs/linux-docker.md)
- [SoundCloud playlist connection](LYRION_SOUNDCLOUD.md)
- [SiriusXM live metadata](SIRIUSXM_METADATA.md)
- [SiriusXM shows, artist stations and Xtra playback](SIRIUSXM_ON_DEMAND.md)
- [Windows SoundSpectrum setup](integrations/soundspectrum/README.md)
- [Optional Lyrion SoundSpectrum music feed](integrations/soundspectrum-audio-feed/README.md)
- [Optional Roon/HQPlayer SoundSpectrum analysis feed](integrations/soundspectrum-hqplayer-feed/README.md)
- [Direct server MCP connection](docs/direct-roon-mcp.md)
- [Architecture](ARCHITECTURE.md)
- [Optional recommendation/sonic engine](docs/recommendation-engine-v2.md)
- [Third-party dependencies and external runtimes](THIRD_PARTY_NOTICES.md)

## Development

```sh
npm ci
npm run check
npm test
```

Playback identities remain exact: Roon/TIDAL verification authorizes the Roon
queue, and Lyrion preserves its original plugin IDs, URLs and server-issued
actions. Enrichment and model suggestions cannot substitute another track.
Optional learned sonic work runs outside the HTTP/Roon thread to avoid blocking
connection heartbeats. Background bulk jobs require deliberate configuration.

Keep `.env`, `config.json`, `data/`, tokens, audio caches, logs and personal
history private. The Docker build includes only runtime source; its data volume
and `.env` stay outside the image. The browser controls are intended for a
trusted LAN. The MCP token protects `/mcp`; it does not add authentication to
all browser routes. Add your own authenticated access layer before remote use.

Rabbit Hole source is licensed under Apache-2.0. SoundSpectrum applications,
music-service subscriptions, model weights and their licenses are separate.
