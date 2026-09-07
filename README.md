# The Rabbit Hole

The Rabbit Hole is a local-first music discovery assistant for Roon. It connects to a local Roon Core as an extension, reads now-playing and queue state, searches Roon/TIDAL for playable tracks, and uses a local or remote LLM to help plan discovery searches.

The app is built around discovery first: generate candidates, verify them, score them, rate them, save candidates, queue them in Roon, or send them to a temporary TIDAL playlist. The model proposes search plans; the app verifies real catalogue/playback results.

## Features

- Local web UI at `http://localhost:3777`
- Roon extension pairing through `Roon Settings -> Extensions`
- Roon zone selection, transport controls, queue view, and now-playing display
- TIDAL verification, artwork lookup, profile OAuth, playlist writes, and pinned Mixes & Radio items when credentials are configured
- Local Ollama, LM Studio/OpenAI-compatible, or OpenRouter LLM support
- Optional OpenRouter fallback
- Optional Last.fm, Discogs, MusicBrainz, and Spotify enrichment
- Discovery scoring, feedback memory, standby discoveries, TIDAL queue bridge, CSV/text export
- Repeat suppression across TIDAL id, URL, and normalized artist/title history aliases
- Asynchronous metadata enrichment for radio/local tracks without blocking playback UI
- Rabbit Hole graph for artists, labels, remixers, collaborators, and hidden-gem prompts
- Server-side MCP endpoint at `/mcp` for normal ChatGPT Developer Mode

## Requirements

- Node.js 18 or newer
- Roon Server/Core on the same network
- Roon client access to approve the extension
- Ollama, LM Studio, or another OpenAI-compatible local LLM server
- Optional API credentials for TIDAL, Last.fm, Discogs, Spotify, or OpenRouter

## Quick Start

```powershell
Copy-Item .env.example .env
npm install
npm start
```

Open `http://localhost:3777`, then approve **The Rabbit Hole** in `Roon Settings -> Extensions`. If using LM Studio, start its local server before generating discoveries.

To access it from a phone or tablet on the same network, use the LAN URL shown in the app, usually something like:

```text
http://192.168.x.x:3777
```

## Configuration

Edit `.env` after copying `.env.example`.

Core local mode with Ollama:

```env
PORT=3777
HOST=0.0.0.0
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=llama3.1:8b
```

Current stronger local model mode with LM Studio or llama.cpp:

```env
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=http://127.0.0.1:1234/v1
LLM_MODEL=qwen/qwen3.6-35b-a3b
LLM_API_KEY=
LLM_PLANNING_TIMEOUT_MS=60000
```

In LM Studio, load the Qwen model, start the local server on port `1234`, and copy the served model name into `LLM_MODEL` if it differs from the example. Local reasoning models can need extra time before they emit JSON, so raise `LLM_PLANNING_TIMEOUT_MS` if planning still times out.

Optional Synapse/OpenAI second brain:

In this repo, **Synapse** is Rabbit Hole's name for the optional OpenAI/ChatGPT-backed reasoning layer. It is not a separate music provider or queue engine; it is the cloud model path Rabbit Hole can use for planning, reviewing, ranking, and tool-calling when local mode is not enough.

```env
AI_MODE=auto
OPENAI_ENABLED=true
OPENAI_API_KEY=
OPENAI_DEFAULT_TIER=luna
OPENAI_MODEL=gpt-5.6-luna
OPENAI_LUNA_MODEL=gpt-5.6-luna
OPENAI_TERRA_MODEL=gpt-5.6-terra
OPENAI_SOL_MODEL=gpt-5.6-sol
OPENAI_MAX_OUTPUT_TOKENS=1200
OPENAI_REASONING_EFFORT=
OPENAI_TIMEOUT_MS=60000
OPENAI_HEALTH_TIMEOUT_MS=6000
OPENAI_RETRY_COUNT=1
OPENAI_RETRY_DELAY_MS=750
OPENAI_MAX_TOOL_ROUNDS=6
OPENAI_MAX_ESCALATION_ATTEMPTS=3
```

