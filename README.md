# The Rabbit Hole

The Rabbit Hole is a local-first music discovery assistant for Roon. It connects to a local Roon Core as an extension, reads now-playing and queue state, searches Roon/TIDAL for playable tracks, and uses a local Ollama model to help rank and explain recommendations.

The app is built around discovery first: generate candidates, verify them, score them, rate them, save candidates, and queue them in Roon. It does not assume Roon can create or manage TIDAL playlists directly.

## Features

- Local web UI at `http://localhost:3777`
- Roon extension pairing through `Roon Settings -> Extensions`
- Roon zone selection, transport controls, queue view, and now-playing display
- TIDAL verification and artwork lookup when credentials are configured
- Local Ollama LLM support, defaulting to `llama3.1:8b`
- Optional OpenRouter fallback
- Optional Last.fm, Discogs, MusicBrainz, and Spotify enrichment
- Discovery scoring, feedback memory, saved playlist candidates, CSV/text export
- Rabbit Hole graph for artists, labels, remixers, collaborators, and hidden-gem prompts

## Requirements

- Node.js 18 or newer
- Roon Server/Core on the same network
- Roon client access to approve the extension
- Ollama for local LLM mode
- Optional API credentials for TIDAL, Last.fm, Discogs, Spotify, or OpenRouter

## Quick Start

```powershell
Copy-Item .env.example .env
npm install
ollama pull llama3.1:8b
npm start
```

Open `http://localhost:3777`, then approve **The Rabbit Hole** in `Roon Settings -> Extensions`.

To access it from a phone or tablet on the same network, use the LAN URL shown in the app, usually something like:

```text
http://192.168.x.x:3777
```

## Configuration

Edit `.env` after copying `.env.example`.

Core local mode:

```env
PORT=3777
HOST=0.0.0.0
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=llama3.1:8b
```

Stronger local model mode with LM Studio or llama.cpp:

```env
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=http://127.0.0.1:1234/v1
LLM_MODEL=qwen3-32b
LLM_API_KEY=
```

In LM Studio, load a Qwen 32B instruct model, start the local server, and copy the served model name into `LLM_MODEL` if it differs from the example.

Optional hosted model fallback:

```env
LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=
OPENROUTER_MODEL=openai/gpt-4o-mini
```

Optional TIDAL verification and artwork:

```env
TIDAL_VERIFY=true
TIDAL_COUNTRY_CODE=US
TIDAL_CLIENT_ID=
TIDAL_CLIENT_SECRET=
TIDAL_ACCESS_TOKEN=
```

Optional TIDAL profile mixes page:

```env
TIDAL_PROFILE_MIXES=true
TIDAL_PROFILE_CLIENT_ID=
TIDAL_PROFILE_CLIENT_SECRET=
TIDAL_PROFILE_REDIRECT_URI=http://127.0.0.1:3777/api/tidal/oauth/callback
TIDAL_PROFILE_SCOPES=user.read playlists.read playlists.write recommendations.read collection.read search.read
TIDAL_PROFILE_ACCESS_TOKEN=
TIDAL_PROFILE_REFRESH_TOKEN=
TIDAL_PROFILE_MIXES_ENDPOINT=
TIDAL_PROFILE_ARTIST_RADIO_FALLBACK=false
```

`TIDAL_PROFILE_ACCESS_TOKEN` must be a user-profile bearer token. The normal catalog/client-credentials token can search tracks, but it cannot read personal mixes such as My Mix, Daily Discovery, New Arrivals, Track Radio, or Artist Radio. TIDAL's full mobile-style Mixes & Radio shelf currently requires a legacy profile scope that normal third-party OAuth may not grant, so Rabbit Hole shows only the official profile mix relationships when that scope is unavailable. For the durable setup, add the redirect URI shown above in the TIDAL developer portal, then open `/api/tidal/oauth/start` from Rabbit Hole. The callback saves the access token and refresh token under `data/tidal-profile-token.json`, which is ignored by Git. `TIDAL_PROFILE_MIXES_ENDPOINT` is optional and can override the default profile page endpoints if TIDAL changes the page route. `TIDAL_PROFILE_ARTIST_RADIO_FALLBACK=true` can synthesize artist radio cards from official mix artists, but leave it false when Rabbit Hole should mirror only what TIDAL returns.

Optional discovery enrichment:

```env
RABBIT_HOLE_MUSICBRAINZ=true
LASTFM_LOOKUP=true
LASTFM_API_KEY=
LASTFM_USERNAME=
LASTFM_HISTORY_LIMIT=200
LASTFM_TOP_ARTIST_LIMIT=50
LASTFM_TOP_ARTIST_PERIOD=12month
LASTFM_TIMEOUT_MS=3500
DISCOGS_TOKEN=
SPOTIFY_ARTWORK_LOOKUP=false
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=
```

`LASTFM_API_KEY` lets Rabbit Hole call Last.fm. `LASTFM_USERNAME` is also required if you want the app to check recent scrobbles, avoid recent repeats, and use long-term top artists as a light taste signal. `LASTFM_TOP_ARTIST_PERIOD` defaults to `12month`.

Optional HQPlayer status line:

```env
HQPLAYER_SIGNAL_PATH_PREFIX=poly-sinc-gauss-hires-mp, TPDF, PCM
HQPLAYER_SIGNAL_PATH_STATIC=
HQPLAYER_RATE_COMMAND="C:\Program Files\Signalyst\HQPlayer 5 Desktop\hqp5-control.exe" localhost --state
HQPLAYER_PTY_WORKER=
HQPLAYER_SIGNAL_PATH_POLL_MS=60000
```

## Local State

The app creates local runtime files while you use it:

- `config.json`: Roon pairing token and paired core id
- `data/`: listening history, ratings, saved candidates, session cache, graph cache
- `*.log`: local server logs

These are intentionally ignored by Git because they are personal and machine-specific. `config.example.json` is included only as a placeholder shape.

## GitHub Safety

Before pushing, run:

```powershell
npm run check
git status --short
```

Do not commit:

- `.env`
- `config.json`
- `data/`
- `node_modules/`
- `blobs/`
- `manifests/`
- `*.log`
- `.codex-remote-attachments/`

The `.gitignore` is set up to exclude those by default.

## Useful Commands

```powershell
npm start
npm run check
```

## Notes

Roon's public API is powerful for browsing, transport, now-playing state, and queue actions, but durable playlist management and full TIDAL playlist writes may be limited. This project focuses on discovery, verification, scoring, and queueing first.

Primary references:

- Roon JavaScript API: https://github.com/RoonLabs/node-roon-api
- Roon Browse API docs: https://roonlabs.github.io/node-roon-api/RoonApiBrowse.html
- TIDAL Developer Portal: https://developer.tidal.com/
- TIDAL API SDK overview: https://developer.tidal.com/documentation/api-sdk/api-sdk-overview
