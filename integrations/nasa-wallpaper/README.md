# Isolated Windows NASA wallpapers

The separate [desktop information helper](../nasa-wallpaper-info/README.md) reads
this publisher's manifest and the existing NASA catalog to show the current image's
title at the desktop's top-right. It is installed/running independently, with
details on deliberate interaction. It does not modify this exporter or any images.

Publishes finished images from Rabbit Hole's existing NASA catalog. This is a
file exporter, not another downloader, image processor, visualizer or slideshow
engine. Windows owns the desktop slideshow.

The dedicated folder is `%USERPROFILE%\Pictures\Rabbit Hole NASA Wallpapers`.
It contains only complete 3840×2160 presentation JPEGs. Publisher state and
temporary files live under the main repository's ignored `data/nasa-wallpaper/`.
Never select a WhiteCap package, background, runtime, library or pipeline folder
as the Windows slideshow source.

The separate [Android app](../../android-nasa-wallpapers/README.md) reads this
finished folder and the existing manifest/per-record JSON through SMB3. It does
not add files here or alter publishing. Windows and Android share the derived
`data/nasa-wallpaper/source-links.json` validation decision for official links;
see source-link operations (private installation record; [published status and operating limits](../../docs/october-2026-update.md)).
That metadata receipt stays outside the image-only slideshow folder.

## Publication

`Pipeline.process()` calls the exporter only after the verified catalog entry
is saved. Pipeline startup and the one-off trial's resume also reconcile the
finished catalog, so a crash between verification and publication is recoverable.
The existing daily maintenance process loads this hook on its next invocation;
no second schedule, service, filesystem watcher or server restart is needed.

An entry must pass the existing source eligibility policy, be `verified`, have
matching preparation/mask receipts and presentation SHA-256, and contain a valid
3840×2160 JPEG. Only `background-4k.jpg` is copied. Masters, masks, flares, PNG
emissions, receipts and metadata stay out of the Windows folder.

The exporter writes a new physical file into private staging, flushes and
rehashes it, then renames it onto the same volume into the slideshow folder.
Windows never sees a `.part` file. Content-addressed filenames deduplicate exact
bytes. There are no hardlinks, junctions or symlinks to WhiteCap or the catalog.
WhiteCap reads its own installed copy; Windows reads the exported copy.

A separate PID lock prevents competing publishers. Interrupted staging stays
private; exact checksum-matching published orphans can be recovered. Full sync
moves only unmodified, owned copies that no longer qualify into private
`withdrawn/`, retaining all original catalog assets. User-added or edited files
are preserved and reported as errors. Keep this folder dedicated to the exporter.
Publication errors are recorded without failing NASA processing or controlling
WhiteCap. The existing NASA processing/installation idle guard is unchanged.

## Controls

Run from the main repository:

```powershell
node integrations/nasa-wallpaper/publisher.cjs enable
node integrations/nasa-wallpaper/publisher.cjs sync
node integrations/nasa-wallpaper/publisher.cjs status
node integrations/nasa-wallpaper/publisher.cjs disable
```

`enable` enables automatic publishing and exports the finished catalog; `sync`
reconciles it without downloads, processing or native installation. `disable`
stops future publication, retaining existing wallpapers and Windows settings.
To stop desktop rotation, separately choose Picture in Windows Settings →
Personalization → Background. Re-enabling catches up from the existing catalog.

Private `config.json`, `manifest.json`, `status.json`, staging and withdrawn
files must never be placed in the slideshow folder. Status describes publishing,
not proof of Windows configuration or a live WhiteCap session. An enabled exporter
does not override a disabled, paused or stopped NASA collector.

## Windows setup and validation

Select Slideshow, choose ONLY the dedicated folder, set 10 minutes, Shuffle on,
and Fill. No source-image resizing or rewriting is required. Windows maintains
its own wallpaper cache independently.

See activation and verification (private installation record; [published status and operating limits](../../docs/october-2026-update.md))
for current installation, live checks and limitations. Run the focused suite with
`node --test integrations/nasa-wallpaper/publisher.test.cjs`; fixture tests cover
atomic publication, interruption recovery, validation, physical independence,
deduplication, disabling and nonfatal integration errors.

### October 12: observation-gallery source compatibility

The WhiteCap intake now discovers only categorized Hubble/Webb observations. The shared source-link validator accepts esahubble.org, cdn.esahubble.org, esawebb.org and cdn.esawebb.org explicitly, preserving recorded URLs and existing redirect/credential checks. Arbitrary subdomains remain refused. All 21 publisher/link tests pass. Change is on disk; no wallpaper refresh, existing export rewrite or service restart was performed for this compatibility update. See the NASA content audit for intake activation and remaining work.
