# Direct Roon MCP tools

Implemented and live-tested September 6, 2026. Rabbit Hole's existing authenticated MCP endpoint now exposes:

- `roon_queue_tracks`: structured tracks, optional `zoneId`, `mode: append | next`, `matchPolicy: flexible | strict`.
- `roon_search_track`: read-only resolution, best candidates, available metadata, heuristic confidence and an expiring queue action handle.
- `roon_get_queue`: zone, current track, subscribed queue entries, count, remaining seconds, availability and truncation.

Refresh the MCP connection/tool list in ChatGPT if the new names are not visible. No new backend credentials are needed. The existing MCP authentication configuration remains in effect.

## Synapse instructions

For “add these tracks to Roon”, call `roon_queue_tracks` with JSON objects and `matchPolicy: flexible`. Do not use discovery, standby, scoring, novelty filtering, TIDAL verification or a string list parser. For an explicit verify-first request, perform exact TIDAL verification first, then queue the verified identities with strict matching. Verification alone does not authorize queue writes.

```json
{
  "tracks": [
    { "artist": "Das Pharaoh", "title": "Whispers in the Wind (Extended Mix)" },
    { "artist": "M.O.S.", "title": "Immensity (Extended Mix)" },
    { "artist": "Hernán Cattáneo", "title": "Tranquilo" }
  ],
  "mode": "append",
  "matchPolicy": "flexible"
}
```

Each track requires nonempty `artist` and `title`. Optional fields: `album`, `tidalTrackId`, `isrc`, `durationMs`, `queueToken`. Strings containing lists are rejected before any writes. The title is never split or interpreted as instructions.

## Reused implementation

`mcpHttpServer.js` → `/api/roon/direct/queue` → `DirectRoonQueue.queue/run` → **`RoonClient.queueTracks` → `performSearchAction` → `resolveSearchAction` → `search/searchWithQueries/searchQuery` → `findPlayableAction/loadCurrentActions` → existing Roon browse action dispatch**.

`resolveDirectAction` adds bounded lookup retries and existing action-cache reuse around that resolver; it is not another search or queue engine. Search uses `canQueueTrack` and the same resolver without dispatch. Queue inspection reads the existing transport subscription. Legacy queue and discovery implementations remain available for their original purposes.

## Matching and identifiers

- Flexible matching normalizes casing, accents, punctuation, ampersands/“and”, artist ordering, initials such as M.O.S./MOS, and title suffix punctuation. All requested artists must be present; additional Roon credits are allowed.
- Version metadata exposed separately by Roon is combined with the title. A missing generic Original/Extended Mix suffix requires matching TIDAL ID, ISRC, or both album and duration within two seconds. Named remixes are never discarded to manufacture a match.
- Strict matching requires the full normalized title/version and requested artists. Conflicting service IDs, ISRC or known duration reject both policies.
- Equally plausible results with distinct exposed recording identifiers return `AMBIGUOUS` without queueing. Confidence values are deterministic heuristics, not calibrated probabilities.
- Valid cached Roon actions are reused before searching. TIDAL ID/ISRC can retrieve metadata from the saved exact-verification result without another TIDAL request, and validate/rank Roon results when Roon exposes comparable identifiers.
- Roon browse does **not** provide a general “queue by TIDAL ID/ISRC” endpoint. No bridge playlist is created, and no fabricated ID lookup is attempted. When there is no usable cached action, the same controlled Roon artist/title search variants run.

## Batching, timeouts and retries

Up to 500 tracks are processed through existing batches of at most 50. Per-track failures do not abort the rest. Append preserves input order. Add Next reverses execution within chunks and processes later chunks first, preserving input order across chunk boundaries; existing Roon action-fallback warnings are returned.

Lookup gets up to two attempts, each with a 20-second deadline; only timed-out lookups are retried automatically. Queue dispatch has a 15-second acknowledgement deadline and is **never automatically replayed**. An uncertain dispatch returns `QUEUE_FAILED`, `queueable: true`, and an explicit instruction to inspect the queue before retrying. A lookup timeout remains `ROON_TIMEOUT`, not a definitive miss.

Each result includes requested and best-resolved identity, status, policy, confidence, queueability, queued state, reason, resolution method, search variants, action, timing and the original `requestedTrack`. Retry with only failed `requestedTrack` objects. Do not resend successes. This is not an idempotent bulk API: deliberately resending a successful track can add another copy. `ALREADY_QUEUED` is not asserted from incomplete queue snapshots.

Search returns an opaque queueToken valid for append in the same zone/policy. Handles expire after 30 minutes or a Roon reconnect/restart and are consumed before dispatch. Successful queue results return an empty queueToken because the action has been consumed. Handles are not backend credentials and are omitted from debug logger entries. Logs contain only batch/zone, search variants, method, confidence, queue action, elapsed time and failure type.

## Live results

The three-object batch was sent through the actual HTTP MCP `tools/call` endpoint, not through discovery or a direct test stub:

| Request | Result |
| --- | --- |
| Das Pharaoh — Whispers in the Wind (Extended Mix) | QUEUED; existing Roon `Queue` action; 432 ms |
| M.O.S. — Immensity (Extended Mix) | NOT_FOUND for that artist. Best result was Dimassive; not substituted. |
| Hernán Cattáneo — Tranquilo | VERSION_MISMATCH. Roon returned Tranquilo (Franco Giannoni Remix); not substituted. |

Total: 3 requested, 1 resolved/queued, 2 failed, 8.239 seconds. Queue inspection confirmed HQPlayer's count increased from 21 to 22. A copy from earlier work already existed; this authorized regression test appended one additional copy.

Only the two failures were retried after final normalization changes; neither resolved (8.137 seconds). Das Pharaoh was not resent. A final strict read-only `roon_search_track` also resolved Das Pharaoh successfully and reported Extended Mix.

Evidence: `work/direct-roon-live-batch.json`, `work/direct-roon-live-retry.json`, `work/direct-roon-strict-search.json`, `work/direct-roon-final-queue.json`.

## Validation and limitations

378 automated tests passed, including 11 new tests covering structured validation, accent/artist normalization, strict versions, strong identifiers, ambiguity, saved metadata, the real bulk dispatch path, partial failures, 101-track Add Next ordering, one-use action caching, MCP routing, and queue inspection. Syntax checks passed for 95 JavaScript files.

The Roon subscription exposes at most 50 queue entries. The tool reports the authoritative total when available and explicitly marks truncated/unavailable data. Album, duration and identifiers can be absent from browse results; absent values are not guessed. Queue acknowledgement confirms Roon accepted the action, not that audio playback completed. No queue-clear tool was added. External ChatGPT clients may need to refresh their tool list, and their own request time limits can interrupt very long batches; inspect the queue before retrying after a disconnected call.
