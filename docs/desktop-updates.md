# Desktop update architecture

The desktop application and its bundled mdbase daemon (mdbn-daemon) are one
release unit. The app update delivers the daemon: the updater never downloads a
daemon on its own and never mixes binaries from different releases.

## Trust and discovery

The desktop checks the GitHub releases for its channel:

- prerelease application versions use the `beta` channel;
- versions without a prerelease suffix use the `stable` channel.

It does not use GitHub's REST API, whose unauthenticated limit of 60 requests
an hour is shared by everything behind the same public IP. One git
protocol-v2 `ls-refs` request lists the repository's version tags; the desktop
then fetches the channel document from each tag's release download URL, newest
version first and a few at a time. A tag without a published release (other
trains tag versions too) answers 404 and is skipped. The first tag whose signed
document verifies is the channel's latest release, because the document's
version must equal its tag's. The first automatic check runs 30 seconds after
launch, without waiting for the daemon to start, and then every six hours.

Every release contains a frozen updater bootstrap for two generations:

- `mdbase-connect-channel-v1.json` is the permanent channel document used by
  current and future desktop clients;
- `mdbase-connect-update.json` preserves the exact beta.14 bootstrap shape so
  an installed beta client can always reach a current updater.

Both files contain the same minimal release description and have independent
Sigstore bundles. Before parsing or acting on a document, the desktop verifies
its bundle against the public Sigstore roots, the GitHub Actions OIDC issuer,
the exact release workflow, and the exact release tag.

The frozen, versioned channel document binds each downloadable artifact to its name,
byte length, SHA-256 digest, Sigstore bundle, platform, architecture, release
tag, and installation mode. Unknown fields, insecure URLs, mismatched tags,
unsupported targets, unsafe filenames, and malformed versions fail closed.
Automatic artifacts are streamed to a private size-limited cache, checked
against the signed digest, then independently verified against their own
Sigstore bundle.

Discovery rejects a malformed or unverifiable release candidate without
preventing another valid signed release from being considered. If no candidate
can be verified, the check fails visibly. The installation records the highest
signed release it has observed. A replayed
older manifest cannot cause a downgrade. A release can name bad installed
versions in `blocked_versions`; those installations bypass staged rollout so a
signed recovery release reaches them immediately, and the app on such a version
says that it is no longer supported and that the update must be installed. A
target must never block itself.

`config/desktop-update-minimum.json` sets the minimum supported version. The
release workflow lists every published version below it in `blocked_versions`,
so the manifest schema is unchanged and apps already installed read it. The
first release with the bundled mdbase daemon sets the minimum to itself: an
older app runs the old Connect daemon, which can write to the same folders as
the new one. The new daemon also closes folders it took over while an old
Connect daemon runs, for apps too old to check for updates.

## Rollout

`UPDATE_ROLLOUT_PERCENTAGE` on the `desktop-release` GitHub environment controls
the percentage from 0 through 100. Membership is a deterministic SHA-256 cohort
of a random per-installation identifier and the release tag. It is stable
without putting user or account identifiers in release traffic. **Check now**
deliberately opts the local user into an otherwise deferred release.

`UPDATE_BLOCKED_VERSIONS` is a comma-separated list of exact semantic versions.
Changing either value requires a new release tag and newly signed manifest;
published manifests are not edited in place.

## Platform installation

The same settings and tray experience reports updates on every platform, while
the platform trust channel owns replacement:

- A Developer ID-signed and notarized macOS release uses Electron's native
  updater. The app verifies the ZIP first, then serves it to the platform
  updater over an ephemeral loopback-only feed. The packaged app declares the
  narrow macOS local-network ATS exception needed by that feed; it does not
  allow arbitrary insecure loads. macOS performs its own application-signature
  check before staging.
- Microsoft Store builds open the product's Store page. Store certification,
  signing, rollout, replacement, and platform rollback remain authoritative.
  Unsigned Squirrel and portable artifacts are never automatic targets.
