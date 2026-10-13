# NASA photographs in the normal WhiteCap Background pool

## Current visual treatment — October 13, 2026

435 installed photographs are fixed and untinted, with the retained strong stellar
flares. Two reviewed separated cloud interiors have stronger bass/kick motion;
the original three-image tour uses those and a stable Deep Field. See
activation, validation and remask operations (private installation record; [published status and operating limits](../../docs/october-2026-update.md)).
Whole-photo deformation described in older reports is retired. New intake gets
stable photographs plus flares, never an automatic unreviewed cloud deformation.

Remasking: `node integrations/soundspectrum-nasa-backgrounds/layer-remask.cjs status`;
`run N` processes a bounded number under the existing pipeline/idle/storage guards.
No argument to run means a full foreground pass, not a scheduled/background daemon.
Cloud candidates require source-bound review/verification before activation. The
full pass is finished: 235 flare-only, 54 cloud candidates, 146 segmentation-gate
failures and zero unprocessed. Of the cloud candidates, 29 await native review,
19 were visually rejected and four have insufficient safe motion; two were
already installed. All 54 pass offline reconstruction/mesh checks. No new scenes
are installed or loaded. WhiteCap remains off while the user listens. Worker and
locks are released. See full review (private installation record; [published status and operating limits](../../docs/october-2026-update.md)). Terminal stopped
session errors no longer strand preparation: no native process, zero clients,
no active viewer and no unclean-shutdown error are required. Errors stay visible.
The full-collection remask allowance is now 48 GiB after a disk/retention audit;
the previous 20 GiB setting is saved privately. Intake remains separately paused.
Native tour reached approximately 120 fps; a normal-run startup clock timeout
caused safety fallback to approximately 64 fps and remains unisolated. Do not
report reliable end-to-end 120 or real-song synchronization from these tests.


## Historical whole-photo experiment — October 12, 2026

Superseded by the October 13 stable-photo correction above. The following records past installation and intake state, not current behavior.

Final production-tour native check: all three selected tour entries passed, including the formerly static deep field. Captured 696 frames; median draws 1.010/1.008/1.208 ms, p95 1.423/1.448/1.509 ms; mean native cadence approximately 120/119.99/119.99 fps. All 1,599 protected files were unchanged, the owned session stopped and temporary probe removed. The first tour attempt had omitted the explicit tour selection; the corrected run used nasa-layers and proved actual entry loading. Existing eight conservative-renderer Python tests were also rerun and pass (17 Python tests total this turn). All 420 installed ordinary scripts were checked to select ExpressiveSpaceBackground. The final hidden intake runner was restarted after tests; private intake-final logs carry its current state. Current real-song validation remains pending because the HQPlayer zone was stopped. No additional service restart or queue operation was performed.

User requested conspicuous artistic star motion/color and kick-driven cloud morphing on every image. Installed ExpressivePhoto.py across 420/420 ordinary NASA entries (135 conservative-mask reactive / 285 formerly static), plus the production three-image NASA tour. Source-bound offline feature maps drive a 25 × 15 image-deformation mesh and 24 colorful rotating/drifting stellar flares; original images and research segmentation are preserved. This is artistic image-space deformation of luminous structure, not semantic gas-only segmentation. Future intake is gated on expressive preparation; GOODS South field was admitted and installed automatically after activation. API coverage now separates universal expressive response from historical conservative-mask status.

Native controlled-audio 4K120 tests passed on three representative images, with roughly 1 ms median background draw time and approximately 120 fps native cadence. Captures show strong response; 1,597 protected files remained unchanged. Python 2's missing json module was found in native testing and removed from generated scripts. 58 Node pipeline tests + 2 tour installer tests + 9 new Python tests pass. Real-music validation is still pending: the configured Roon/HQPlayer zone was stopped, and no playback was started on the user's behalf. Native test sessions are stopped; installed effects load on the next normal Start Visuals. No app/MCP restart, vendor binary, queue, audio source, native clock or streaming rewrite. No staging/commit. Intake is resumed after native validation under the existing authorization. See docs/whitecap-nasa-expressive-20261012.md for native tour result, current intake checkpoint, activation and limitations. This supersedes older claims that production photos must remain stationary or that many installed NASA images are nonreactive.


