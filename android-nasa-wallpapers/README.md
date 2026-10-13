# Rabbit Hole NASA for Android

A small native Android wallpaper app that reads the **existing finished NASA
wallpaper folder and catalog JSON over SMB3**. It does not call Rabbit Hole's
server, download NASA originals, control WhiteCap, process masks or maintain a
second metadata database. The voice app in `android-companion/` is independent.

## Connect the existing collection

In **Connection & slideshow**, enter:

| Field | What belongs here |
| --- | --- |
| Wallpaper folder | Full `smb://server/share/path` address of the dedicated finished wallpaper folder |
| Catalog data folder | Full SMB address of Rabbit Hole's `data` directory, not `catalog.json` itself |
| SMB username | The account authorized to read those Windows shares; it may differ from the profile folder name |
| SMB password | That account's password, not its Windows Hello PIN |
| Domain | Usually blank; for a local Windows account, the PC name can be used |

Both folders must be on the same server in this version. Spaces are accepted as
typed; UNC paths are also accepted. Do not embed credentials in a URL. No guest,
SMB1/2, DFS, anonymous authentication or automatic share creation is provided.
The account needs read access to both the share and the underlying folders.
Do not share `.env`, tokens or the entire repository merely to configure this app.

**Save & test connection** pauses rotation, reads both folders, verifies one JPEG
and loads a preview without changing the wallpaper. A blank password field on
later edits keeps the saved password. Error text distinguishes a rejected login,
missing share/path, read permission and unreachable server without logging secrets.

**Set wallpaper / Next wallpaper** changes the home screen immediately. Enable
**Also use on lock screen** to apply the same clean photograph to both screens.
Enabling it reuses the current cached image and crop immediately, without a
download or consuming another shuffle choice. Future manual and scheduled
changes update both screens together. Turning it off leaves the current lock
wallpaper in place and makes future changes home-screen only.
**Start slideshow** enables the chosen interval; **Pause slideshow** cancels future
work and leaves the current wallpaper. **Forget connection & clear cache** removes
the phone's saved settings/cache, leaving the PC and current system wallpaper alone.
The default is hourly shuffle with Wi-Fi-only fetching. New images enter the next
manifest refresh; unseen names are shuffled before repeating a cycle. A successful
wallpaper change alone advances the persisted shuffle history.

The preview/title opens **Image details**. The metadata is never burned into the
wallpaper. The app checks the home wallpaper and, when both screens were set,
the lock wallpaper for external changes; it then labels the retained image as
the last NASA wallpaper. No title or metadata overlay is added to the lock screen.

## Existing data contract

Paths below are relative to the configured catalog data folder:

1. `nasa-wallpaper/manifest.json` maps `NASA-<sha256>.jpg` to catalog IDs, exact
   published bytes, SHA-256 and 3840×2160 dimensions.
2. `nasa-whitecap/pipeline/assets/<id>/metadata.json` is the pipeline's existing
   per-record JSON, not a new export. The ID, verified stage, presentation hash
   and prepared `background-4k.jpg` hash must agree with the manifest/JPEG.
3. `nasa-wallpaper/source-links.json` contains the same canonical source-link
   validation decisions consumed by Windows. See the [shared resolver guide](../docs/nasa-source-link-validation-20261011.md).

The app never guesses a source URL from a title, provider, identifier or filename.
Only a fresh matching validation decision can open a NASA link. An official image
fallback is explicitly labeled **Open NASA image**. Expired/unknown decisions
produce explanatory text and no clickable bad URL; image rotation still works.

This reads a small manifest and selected metadata files, rather than the full
pipeline catalog. Original/source and retained dimensions are displayed separately.
Missing metadata is labeled, not invented. Lightweight HTML cleanup is presentation
only; JSON and remote images remain byte-for-byte unchanged.

## Storage, background work and privacy

- At most three hash-verified 4K JPEGs, each at most 16 MiB, plus their existing
  metadata are retained in private app storage. One download can temporarily add
  up to 16 MiB. The manifest and source-link cache are each limited to 8 MiB;
  individual metadata is limited to 256 KiB. No full-library download.
- Private staging and atomic renames prevent interrupted downloads from becoming
  wallpaper. The current image is protected while one future image is prefetched.
  Offline rotation can use another verified cached image; otherwise it keeps the
  current image. PC originals are opened read-only over signed, encrypted SMB3.
- Crop maintains aspect ratio and estimates a focus from brightness/detail with a
  centre bias; it is not object recognition. **Fit the whole image** uses margins.
  Android receives a portrait bitmap capped at 2160×3840; source files are unchanged.
- Native `JobScheduler`, persisted at reboot, with battery/storage-not-low
  constraints. Intervals are 15 minutes through one day, without exact alarms or
  an always-running foreground service. Android/Samsung may delay jobs. Wi-Fi-only
  sockets bind to the selected Wi-Fi network and cannot fall back to mobile data.
- A single worker prevents overlapping changes. Pause cancels active reads and
  checks cancellation again before applying a wallpaper. A failed first Start
  pauses instead of repeatedly retrying a rejected connection.
- Settings and credentials are encrypted using Android Keystore AES-GCM. No
  credentials in code, URLs, logs, backups or device-test fixtures. Settings blocks
  screenshots/autofill/state saving. No analytics, ads, cloud account or web runtime.

Version 0.2.0 supports home-only or the same image on home and lock screens. Both
screen updates passed the S24 Ultra device test, and the user confirmed the image
appears on the lock screen. Long-duration Samsung sleep behavior, reboot and
physical Wi-Fi-loss recovery remain unverified. No workaround service or battery
exemption has been installed.
The PC/share must be reachable for fresh images. Android's force-stop prevents
scheduled work until the app is opened again; Pause is the normal control.

## Build and verification

Requires JDK 17 and Android SDK platform/build-tools 35. Set `JAVA_HOME` and
`ANDROID_HOME` locally; do not commit SDK paths or signing keys. Minimum Android
12/API 31; compiled/targeted API 35 and device-tested on Android 16/API 36.

```powershell
.\gradlew.bat :app:testDebugUnitTest :app:lintDebug :app:assembleDebug :app:assembleDebugAndroidTest
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Application ID: `house.rabbithole.nasa`. This is a sideloaded **debug build**, not a
Play Store release. Keep the same local debug signing key for compatible updates.
Gradle wrapper/checksum are pinned; dependencies are SMBJ and an inert SLF4J
implementation. Tests use JUnit/AndroidX; the production UI uses native Views.

25 unit tests cover exact identity, malformed data, paths, bounded/cancelled copies,
cache interruption/tampering, shuffle persistence and aspect-preserving rendering,
and shared source-link decisions. Lint reports zero errors; remaining warnings are
durable SharedPreferences commits, English-only UI text and a guarded API attribute.

Device tests require saved settings entered **on the phone**. The real source-link
test consumes a private fixture made from existing metadata/receipts; it contains
no credentials. The wallpaper-changing acceptance test requires the explicit
`-e exerciseWallpaper true` argument. The both-screen acceptance test requires
`-e exerciseBothScreens true`; it checks current-image reuse, persistent targeting,
disabling without changing the lock image, the next shared image and preserved
settings/slideshow state. UI captures require `-e captureUi true` and render only
this app's own views, never other apps or settings secrets.

[Actual installation, checks and remaining work](../docs/android-nasa-wallpapers-20261011.md).
Scheduling behavior follows Android's [periodic job API](https://developer.android.com/reference/android/app/job/JobInfo.Builder#setPeriodic(long));
wallpaper application uses [WallpaperManager](https://developer.android.com/reference/android/app/WallpaperManager).
