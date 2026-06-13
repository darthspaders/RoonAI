# The Rabbit Hole - TODO

## Highest Priority

1. Verify LM Studio is actually used during Generate.
   - Confirm `/api/llm-status` says `Local model ready`.
   - Confirm server responses show `modelPlan` and `modelPlanQueryCount`.
   - Confirm LM Studio GPU activity when pressing Generate.
   - Add visible UI telemetry: provider, model, plan query count, and model error if any.

2. Improve Roon queueable matching.
   - User can manually find many tracks in Roon by searching artist + track.
   - Search strategy should try multiple query shapes:
     - `artist title`
     - `title artist`
     - exact title without remix clutter
     - artist only, then browse/select matching title
     - album + title when known
   - Keep all displayed discovery results Roon-queueable in strict mode.
   - Prefer fewer great, queueable tracks over hallucinated or unplayable tracks.

3. Fix queue count/time mismatch.
   - Compare Rabbit Hole queue count to Roon's Queue screen.
   - Current track should be hidden from the Rabbit Hole queue list after playback starts, but the real Roon queue must not be changed.
   - Avoid stale queue state when skipping or seeking.

4. Keep audio stable.
   - Preserve reduced polling.
   - Avoid extra Roon/HQPlayer polling during active playback.
   - Do not add watchers that call playback, resync, or zone refresh commands.

## Discovery Quality

5. Strengthen genre-specific discovery.
   - Progressive house should stay excellent.
   - Tech house, trance, rock, 80s, synth-pop, metal, and other genres should not be over-penalized by the progressive-heavy taste profile.
   - If the user enters a genre-only prompt, weight genre/source accuracy higher and taste-profile similarity lower.

6. Fill requested track counts better.
   - If user asks for 30 tracks, try to produce 30 verified/queueable tracks when possible.
   - If strict filters prevent that, show exactly which filter limited the result:
     - year/date
     - minimum score
     - Roon queueable match
     - TIDAL metadata
     - duplicate/previously suggested

7. Reduce repeat suggestions.
   - Respect `Not previously suggested` more strongly.
   - Penalize tracks suggested many times recently.
   - Diversify by artist, label, album, and source.

8. Normalize artist names.
   - Fix `D-Nox` being split into `D` and `Nox`.
   - Preserve artist names with hyphens, initials, dots, and stylized names:
     - D-Nox
     - M.O.S.
     - D-Nox & Beckers
     - Hernan Cattaneo

9. Improve date filters.
   - Strict date/year filters must use actual metadata.
   - Do not accept album compilations from older years when user asks for 2025-2026.
   - Surface whether date means track release date, album release date, or TIDAL availability date.

## LLM / Tokens

10. Add model context telemetry.
    - Show approximate prompt tokens if available.
    - Show when the prompt is too large.
    - Offer "Start fresh model context" / "compact context" in the app if local model state becomes stale.

11. Use the LLM more intentionally.
    - Done: the LLM now plans search strategy instead of inventing final tracks.
    - Next: after TIDAL/Roon return verified candidates, ask the LLM to rank/explain only that verified list.
    - It should not be trusted as the authority for release dates or availability.
    - Roon/TIDAL metadata remains the source of truth.

12. Consider a larger context setting in LM Studio.
    - Current model supports large contexts, but the app config and LM Studio runtime should stay balanced for speed and stability.

## Rabbit Hole Graph

13. Improve graph entity quality.
    - Use real artists, remixers, labels, related artists, and hidden gems.
    - Avoid placeholder strings.
    - Make entities clickable and discovery-ready.

14. Cache graph results safely.
    - Do not regenerate the same artist/label graph every open.
    - Add cache age/status to the UI.

15. Add better source labels.
    - TIDAL catalogue
    - Roon queue
    - Local taste profile
    - Last.fm
    - Discogs
    - MusicBrainz
    - Saved candidates

## UI Polish

16. Keep desktop and mobile layouts aligned.
    - Now Playing, Queue, and Playlist Builder should feel balanced on desktop.
    - Mobile should wrap long titles without overflow.
    - Rating buttons should not flicker on tablet.

17. Replace old/static labels.
    - Ensure header reflects actual LLM provider, not hard-coded OLLAMA.
    - Playlist builder title should remain "Start the Rabbit Hole Journey".

18. Keep HQPlayer compact.
    - No large HQPlayer card.
    - Show filter/rate inline with the selected Roon output zone when possible.

## Metadata Sources

19. Last.fm
    - API key and username are enough for public listening-history calls.
    - Shared secret is only needed for authenticated write/private flows.

20. Songstats
    - Optional future integration.
    - Potentially useful for artist/label/track popularity and cross-platform signals.
    - Need pricing and terms before adding.

21. Spotify
    - Optional future source for artist images, popularity, related artist style, and metadata cross-checking.
    - Avoid making Spotify required for the core app.

## GitHub / Repo

22. Finish GitHub upload.
    - Create the GitHub repo or correct the remote URL.
    - Confirm `.env` is ignored.
    - Push `main`.

23. Add setup docs.
    - Node install
    - Roon authorization
    - TIDAL credentials
    - Last.fm optional credentials
    - LM Studio setup
    - Ollama fallback

24. Add a troubleshooting section.
    - Port 3777 already in use
    - Roon extension not authorized
    - LM Studio status red/yellow
    - TIDAL searches timing out
    - Audio pops
    - Queue mismatch
