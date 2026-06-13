# The Rabbit Hole - Project Status

Last updated: 2026-06-12

This repo is the local Roon/TIDAL/LLM discovery app called **The Rabbit Hole**. It runs as a Node.js web app at `http://localhost:3777` and talks to:

- Roon Core via `node-roon-api`
- TIDAL via configured API credentials
- Local or remote LLM provider via `src/llmClient.js`
- Optional metadata sources: Last.fm, Discogs, MusicBrainz-style lookups, radio metadata enrichment

## Current Runtime Setup

The app is currently configured to use LM Studio through an OpenAI-compatible endpoint:

```env
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=http://127.0.0.1:1234/v1
LLM_MODEL=qwen/qwen3.6-35b-a3b
LLM_API_KEY=
```

The LM Studio local server should be running on port `1234`, with `qwen/qwen3.6-35b-a3b` loaded. The app now checks `/api/llm-status` and should show whether the local model is actually reachable and loaded instead of always showing a green "Local model" indicator.

Do not commit `.env`. Use `.env.example` for public config examples only.

## How To Start

From this folder:

```powershell
npm start
```

Then open:

```text
http://localhost:3777
```

For phone/tablet access, use the LAN/Tailscale URL shown in the app. The server listens on `0.0.0.0:3777`.

If port `3777` is already in use, another copy is already running. Either use the running app or stop the listener before restarting.

## What Works Now

- Roon extension connection and authorization.
- Roon output zone picker.
- Roon now-playing display with album art.
- Roon controls: previous, play/pause, stop, next, seek.
- Live Roon queue display.
- Current track is filtered out of the Rabbit Hole queue view when it appears as the now-playing item.
- Queue actions:
  - Add all to queue
  - Add all next / top-ish queue behavior where Roon exposes an Add Next action
  - Add individual tracks
  - Add individual tracks next
- TIDAL search and metadata verification.
- TIDAL-first discovery with Roon used as verifier/playback engine.
- Local LLM search-strategy planning for normal discovery searches.
- Strict year/date catalogue searches avoid LLM hallucinated dates.
- Release date filters:
  - Today
  - Yesterday
  - Last 7 Days
  - Last 30 Days
  - Last 90 Days
  - This Year
  - Exact Date
  - Date Range
- Discovery scoring with readable badges.
- Minimum match picker.
- Taste profile ratings:
  - Love = +3
  - Good = +1
  - OK = +0.5
  - Skip = -1
  - Never Again = -3
- Candidate saves affect taste lightly through the candidate signal system.
- Persistent track memory and taste memory.
- Separate generated list ("Current Rabbit Hole") and saved list ("Playlist Candidates").
- Cross-device UI updates through the event stream.
- Rabbit Hole graph for current tracks, with cached artist/label/related-entity exploration.
- Radio metadata resolver for live/radio titles.
- Radio program titles should not be treated as exact catalogue tracks when they look like long shows or station programs.

## Current LLM Behavior

Normal discovery now asks the configured LLM for a search plan, not final track recommendations. The model returns target genres, vibe terms, seed artists, candidate artists, candidate labels, and search query ideas. The app then searches TIDAL/Roon and only real catalogue results can become output tracks. This is the controlled "give the model access to TIDAL" pattern: the model steers the search, while TIDAL/Roon remain the source of truth.

The current intended discovery pipeline is:

1. User prompt and explicit filters
2. LLM search-plan generation
3. TIDAL catalogue candidate generation
4. Metadata/semantic filtering
5. Prompt-match and taste-match scoring
6. Roon queueability verification
7. Roon queue/playback actions

Roon should not be the primary discovery engine. Roon is the verifier and playback layer.

This should cause LM Studio GPU activity when generating a playlist. If Task Manager only moves when chatting directly in LM Studio but not when pressing Generate, check:

1. `/api/llm-status`
2. `LLM_PROVIDER`
3. `LLM_BASE_URL`
4. `LLM_MODEL`
5. Response verification fields: `modelPlan`, `modelPlanQueryCount`, `modelProvider`, `modelName`, and `modelError`
6. Server logs for timeout information

Year/date strict searches still rely on catalogue metadata for release dates. The model can propose search strategy for a date-limited run, but it is not trusted for dates or availability.

## Recent Important Changes

- Added real LLM health detection instead of static "Local model" green status.
- Added LM Studio/OpenAI-compatible flow to the discovery pipeline.
- Replaced LLM track-name generation with LLM search planning so the model cannot hallucinate unavailable tracks into the results.
- Increased LLM timeout for model planning.
- Added context/token-limit messaging in the UI for model failures.
- Added Roon query generation from LLM candidates.
- Added prompt-vs-taste explanation for result cards:
  - Prompt Match percentage
  - Taste Match percentage
  - Inferred genre/lane
  - Human-readable reason bullets
- Added broader genre discovery behavior so non-progressive genres are not punished as hard by a progressive-heavy taste profile.
- Added release date filters down to exact day.
- Reduced HQPlayer polling and cached filter/rate to avoid playback pops.
- Added OK rating.
- Added "Add Next" style queue controls.

## Known Issues

- Discovery can still return fewer tracks than requested when strict Roon queueable matching and high minimum score filters are active.
- Roon/TIDAL matching is still the hardest part. Roon may find a track manually but not expose a queue action through the same Browse API path.
- Queue count/time can disagree with Roon's own UI, especially around the currently playing item and queue subscription updates.
- Some generated searches still over-focus on a few artists or labels if the taste profile is narrow.
- Artist normalization still needs cleanup for names like `D-Nox`; it previously split into `D` and `Nox`.
- Genre-only searches need more testing across tech house, rock, 80s, trance, and non-progressive genres.
- Radio metadata is improved but still needs edge-case testing for long DJ shows and station titles.
- GitHub push failed because the remote repo URL was not found or the repo had not been created yet.

## Git State

At handoff time, there were modified app files in the worktree. Do not reset or discard them unless the user explicitly asks.

The initial commit was made earlier, but the remote push failed with:

```text
remote: Repository not found.
fatal: repository 'https://github.com/darthspaders/RoonAI.git/' not found
```

Likely next step: create the GitHub repo or correct the remote URL, then push again.