- Linux package installs open the signed release/package channel. The package
  manager owns dependencies, replacement, and rollback; Electron never mutates
  `/usr` or invokes privilege elevation.
- A Linux app unpacked into a folder the user owns (its folder and the parent
  are owned by and writable for the user, so never a root-owned package
  install) replaces itself from the release's `.deb`. The client decides
  this from its own installation; the manifest target stays `manual`, so
  clients without this support keep opening the release page. The `.deb` is
  verified like any automatic artifact, its `data.tar.zst` is unpacked beside
  the app as `<app>.next`, and **Restart and update** renames the running app
  to `<app>.previous` (replacing the one kept by the previous update), moves
  the new one into place and relaunches. Moving `.previous` back is the manual
  rollback. The release workflow stages each published `.deb` this way before
  publishing it.
- Unsigned macOS or Windows previews can be announced as manual downloads, but
  are never automatic targets.

## Linux background updates and first install

An app in a folder the user owns also updates while it is closed. Each launch
writes a systemd user timer, `mdbase-connect-update.timer`, for the running
executable (again whenever the app moves) and enables it. Every six hours, with
up to an hour of random delay and catching up after the computer was off, it
runs `mdbase-connect --mdbase-update` (`headless-update.ts`):

1. If the app is running it holds the single-instance lock; the run asks it to
   check now (its `second-instance` handler, without showing a window) and
   exits. The running app installs as it always does.
2. Otherwise it checks the signed channel exactly as the app does (staged
   rollout and blocked versions apply), stages a verified release and swaps it
   in, keeping `<app>.previous`. Nothing is relaunched.
3. It installs the daemon the app in the folder now bundles, with the same
   rollback and held-back rules as a launch (`ensureBundledDaemon`).
4. It writes the update report below and exits 1 if the check, the swap or the
   daemon failed, so the failure shows in
   `systemctl --user status mdbase-connect-update`.

The run holds `<userData>/updates/background-update.pid` from before it takes
the lock until it exits. A launch that finds a live run (its `/proc` command
line carries `--mdbase-update`, so a reused PID does not count) waits for it,
then starts the app that is in the folder by then. The service uses
`KillMode=mixed`: stopping it sends SIGTERM to the app's main process only,
because Electron crashes with SIGTRAP when its Chromium children are signalled
before it. The run uses Chromium's headless platform, so it needs no display.

`apps/desktop/scripts/install-linux.sh` is the first install for such a
folder. It finds the newest release with a Linux package (one REST API
request), downloads its `.deb`, checks it against the release's
`SHA256SUMS-linux-x64` and, when `cosign` is installed, its Sigstore bundle
against the release workflow identity. It unpacks the app with the same
`.next`/`.previous` swap the app uses, refuses while the app is running,
installs a launcher entry (with the `mdbase-connect:` URL handler) and icon,
links `mdbase-connect` and `mdbase` in `~/.local/bin` only when those names
are free, and runs `mdbase-connect --mdbase-update` once to install the daemon
and the timer. Run again, it installs the newest release over the old one.

Chromium picks X11 or Wayland from `XDG_SESSION_TYPE`. A session started by a
systemd user unit (for example Hyprland) often exports `WAYLAND_DISPLAY` and
`DISPLAY` without it, and Chromium then picks X11 through XWayland. When
`WAYLAND_DISPLAY` is set and the session type is neither `wayland` nor `x11`,
the app re-executes itself once with `--ozone-platform=wayland`; an explicit
`--ozone-platform` is always kept (`display-platform.ts`).

## What `mdbase doctor` reports

Whether a newer release exists is the app's knowledge, so the daemon reads it
from the app. After every completed check (by the app or the background run)
the app replaces `<state>/updates/desktop.json` in the daemon's state directory,
user-only and by atomic rename:

