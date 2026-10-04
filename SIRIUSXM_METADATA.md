# SiriusXM metadata overlay

SiriusXM metadata, artwork and catalogue enrichment form a display view model.
The selected Lyrion player controls audio and transport. Raw playback fields and
queue identity are retained; the existing Roon path is independent.

## Public metadata

Rabbit Hole queries SiriusXM's public website endpoints directly in Node:

- [Live lookAround feed](https://lookaround-cache-prod.streaming.siriusxm.com/playbackservices/v1/live/lookAround)
- [Example channel metadata](https://www.siriusxm.com/api/mountain/9472)
- [Example program guide](https://www.siriusxm.com/sxmepg/epg.sxmchepginfo.xmc?channelKeys=9472&distribution=XMDCOM&tzone=Eastern)

The lookAround endpoint was identified using
[aiosxm protocol references](https://github.com/MizterB/aiosxm). No Python library,
browser tab or subscriber authorization is required for this metadata path.
These website endpoints are not a guaranteed public developer API; failures
fall back to Lyrion rather than inventing missing information.

Concurrent requests coalesce and caches are bounded. Channel matching uses
the expected channel number and exact IDs/names, with saved Lyrion favorites
providing additional exact channel identities. Fuzzy matches are not accepted.

The program guide provides dated current/next shows with explicit timezone
handling. Old mountain `showSchedules` entries are ignored. Missing song
artist/title fields are reported as unavailable.

## Buffered display timing

`GET /api/lyrion/status` adds `siriusxmMetadata`, `siriusxmDiagnostics` and
`displayPlaybackState` without overwriting raw `nowPlaying` or queue fields.

Native channels are identified by exact `sxm:` IDs or the plugin's loopback
port 9999 HLS URLs. Where the plugin's per-channel PDT files are locally
accessible, timestamped cuts are aligned to fresh playback timestamps.
History retains the previous cut while newer broadcast metadata is ahead
of buffered audio.

The clock uses a 20-second downstream buffering estimate. It does not
extrapolate audio position using wall time. Fresh advancing PDT can be up to
six hours behind the broadcast; stale/nonadvancing files after 60 seconds,
backwards timestamps and out-of-window times are rejected. A brief outage
can hold the last aligned cut for up to 60 seconds before raw Lyrion fallback.

PDT represents downloaded media segments, not the DAC clock. The resulting
display is approximate. Channel cards and the manual metadata endpoint describe
the broadcast, which can differ from a buffered player's current audio.

Track artwork has priority. Exact channel logos are fallbacks when track artwork
is absent or fails. `channelArtwork` and `showArtwork` remain separate, so a
scheduled show's image cannot establish the identity of a different buffered song.
Late image/status responses cannot restore a previous track after a newer one.

## Diagnostics and plugin timing patch

Read-only metadata examples:

```text
http://localhost:3777/api/siriusxm/metadata?channel=53
http://localhost:3777/api/siriusxm/metadata?channel=52
http://localhost:3777/api/siriusxm/metadata?channel=55
```

See [SiriusXM playback](SIRIUSXM_ON_DEMAND.md) for show/station authorization and
the optional installed-plugin timing patch.

The old subscriber device-code experiment was unsuccessful and is not required.
The historical browser metadata helper is disabled: repeated DOM readings did
not prove fresh metadata. Rabbit Hole rejects those deliveries. Do not install
that helper as an active live metadata solution.