Current October 12 content audit supersedes the historical counts below:
**323 installed scenes, 120 reactive / 203 ordinary**, with 118 anchored flare
scenes and 18 reviewed cloud-light scenes. Ninety visually confirmed press/event,
equipment or graphic entries were excluded without deleting source artifacts.
Publication now revalidates prior verified records against current subject and
source-hash review exclusions. Metadata qualification alone is not visual approval.
All installed hashes checked; 45 Node and 8 Python tests pass. Installation is
on disk and loads on next Start Visuals; no native launch was made for this update.
The 500-new-image trial remains paused at 302 valid new passes / 198 remaining
after the historical EPERM catalog rename failure. Acquisition was not resumed.
See content audit and audio coverage (private installation record; [published status and operating limits](../../docs/october-2026-update.md)).

The approved three-image layer pilot (private installation record; [published status and operating limits](../../docs/october-2026-update.md))
has a separate installed **NASA layers · 3 backgrounds** preset under **Visuals &
audio → WhiteCap theme**. Choose while stopped and Start visuals; Current custom
theme returns to the existing tour. Native startup/custom-theme files are preserved.
The owned `RabbitHole.NasaLayers.package` registers exactly three entries only in
that selected process. Two clouds deform; deep field stays the static control.
The artwork companion yields only background ownership to this selected rotation.

`layer-pilot/package.cjs` reuses prepared source-bound assets for the installer and
native test harness. It runs no new inference or acquisition. Private outputs stay
under `data/nasa-whitecap/layer-pilot/`; bulk/default publication remains disabled.
The three-image native loop/wrap and ordinary return were tested, with all 1,562
protected hashes unchanged. Focused tests and browser persistence pass; server/UI
selection is loaded and the temporary observer has been removed. See
selector operations, actual evidence and limitations (private installation record; [published status and operating limits](../../docs/october-2026-update.md)).

With visuals stopped, `node integrations/soundspectrum-nasa-backgrounds/layer-pilot/install-rotation.cjs`
inspects installed integrity; append `install` to explicitly install/update only
the owned separate package. `layer-pilot/verify-rotation.cjs` runs bounded native
generator QA; `--music` requires the configured zone playing. Keep normal NASA
publication and the paused collector independent. The normal pool uses the renderer below.

Latest renderer: stronger native FFT response on **129 masked scenes**, anchored
flares on **127**, and flowing cloud illumination on **18 reviewed scenes**.
The original photographs stay stable; the other **283 scenes are ordinary**.
Four native scenes passed a real-music test at existing production 4K settings.
Normal pool installed; temporary QA removed. See
visibility repair, measurements and remaining limits (private installation record; [published status and operating limits](../../docs/october-2026-update.md)).
Cloud movement is artistic illumination, not deformation of astronomical objects.
`motion.cjs prepare-response` prepares local reviewed light; `enable` installs
while idle. Automatic admitted stars inherit the active flare policy at future
publication. No additional acquisition, runtime analysis or wallpaper processing.

Current publication policy: **every verified image**, with automatic idle-only
publication after completion and on resume. Live `activeImages` is `"all"`;
`pipeline.cjs publish-all` initially installed 304 images (108 reactive, 196
ordinary photo scenes). The pool has since reached 412 (129 reactive, 283 ordinary).
New passes publish automatically while idle. See
continuous publication and validation (private installation record; [published status and operating limits](../../docs/october-2026-update.md)).
This supersedes the historical 24-image pool and wait-for-500 gate described below.
Do not run the legacy pruning `library.cjs` CLI against the expanded collection.