`AI_MODE` can be `local`, `synapse`, or `auto`. The UI exposes **LOCAL**, **AUTO**, and the Synapse tiers **LUNA**, **TERRA**, and **SOL**, plus an editable Synapse model field. `/local`, `/auto`, `/luna`, `/terra`, `/sol`, and `/synapse` prefixes on model-chat requests override the current mode for that request.

Rabbit Hole keeps LM Studio as the local-first model path. Synapse/OpenAI is isolated behind the model router and uses one OpenAI Responses API provider with three model tiers:

- **Luna**: default cloud tier for normal discovery, request interpretation, candidate validation, ranking, moderate tool workflows, and summaries.
- **Terra**: deeper preference analysis, larger feedback/history context, difficult comparisons, and larger multi-stage discovery.
- **Sol**: hardest reasoning, Rabbit Hole debugging, architecture/algorithm analysis, major preference-model reconstruction, or explicit maximum-reasoning requests.

All Synapse tiers reuse the same OpenAI client, tool schema, MCP/tool execution loop, conversation state, preference data, and usage ledger. Only the selected model/tier changes. When Synapse needs to act, it calls Rabbit Hole tools such as `get_rabbit_hole_status`, `rate_now_playing`, `control_roon`, `search_rabbit_hole`, `queue_rabbit_hole_tracks`, and `refresh_standby_pool`; those tools route back through the existing Roon, TIDAL, discovery, history, and standby handlers. Roon and TIDAL business logic is not duplicated in the OpenAI provider.

AUTO mode is cost-aware and conservative. Routine commands such as "what's playing", transport control, feedback, simple database lookups, simple search, and standby refresh stay local. Normal discovery and candidate ranking use Luna. Deeper preference/history analysis escalates to Terra. Sol is reserved for difficult debugging, architecture, major reconstruction, or explicit hard-reasoning requests. If a Synapse tier fails with an API/tool/validation problem, Rabbit Hole can walk upward through the bounded ladder `Luna -> Terra -> Sol`. It does not escalate just because an answer is not your favorite. If Synapse is unavailable or budget-limited, Rabbit Hole falls back to local mode and keeps controls usable.

The top status area shows separate live indicators for:

- Roon connection
- Local model / LM Studio
- Rabbit Hole MCP
- Synapse/OpenAI
- Active provider and fallback state

The Synapse indicator is based on actual backend state, not just `OPENAI_ENABLED`. Rabbit Hole updates it after OpenAI requests and uses a cheap `/v1/models/<model>` health check when you press **Check** or when the UI requests a refresh. It never exposes `OPENAI_API_KEY` to the browser.

Optional cost/budget logging:

```env
OPENAI_MAX_COST_PER_REQUEST=
OPENAI_DAILY_BUDGET=
OPENAI_MONTHLY_BUDGET=
OPENAI_LUNA_DAILY_BUDGET=
OPENAI_TERRA_DAILY_BUDGET=
OPENAI_SOL_DAILY_BUDGET=
OPENAI_INPUT_COST_PER_1M=
OPENAI_CACHED_INPUT_COST_PER_1M=
OPENAI_OUTPUT_COST_PER_1M=
OPENAI_LUNA_INPUT_COST_PER_1M=
OPENAI_LUNA_OUTPUT_COST_PER_1M=
OPENAI_TERRA_INPUT_COST_PER_1M=
OPENAI_TERRA_OUTPUT_COST_PER_1M=
OPENAI_SOL_INPUT_COST_PER_1M=
OPENAI_SOL_OUTPUT_COST_PER_1M=
OPENAI_USAGE_FILE=
```

Token usage is logged for OpenAI calls by tier and model: calls, input tokens, cached input tokens, output tokens, tool calls, latency, and estimated spend. Dollar estimates are only calculated when you provide per-1M token rates, so pricing can be updated without code changes. `OPENAI_USAGE_FILE` defaults to `data/openai-usage.json`, which is ignored by Git.

Optional normal ChatGPT MCP bridge:

```env
RABBIT_HOLE_MCP_BASE_URL=http://127.0.0.1:3777
RABBIT_HOLE_MCP_TOKEN=
RABBIT_HOLE_MCP_TIMEOUT_MS=120000
```

