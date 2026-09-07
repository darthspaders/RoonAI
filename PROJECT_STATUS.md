# The Rabbit Hole - Project Status

Last updated: 2026-08-05

This repo is the local Roon/TIDAL/LLM discovery app called **The Rabbit Hole**. It runs as a Node.js web app at `http://localhost:3777` and talks to:

- Roon Core via `node-roon-api`
- TIDAL catalogue APIs and optional TIDAL profile OAuth
- Local or remote LLM provider via `src/llmClient.js`
- Optional metadata sources: Last.fm, Discogs, MusicBrainz-style lookups, radio metadata enrichment

Do not commit `.env`. Use `.env.example` for public config examples only.

Current repo directory:

```text
C:\Users\spade\Documents\Codex\2026-06-07\the-rabbit-hole
```

## Current Runtime Setup

The app is currently expected to use LM Studio through an OpenAI-compatible endpoint:

```env
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=http://127.0.0.1:1234/v1
LLM_MODEL=qwen/qwen3.6-35b-a3b
LLM_API_KEY=
```

LM Studio should be running on port `1234` with `qwen/qwen3.6-35b-a3b` loaded. The UI calls `/api/llm-status` and should show green only when the local model endpoint is reachable.

Start the app from the repo directory above:

```powershell
npm start
```

Then open:

```text
http://localhost:3777
```

For phone/tablet access, use the LAN/Tailscale URL shown in the app. The server listens on `0.0.0.0:3777`.

## What Works Now

- Roon extension connection, authorization, zone picker, now-playing, queue display, transport controls, seek, and album art.
- Full-screen player mode, phone/tablet layout polish, larger artwork in landscape, and wake-lock support while in full-window player mode.
- Roon queue actions: queue all, add all next, individual queue/add next/play, and title-first fallback search when an exact Roon match is hard to find.
- TIDAL catalogue verification, metadata, artwork, release dates, and request timeout/circuit-breaker protection.
- Asynchronous now-playing metadata enrichment for radio/local tracks. Roon metadata wins first; missing duration, release year, label, genre, album, and artwork can be filled from TIDAL and cached locally.
- TIDAL profile OAuth with durable refresh token storage under ignored `data/tidal-profile-token.json`.
- TIDAL profile Mixes & Radio page for official profile mixes exposed by the current OAuth API.
- Pinned TIDAL items for hidden/mobile-only mix or radio URLs that the public OAuth API does not expose.
- TIDAL playlist writes: add the current track to an existing TIDAL playlist or create a new TIDAL playlist from the player.
- TIDAL queue bridge: generated and standby lists can be sent to a temporary TIDAL playlist for easier queueing/import workflows.
- Artist radio refresh logic that avoids re-adding the exact same queued/recent tracks where possible.
- Roon Radio page lists live radio stations, plays available stations, and supports local drag/tap reordering per radio folder.
- Last.fm public history/taste connection.
- Standby Discovery maintains a small background pool of ready-to-queue discoveries and now filters previously suggested tracks out of the visible standby pool.
- Feedback controls: Love, Good, OK, Wrong Genre, Skip, Never Again.
- Live radio tracks can be rated and remembered as taste signals.
- Rabbit Hole graph for current tracks, with cached artist/label/related-entity exploration.
- WebMCP bridge exposes Rabbit Hole status/search/queue/TIDAL/feedback tools when a browser tool runtime is available.
- Roon Presence companion improvements: current track appears in Discord presence, local file art fallback is improved, and HQPlayer filter/rate is read conservatively.
- PC temperature badges in full-window player mode when the local monitor endpoint is available.

## Discovery Pipeline

The model does not directly invent final tracks. It proposes a search plan, and the app searches/verifies real catalogue results.

Current intended flow:

1. User prompt, scoring mode, explicit filters, seed artist/playlist/current track.
2. Intent parser maps prompt into controlled genre, vibe, era/date, length, artist/label, and track-characteristic fields.
3. LLM generates a search plan: query ideas, seed artists, adjacent artists, labels, and related lanes.
4. TIDAL catalogue searches generate candidate pools.
5. Metadata, SEO, collision, date, duplicate, and wrong-genre filters prune the pool.
6. Genre inference combines weak official tags with labels, artist relationships, prompt intent, Last.fm/history, and feedback.
7. Discovery history and track identity aliases suppress repeats across TIDAL id, TIDAL URL, and normalized artist/title forms.
8. Discovery lane quotas keep a blend of core, adjacent, label, taste, and branch-out candidates.
9. Roon verifies that final results are actually playable/queueable in the selected zone.
10. The UI shows verified results, rejected counts, pool diagnostics, and queue outcomes.

Scoring modes:

