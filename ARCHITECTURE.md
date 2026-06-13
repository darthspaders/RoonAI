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
  |     TIDAL catalogue search, track metadata, album art, release dates
  |
  |-- src/llmClient.js
  |     Ollama, OpenRouter, or OpenAI-compatible/LM Studio search planning
  |
  |-- src/discoveryEngine.js
  |     Candidate expansion, filtering, scoring, metadata rules
  |
  |-- src/tasteProfile.js
  |     Love/Good/OK/Skip/Never Again taste weighting
  |
  |-- src/trackMemory.js
  |     Remembered suggestions and anti-repeat memory
  |
  |-- src/savedPlaylist.js
  |     Playlist Candidates persistence
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

- Header and model/Roon status pills
- Now Playing tab
- History Report tab
- Roon Output Zone picker
- Now Playing card
- Rating controls
- Discovery score badge
- Jump to track
- Add candidate
- Open Rabbit Hole
- Playback controls
- Live queue
- Playlist builder
- Current Rabbit Hole results
- Playlist Candidates

The app uses `EventSource` against `/api/events` so multiple devices can update when now-playing, queue, feedback, or saved candidates change.

## Server

`src/server.js` is the main HTTP server. It serves static UI files and exposes JSON endpoints.

Important endpoints:

- `GET /api/state`
- `GET /api/events`
- `GET /api/llm-status`
- `POST /api/ai/playlist`
- `POST /api/feedback`
- `POST /api/saved-playlist`
- `POST /api/saved-playlist/remove`
- `POST /api/roon/control`
- `POST /api/roon/queue-tracks`
- `POST /api/roon/queue-check`
- `GET /api/roon/image/:imageKey`
- `POST /api/rabbit-hole`

## Roon Module

`src/roonClient.js` owns:

- Roon extension startup and authorization
- Zone discovery
- Now-playing updates
- Queue subscription
- Roon browse/search
- Playback actions
- Queue/add-next action resolution
- Roon-first discovery helpers

Roon matching is not just "is this in TIDAL". It needs a Roon Browse API item that exposes a playable or queueable action for the selected zone.

## TIDAL Module

`src/tidalVerifier.js` owns:

- Track search
- Metadata retrieval
- Release year/date parsing
- Album art URL handling
- TIDAL verification status

TIDAL is good at catalogue metadata, but queue/play still goes through Roon so Roon can play it in the selected zone.

## LLM Module

`src/llmClient.js` supports:

- Ollama
- OpenRouter
- OpenAI-compatible servers such as LM Studio

Normal discovery flow:

1. User gives prompt, genre, mood, year/date filters, track count, seed playlist/current track.
2. Server calls `generateSearchPlan()`.
3. LLM returns a JSON search plan: target genres, vibe terms, seed artists, candidate artists, labels, and query ideas.
4. The app searches TIDAL using that plan and explicit filters.
5. TIDAL metadata is treated as the authority for title, artist, album, release date, artwork, and catalogue identity.
6. Metadata/semantic/SEO filtering removes obvious misses, weak catalogue filler, date misses, duplicates, and prior suggestions when requested.
7. Scoring separates prompt fit from taste fit.
8. Roon verifies that the track can actually be queued/played in the selected output zone.
9. UI displays only verified/queueable results when strict mode is active.

The model should not invent final tracks. It can suggest where and how to look, then the app verifies every output against real catalogue results.

Roon should not be used as the primary discovery engine. Use Roon for now-playing context, playlist/queue context, playback control, queueability verification, and queue actions.

Strict date/year catalogue flow:

- Avoids trusting LLM release dates.
- May use the LLM search plan for query expansion.
- Uses catalogue metadata and filters by exact parsed release date/year.

## Scoring

Discovery score is based on:

- Freshness: 19
- Label Match: 19
- Artist Match: 19
- Length Preference: 19
- Genre Match: 24
- Taste Adjustment: separate bump/penalty from feedback profile

Each result also exposes:

- Prompt Match: how strongly the candidate follows the current prompt, filters, genre/vibe, seed artists, labels, release window, and length preference.
- Taste Match: how strongly the candidate matches learned Love/Good/OK/Skip/Never Again/candidate signals.
- Inferred Genre: a readable lane such as `Progressive Tech House`.
- Why: a short explanation of whether the result came from prompt intent, taste profile, or the overlap between both.

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
- Skip: -1
- Never Again: -3

It updates artist, label, and track tendencies. Simply playing a track should not count as a like because the user often falls asleep to music. Played history is useful as context, but feedback is the explicit signal.

`src/trackMemory.js` stores suggestion memory so the app can avoid repeating the same tracks across searches.

## Rabbit Hole Graph

`src/rabbitHoleGraph.js` builds a cached graph for the current track:

- Depth 1: Artist
- Depth 2: Collaborators and Remixers
- Depth 3: Frequent / Similar Labels
- Depth 4: Similar Artists
- Depth 5: Hidden Gems

Sources include TIDAL metadata, local queue/history, liked tracks, saved candidates, Last.fm/Discogs where configured, and fallback local relationships.

The graph should generate actionable prompts, not placeholder text.

## HQPlayer

`src/hqplayerStatus.js` reads HQPlayer filter/rate, caches it, and avoids frequent polling during playback. Keep this conservative because the user reported audio pops.

Rules to preserve:

- Now-playing updates no faster than about every 2 seconds.
- HQPlayer filter/rate no faster than 5-10 seconds, preferably much slower during playback.
- Cache last known rate/filter.
- Only update UI when values change.
- Do not trigger playback, resync, or zone refresh commands from watchers.