Rabbit Hole serves MCP over HTTP at `/mcp`. With the public bridge tunnel running, add `https://art.darthspader.com/mcp` as a ChatGPT Developer Mode MCP server. If you set `RABBIT_HOLE_MCP_TOKEN`, configure ChatGPT to send `Authorization: Bearer <token>` when connecting. Leave the token blank only when the tunnel is private or otherwise trusted, because the MCP tools can queue music and write TIDAL playlists.

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
TIDAL_PROFILE_REDIRECT_URI=
TIDAL_PROFILE_SCOPES=user.read playlists.read playlists.write recommendations.read collection.read collection.write search.read
TIDAL_PROFILE_ACCESS_TOKEN=
TIDAL_PROFILE_REFRESH_TOKEN=
TIDAL_PROFILE_MIXES_ENDPOINT=
TIDAL_PROFILE_ARTIST_RADIO_FALLBACK=false
```

`TIDAL_PROFILE_ACCESS_TOKEN` must be a user-profile bearer token. The normal catalog/client-credentials token can search tracks, but it cannot read personal mixes such as My Mix, Daily Discovery, New Arrivals, Track Radio, or Artist Radio. TIDAL's full mobile-style Mixes & Radio shelf currently requires a legacy profile scope that normal third-party OAuth may not grant, so Rabbit Hole shows only the official profile mix relationships when that scope is unavailable. For the durable setup, leave `TIDAL_PROFILE_REDIRECT_URI` blank so Rabbit Hole can use the host you opened it from, then add the matching callback URL in the TIDAL developer portal, for example `http://192.168.50.119:3777/api/tidal/oauth/callback` or `http://100.x.x.x:3777/api/tidal/oauth/callback`. Open `/api/tidal/oauth/start` from Rabbit Hole on the same host. The callback saves the access token and refresh token under `data/tidal-profile-token.json`, which is ignored by Git. `TIDAL_PROFILE_REDIRECT_URI` can still pin one exact callback when needed. `TIDAL_PROFILE_MIXES_ENDPOINT` is optional and can override the default profile page endpoints if TIDAL changes the page route. `TIDAL_PROFILE_ARTIST_RADIO_FALLBACK=true` can synthesize artist radio cards from official mix artists, but leave it false when Rabbit Hole should mirror only what TIDAL returns.

Rabbit Hole keeps its own local music memory in `data/rabbit-hole-memory.sqlite`. This is separate from provider reference data: TIDAL/Roon remain track identity authority, while Beatport, MusicBrainz, and Discogs are enrichment evidence. Rabbit Hole can also enrich broad TIDAL/Roon metadata with a local MusicBrainz JSON-dump index before using the public MusicBrainz API fallback. Build it with `npm run import:musicbrainz -- C:\path\to\extracted\musicbrainz-json-dumps`, then set `MUSICBRAINZ_LOCAL_INDEX=true`. See [docs/musicbrainz-local-index.md](docs/musicbrainz-local-index.md).

Beatport metadata lookup is available as an experimental, read-only enrichment source for electronic releases. It stays disabled until a valid Beatport OAuth access token is configured:

```env
BEATPORT_ENABLED=false
BEATPORT_EXPERIMENTAL_PUBLIC_CLIENT=true
BEATPORT_CLIENT_ID=0GIvkCltVIuPkkwSJHp6NDb3s0potTjLBQr388Dd
BEATPORT_ACCESS_TOKEN=
BEATPORT_REFRESH_TOKEN=
BEATPORT_BASE_URL=https://api.beatport.com/v4
BEATPORT_REQUESTS_PER_SECOND=2
BEATPORT_MISSING_RETRY_MS=604800000
```

To save browser-copied OAuth JSON locally:

```powershell
npm run beatport:token
```

Paste the full JSON response from Beatport's `/auth/o/token/` request. Rabbit Hole saves it to `data/beatport-token.json`, which is ignored by Git. When a refresh token is present, Rabbit Hole will attempt to refresh the access token before metadata lookup. Beatport requests are throttled through the client at 2 requests/sec by default, cache successful enrichment reads, back off on rate-limit responses, and remember misses until `BEATPORT_MISSING_RETRY_MS` expires so non-EDM tracks are not repeatedly queried.

When Beatport is enabled, Rabbit Hole also runs a conservative background fill for older music-memory tracks that predate Beatport integration. It reads the local Rabbit Hole memory DB first, skips tracks that already have Beatport enrichment, and fills missing Beatport genre/BPM/key/release evidence in small batches without blocking playback:

