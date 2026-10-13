# NASA desktop information

A standalone Windows desktop caption and deliberate details window for the
existing NASA wallpaper library. It does not participate in the Rabbit Hole
server, browser/player UI, WhiteCap, acquisition, processing or wallpaper rotation.

The title and smaller credit sit at the **top-right** of each attached desktop,
inset 24 logical pixels inside its work area. This supersedes the first bottom-right
placement, which the user asked to move. The caption is below normal applications,
not always on top. Click the title for details, or use **Open wallpaper details**
from the NASA information icon in the Windows notification area. That native menu
also provides keyboard access. Escape or Close dismisses details. Reading a panel
does not change its image when the slideshow advances; a notice explains that the
desktop has moved on. Click the new caption to open the new image's information.

## Existing data, exact identity

1. Read each attached monitor's source path through `IDesktopWallpaper.GetWallpaper`.
   The null-monitor form is unsuitable for slideshows. Skip remembered disconnected
   monitors; this PC also returns E_FAIL for a remembered display.
2. Require the path to be directly inside the existing export config's output folder.
3. Match the content-addressed filename to `data/nasa-wallpaper/manifest.json`,
   verify its SHA-256 against the actual file, and follow its catalog IDs.
4. Stream the existing `data/nasa-whitecap/pipeline/catalog.json` to find an exact
   verified record with matching presentation and preparation hashes.
5. Display that record's title, target, description, mission, credit, publication
   date/date meaning, original NASA dimensions, downloaded-source dimensions and
   official NASA source link from the shared validation receipt. Missing metadata
   is explicitly unavailable.

There is no title guessing, cache-image hash guessing, second catalog, source
metadata rewriting, download or image transformation. HTML entities are decoded
into plain text. Source links must be HTTPS NASA domains without credentials or
custom ports, and open only on a deliberate click. The exact ID/hash must match a
fresh successful decision in `data/nasa-wallpaper/source-links.json`; raw catalog
`sourceUrl` is no longer opened without validation. A recorded official image
fallback is labeled **Open NASA image**. Unknown/expired/bad links are disabled.

The existing desktop worker invokes the shared Node resolver in bounded batches,
prioritizing the current image, with a persisted 100-request/hour public-check
budget. It preserves original catalog metadata and does not download wallpaper
images. Node must be available on PATH for refresh; the caption/details still work
if refresh is unavailable. Android consumes the same receipt over SMB. See the
404 investigation and resolver controls (private installation record; [published status and operating limits](../../docs/october-2026-update.md)).

Windows is checked every two seconds by one low-priority STA worker. Metadata is
read on a wallpaper/file change, not every frame or poll. Incomplete or unknown
matches hide the caption and retry after 15 seconds. After IO, the current Windows
path is checked again before publishing the caption. Shared-delete reads tolerate
the existing publisher's atomic JSON replacements; errors never block publishing.

Caption changes use a 120 ms fade out and 200 ms fade in. Windows' animation setting
and high contrast disable fades. The app places only its own non-activating window
immediately above Explorer's existing desktop layer. It does not reparent windows,
create WorkerW windows, inject into Explorer, or set any window always on top. If
the desktop host is unavailable, the caption hides and tries again. Geometry uses
the monitor work area and DPI; no taskbar, slideshow or wallpaper settings change.

## Build and controls

Use Windows PowerShell from the main repository. The installed .NET Framework 4.x
compiler and WPF are sufficient; no SDK, NuGet download, admin account or service
is needed. Builds and private diagnostics stay in ignored `data/nasa-wallpaper-info/`.

```powershell
powershell -File integrations/nasa-wallpaper-info/build.ps1
powershell -File integrations/nasa-wallpaper-info/build.ps1 -Test
powershell -File integrations/nasa-wallpaper-info/control.ps1 start
powershell -File integrations/nasa-wallpaper-info/control.ps1 status
powershell -File integrations/nasa-wallpaper-info/control.ps1 details
powershell -File integrations/nasa-wallpaper-info/control.ps1 inspect
powershell -File integrations/nasa-wallpaper-info/control.ps1 stop
powershell -File integrations/nasa-wallpaper-info/control.ps1 enable-startup
powershell -File integrations/nasa-wallpaper-info/control.ps1 disable-startup
```

A per-user, per-repository mutex prevents duplicate helpers. Starting again leaves
the existing process alone. Stop signals only this helper, never Rabbit Hole or
WhiteCap. Stop before rebuilding a loaded executable. Startup uses one user Startup
shortcut, **Rabbit Hole NASA Information.lnk**; disabling startup leaves the running
helper and slideshow intact. Use both `disable-startup` and `stop` to turn it off
permanently. No other shortcuts or startup settings are changed.

`status` includes a process-alive check; a stale JSON receipt is not proof of a
running program. `inspection.json` contains a fresh read-only Windows/catalog query
and window stacking/geometry. `events.jsonl` records transitions and deliberate
detail opens, with bounded growth. `error.json` records the last fatal attempt and
may be historical; compare timestamps and current status. `render-caption` renders
only the caption control into a private UI proof PNG, without wallpaper pixels.

## Validation and limitations

Twenty C# fixture checks cover identity, hashes, aliases, shared validated links, HTML text,
missing metadata, original/downloaded dimensions, partial reads and recovery.
Eleven shared resolver tests and the existing nine publisher checks also pass. See the dated
activation record (private installation record; [published status and operating limits](../../docs/october-2026-update.md)) for observed Windows
transitions, application layering, preserved hashes and actual activation.

The live check used one attached 4K display. Multi-monitor/mixed-DPI, virtual desktop,
Explorer restart and a full sign-out/sign-in cycle have not been live-tested. The
helper deliberately has no way to read astronomy details in the player/remote UI.
Do not add one: the user explicitly wants to avoid reading them while driving.

API references: Microsoft's [current wallpaper getter](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-idesktopwallpaper-getwallpaper),
[monitor rectangle](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-idesktopwallpaper-getmonitorrect)
and [window positioning](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowpos).