- Taste Guided: default. Prompt first, taste as a soft guide.
- Pure Search: follow the prompt with minimal taste bias.
- Explore Mode: intentionally branch outside the known taste cluster.
- Similar Mode: lean heavily on liked artists/labels/tracks.

## Recent Important Changes

- Added controlled electronic music ontology so `progressive psytrance`, `psychedelic trance`, `progressive house`, `tech house`, and `melodic techno` do not collapse into the same bucket.
- Added Intent Parsed debug card with requested genre, vibe, vibe source, era/date, length, characteristics, artist seed, labels, scoring mode, learned taste strength, and progressive-bias state.
- Added Discovery Lane Quotas so one artist/label/taste source cannot monopolize a run.
- Added pool diagnostics: generated/kept/discarded, top rejection reasons, lane availability, query yield, skipped/pruned query families, runtime exhaustion, and below-minimum rescue notes.
- Added query-yield memory so bad query templates are ranked down or pruned on future crawls.
- Increased strict catalogue crawl runtime modestly and added conservative search parallelism/reserved budget per lane.
- Added broader artist crawl/branching so discovery can use similar artists without becoming only "more of the same".
- Added stronger Pure Search behavior so liked artists should not override explicit artist/prompt requests.
- Added exact artist audit option and better artist-collision handling for names shared by unrelated artists.
- Added better below-minimum handling: near-miss candidates can be shown when they are in the ballpark, but diagnostics explain why.
- Added wrong-genre feedback path separate from ordinary dislikes.
- Added TIDAL OAuth/profile mix tools and pinned TIDAL item import for hidden mobile-only mixes/radios.
- Replaced the old candidate-list infrastructure with TIDAL playlist actions, standby discovery, and direct queue/send workflows.
- Added radio station browser/play controls with local per-folder ordering.
- Added genre-profile feedback learning for niche child genres so weakly known requests can be promoted or pruned over time.
- Added a generated syntax-check runner so `npm run check` automatically covers new JS files under `src`, `public`, and `test`.
- Added shared artist identity handling for collision-sensitive artists and provider artist ids.
- Added now-playing metadata enrichment with persistent cache and bridged artwork fallback.
- Added stricter TIDAL playlist duplicate checks and playlist write safeguards.
- Added repeat suppression that recognizes tracks by TIDAL id, TIDAL URL, and normalized artist/title aliases.
- Added final freshness guard before manual generation results are shown.
- Changed standby refresh to replace the old candidate pool with a fresh pool instead of merging old high-score candidates back in.

## Known Issues / Watch Points

- Discovery can still return fewer tracks than requested when strict year/date, novelty, Roon queueability, and minimum-score filters all collide.
- Standby can go empty when the existing standby pool is all repeats and a fresh refresh cannot find enough unseen candidates. This is preferable to replaying stale tracks, but the next tuning pass should broaden standby's fresh-candidate sources.
- TIDAL/Roon matching remains difficult. Roon may find a track manually but not expose the same queueable action through Browse API search.
- Some TIDAL mobile-only shelves, especially the full Mixes & Radio shelf, appear to require legacy/private scopes not granted by normal third-party OAuth. Use pinned TIDAL URLs as a practical workaround.
- Genre inference is improving but still needs real-world tuning. Official genre tags are often just `Electronic`, so label/artist/radio/taste evidence must stay visible in diagnostics.
- Search can still over-focus on familiar artists if the prompt, seed, and learned taste all point to the same cluster. Lane quotas and artist identity memory help but need more tuning.
- Date filters rely on catalogue metadata, which may reflect album/compilation date rather than original track release date.
- Roon queue count/time can disagree with Roon's own UI around current-track filtering and queue subscription timing.
- TIDAL OAuth refresh and playlist write behavior should be monitored after long idle periods.
- Artwork comes from Roon first, then the local bridge/enrichment cache. If bridge-backed artwork fails, check `ROONPRESENCE_NOW_STATE_URL`, TIDAL token status, and metadata enrichment cache state.

## Verification Status

Most recent verification in this chat:

- `npm run check` passed: 55 JavaScript files.
- `npm test` passed.
- `npm audit --audit-level=moderate` found 0 vulnerabilities.
- `git diff --check` passed.

Run these again after any next change:

```powershell
npm run check
npm test
npm audit --audit-level=moderate
```

## Git State

Current worktree contains uncommitted app, test, and docs changes. New files that must be added before commit include:

- `src/artistIdentity.js`
- `src/metadataEnrichmentService.js`
- `test/discoveryHistory.test.js`
- `test/metadataEnrichmentService.test.js`

This handoff is intended to be committed and pushed after final verification. If a push fails, check the remote:

```powershell
git remote -v
```

The old push failure was caused by a missing or incorrect GitHub remote. Do not reset or discard worktree changes unless the user explicitly asks.