```env
BEATPORT_MEMORY_BACKFILL=true
BEATPORT_MEMORY_BACKFILL_BATCH_SIZE=25
BEATPORT_MEMORY_BACKFILL_INTERVAL_MS=300000
BEATPORT_MEMORY_BACKFILL_DELAY_MS=2000
```

Beatport remains enrichment only; TIDAL/Roon identity and queue behavior are unchanged.

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
ROONPRESENCE_NOW_STATE_URL=http://127.0.0.1:8787/now-state
ROONPRESENCE_NOW_STATE_TIMEOUT_MS=1200
SPOTIFY_ARTWORK_LOOKUP=false
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=
```

`LASTFM_API_KEY` lets Rabbit Hole call Last.fm. `LASTFM_USERNAME` is also required if you want the app to check recent scrobbles, avoid recent repeats, and use long-term top artists as a light taste signal. `LASTFM_TOP_ARTIST_PERIOD` defaults to `12month`.

Metadata enrichment runs asynchronously for now-playing tracks. Roon metadata is used first. If duration, release year, label, genre, album, or artwork is missing, Rabbit Hole can look up TIDAL and cache the successful result under `data/metadata-enrichment-cache.json`. Low-confidence matches are not displayed.

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
npm test
npm audit --audit-level=moderate
```

## Notes

Roon's public API is powerful for browsing, transport, now-playing state, and queue actions, but durable playlist management and full TIDAL playlist writes may be limited. This project focuses on discovery, verification, scoring, and queueing first.

Primary references:

- Roon JavaScript API: https://github.com/RoonLabs/node-roon-api
- Roon Browse API docs: https://roonlabs.github.io/node-roon-api/RoonApiBrowse.html
- TIDAL Developer Portal: https://developer.tidal.com/
- TIDAL API SDK overview: https://developer.tidal.com/documentation/api-sdk/api-sdk-overview

## Hard standby freshness

Manual Refresh requests a different discovery pool. Both manual and background refreshes now apply hard identity exclusions before Synapse review. Standby uses numeric TIDAL identity plus normalized artist/title/version aliases; distinct versions remain distinct. The last 10 standby refreshes are excluded regardless of age; suggestions, listening, ratings, queue observations and playlist additions have 30-day cooldowns. Clear removes the display, not history.

Configure STANDBY_COOLDOWN_REFRESHES (10), STANDBY_ACTIVITY_COOLDOWN_DAYS (30), STANDBY_SUGGESTED_COOLDOWN_DAYS (30), STANDBY_RAW_POOL_MULTIPLIER (4), and STANDBY_SEARCH_BUDGET_MS (120000) in .env and restart. For a target of 25, search aims for 100 raw candidates. Initial and four replacement source passes run within the search budget. Related TIDAL artist/album metadata is requested together for standby, and validated partial results survive pass timeouts. Freshness, score >=50 and existing bad-fit filters precede artist caps and review. One track per artist is preferred; at most two are admitted when replacement searches are exhausted. Album cap remains one.

Successful refreshes replace the pool even when empty; they never refill from rejected or prior-visible tracks. Synapse ranks the fresh shortlist for taste, duration, progressive/trance relevance, diversity, release freshness and quality. Invalid/failed review keeps that fresh local shortlist. Activity is checked again before review and commit. A failed refresh before commit may retain the prior display, with an explicit error and carryoverReason. A manual request during another refresh waits, then runs its own refresh.

Standby history is stored atomically with the pool in data/standby-candidates.json. At least 100 refreshes are retained regardless of age, plus all runs in the configured suggestion window. Queue and playlist activity is stored atomically in data/standby-activity.json; existing discovery, listening and taste stores supply other timestamps. Queue observations cover the visible Roon queue and Rabbit Hole queue operations. Previously unrecorded historical actions cannot be reconstructed.

Diagnostics are in app.standby.lastRun.diagnostics.novelty, including source exclusions, raw candidate count, artist caps, replacement passes, final count, new count and numeric carriedOver. The UI shows the actual fresh count/target and exhaustion reason. No repeat override bypasses manual freshness.
