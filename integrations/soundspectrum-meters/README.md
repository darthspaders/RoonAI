# Rabbit Hole native meters

An independent, removable G-Force package containing original line geometry
inspired by three supplied meter references. The app does not import this module.
It adds native WaveShapes to the existing `Rabbit Hole - darthspader` category.

| WaveShape | Reactive behavior | Optional matching ColorMap |
| --- | --- | --- |
| Rabbit Hole - Emerald VU | Curved scale and one smoothed music-level needle | Green/red scale, amber needle and white labels |
| Rabbit Hole - Twin Cyan VU | Two smoothed needles representing low/high frequency activity | Cyan face and white needles |
| Rabbit Hole - Prism Spectrum | 26 columns of individually gated LED segments | Cyan, green, yellow and red levels |

These are native WaveShapes, not still-image overlays. Geometry uses independent
line segments and a small original stroke alphabet. Signal controls are sampled
and smoothed in the native expressions; silence lets needles and bars settle.
The supplied photographs are visual references, not the source of sampled pixels
or copied installed geometry.

## Colors and measurement limits

G-Force applies one shared ColorMap to WaveShapes, particles and flow trails.
`Pen` specifies intensity rather than independent RGB. Adding a WaveShape to
rotation does not automatically select its matching map. This installer preserves
the user's existing theme ColorMap selection and timing. Select the same-named
ColorMap manually for the reference colors, or run the optional same-named script
from G-Force's Scripts menu to start both together. The scripts do not disable
slideshows; the existing rotation resumes on its normal schedule. A shared map
also affects the other native elements on screen.

The HQPlayer analysis feed is an isolated visual analysis signal. These designs
are visual indicators, not calibrated electrical VU meters, true left/right
channel measurements or exact-frequency laboratory instruments. The twin face
uses LOW/HIGH labels for that reason. Current FlowFields and particles can add
trails and visual motion to the meter faces, as with other built-in WaveShapes.

Official references: [config programming](https://www.soundspectrum.com/g-force/Documentation/config-programming.html),
[shared rendering palette](https://www.soundspectrum.com/g-force/Documentation/background.html),
[scripting](https://www.soundspectrum.com/g-force/Documentation/scripting.html).

## Generate and check

```powershell
node integrations/soundspectrum-meters/generate.cjs
node --test integrations/soundspectrum-meters/*.test.cjs
node integrations/soundspectrum-meters/install.cjs plan
```

SVG previews are geometry previews with synthetic audio values, not captures of
G-Force or proof that the native expressions compile. Actual renderer verification
requires installation followed by the explicit generator-only QA below.

## Install

First stop visuals on every Rabbit Hole page and close G-Force Standalone and
Toolbar. Music playback may continue. Then run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File integrations/soundspectrum-meters/install-windows.ps1 -Action install
```

Windows asks for administrator access because G-Force loads its package from
Program Files. Run the prompt as the same Windows account that uses G-Force.
The helper writes its result to the private `data/soundspectrum-meters-installer.log`.

The installer:

- Copies only the allowlisted new `RabbitHole.Meters.package` files and three
  optional, manually invoked scripts.
- Appends the three exact WaveShape names to the user's existing custom category,
  preserving other members, exclusions and unrelated fields.
- Journals file hashes, the original category and the names it actually added
  under private `data/soundspectrum-meters-install.json` before target changes.
- Rejects conflicts and requires G-Force/Toolbar to stay closed during writes.
- Leaves the original Darthspader package and its ownership manifest, the theme,
  slideshow preferences, particles, persistent artwork, audio and video untouched.

Restart visuals using the usual input/transport. The three new shapes are eligible
for the existing WaveShape slideshow; no Rabbit Hole server restart is required.

For a later preset correction, use `install.cjs plan-update` to review old/new
hashes, then the Windows helper with `-Action update` while G-Force and Toolbar
are closed. Updating requires unchanged owned files and the same allowlisted
file set; it backs up replaced files and journals the intended hashes before
copying. It does not rewrite the category, theme or preferences.

## Explicit native QA

Only run while G-Force and Toolbar are closed. This test uses G-Force's own
no-microphone generator. It never opens HQPlayer, Lyrion or ASIO audio streams.

```powershell
node integrations/soundspectrum-meters/verify-native.cjs "Rabbit Hole - Emerald VU"
node integrations/soundspectrum-meters/verify-native.cjs "Rabbit Hole - Twin Cyan VU"
node integrations/soundspectrum-meters/verify-native.cjs "Rabbit Hole - Prism Spectrum"
```

Each bounded test uses exclusive temporary user categories/theme, a private
preference backup and the existing renderer ownership helper. It captures the
actual owned G-Force window, then stops that renderer and restores settings.
Startup transitions and config preparation are temporarily set to zero so the
test shows the selected face rather than a long transition. Production timing is
restored byte for byte. Capture thumbnails are 960×540 JPEG at 20 fps; these test
images do not measure the production OBS/WebRTC resolution or frame rate.
Captures and reports are private under `data/soundspectrum-meters-qa/`.
Inspect the saved images for the intended design and config errors; changing
JPEG checksums alone do not prove that a specific shape rendered correctly.

To check the existing 4K borderless startup path without OBS or music audio, run:

```powershell
node integrations/soundspectrum-meters/verify-native.cjs "Rabbit Hole - Prism Spectrum" 18000 generator:high-energy normal 4k
```

Native strokes use a nominal 720-pixel reference and an empirically checked
thickness factor. G-Force's existing AutoLineScale supplies resolution scaling;
the preset does not multiply by live frame height a second time. Large manual
line-width preferences or animated FlowFields can still alter the appearance.

## Remove

Stop visuals and close G-Force/Toolbar, then use the same helper with
`-Action remove`. Removal deletes only unchanged owned files and removes only
category names that this installer added. Subsequent user additions to the
category are preserved. Edited owned files are reported and left for review.
The original Darthspader preset remains installed.