Windows desktop wallpapers are now exported separately after catalog verification.
The [isolated publisher](../nasa-wallpaper/README.md) copies finished 4K JPEGs;
Windows never reads this pipeline's runtime, masks or installed WhiteCap files.
This adds no NASA acquisition, processing, native rotation or playback settings.

Current: the explicit 500-passing-image qualification job uses `trial.cjs`.
The rolling request cap is 900/hour; progress survives restart. It does not alter
daily maintenance. The pipeline now publishes each pass without waiting for 500.
`motion.cjs` initially enabled stronger
source-bound star response and flares on 19 reviewed scenes; the latest renderer
extends flares to matching automatic receipts as described above. See
`scale and motion operations` (private installation record; [published status and operating limits](../../docs/october-2026-update.md))
for current status, actual tests, limitations, resume/finish and rollback.

Earlier baseline: all 19 cached NASA scenes have enabled native reactive layers. Cosmic
Cliffs is unchanged; 18 additions use explicit source-bound artistic profiles,
not relaxed unattended detection. `curate.cjs` prepares/reviews offline;
`reactive-library.cjs` promotes exact reviewed generations through this installer.
The existing four-layer renderer and delivery pipeline are unchanged.
See `docs/whitecap-nasa-curated-reactivity-20261011.md` for actual activation,
30 checks, short tablet performance evidence, per-image scope and rollback.
Older one-image/research-only descriptions below are historical stages.

The ordinary pool has no separate mode or webpage overlay. The opt-in three-image
selector above adds no second stream, decoder or audio consumer.
`RabbitHole.SpaceImages.package` registers ordinary native **Background**
entries. The existing artwork package's `background_names` tour interleaves these
among all other available, non-special-use backgrounds. With 83 native and 19 NASA
entries, one NASA image appears after four or five native backgrounds. Existing
20-second slots and 2-second transitions are unchanged; all original entries
remain. The separate current-artwork SceneInstance still draws after Background
and before the waveform. Its texture, identity validation, bass response, drift,
depth simulation and track-change behavior are unchanged.

The ordinary `Photo.py` includes the **installed WhiteCap** `Slideshow.lib.py` and uses its
`SlideshowImage` textured quad, alpha, camera, texture-coordinate interpolation
and image loading. Each entry loads only one local prepared JPEG and uses a
restrained 2.5% native zoom. The group handles crossfades. Photos do not invoke a
parallel slideshow, clock, timer or renderer. The optional identification label
is omitted to keep the composition clean. Factory packages are never edited.

Native scene includes can replace globals while an older scene still exists.
Keep the original Slideshow method bound to the subclass; never resolve a new
global `SlideshowImage` from the per-frame override. Constructors capture their
own asset paths and settings. Every generated reactive scene explicitly declares
its motion state, including disabled, so flares cannot leak from the previous
scene. See the class-identity repair and native evidence (private installation record; [published status and operating limits](../../docs/october-2026-update.md)).
The repair is installed for all 412 images. Seven native scenes passed, including
the reported Fornax image, forced class reloads and a reactive scene following
enabled flares. Test selection was removed; the full pool is ready on next Start.

Historical one-image stage: the Cosmic Cliffs prototype uses a fixed
photo and four precomputed native emission layers. It does not pan or zoom.
It remains the same Background entry in the same rotation. See
`whitecap-nasa-reactive-prototype-20261011.md` (private installation record; [published status and operating limits](../../docs/october-2026-update.md))
for architecture, measurements, limits and installation/disable commands.
`prototype.cjs prepare` needs Pillow and numpy and refuses active WhiteCap.
`prototype.cjs install` enables only Cosmic Cliffs; `prototype.cjs disable`
restores its ordinary photo implementation. No other NASA photo gains this
effect automatically, including future weekly additions.
Status at that earlier stage: built and native-tested, then disabled pending sender-failure
diagnosis/final validation. Ordinary NASA entries are restored. The sender also
failed in the restored baseline; no transport changes were made. Do not interpret
the prior NASA collection acceptance as acceptance of this enhancement.

