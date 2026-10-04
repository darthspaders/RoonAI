# Linux, Docker and Unraid

The public repository includes Lyrion playback alongside the independent Roon
path. Use the app-only server on Linux; the Windows combined-service supervisor
expects a separate `rabbit-hole-mcp` checkout.

## Supplied Docker image and Compose file

The Dockerfile uses Node 24 on Debian, installs FFmpeg/FFprobe, and runs
`node src/server.js` as UID/GID 1000. The build context excludes credentials,
databases, caches and personal files. SoundSpectrum, Python, CUDA and learned
model weights are optional external runtimes and are not installed in this image.

```sh
git clone https://github.com/darthspaders/RoonAI.git
cd RoonAI
cp .env.example .env
```

Edit `.env` with your own LMS address and model settings:

```env
PORT=3777
HOST=0.0.0.0
LYRION_URL=http://127.0.0.1:9000
# Optional: LMS HTTP authentication, not your music-service login.
LYRION_USERNAME=
LYRION_PASSWORD=
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=YOUR_INSTALLED_MODEL
AI_MODE=local
```

Use the model server's reachable LAN address when it runs elsewhere. Player
controls work without a model server. Install and sign into music-service
plugins in LMS itself.

```sh
docker compose up -d --build
docker compose logs --tail=100 rabbit-hole
```

Open `http://YOUR_SERVER_IP:3777`, choose **Lyrion**, then select a connected LMS
player. An existing HQPlayerBridge player can be selected directly. For Roon,
enable **The Rabbit Hole** in Roon Settings → Extensions and select your zone.

After changing `.env`, use `docker compose up -d` to recreate the container with
the updated environment. To update source, pull the repository and run
`docker compose up -d --build` again. A Rabbit Hole restart interrupts audio
relayed by Rabbit Hole and stops station replenishment; ordinary LMS plugin
playback remains owned by LMS.

## Networking and LMS location

The supplied Compose file uses **Linux host networking**. This preserves Roon
LAN multicast discovery and lets same-host LMS access Rabbit Hole's local audio
relay. Port 3777 must be free on the host; host networking does not use a Docker
`ports` mapping. The browser UI is intended for your trusted LAN.

| LMS deployment | LYRION_URL | Basic controls | Extra SiriusXM relay |
| --- | --- | --- | --- |
| Same host, native or host-network container, HTTP 9000 | `http://127.0.0.1:9000` | Yes | Yes |
| Same host but isolated bridge container | Reachable published HTTP address | Yes | Requires a shared loopback topology |
| Another computer | `http://LMS_LAN_IP:9000` | Yes | Unavailable with the current local-only relay |

The optional SiriusXM shows/artist/Xtra routes are loopback-only. A remote LMS
host cannot consume them by changing a base URL; ordinary live plugin playback
and controls still work remotely. When these routes are needed, Rabbit Hole and
LMS must share the Linux host's loopback namespace. Keep HQPlayerBridge/HQPlayer
configured in LMS as before. Rabbit Hole does not install the bridge or open
a second bridge playback stream.

For optional authenticated SiriusXM catalogue features, configure your own
`SIRIUSXM_USERNAME` / `SIRIUSXM_PASSWORD`. Alternatively, mount your LMS plugin
preferences file read-only and set `SIRIUSXM_LYRION_PREFS` to its container path.
These variables are separate from LMS HTTP authentication. See the
[Lyrion guide](lyrion.md) and [SiriusXM playback guide](../SIRIUSXM_ON_DEMAND.md).

Buffered SiriusXM live-song alignment can read the native plugin's advancing
`pdt_CHANNEL.txt` files from `/tmp/siriusxm`. Separate LMS/Rabbit Hole containers
do not share `/tmp` automatically. If the installed plugin publishes those
timestamps, mount its actual timestamp directory read-only at
`/tmp/siriusxm` in Rabbit Hole. Without fresh timestamps, Rabbit Hole retains LMS
song metadata and channel-art fallback. Basic playback does not need this mount.

## Persistent private state

