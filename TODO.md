# The Rabbit Hole - TODO

## Highest Priority

1. Tune discovery pool volume and runtime.
   - Use Pool Diagnostics after every bad run.
   - Watch `runtime exhausted`, `query yield`, `queries skipped`, and lane availability.
   - If core/adjacent lanes show `0/0`, the crawl is not searching the right sources yet.
   - Keep runtime increases modest; prefer faster query ranking and better source expansion over blind long crawls.

2. Improve discovery branching without turning Rabbit Hole into plain search.
   - Taste Guided should discover adjacent artists, not only repeat top liked artists.
   - Enforce artist diversity per run unless the user explicitly asks for one artist.
   - Use similar artists, labels, radios, remixers, and candidate-list context as branch seeds.
   - Keep a small taste lane, but do not let taste lane monopolize the output.

3. Strengthen genre inference.
   - Treat official TIDAL/Roon genre tags as weak hints, especially generic `Electronic`.
   - Combine artist relationships, labels, radios, Last.fm/history, saved candidates, and Darth ratings.
   - Surface confidence/risk when evidence is weak.
   - Continue improving cases where strong tracks are ranked low because genre evidence is vague.

4. Keep date/year filters strict.
   - If user asks for this year or a specific year range, do not accept old compilations unless the prompt explicitly allows it.
   - Surface whether the date came from track, album, compilation, or TIDAL availability metadata.
   - Keep rejected diagnostics clear for older tracks.

5. Improve Roon exact queue matching.
   - Continue trying multiple query shapes:
     - `artist title`
     - `title artist`
     - stripped remix/title variant
     - album + title
     - artist browse, then title match
   - Only queue the exact artist/title match or explain the mismatch.
   - Keep the failure message actionable when Roon finds the wrong artist.

## Discovery Quality

6. Reduce SEO sludge.
   - Keep rejecting playlist bait, yearly SEO compilations, generic channel uploads, and fake long-tail titles.
   - Add new examples from rejected runs to tests when a miss leaks through.
   - Avoid blocking legitimate DJ tools, EPs, and underground releases by title alone.

7. Improve Pure Search behavior.
   - Pure Search should not use liked artists as substitutes for the requested artist or genre.
   - If an exact artist seed is present, search that artist first and report whether exact-artist audit passed.
   - Taste can break ties only after prompt fit is satisfied.

8. Improve Taste Guided behavior.
   - Prompt intent stays primary.
   - Taste profile is a soft preference layer.
   - Prefer branch-out tracks in the same lane over direct repeats from top artists.
   - Show when learned taste is applied strongly, lightly, or not at all.

9. Fill requested track counts better.
   - Return high-quality below-minimum candidates when the user asks to see ballpark options.
   - Do not silently hide near misses; show why they were below minimum.
   - Avoid backfilling with stale previous tracks unless the user explicitly requests prior results.

10. Reduce repeat suggestions.
    - Penalize tracks suggested many times recently.
    - Diversify by artist, label, album, and source.
    - Keep novelty memory visible in diagnostics.

## TIDAL / Profile / Queue Bridge

11. Monitor TIDAL OAuth refresh.
    - Confirm profile token refresh works after the short access token expires.
    - Keep durable refresh tokens in ignored `data/tidal-profile-token.json`.
    - Never commit profile tokens.

12. Improve Mixes & Radio handling.
    - Official OAuth only exposes some profile mix relationships.
    - Hidden mobile-only shelves can be pinned by URL.
    - Keep pinned items separate from official TIDAL profile items so the UI stays honest.

13. Improve TIDAL queue playlist bridge.
    - Confirm temporary playlist creation/update on generated results and candidate lists.
    - Avoid duplicate playlist tracks when sending the same list repeatedly.
    - Make the resulting TIDAL link easy to open on phone/tablet.

14. Artist radio refresh.
    - When adding a pinned Artist Radio again, try to avoid tracks already queued or recently added.
    - Surface whether TIDAL returned the same radio payload again.

## UI Polish

15. Keep player layouts stable.
    - Tablet landscape buttons should remain evenly spaced.
    - Phone full-screen mode should stay compact without affecting landscape.
    - Artwork should remain large but not crowd controls.
    - Wake lock should only run in full-window/player mode.

16. Improve result readability.
    - Keep the short description under each scoring mode.
    - Keep discovery score badge prominent in player views.
    - Keep Pool Diagnostics readable on phone.

17. Candidate-list UX.
    - Add candidate should always require or expose list selection when multiple lists exist.
    - Move between lists should remain easy.
    - Avoid silently adding everything to the first list.

## Metadata Sources

18. Last.fm.
    - Keep as a taste/context source, not a hard filter.
    - Use public history for artist/track familiarity and repeat avoidance.
    - Shared secret is only needed for authenticated write/private flows.

19. Discogs / MusicBrainz.
    - Use for label, release, and artist disambiguation when overhead is acceptable.
    - Cache aggressively.
    - Do not block discovery on slow external metadata.

20. Songstats.
    - Optional future integration.
    - Useful for artist/label/track popularity and cross-platform signals.
    - Check pricing/terms before adding.

## Testing / Release

21. Keep tests current.
    - Add regression tests for each real bad result pattern:
      - wrong artist collision
      - SEO sludge
      - old compilation in new-year search
      - repeated top artist domination
      - weak genre evidence
      - Roon wrong-match queue attempt

22. Standard verification before push.
    - `npm run check`
    - `npm test`
    - `npm audit --audit-level=moderate`
    - `git diff --check`

23. GitHub hygiene.
    - Confirm `.env` and token data are ignored.
    - Commit focused app/docs/test changes.
    - Push `main`.

## Troubleshooting Notes

24. Common failures to check.
    - Port 3777 already in use.
    - Roon extension not authorized.
    - LM Studio server running on the wrong port.
    - TIDAL token expired or refresh failed.
    - TIDAL circuit breaker backing off after repeated fetch failures.
    - Roon Browse API found a visual result but no queue action.
    - Tailscale/DNS route changed after router/NAS network changes.
