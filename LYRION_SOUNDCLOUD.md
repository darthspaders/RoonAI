# Lyrion actions and SoundCloud playlists

Lyrion has independent player selection, playback, queues and source browsing.
Roon keeps its own zones and identity checks. The shared parallel music manifest,
`src/parallelMusicTools.json`, defines 35 actions: 20 Lyrion, eight SoundCloud,
and seven SiriusXM show/artist actions. A separately installed MCP wrapper must
keep its matching manifest synchronized.

## Exact identities

Search/browse retains original item parameters, playable URLs, SoundCloud track
URNs when available, and a durable `referenceId` for playable discoveries.
Queue actions use these references or player-bound action tokens; they never
rematch an item by title. Action tokens expire after one hour.

Private `data/lyrion-items.json` retains up to 2,000 unique playable discoveries.
Recent discoveries are saved search/browse results, rather than listening history.
Durations are included only when supplied by the source.

Native Lyrion favorites use its favorites API. Plugin capabilities vary;
browse-only and unavailable services are reported. See [Lyrion setup](docs/lyrion.md).

## SoundCloud setup

Open `/soundcloud-setup.html` on your Rabbit Hole server. Register your own
SoundCloud application, copy the displayed redirect URI exactly, and configure
`SOUNDCLOUD_CLIENT_ID`, `SOUNDCLOUD_CLIENT_SECRET` and
`SOUNDCLOUD_REDIRECT_URI` in your private `.env`.
Restart Rabbit Hole, select Connect SoundCloud, continue to SoundCloud and
authorize your account.

This separate OAuth connection uses PKCE, expiring one-use state, and serialized
rotating refresh tokens. Tokens stay in ignored `data/soundcloud-auth.json`.
Lyrion plugin playback credentials are not reused. Playlist actions require the
developer application and account authorization; Lyrion playback has its own setup.

## Playlist actions

Create or find Synapse Finds reuses a uniquely named existing playlist.
New playlists default private. Creating a missing playlist requires an explicit
request. Actions can list/find/create playlists, read every page of tracks,
and add/remove exact URNs, IDs, permalinks or saved discovery references.

Additions avoid duplicates and preserve order. `recentCount` requires the
requested number of saved exact SoundCloud discoveries and fails if fewer exist.
Writes require the connected account to own the playlist.

Local writes serialize, complete track lists are checked, and an immediate
re-read detects intervening edits. SoundCloud playlist replacement has no atomic
compare-and-swap here: an external edit between checking and writing remains
possible. An uncertain write is not retried automatically; read current contents first.

Synapse routes explicit Lyrion/SoundCloud requests to the corresponding actions.
Refresh a cached MCP tool list after upgrading.

References: [SoundCloud API guide](https://developers.soundcloud.com/docs/api/guide)
and [official API schema](https://github.com/soundcloud/api/blob/master/openapi/api.yaml).
