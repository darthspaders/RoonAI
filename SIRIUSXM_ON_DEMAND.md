# SiriusXM shows, artist stations and Xtra channels

The independent Lyrion view provides SiriusXM show search, episode browsing,
artist stations and Xtra channels. Every action retains exact entity type and ID.
Play now replaces only the selected Lyrion queue; Play next and Add preserve it.

## Requirements and authorization

Use your own eligible SiriusXM account. The catalogue reads the local Lyrion
SiriusXM preferences or private `SIRIUSXM_USERNAME` / `SIRIUSXM_PASSWORD`
environment variables. `SIRIUSXM_LYRION_PREFS` overrides the local preferences
file location. Rabbit Hole does not copy the password into its data directory.
Refresh/access tokens and discovered items stay in ignored
`data/siriusxm-on-demand.json`.

FFmpeg must be installed; `FFMPEG_PATH` can select its executable. The authorized
media relay binds only to loopback. These relayed features currently require
Lyrion and Rabbit Hole on the same host/network namespace. Ordinary Lyrion source
browsing/playback can use a separately reachable Lyrion server; see
[Linux/Docker setup](docs/linux-docker.md).

Public live metadata uses a separate unauthenticated path.
The failed subscriber device-code experiment is not required.
No Python runtime or open SiriusXM browser tab is needed.

## Show episodes

Authorized HLS resources are resolved behind opaque local URLs and decoded to
FLAC. Subscriber tokens do not appear in FFmpeg arguments or Lyrion queue URLs.
FLAC preserves decoded audio; it cannot turn a lossy source into lossless audio.

Long episodes stream from the beginning, with pause/resume and queue actions.
Random seeking or resuming at a stored position is not implemented.
External podcast media can be listed but playback is disabled.
Restarting Rabbit Hole interrupts its relayed episode; choose Play now again
afterward. Native live channels keep their Lyrion plugin playback path.

On-demand items are labeled `SiriusXM on demand` and do not receive the live
channel overlay. Catalogue duration is displayed when Lyrion reports zero;
the player may still treat a relayed episode as an unknown-length stream.

POST endpoints under `/api/siriusxm/ondemand/`:

- `search`: `{query}`
- `episodes`: `{type:"show",id}` or `show-podcast`
- `queue`: `{type:"episode-audio",id,playerId,action:"play"|"next"|"add"}`

MCP actions are `siriusxm_search_shows`, `siriusxm_show_episodes` and
`siriusxm_queue_episode`.

## Artist stations and Xtra channels

Artist stations are distinct from artist-branded broadcast channels.
Search authenticated `artist-station` results or browse the subscriber's
My stations library. Artist favorites save the exact station ID locally;
they are separate from the subscriber account library.

Xtra channels retain `channel-xtra` identities and have their own
search/browse/favorites view. They must never be substituted with a broadcast
channel or rematched by a song title. Saving a favorite does not start playback.

Play station replaces only the selected player's queue. Every ten seconds,
a timer can fetch the next cursor page when three or fewer tracks remain.
It deduplicates exact track IDs and does not refill paused/stopped players.
Other Rabbit Hole queue actions cancel additions; external queue changes are
checked before appending. Stop adding songs leaves existing playback intact.

After three fetch failures, an uncertain queue write, repeated/empty pages,
or 1,000 distinct songs, replenishment stops with a visible reason.
Restarting Rabbit Hole ends replenishment sessions; choose Play station again
to resume. Expired media URLs are reported rather than replaced with other songs.
Rabbit Hole transport controls check station skip allowances; other Lyrion
clients remain responsible for their own controls.

Artist POST endpoints under `/api/siriusxm/ondemand/artist/` are `search`,
`library`, `play`, `status`, `stop`, and `favorites`.
Xtra endpoints under `/api/siriusxm/ondemand/xtra/` are `search`, `browse`,
`favorites`, `play`, `status`, and `stop`.
Four artist MCP actions provide search, library, play and stop-additions.
Dedicated Xtra MCP actions are not yet included.

## Completed-track delivery and source quality

Artist/Xtra tune requests prefer HLS. HLS selects the highest advertised audio
rendition by average bandwidth, with peak bandwidth fallback. The authorized
audio is decoded without another lossy encoding step. Legacy queued M4A/MP4
sources retain their original format/quality.

FFmpeg can skip a missing HLS segment and still exit successfully.
Artist/Xtra tracks therefore complete into a local FLAC file before any playback
read. Explicit segment/audio errors or a decoded duration shorter than catalogue
duration, allowing the greater of two seconds or 1%, reject the attempt.
The exact source can be retried before delivery.

Completed files have finalized sample counts, Content-Length and byte-range
support. Reconnects and seeking read the same file. The first track is prepared
before queue replacement; two following tracks warm in the background.
Slow preparation runs outside the playback lock. Newer playback intent,
changed queue ownership or a disconnected setup request can cancel its commit.

HLS resources have an 8 MiB limit and at most three download attempts.
Completed audio cache limits are 128 MiB per track, 256 MiB total, 12 files,
one-hour expiry and two preparation jobs. Active readers are pinned against
eviction. A lasting failure is reported rather than delivering a partial track.
Decoder attempts are capped at 120 seconds; station-start requests allow
300 seconds. Cache misses can add an initial preparation delay.

Private audio cache files live under `data/siriusxm-audio-cache`.
Logs expose scalar diagnostics and opaque track keys, not signed URLs.
Restarting Rabbit Hole can interrupt relayed audio even when completed cache
files survive it. Long episodes and native channels retain their respective
streaming paths.

## Optional native metadata timing patch

`node scripts/fix-siriusxm-metadata-timing.cjs` patches a reviewed installed
SiriusXM plugin, checks expected source fragments, and creates backups.
It re-fetches metadata against PDT rather than trusting predicted transition
times, rejects older/all-future cuts, and bounds polling delays.

The helper targets the installed Windows plugin path in its source.
Do not run it against a different installation without reviewing that path
and the plugin version. A Lyrion restart is needed to activate plugin edits
and briefly interrupts playback. Plugin updates can replace the patch;
unexpected source is rejected rather than patched automatically.

Protocol reference: [aiosxm](https://github.com/MizterB/aiosxm).
The Node adapter does not bundle or execute that Python library.
