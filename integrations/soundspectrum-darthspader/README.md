# Darthspader for G-Force

An original lowercase **darthspader** WaveShape, packaged as an optional,
removable add-on. Each letter outline is real native drawing geometry. G-Force's
signed audio waveform and frequency spectrum bend different parts of the
outlines directly. Bass also brightens/thickens them.
The matched purple/lilac ColorMap and neutral FlowField keep the word centered
and readable. This is not a raster text overlay.

The add-on does not import into Rabbit Hole or Roon Visualizer and does not
restart either service. Both applications already launch the installed G-Force
Standalone engine; their existing video capture carries its rendered picture to
phones and tablets. This add-on adds no audio consumer or audio route.

The first version was installed and visually verified on October 4, 2026 with
G-Force 5.9.7. The direct waveform/spectrum revision is also installed and native
verified. A 55-second High Energy generator capture rendered the full word with
local outline deformation at 800x450/JPEG65 and delivered 30 fps after startup.
Its owned renderer/capture stopped and exact standalone preferences were
restored. The actual revised recording is
`preview/darthspader-native-reactive.gif`; the earlier first-version picture is
`preview/darthspader-native.jpg`. A physical tablet and live music feed were not
opened for these tests.

## Install and use

Stop any G-Force visualizer window first; music can remain playing. Open
PowerShell in this folder and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-windows.ps1
```

Approve the Windows administrator prompt on the PC. Program Files requires that
access. The helper uses the same Windows account, installs only this owned
package and profile files, and records the former G-Force startup theme.

In Rabbit Hole or Roon Visualizer, choose **G-Force**, choose the desired existing
audio input, and press **Start**. G-Force uses **Rabbit Hole - darthspader** as its
startup theme. A music-analysis input reacts to the existing feed; a no-mic
generator produces simulated movement and does not listen to the music.
G-Force's existing startup transition briefly zooms/distorts the picture before
the word settles (about 20 seconds in the local test).

G-Force's own theme picker can select **Rabbit Hole - darthspader** or another
installed theme. Aeon and WhiteCap are unaffected. Choosing this theme does not
start playback or a visualizer by itself.

To update an existing owned installation:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-windows.ps1 -Action update
```

The updater backs up changed package files under ignored
`data/soundspectrum-darthspader-updates/`, replaces only owned configs, and leaves
preferences and the original removal history intact. It refuses edited files
and can resume an interrupted update. Restart the visualizer to load the updated
config; music and the web services can remain running.

### Editable Particles and Sprites

For an existing installation, add the missing editable categories with:

```powershell
node .\install.cjs add-categories
```

This writes only the two missing per-user category files and extends the
ownership record. It needs no administrator prompt and preserves existing theme
edits, preferences and category selections. It can run while G-Force is open;
close and reopen G-Force afterward to reliably load the new category rows.

In **Particles** or **Sprites**, open the category list, find **Rabbit Hole -
darthspader**, and choose its **Edit** row. Each starts with no members; the native
editor offers the installed effects so you can choose which ones belong. The
same named category is also available in the theme editor. Membership and theme
selection are separate: adding an effect to a category does not enable that
category in your current theme. These are editable groups for existing effects;
the add-on's custom lettering remains a WaveShape.

The theme's Particle selection should be `+Rabbit Hole - darthspader`, with
`(All)` left unmarked. An excluded `(All)` blocks every particle, including
members of an included custom category. The October 6 correction removes that
conflicting Particle exclusion; it preserves existing category members, timing,
Sprite rules and the separate album-art companion. The installed user's theme
was backed up before its one-line edit. Its ownership hash remains unchanged so
removal continues preserving that user-edited theme.
The user then confirmed active particles in the custom theme; the working
album-art/text companion remained healthy.

The Particle slideshow must also be on. The user's existing startup setting is
enabled with a 60-second interval; allow about 90 seconds after starting for a
particle to become visible. Particle duration controls how long each runs, while
slideshow interval controls how often a new one starts. Fresh installs use the
custom Particle category directly; an empty category still produces no particles
until members are selected. Sprite selection is independent.

## Remove

Stop the G-Force visualizer, then run:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-windows.ps1 -Action remove
```

Removal checks its ownership record and file hashes. It restores the previous
startup theme if the add-on's theme is still selected, and preserves later audio
settings, other selected themes, unrelated files and edited add-on files.
If edited files are preserved, the command reports their names for review.

Installed locations:

- `C:\Program Files (x86)\SoundSpectrum\G-Force\Packages\RabbitHole.Darthspader.package\`
- `%APPDATA%\SoundSpectrum\G-Force\Categories\{WaveShape,ColorMap,FlowField,Particle,Sprite}\Rabbit Hole - darthspader.txt`
- `%APPDATA%\SoundSpectrum\G-Force\Themes\Rabbit Hole - darthspader.txt`

The ownership record and installer log live in Rabbit Hole's ignored `data/`:
`soundspectrum-darthspader-install.json` and
`soundspectrum-darthspader-installer.log`. Keep the record until removal finishes.
Factory configs, licensing data and audio-device settings are not installation
targets. The source folder can be deleted after removal.

## Development and verification

The source is original geometric lettering, with no font extraction or copied
factory visual. The generator has no external dependencies:

```powershell
node generate.cjs
node --test geometry.test.cjs install.test.cjs
```

There are 17 closed contours, including six counters; native drawing uses 2,720
points per frame. Static matrices load once, cached row views select the contour,
and native `map1D` evaluates the samples. A shared 48-control field combines
soft-clipped signed PCM (up to `.28` glyph units) and mirrored frequency-band
contrast (up to `.10`). A three-tap spatial filter rounds sharp spikes. Every
point receives the same vertical displacement as other points at its original
horizontal position, so counters warp with their outlines and letter spacing
stays fixed. Maximum displacement is `.38` glyph units, with no clock-driven
shape motion; silence leaves the geometry unchanged. Native drawing fits the
entire deformation inside the window, with stroke width bounded to 1.8 pixels.
The geometry previews under `preview/` are labeled synthetic; files named
`darthspader-native*` come from actual G-Force capture.

`verify-native.cjs` is an explicit, bounded Windows QA command. It launches one
test-owned G-Force window with a no-mic generator, captures only that window
through the existing Windows Graphics Capture pipeline, then closes its own
renderer and restores its original preferences. It never starts music or opens
the HQPlayer/Lyrion analysis feed. Native captures and reports go to ignored
`data/soundspectrum-darthspader-qa/`. Frame changes alone do not prove that the
letters loaded: inspect the captured image before accepting native verification.

The installation-folder requirement was checked against the installed loader.
A per-user package probe did not render the effect. Moving the standalone EXE
alone also does not relocate its engine: it still loads the installed DLL.
Those probes are not supported deployment methods.

Primary references: [G-Force configuration programming](https://www.soundspectrum.com/g-force/Documentation/config-programming.html),
[scripting](https://www.soundspectrum.com/g-force/Documentation/scripting.html),
and [FAQ](https://www.soundspectrum.com/g-force/Documentation/faq.html).
