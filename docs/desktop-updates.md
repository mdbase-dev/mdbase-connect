# Desktop update architecture

The desktop application and its bundled mdbase daemon (mdbn-daemon) are one
release unit. The app update delivers the daemon: the updater never downloads a
daemon on its own and never mixes binaries from different releases.

## Trust and discovery

The desktop checks the GitHub Releases API for its channel:

- prerelease application versions use the `beta` channel;
- versions without a prerelease suffix use the `stable` channel.

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
signed recovery release reaches them immediately. A target must never block
itself.

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
- Linux builds open the signed release/package channel. The package manager
  owns dependencies, replacement, and rollback; Electron never mutates `/usr`
  or invokes privilege elevation.
- Unsigned macOS or Windows previews can be announced as manual downloads, but
  are never automatic targets.

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
7. test Store and Linux actions without package-manager privilege in Electron;
8. raise rollout gradually while watching privacy-minimal startup and recovery
   telemetry.

Never repair a published manifest, reuse a tag, remove either bootstrap asset,
change the v1 bootstrap shape, lower the trusted-version floor, or point an
automatic target at an unsigned preview. Richer update metadata must use a new
separately versioned asset; it must not alter the permanent bootstrap.