```json
{
  "schema_version": 1,
  "app_version": "0.1.0-beta.185",
  "checked_at": "2026-11-14T03:00:00.000Z",
  "background": true,
  "available": {
    "version": "0.1.0-beta.208",
    "install": "restart",
    "release_url": "https://github.com/mdbase-dev/mdbase-connect/releases/tag/v0.1.0-beta.208"
  }
}
```

`available` is present only when this installation can have the release now
(a release still rolling out to other installations is not available here).
`install` is `restart` (the app installs it), `package` (a new package from
the release page) or `store`; `required` is set when the running version is
blocked. The `doctor` `update` check is `ok` after a check in the last three
days that found nothing, and otherwise warns with what to do: no report yet, a
stale report (pointing at the timer when `background` is set), or the
available version and how to install it. Unknown fields are ignored and
unknown `install` values get a generic action; an incompatible change needs
`schema_version` 2.

## App update, then daemon update

An app update replaces only the application. The installed mdbase daemon is an
OS service (systemd user unit, LaunchAgent or scheduled task) that keeps serving
collections while the app downloads, restarts and installs; **Restart and
update** asks the platform updater to quit and install, through Electron's
update-specific quit path so the tray's hide-on-close behavior cannot block it.

Each app ships its daemon as `Resources/mdbase-next/mdbase[.exe]` with a
`VERSION` file. On every launch the app runs `mdbase --json service status`:

- an equal or newer registered daemon is kept (started if stopped);
- an older, absent or stale one is replaced with `mdbase --json service install`,
  which stops the daemon, copies the bundled binary to
  `<state>/runtime/mdbase`, keeps the replaced copy as `mdbase.previous`,
  registers, starts and waits for readiness with the bundled version.

If the swapped-in daemon does not become ready, the app runs
`mdbase.previous --json service install`, which puts the previous copy back the
same way and waits for its readiness. The failed bundled version is recorded as
held back in the update state (`daemon_held_back`), Settings says that the
previous version keeps running, and later launches of the same app keep it
instead of retrying. The next app update (another bundled version) tries again;
a release that fixes the daemon is the recovery path. The app rolls back only a
completed swap: if `service install` failed before replacing the runtime, the
registered daemon is left as it was and the failure is shown.

The app never starts, stops or replaces the old `mdbase connect` connector. On
machines that still have it, the daemon's takeover stops it and moves its
collections. Update state written by apps that managed the old connector
(`transaction`, `last_known_good_runtime`) is dropped on read; the installation
identifier and trusted-version floor are kept.

The platform installer rolls back a failed application-bundle replacement.
After a new signed app has launched, mdbase uses publish-forward app recovery
instead of overwriting a running signed bundle. This avoids a second privileged
installer and keeps signing authority with macOS, Microsoft Store, or the Linux
package manager.

Update state uses user-only permissions and atomic rename; its in-memory cache
publishes a transition only after the durable write succeeds. Invalid state is
quarantined.

## Release and recovery drills

Before enabling a non-zero automatic rollout:

1. publish a signed test beta at 0%;
2. use **Check now** on both macOS architectures;
3. interrupt the download and the platform replacement, and verify the daemon
   keeps serving throughout;
4. verify the next launch installs the bundled daemon version as the service's
   `<state>/runtime/mdbase`, keeping `mdbase.previous`;
5. ship a bundled daemon that cannot become ready and verify `mdbase.previous`
   returns, Settings reports it, and the next launch does not retry it;
6. publish a higher signed release that blocks the bad version and verify it
   bypasses a 0% rollout;
7. test Store and Linux package actions without package-manager privilege in
   Electron, a Linux user-folder install updating and relaunching, and the
   background timer updating a closed app and its daemon;
8. raise rollout gradually while watching privacy-minimal startup and recovery
   telemetry.

Never repair a published manifest, reuse a tag, remove either bootstrap asset,
change the v1 bootstrap shape, lower the trusted-version floor, or point an
automatic target at an unsigned preview. Richer update metadata must use a new
separately versioned asset; it must not alter the permanent bootstrap.