Compose stores `/app/data` in the `rabbit-hole-data` named volume. The image
links `/app/config.json` to `/app/data/config.json`, so Roon pairing is persistent
along with favorites, ratings, tokens and databases. `.env` remains on the host
and is supplied to the container. Ordinary rebuilds and container replacements
retain this state; deleting the named volume removes it.

Run only one Rabbit Hole instance per data volume. The process lock does not
provide distributed locking between containers with separate PID namespaces.

Back up `.env`, the data volume and any existing `config.json` privately.
For an existing installation, stop its Rabbit Hole process/container before
copying SQLite databases or pairing files. Keep LMS/HQPlayer running if they
are independent services. Then create the new container without starting it:

```sh
docker compose create rabbit-hole
# Only copy files that exist in your old installation:
docker compose cp ./data/. rabbit-hole:/app/data/
docker compose cp ./config.json rabbit-hole:/app/data/config.json
docker compose run --rm --user 0 --entrypoint sh rabbit-hole \
  -c 'chown -R 1000:1000 /app/data'
docker compose up -d
```

Copy your old `.env` settings into the new host `.env` before creating the
container. The copying commands do not start the app. The ownership command
prepares the private volume for the image's Node user. Without an old pairing
file, enable the extension in Roon again.

On Unraid, you may replace the named-volume mapping with an appdata bind mount,
such as `/mnt/user/appdata/rabbit-hole/data:/app/data`. Create that directory and
give UID/GID 1000 read/write access before starting the container. Preserve your
existing private files when updating. Do not put a private `.env` or data
directory in the image build context.

## Update and recover after a crash

Version **0.2.1** automatically recovers known stale startup locks after a crash
or container replacement when their old owner can be identified as no longer
running. Update the source and rebuild while retaining the existing private
volume:

```sh
git pull
docker compose up -d --build
```

Keep the same data-volume mapping; do not delete the volume or use
`docker compose down -v`. Pairing, favorites, tokens and databases stay in it.

An unknown owner or invalid lock record conservatively blocks startup. If manual
recovery is needed, first stop every Rabbit Hole process/container using that
volume and confirm no lock owner remains running. Only then remove the stale
`/app/data/rabbit-hole.app.lock` file from the persistent data and start the app
again. Preserve the rest of the data.

## Existing node:22-slim Unraid template

You can retain a source bind-mount installation instead of the supplied image:

1. Update the source checkout and run `npm ci` in the project directory.
2. Use **Node 22.13.0 or newer**; Node 24 is recommended. Current storage uses
   built-in SQLite, which is unavailable without a flag on older Node 22 builds.
3. Set the working directory to the source checkout and the command to
   `node src/server.js` (or `npm run start:app`). Do not use the combined
   `npm start` without its separately installed sibling MCP repository.
4. Keep the source, `.env`, `data/` and `config.json` mounts persistent. In this
   layout the SDK still stores `config.json` in the source working directory;
   the supplied Docker image's symlink is specific to that image.
5. Use host networking for Roon discovery and same-host SiriusXM relays. For
   ordinary controls alone, set `LYRION_URL` to the reachable LMS HTTP address.
6. Install FFmpeg/FFprobe in a custom image if you need optional audio decoding;
   a stock `node:22-slim` image does not include them.

No Windows PowerShell launcher is required for basic Linux Lyrion playback.
Optional learned sonic workers need their separately documented environment.

## Check the setup

- Confirm the LMS web interface is reachable from the Rabbit Hole network
  namespace. LMS HTTP 401 means its separate username/password is needed.
- Confirm Rabbit Hole lists a connected LMS player. HQPlayerBridge availability
  is established in LMS, not by Roon extension pairing.
- Test a source already working in LMS before adding optional catalogue logins.
- If Roon is missing, confirm host networking, same-LAN discovery and extension
  approval. A disconnected Roon path does not disable Lyrion controls.
- If data writes fail, check access to `/app/data` for UID/GID 1000. Repeated
  extension approval after every update indicates an unpersisted pairing file.

The image has an HTTP health check. It checks the web server, not your LMS
subscription, Roon pairing or audio output. The main browser routes have no
built-in user login; protect them with your own authenticated access layer if
you make the server reachable outside your LAN. `/mcp` has its own configurable
token and is a separate interface.