## Official sources

The [NASA Image Library API](https://images.nasa.gov/docs/images.nasa.gov_api_docs.pdf)
offers search, asset manifests and metadata without embedding its webpage. Its
Webb search results were comparatively sparse. The
[Webb gallery](https://science.nasa.gov/mission/webb/multimedia/images/) is backed
by NASA Science image records. The selected 19 assets use NASA Science's public
WordPress media API and official `assets.science.nasa.gov` files. `seed.json`
contains exact IDs, source/API/asset URLs, target, title, mission, credit,
description, release date and source dimensions. These are NASA-hosted telescope
releases (often jointly credited NASA/ESA/CSA/STScI), not generated imagery.
Dates are identified as NASA media-record publication dates; a migrated record
does not establish the original telescope-image release date.

[APOD](https://api.nasa.gov/) was investigated but is not used: its mixed daily
selection can include video, amateur photographs and diagrams; it is a poorer
fit for unattended, uniformly high-resolution telescope imagery. NASA also
announces its legacy APOD API retirement on December 1, 2026. No API key or
third-party scraper is required for this collection. No browser fetches NASA.

## Historical seed preparation and installation

Run only while Rabbit Hole is idle and WhiteCap is closed. Both tools enforce
that precondition; neither stops playback or visuals for you.

```powershell
$env:RH_TEST_PYTHON = '<Python 3 executable with Pillow>'
node integrations/soundspectrum-nasa-backgrounds/library.cjs
node integrations/soundspectrum-nasa-backgrounds/install.cjs
node integrations/soundspectrum-whitecap-artwork/install.cjs install
```

Sources have 4K-or-larger dimensions. NASA's documented dynamic-image sizing
parameters request a 4800px-wide rendition to bound downloads; originals and
requested download URLs/dimensions remain recorded. Raster validation rejects
anything below 3840x2160, oversized/decompression-bomb images, unsupported
formats, oversized HTTP bodies and redirects outside the explicit NASA hosts.
Verified preparations are checkpointed individually, so a rejected source can be
replaced without re-downloading the successful collection. Offline preparation makes 3840x2160 high-quality JPEGs, preserving aspect ratio.
`contain` preserves complete objects with black side/top space for OLED;
`cover` is available per curated entry for suitable broad fields. No stretching
or invented imagery. The native small zoom occurs inside this prepared frame.

Cache: `data/nasa-whitecap/library/`. The manifest retains provenance, source and
prepared SHA-256, perceptual signature, dimensions, fit and dates. Raw temporary
downloads are removed after preparation. Identical source/asset/target and near
duplicate signatures are excluded. Default limits: 24 images, 256 MiB prepared
cache. `config.json` may set `maxImages` from 20–40 and `maxBytes` from 64–512 MiB.
The original curated 19 are pinned. Only unpinned oldest entries may be evicted;
an impossible pinned-size budget fails instead of deleting favorites. Only owned
content-addressed image files are eligible for cleanup.

The installer validates prepared hashes, refuses linked/edited/unowned package
files, builds a staging directory and keeps one previous installed generation.
The package directory is separate from factory backgrounds. Native changes load
on the next WhiteCap Start. No server restart or transport change is needed when
the already-attached artwork companion was installed before this update.

## Historical maintenance before the catalog pipeline

`maintenance.cjs` remains dormant without `stability.json` containing a recorded
successful `verified: true` check. After that check, `maintenance.ps1` can register
the owned, hidden, current-user daily task. The task checks local idle status,
then enforces **seven days between network attempts**. There is no network polling
while visuals run. One bounded metadata request searches releases from the last
60 days; at most two credited, high-resolution, unannotated Webb candidates are
prepared. Errors/429s stop the batch and defer another attempt for a week.
Downloaded images are admitted only after preparation and duplicate checks;
installations happen while idle and become visible on the next native start.

The automatic title/metadata filter is conservative, not a human visual curator.
Initial seeds are visually reviewed separately; annotated Centaurus A/Flame Nebula
images and false high-resolution records were excluded. Native display names use
ASCII-safe labels; original Unicode titles remain in the metadata. Maintenance uses the same native
entries and bounded pool; it never changes the video pipeline. The task uses the
current user's permissions (no elevation or credentials). An interrupted lock or
unowned/edited package requires inspection instead of destructive recovery.

## Verification

Conservative preprocessing candidate now lives in `preprocessing/` and
`preprocess.cjs`, with a dedicated isolated environment. It prepares immutable
offline masks only; neither this installer nor maintenance activates them.
See `docs/whitecap-nasa-mask-candidate-20261011.md` for setup, idle-only commands,
exact-key artistic review, static fallback, cache limits and actual validation.
Only Cosmic Cliffs passed offline artistic review. Its reviewed candidate is now
installed/enabled through the existing one-image override, at the user's request;
it loads on next Start visuals. Native/tablet validation remains pending.

Offline tool research (no installer/runtime changes): see
`docs/whitecap-nasa-mask-research-20261011.md` for Photutils/OpenCV comparison
results and StarNet limitations. The research environment is private and separate;
its research masks are not production assets. The later conservative candidate
is enabled for Cosmic Cliffs only; previous sender investigation remains unresolved.

```powershell
node --test integrations/soundspectrum-nasa-backgrounds/index.test.cjs integrations/soundspectrum-whitecap-artwork/index.test.cjs
& $env:RH_TEST_PYTHON -B integrations/soundspectrum-nasa-backgrounds/test_native.py 'C:/Program Files (x86)/SoundSpectrum/WhiteCap/Packages/WhiteCap.Background.package/Slideshow.lib.py'
```

See `docs/whitecap-nasa-backgrounds-20261011.md` for actual activation state,
asset contact-sheet review, native/receiver measurements and remaining work.
Do not interpret stub tests or an installed package as live tablet validation.

### Observation-only operations

`discoveryPolicy: "observation-galleries-v1"` is the default and deployed intake configuration. Hubble/Webb gallery pages are parsed as inert metadata, never evaluated. Only advertised JPEG/PNG assets are downloaded. Prefer the advertised 4K publication JPEG when its aspect ratio can retain the 2,160-pixel short edge; otherwise use the advertised larger JPEG. Actual raster dimensions are independently verified, never upscaled. Unclassified/Photograph/Illustration records, disallowed categories, untrusted hosts and subject/annotation exclusions do not proceed to image processing. Source classifications are a conservative metadata gate, not a new pixel-based person detector; keep visual review exclusions as a second defense. Broad-source compatibility requires explicit legacy configuration and is not used by the restarted job.

Resume the existing authorized intake with `node integrations/soundspectrum-nasa-backgrounds/trial.cjs resume --finish`; do not launch another runner while its PID/lock is live. Stop future work with the `pause` command. Each qualified addition publishes while idle; status differentiates installed assets from native-loaded visuals. Live progress is in the status endpoint and private trial-status.json; the total target remains 500 new passing images plus the 21-image baseline.

### Verified restart checkpoint

Live restart validation reached **303 new passes / 197 remaining**, plus 21 baseline images (**324 installed: 120 reactive / 204 static**). The first new addition, Hubble “Clusters within clusters” (potw1849a), is explicitly classified Observation; its advertised publication JPEG decoded at 4000 × 2250, passed preparation/mask checks, was visually inspected, and installed. All 1,148 installed member hashes matched. It is a static fallback, not a newly reactive scene. The runner remains active; native loading/live audio response were not tested. **56 intake/installer tests + 21 wallpaper/link tests pass**, with syntax checks. The shared wallpaper source-link validator now accepts only the four explicit ESA archive/CDN hosts in addition to NASA so provenance remains usable; that on-disk change is tested, with no refresh/service restart or claim it is loaded in an existing app process.
