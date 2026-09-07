# The Rabbit Hole - TODO

Repo directory:

```text
C:\Users\spade\Documents\Codex\2026-06-07\the-rabbit-hole
```

## Highest Priority

1. Broaden fresh standby discovery after repeat suppression.
   - The standby endpoint now filters previously suggested tracks out of the visible pool.
   - Current status: standby refresh now runs fresh standby-only broadening before it gives up on a thin visible pool.
   - Current status: broadening covers:
     - adjacent artist branches
     - label branches
     - TIDAL/radio-style branches
     - Last.fm similar artists
     - low-exposure liked-label branches
   - Do not backfill standby with stale previous suggestions unless the user explicitly asks for repeats.
   - Watch Pool Diagnostics after the next overnight/session refresh to see which broadening pass is actually carrying the pool.

2. Tune discovery pool volume and runtime.
   - Use Pool Diagnostics after every bad run.
   - Watch `runtime exhausted`, `query yield`, `queries skipped`, and lane availability.
   - If core/adjacent lanes show `0/0`, the crawl is not searching the right sources yet.
   - Current status: adaptive recovery now detects lane starvation, so a full-but-narrow pool can trigger branch/label/adjacent/omnivore recovery instead of accepting core monotony.
   - Current status: Pool Diagnostics recovery details now show target lanes and lane shortfalls.
   - Keep runtime increases modest; prefer faster query ranking and better source expansion over blind long crawls.

3. Improve discovery branching without turning Rabbit Hole into plain search.
   - Taste Guided should discover adjacent artists, not only repeat top liked artists.
   - Enforce artist diversity per run unless the user explicitly asks for one artist.
   - Use similar artists, labels, radios, remixers, standby discoveries, and playlist context as branch seeds.
   - Current status: adaptive recovery has lane-specific query families for adjacent-lane and cross-genre omnivore branch recovery.
   - Keep a small taste lane, but do not let taste lane monopolize the output.

4. Strengthen genre inference.
   - Treat official TIDAL/Roon genre tags as weak hints, especially generic `Electronic`.
   - Combine artist relationships, labels, radios, Last.fm/history, standby/rated tracks, and Darth ratings.
   - Surface confidence/risk when evidence is weak.
   - Continue improving cases where strong tracks are ranked low because genre evidence is vague.

5. Keep date/year filters strict.
   - If user asks for this year or a specific year range, do not accept old compilations unless the prompt explicitly allows it.
   - Surface whether the date came from track, album, compilation, or TIDAL availability metadata.
   - Keep rejected diagnostics clear for older tracks.

6. Improve Roon exact queue matching.
   - Continue trying multiple query shapes:
     - `artist title`
     - `title artist`
     - stripped remix/title variant
     - album + title
     - artist browse, then title match
   - Only queue the exact artist/title match or explain the mismatch.
   - Keep the failure message actionable when Roon finds the wrong artist.

## Discovery Quality

7. Reduce SEO sludge.
   - Keep rejecting playlist bait, yearly SEO compilations, generic channel uploads, and fake long-tail titles.
   - Add new examples from rejected runs to tests when a miss leaks through.
   - Avoid blocking legitimate DJ tools, EPs, and underground releases by title alone.

8. Improve Pure Search behavior.
   - Pure Search should not use liked artists as substitutes for the requested artist or genre.
   - If an exact artist seed is present, search that artist first and report whether exact-artist audit passed.
   - Taste can break ties only after prompt fit is satisfied.

9. Improve Taste Guided behavior.
   - Prompt intent stays primary.
   - Taste profile is a soft preference layer.
   - Prefer branch-out tracks in the same lane over direct repeats from top artists.
   - Show when learned taste is applied strongly, lightly, or not at all.

10. Fill requested track counts better.
   - Return high-quality below-minimum candidates when the user asks to see ballpark options.
   - Do not silently hide near misses; show why they were below minimum.
   - Avoid backfilling with stale previous tracks unless the user explicitly requests prior results.

