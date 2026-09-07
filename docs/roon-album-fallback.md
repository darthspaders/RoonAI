# Shared Roon album fallback — September 6, 2026

Implemented in the shared Roon resolver and live-tested against HQPlayer. Plain **Hernán Cattáneo — Tranquilo** now resolves and queues through the album, without substituting either remix.

## Root cause confirmed by live inspection

The earlier resolver already attempted some nested browsing, but it missed the actual Roon structure:

1. The direct Tracks category showed only **Tranquilo (Franco Giannoni Remix)**.
2. The Albums category exposed **Tranquilo**, with artist text `[[836218|Hernan Cattaneo]]`. Internal link markup broke strict artist comparisons.
3. Opening that album exposed a second same-title album/release node.
4. Opening the second node exposed `Play Album`, `1. Tranquilo`, `2. Tranquilo (Adrien (AR) Remix)`, and `3. Tranquilo (Franco Giannoni Remix)`.
5. The old traversal did not handle the same-name wrapper and numbered track presentation. It also reused root category handles after entering another page. Separately, `action_list` hints could be misclassified as generic lists, and legacy matching explicitly allowed named remixes to replace plain titles.

## Shared changes and consumers

In `src/roonClient.js`:

- `searchQuery` evaluates actual direct track rows, then invokes bounded album traversal before concluding failure.
- `findAlbumTrackFallback` navigates the existing Roon browse API in a separate search session, reacquires category handles, opens plausible albums, follows bounded Tracks/disc/same-title release wrappers and validates individual track rows.
- `searchWithQueries` shares the album budget across query variants and returns/logs diagnostic counters.
- `findNestedSearchMatch` leaves album categories to the corrected album traversal.
- `itemLooksLikeTrackResult` recognizes Roon track `action_list` rows. Album-wide Play/Queue actions are excluded from fallback selection.
- `titleMatchesTrackCandidate` and `sameArtistVersionFallbackMatches` no longer infer a named remix from a plain title or artist credits.
- `resolveSearchAction`, `resolveDirectAction`, `queueTracks` and cached action handling preserve fallback provenance and diagnostics. A fallback timeout remains unresolved rather than becoming a definitive catalog miss.
- Shared display normalization strips Roon `[[id|display text]]` markup. Number prefixes are removed only from album track rows. Accents, punctuation and artist ordering remain supported; Roon's spaced-slash artist separators are also recognized.

Consumers of the same corrected search path:

| Consumer | Entry point |
| --- | --- |
| MCP `roon_search_track` | `canQueueTrack → resolveDirectAction → resolveSearchAction` |
| MCP `roon_queue_tracks` | `queueTracks → performSearchAction → resolveDirectAction → resolveSearchAction` |
| Legacy, supplied-list and standby queueing | `queueTracks → performSearchAction → resolveSearchAction` |
| Rabbit Hole queueability/candidate verification | `canQueueTrack → resolveSearchAction` |
| Saved exact TIDAL identity resolution | `resolveVerifiedTracksForRoon → canQueueTrack → resolveSearchAction` |
| Exact compatibility resolver | `resolveExactSearchAction → resolveSearchAction` |
| Roon-first candidate/rescue queue checks | `canQueueKnownRoonTrack → resolveSearchAction` |

All continue through `search/searchWithQueries/searchQuery`, then the existing `findPlayableAction` and existing queue dispatcher. No new queue implementation or TIDAL discovery fallback was introduced. Bulk discovery harvesting is not converted into an album crawl; the improvement applies when a requested candidate is resolved or checked for queueability.

## Safeguards

- Album/release title must match the requested base title or explicit album after normalization, and its artist credit must contain **all** requested artists.
- Valid browse nodes only; no unrelated artist catalog crawling.
- At most **3 album candidates per query sequence**, **100 inspected track rows per album**, **2 child levels below the album**, and **3 eligible child branches per page**.
- Album browsing has a **10-second cumulative budget** across query variants and inherits any earlier enclosing request deadline/cancellation.
- Album artist inheritance is permitted only when a track row has no artist or contains only a duration; explicit conflicting credits remain rejected.
- Strict version validation occurs after removing presentation-only numbering. Plain Tranquilo never matches either named remix.
- Only the matched track's action is dispatched. Album-wide actions are not selected. Valid cached track actions remain reusable.

## Live results

| Test | Result |
| --- | --- |
| `roon_search_track`, flexible | Plain Tranquilo found in album Tranquilo; `queueable: true`, `resolutionMethod: album_track_fallback` |
| `roon_queue_tracks` | **1 requested, 1 queued, 0 failed**; existing `Queue` action; plain title and fallback method preserved |
| Rabbit Hole `/api/roon/queue-check`, `exactVerification: true` | **1 queueable, 0 failed** through the internal strict `canQueueTrack` path |
| Roon queue subscription | Confirmed `Tranquilo — Hernán Cattáneo`, album Tranquilo, duration 282 seconds |

The album traversal itself took about **812 ms** in the successful search. Queueing reused that resolved action. Tranquilo was appended once for the authorized live regression test. Other historical cases were search-only. Existing saved TIDAL verification state was not replaced to run the test; the persistence wrapper `resolveVerifiedTracksForRoon` is additionally covered by the automated album regression.

## Historical before/after sample

The same four identities were searched with `exactVerification: true` immediately before and after the implementation:

| Identity | Before | After | Album fallback |
| --- | --- | --- | --- |
| Hernán Cattáneo — Tranquilo | Failed | **Resolved** | Attempted and resolved |
| M.O.S. — Immensity (Extended Mix) | Failed | Unresolved | No plausible matching album |
| Abity, Luca Abayan — Afterimage (DJ Ruby Remix) | Resolved | Resolved | Attempted and resolved |
| D-SHIFT, Drunken Kong — City Lights (HAFT Remix) | Failed | Unresolved | No plausible matching album |

**3 immediate baseline failures; 1 newly recovered; 2 remain unresolved.** Album fallback attempted for 2/4 identities and succeeded for both. Afterimage had failed historically, but it already succeeded in the immediate baseline and is not counted as a new recovery. Unresolved means no accepted result in these bounded Roon searches, not proof that the recording is absent from every catalog.

## Diagnostics and tests

Added `roonAlbumFallbackAttempted`, `roonAlbumFallbackResolved`, `roonAlbumFallbackFailed`, `albumCandidatesInspected`, `tracksInspected`, elapsed time, timeout/error information and bounded album/page details. Per-search diagnostics are returned with results; counters are also exposed as `resolverDiagnostics` in Roon state and logged with `[roon-album-fallback]`. The aggregate counters reset on server restart. Exact-resolution state and internal queue-check responses retain the same provenance. Logs do not include credentials or executable queue handles.

**388 tests passed; syntax checks passed for 96 JavaScript files.** Ten new album regressions cover shared/direct/internal paths, original/extended versions, linked artists, same-title wrappers, numbered rows, page-scoped handles, unrelated artists, missing versions, album/track caps and parent cancellation. Two legacy tests were corrected to reject unsafe plain-title-to-named-remix substitution.

Evidence files:

- `work/album-tranquilo-search.json`
- `work/album-tranquilo-queued.json`
- `work/album-tranquilo-internal.json`
- `work/album-historical-before.json`
- `work/album-historical-after.json`
- `work/album-live-queue-confirmation.json`
- `work/album-final-tests.log`

Remaining limits: Roon may omit artist/duration/identifier metadata, paginate beyond inspected rows, or expose releases behind more nesting than the configured depth. Such cases remain unresolved rather than accepting a different recording. Queue inspection retains the existing 50-entry subscription limit.
