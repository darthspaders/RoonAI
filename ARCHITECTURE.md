# The Rabbit Hole - Architecture

## High-Level Flow

```text
Browser UI
  |
  | HTTP + EventSource
  v
src/server.js
  |
  |-- src/roonClient.js
  |     Roon Core, zones, now playing, queue, browse/search, playback controls
  |
  |-- src/tidalVerifier.js
  |     TIDAL catalogue search, metadata, artwork, release dates, request guard
  |
  |-- src/tidalProfileAuth.js
  |     TIDAL OAuth start/callback/refresh token flow
  |
  |-- src/tidalProfileMixes.js
  |     Official TIDAL profile mixes/radios exposed by OAuth
  |
  |-- src/tidalPinnedMixes.js
  |     User-pinned TIDAL mix/radio/playlist URLs for hidden mobile-only shelves
  |
  |-- src/llmClient.js
  |     Ollama, OpenRouter, or OpenAI-compatible/LM Studio search planning
  |
  |-- src/discoveryEngine.js
  |     Candidate crawl, filtering, lane quotas, scoring, diagnostics
  |
  |-- src/musicOntology.js
  |     Controlled genre/vibe/characteristic vocabulary and aliases
  |
  |-- src/queryYieldTracker.js
  |     Query-template success/failure memory and pruning
  |
  |-- src/tasteProfile.js
  |     Love/Good/OK/Wrong Genre/Skip/Never Again taste weighting
  |
  |-- src/discoveryHistory.js / src/trackMemory.js
  |     Suggestion memory, novelty checks, rejected/wrong-genre history
  |
  |-- src/savedPlaylist.js
  |     Multiple named candidate lists
  |
  |-- src/rabbitHoleGraph.js
  |     Artist/label/remixer/similar-artist/hidden-gem graph
  |
  |-- src/radioMetadataResolver.js
  |     Radio title parsing and optional catalogue enrichment
  |
  |-- src/hqplayerStatus.js
        HQPlayer filter/rate cache
```

## Frontend

Main files:

- `public/index.html`
- `public/app.js`
- `public/styles.css`

The browser UI shows:

- Header/banner and Roon/model/Last.fm/TIDAL status cards
- Now Playing tab
- History Report tab
- TIDAL Mixes & Radio / pinned TIDAL items page
- Roon Output Zone picker
- Now Playing player, full-window player, wake-lock support
- Rating controls and wrong-genre feedback
- Discovery score badge
- Jump to track, add candidate with list selection, jump to candidates, open Rabbit Hole
- Playback controls and live queue
- Playlist builder and current Rabbit Hole results
- Multiple named candidate lists with move/remove/queue actions
- Intent Parsed and Pool Diagnostics cards

The app uses `EventSource` against `/api/events` so multiple devices update when now-playing, queue, feedback, discovery state, or saved candidates change.

## Server

`src/server.js` is the main HTTP server. It serves static UI files and exposes JSON endpoints.

Important endpoints include:

- `GET /api/state`
- `GET /api/events`
- `GET /api/llm-status`
- `POST /api/ai/playlist`
- `POST /api/feedback`
- `POST /api/saved-playlist`
- `POST /api/saved-playlist/remove`
- `POST /api/saved-playlist/move`
- `POST /api/roon/control`
- `POST /api/roon/queue-tracks`
- `POST /api/roon/queue-check`
- `GET /api/roon/image/:imageKey`
- `POST /api/rabbit-hole`
- `GET /api/tidal/oauth/start`
- `GET /api/tidal/oauth/callback`
- `GET /api/tidal/mixes`
- `POST /api/tidal/mixes/refresh`
- `POST /api/tidal/pinned`
- `POST /api/tidal/pinned/remove`
- `POST /api/tidal/queue-playlist`

## Roon Module

`src/roonClient.js` owns:

- Roon extension startup and authorization
- Zone discovery
- Now-playing updates
- Queue subscription
- Roon browse/search
- Playback actions
- Queue/add-next action resolution
- Deep search/fallback query shapes for exact queueable matches

Roon matching is not just "is this in TIDAL". The app needs a Roon Browse API item that exposes a playable or queueable action for the selected zone. The queue path now tries multiple query shapes, including title-first, artist-title, and album/title variants, before giving up.

## TIDAL Catalogue Module

`src/tidalVerifier.js` owns:

- Track search
- Metadata retrieval
- Release year/date parsing
- Album art URL handling
- TIDAL verification status
- Per-request timeout and circuit-breaker behavior through `src/tidalRequestGuard.js`

TIDAL catalogue metadata is usually better than Roon search for candidate discovery, but Roon remains the playback layer unless the user uses the TIDAL playlist bridge.

## TIDAL Profile / Mixes

