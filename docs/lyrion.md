# Lyrion playback and HQPlayerBridge

Rabbit Hole controls an existing **Lyrion Music Server (LMS)** using its HTTP
JSON-RPC API. LMS remains responsible for its players and installed service
plugins. This path works independently of Roon pairing and preserves the exact
source IDs, URLs and commands returned by LMS.

## Connect LMS

Set the LMS web address in Rabbit Hole's `.env`, then restart Rabbit Hole:

```env
LYRION_URL=http://127.0.0.1:9000
LYRION_USERNAME=
LYRION_PASSWORD=
```

Use the reachable LMS host address if LMS runs elsewhere. The address must be
the HTTP web interface, typically port 9000, rather than the CLI port 9090.
When LMS requires HTTP authentication, enter its username and password in the
two separate variables. Rabbit Hole sends HTTP Basic authentication to LMS
from the server; these credentials are not sent to the browser.

For Docker, see [the host-network setup](linux-docker.md). A bridge-network
container's `127.0.0.1` refers to that container, so an existing bridge-network
installation needs its reachable host/LMS address for ordinary controls.

Open Rabbit Hole and choose **Lyrion** in **Playback system**, then select a
connected player. The selector changes the visible interface without starting
playback. Roon and Lyrion retain independent selections and queues.

## Browse and play

The Lyrion interface has Now playing, Channels, Shows, Artist stations, Xtra
channels, Sources and Queue views. Browse or search Sources to reach your local
library, radio menus and installed LMS apps. Install and sign into subscription
plugins in LMS first. Some menus return another browse/search category; open it
before selecting playable results.

- **Play now** replaces the selected LMS player's queue and starts that exact
  source. Rabbit Hole pauses the other playback frontend during this handoff.
- **Play next** and **Add to queue** preserve the queue and do not take ownership
  of the other frontend.
- Transport controls, queue rows and artwork use LMS state. Live streams may
  have no duration or seek support.
- Saving favorites never starts playback. SiriusXM channels, artist stations
  and Xtra channels have their own Rabbit Hole favorites.

Browse/play actions use player-bound handles issued by the server. Expired
results must be browsed again. Lyrion results do not become verified Roon/TIDAL
identities or automatically enter Roon's Discovery 100 scoring path.

## HQPlayerBridge

When your selected LMS player is HQPlayerBridge, the control and audio paths are:

```text
Rabbit Hole browser → Rabbit Hole server → LMS playback command
LMS plugin/source → HQPlayerBridge → HQPlayer → existing audio output
```

Keep the working HQPlayerBridge/HQPlayer configuration in LMS. Rabbit Hole
selects and controls the player; it does not install the bridge, open a second
bridge playback stream or reroute ASIO/DSD output. External Roon/LMS clients can
still start playback independently, so a Rabbit Hole handoff cannot enforce a
global exclusive lock inside those applications.

## Optional SiriusXM features

Ordinary live-channel playback uses your installed LMS SiriusXM plugin.
Rabbit Hole adds favorites, schedule/current-song metadata and exact channel-logo
fallback. Buffered song alignment uses advancing timestamps from that plugin;
without those timestamps, it retains LMS song metadata rather than guessing.
See [live metadata](../SIRIUSXM_METADATA.md).

Shows, personalized artist stations and Xtra channels use a separate
authenticated SiriusXM catalogue connection. Configure:

```env
SIRIUSXM_USERNAME=YOUR_SUBSCRIBER_LOGIN
SIRIUSXM_PASSWORD=YOUR_SUBSCRIBER_PASSWORD
```

Alternatively, `SIRIUSXM_LYRION_PREFS` can point to a readable LMS SiriusXM
preferences file. Its default path is the Windows LMS installation path;
Linux users must provide their own path or the two variables above. These
credentials are distinct from `LYRION_USERNAME` / `LYRION_PASSWORD`.

These additional audio routes use FFmpeg and a **loopback-only relay**. LMS
must be on the same host and share loopback access, such as Linux host-network
containers. A remote LMS server can use ordinary plugin playback, but cannot
consume this relay. Artist/Xtra tracks finish validated decoding before playback
and retain exact per-track identity. Their first playback can wait for that
preparation. Restarting Rabbit Hole interrupts an active relay and ends automatic
station replenishment. See [shows and station playback](../SIRIUSXM_ON_DEMAND.md)
for source quality, seeking and retry limits.

## Optional SoundCloud playlists and visuals

SoundCloud playback uses the LMS plugin. Rabbit Hole's playlist-management
connection is separate OAuth and needs your own application credentials and
registered callback. See [SoundCloud setup](../LYRION_SOUNDCLOUD.md).

The SoundSpectrum renderer is optional and requires Windows plus installed
licensed Standalone apps. It is unavailable in Linux Docker. Separate removable
[Lyrion audio-feed](../integrations/soundspectrum-audio-feed/README.md) and
[Roon/HQPlayer analysis](../integrations/soundspectrum-hqplayer-feed/README.md)
modules document the additional Windows prerequisites; basic LMS/HQPlayerBridge
playback needs neither.

Protocol references: [LMS CLI](https://lyrion.org/reference/cli/using-the-cli/)
and [SlimBrowse](https://lyrion.org/reference/slimbrowse/).