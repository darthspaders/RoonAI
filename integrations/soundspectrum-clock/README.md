# SoundSpectrum native clock

This is the normal external scheduler for validated installed x64 SoundSpectrum
standalone hosts. It has no user-facing enable/disable mode and no dependency on
Rabbit Hole streaming, OBS, a browser, Frida or an audio source. The deployment
allowlist is an engineering safety gate for independently validated products.

See current installation and measured results (private installation record; [published status and operating limits](../../docs/october-2026-update.md))
for the enabled products, binary identity, actual activation and remaining limits.

## Ownership and recovery

The current-user **Rabbit Hole native visualizer clock** scheduled task starts a
single watcher at logon. A one-minute repeating recovery trigger covers watcher
exit even when Windows does not classify the exit for its RestartOnFailure setting.
IgnoreNew and the watcher mutex prevent competing instances. A normal
vendor executable launch is discovered automatically after engine initialization.
The watcher admits only the same user/session, exact installed path and pinned
host/engine SHA-256 pair in `common.hpp`. Unknown or updated vendor builds retain
their original scheduler until separately reverse engineered and validated.

The external DLL is loaded into the admitted process and pinned until process
exit. Vendor executable/DLL files and executable code bytes are not patched.
The adapter verifies the actual loaded engine, reads the existing Standalone
`Graphics.TargetFrameRate`, and claims the original timer on its UI thread. It
uses QPC deadlines with a high-resolution one-shot waitable timer, dispatching
one render synchronously through the verified vendor UI route. It removes the
original timer and suppresses stale timer messages. A per-process owner mutex
and idempotent bootstrap prevent competing clocks. It does not generate copies
of frames or change resolution, themes, preferences or audio inputs.

Initialization failure leaves the original clock intact. Unsupported target
values fail closed. A render dispatch timeout requests restoration on the UI
thread; a hung UI must resume before either scheduler can render. Recovery has
at most one queued restore message, retries failed restoration, and stops further
replacement dispatches. Closing restores the original timer before vendor
shutdown. Destroyed windows and changed native objects stop replacement ownership
without resurrecting timers on dead objects. A crashed native process releases
its resources; its next normal launch gets a fresh clock. Losing the watcher
does not stop an already loaded clock. Capture/encoder throughput is never a
fallback trigger. An overloaded scene may miss 120 while the high-resolution
clock remains active; missing a deadline does not switch it back to USER32.

## Build, validate and install

`build.ps1` uses the local VS2019 x64 toolchain, runs the configuration/identity
tests, and writes binaries plus source/binary hashes under private
`data/soundspectrum-native-clock/build`. No vendor redistribution is required.

Run `node integrations/soundspectrum-clock/validate.cjs --run WhiteCap` with no
existing visualizers or viewer clients. Repeat independently for Aeon/G-Force.
`--stall` exercises recovery after a bounded UI stall; `--reject-init` tests a
deliberately mismatched external-adapter receipt. The harness uses an owned 4K
Fluid generator, an independent temporary RenderFrame observer, and restores
preferences/removes the observer. Private probe options additionally require the
locally built capture-isolation tools. They are diagnostics, not production modes.

Create `validated-products.json` only from reviewed passing receipts for the
exact build, with `adapterSha256`, `products` (WhiteCap first) and receipt IDs.
Then run `powershell -NoProfile -File integrations/soundspectrum-clock/install.ps1 -Install`.
Installation refuses live standalone processes, verifies source/binary receipts,
stages an immutable version under `%USERPROFILE%/.rabbit-hole/native-clock`, and
registers/starts the current-user interactive task. Failed task replacement rolls
back its prior XML. Old installed versions are retained. No app/MCP restart is
needed. Revalidate every new adapter build and newly supported vendor version.

The user-profile directory is intentional: this packaged desktop environment
made files written under LocalAppData invisible to an ordinary scheduled process.
The first task attempt failed with file-not-found and rolled back; the shared
profile location was independently verified by a running scheduled watcher.

After installing, `validate-installed.cjs --run WhiteCap --recovery` launches the
ordinary vendor executable, tests watcher crash/automatic restart while rendering
continues, crashes its own native process, then verifies automatic reattachment
and normal window shutdown. It never invokes the streaming controller. Repeat
ordinary-launch tests independently for each enabled product. These commands
launch visible native windows and should only run in an idle diagnostic session.

For production capture regression, add `--installed --production` to the owned-window validator; add `--fps60` to verify 60 fps output while native rendering stays at 120. This uses the installed adapter and actual production helper. The 120 path now uses P4; 60 retains P5. Browser decode/draw must be verified separately.

## Diagnostics and maintenance

Installed `logs/Product-PID.jsonl` records activation, target, completed dispatches,
missed deadlines, dispatch work, fallback and shutdown. Two-second cadence samples
are scheduler evidence; independent RenderFrame/WGC measurements are required to
claim actual native/capture rates. DLL logs rotate at 4 MiB, retaining one previous
file per process. Launcher events are bounded at 4 MiB. Logs do not contain audio,
images, credentials or preference contents. Per-process log files accumulate
across launches; archive old receipts during maintenance.

For an engineering rollback, close standalone visualizers, disable/unregister this
exact owned scheduled task, stop its verified watcher, and retain its version directory and receipts. The
next launch will use the vendor scheduler. This is maintenance recovery, not a
user-facing fps selector. Never unload a pinned adapter or replace its files in
a running native process. A watcher-only stop leaves existing native clocks active
until those processes exit. To restore an older deployment, use its reviewed task
action/version after all native instances have closed.

Known limits: only exact tested x64 builds; target is read at process startup;
no physical scanout guarantee; no automatic elevation into other users/sessions;
no guarantee every scene fits within 8.33 ms. Sleep/resume, long multi-day soak and
future vendor updates require additional validation. Keep capture/encode work
separate from this scheduler's safety state.