`src/tidalProfileAuth.js` handles OAuth:

- Start URL
- Callback exchange
- Token refresh
- Durable token storage in ignored `data/tidal-profile-token.json`

`src/tidalProfileMixes.js` reads official profile mix relationships exposed by the current OAuth API. It can show My Mix, Daily Discovery, New Arrivals, and any other profile relationships TIDAL exposes to the granted scopes.

`src/tidalPinnedMixes.js` stores user-pinned TIDAL URLs. This is the workaround for mobile-only shelves such as some Artist Radio cards that are visible in the TIDAL app but not exposed through current third-party OAuth.

The TIDAL queue bridge creates/updates a temporary TIDAL playlist from generated or saved candidates so the user can open/import/queue the list in TIDAL or Roon. It should be treated as a convenience bridge, not the source of truth for discovery quality.

## LLM Module

`src/llmClient.js` supports:

- Ollama
- OpenRouter
- OpenAI-compatible servers such as LM Studio

Normal discovery flow:

1. User gives prompt, genre, mood, year/date filters, track count, seed playlist/current track.
2. Server parses intent with controlled ontology aliases.
3. Server calls `generateSearchPlan()`.
4. LLM returns JSON search plan: target genres, vibe terms, seed artists, candidate artists, labels, and query ideas.
5. The app searches TIDAL using that plan and explicit filters.
6. Metadata/semantic/SEO filtering removes obvious misses, weak catalogue filler, date misses, duplicates, artist collisions, and prior suggestions.
7. Scoring separates prompt fit from taste fit.
8. Roon verifies queueability when strict playback output is needed.

The model should not invent final tracks. It can suggest where and how to look; TIDAL/Roon verify every output.

## Discovery Engine

`src/discoveryEngine.js` is the heart of the app:

- Builds query families from prompt intent, model plan, seed artist, labels, history, similar artists, and saved/listened context.
- Uses `src/musicOntology.js` to keep genre, vibe, era, length, artist/label, and track characteristics separate.
- Applies SEO sludge filters, exact artist collision checks, date/year filters, duplicate filters, prior-suggestion memory, and wrong-genre feedback.
- Infers genre from multiple weak signals rather than trusting official `Electronic` tags.
- Uses lane quotas to reserve room for core prompt, adjacent, label, taste, and branch-out candidates.
- Uses query-yield memory to rank or skip query templates that have repeatedly produced poor results.
- Produces Pool Diagnostics for the UI.

Pool Diagnostics should help answer:

- How many candidates were generated, kept, and discarded?
- Which rejection reasons dominated?
- Did runtime run out?
- Which lanes were starved?
- Which query families were skipped?
- Were below-minimum candidates available?

## Scoring

Discovery score is based on prompt fit plus supporting evidence:

- Freshness
- Label Match
- Artist Match
- Length Preference
- Genre Match
- Taste Adjustment

Each result also exposes:

- Prompt Match: how strongly the candidate follows the current request.
- Taste Match: how strongly it matches learned preferences.
- Inferred Genre: the best current genre lane.
- Why: short explanation of the evidence.
- Risk: weak genre evidence, date uncertainty, SEO risk, artist collision, or below-floor rescue.

Score bands:

- 90+ Excellent
- 80-89 Strong
- 70-79 Worth checking
- 60-69 Experimental
- Below 60 Long shot

## Taste Memory

`src/tasteProfile.js` stores feedback signals:

- Love: +3
- Good: +1
- OK: +0.5
- Wrong Genre: genre/prompt rejection signal
- Skip: -1
- Never Again: -3

Played history is context, not a like. The user often lets music run, so explicit feedback carries more weight than passive plays.

Taste Guided should remain discovery-oriented: use taste as a compass, not a cage. Pure Search should follow the prompt even when it disagrees with learned taste.

## Rabbit Hole Graph

`src/rabbitHoleGraph.js` builds a cached graph for the current track:

- Depth 1: Artist
- Depth 2: Collaborators and remixers
- Depth 3: Frequent/similar labels
- Depth 4: Similar artists
- Depth 5: Hidden gems

Sources include TIDAL metadata, local queue/history, liked tracks, saved candidates, Last.fm/Discogs where configured, and fallback local relationships.

The graph should generate actionable prompts and branch-out seeds, not placeholder text.

## HQPlayer

`src/hqplayerStatus.js` reads HQPlayer filter/rate, caches it, and avoids frequent polling during playback. Keep this conservative because the user reported audio pops.

Rules to preserve:

- Now-playing updates no faster than about every 2 seconds.
- HQPlayer filter/rate no faster than 5-10 seconds, preferably slower during playback.
- Cache last known rate/filter.
- Only update UI when values change.
- Do not trigger playback, resync, or zone refresh commands from watchers.