11. Reduce repeat suggestions.
    - Current status: track identity now uses TIDAL id, TIDAL URL, and normalized artist/title aliases.
    - Current status: manual generation has a final freshness guard before results are shown.
    - Current status: standby visible pool filters prior suggestions and refreshes replace old pools instead of merging them.
    - Current status: standby diagnostics show repeat-suppression counts by source/lane.
    - Current status: discovery history now records label/source/lane exposure.
    - Current status: quota selection applies a decaying recent-suggestion novelty tax for overused artists, labels, and branch/source pockets.
    - Current status: Pool Diagnostics shows how many retained candidates were novelty-taxed.
    - Current status: per-run quota selection caps labels and meaningful source pockets, with partial relaxation when the pool would otherwise underfill.
    - Current status: Pool Diagnostics shows label/source caps and cap relaxation counts.
    - Current status: Pool Diagnostics shows cap-held label/source examples for high-ranking candidates withheld by diversity caps.
    - Keep novelty memory visible in diagnostics.

## TIDAL / Profile / Queue Bridge

12. Monitor TIDAL OAuth refresh.
    - Confirm profile token refresh works after the short access token expires.
    - Keep durable refresh tokens in ignored `data/tidal-profile-token.json`.
    - Never commit profile tokens.

13. Improve Mixes & Radio handling.
    - Official OAuth only exposes some profile mix relationships.
    - Hidden mobile-only shelves can be pinned by URL.
    - Keep pinned items separate from official TIDAL profile items so the UI stays honest.

14. Improve TIDAL queue playlist bridge.
    - Confirm temporary playlist creation/update on generated results and standby lists.
    - Avoid duplicate playlist tracks when sending the same list repeatedly.
    - Make the resulting TIDAL link easy to open on phone/tablet.

15. Artist radio refresh.
    - When adding a pinned Artist Radio again, try to avoid tracks already queued or recently added.
    - Surface whether TIDAL returned the same radio payload again.

## UI Polish

16. Keep player layouts stable.
    - Tablet landscape buttons should remain evenly spaced.
    - Phone full-screen mode should stay compact without affecting landscape.
    - Artwork should remain large but not crowd controls.
    - Wake lock should only run in full-window/player mode.

17. Improve result readability.
    - Keep the short description under each scoring mode.
    - Keep discovery score badge prominent in player views.
    - Keep Pool Diagnostics readable on phone.

18. Radio and standby UX.
    - Radio station reordering should remain touch-friendly on tablets.
    - Reset order should stay scoped to the current radio folder.
    - Standby discovery should not refresh over a full 25-track cache before the user can play it.
    - Queue/send controls should stay visibly busy for slower Roon/TIDAL operations.

## Metadata Sources

19. Last.fm.
    - Keep as a taste/context source, not a hard filter.
    - Use public history for artist/track familiarity and repeat avoidance.
    - Shared secret is only needed for authenticated write/private flows.

20. TIDAL/Roon artwork and metadata enrichment.
    - Roon metadata and artwork should remain first priority.
    - TIDAL enrichment fills missing radio/local metadata asynchronously and must not block playback UI.
    - Keep confidence threshold conservative; do not show enriched data below 80 confidence.
    - Bridge-backed artwork should be used by both Rabbit Hole and Roon Presence when direct Roon art is absent.
    - Cache successful lookups by normalized artist/title.

21. Discogs / MusicBrainz.
    - Use for label, release, and artist disambiguation when overhead is acceptable.
    - Cache aggressively.
    - Do not block discovery on slow external metadata.

22. Songstats.
    - Optional future integration.
    - Useful for artist/label/track popularity and cross-platform signals.
    - Check pricing/terms before adding.

## Testing / Release

23. Keep tests current.
    - Add regression tests for each real bad result pattern:
      - wrong artist collision
      - SEO sludge
      - old compilation in new-year search
      - repeated top artist domination
      - repeated standby candidates after history alias changes
      - weak genre evidence
      - Roon wrong-match queue attempt

24. Standard verification before push.
    - `npm run check`
    - `npm test`
    - `npm audit --audit-level=moderate`
    - `git diff --check`

25. GitHub hygiene.
    - Confirm `.env` and token data are ignored.
    - Commit focused app/docs/test changes.
    - Push `main`.

## Troubleshooting Notes

26. Common failures to check.
    - Port 3777 already in use.
    - Roon extension not authorized.
    - LM Studio server running on the wrong port.
    - TIDAL token expired or refresh failed.
    - TIDAL circuit breaker backing off after repeated fetch failures.
    - Roon Browse API found a visual result but no queue action.
    - Tailscale/DNS route changed after router/NAS network changes.
