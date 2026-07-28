# Desktop update architecture

The desktop application and its bundled unified `mdbase` CLI/daemon are one
release unit. The updater never replaces the daemon independently and never
mixes binaries downloaded from different releases.

## Trust and discovery

The desktop checks the GitHub Releases API for its channel:

- prerelease application versions use the `beta` channel;
- versions without a prerelease suffix use the `stable` channel.

Every release contains `mdbase-connect-update.json` and
`mdbase-connect-update.json.sigstore.json`. Before parsing or acting on the
manifest, the desktop verifies its Sigstore bundle against the public Sigstore
roots, the GitHub Actions OIDC issuer, the exact release workflow, and the
exact release tag.

The strict, versioned manifest binds each downloadable artifact to its name,
byte length, SHA-256 digest, Sigstore bundle, platform, architecture, release
tag, and installation mode. Unknown fields, insecure URLs, mismatched tags,
unsupported targets, unsafe filenames, and malformed versions fail closed.
Automatic artifacts are streamed to a private size-limited cache, checked
against the signed digest, then independently verified against their own
Sigstore bundle.

The installation records the highest signed release it has observed. A replayed
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

## App and daemon transaction

When an eligible automatic macOS release is selected, the desktop:

1. copies the running CLI/daemon to a private last-known-good runtime;
2. atomically records previous and target versions, service-registration state,
   and the recovery runtime;
3. downloads, verifies, and asks the native updater to stage the application
   while the existing daemon remains available.

Only after the user chooses **Restart and update**, the desktop:

1. stops the daemon through its normal versioned control path;
2. marks the transaction `installing`;
3. handles Electron's update-specific quit path so the tray's normal
   hide-on-close behavior cannot block replacement;
4. asks the platform updater to quit and install.

On first launch of the target app, before ordinary daemon startup, it:

1. marks the recorded transaction `recovering`;
2. atomically copies the new bundled CLI into the private stable service
   runtime and refreshes service registration, or starts a new transient daemon;
3. waits for the daemon to open its state and report the exact target version;
4. commits only after that health check.

If replacement was interrupted, the old app restarts its daemon and clears the
transaction. If the target daemon cannot start or migrate state, the new app
re-registers and health-checks the preserved previous daemon. Recovery remains
visible so the user can install a higher signed recovery release.

The platform installer rolls back a failed application-bundle replacement.
After a new signed app has launched, mdbase uses publish-forward app recovery
instead of overwriting a running signed bundle. The preserved daemon keeps
collection access available. This avoids a second privileged installer and
keeps signing authority with macOS, Microsoft Store, or the Linux package
manager.

Update state uses user-only permissions and atomic rename. Invalid state is
quarantined. A crash at every boundary is safe to retry: before stop there is
no service impact; after stop the previous runtime is recorded; after
replacement recovery is idempotent.

## Release and recovery drills

Before enabling a non-zero automatic rollout:

1. publish a signed test beta at 0%;
2. use **Check now** on both macOS architectures;
3. interrupt before daemon stop, after stop, and after platform replacement;
4. verify an installed service is rebound away from the old app bundle;
5. inject daemon startup failure and verify the last-known-good daemon returns;
6. publish a higher signed release that blocks the bad version and verify it
   bypasses a 0% rollout;
7. test Store and Linux actions without package-manager privilege in Electron;
8. raise rollout gradually while watching privacy-minimal startup and recovery
   telemetry.

Never repair a published manifest, reuse a tag, lower the trusted-version
floor, or point an automatic target at an unsigned preview.
