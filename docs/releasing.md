# Beta release checklist

mdbase connect desktop bundles contain the Electron controller and the matching
Rust connector agent. A release is one tested unit; mixing controller and agent
versions is unsupported.

## Local package verification

From the repository root:

```bash
pnpm install --frozen-lockfile
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm build
pnpm typecheck
pnpm test
pnpm e2e
pnpm e2e:sync
pnpm e2e:oracle
pnpm --filter @mdbase/connect-desktop package
```

The package command compiles a release agent, creates the platform Electron
bundle, and verifies that `app.asar` and the agent executable are both present.
Run the packaged application once with a fresh user-data directory and complete
pairing, collection registration, encrypted application authorization, one write,
pause/resume, and revocation.

## Signing and publication

Canonical public artifacts use each platform's trust channel:

- macOS: Developer ID signing and Apple notarization;
- Windows: Microsoft Store AppX packaging, certification, and Store signing;
- Linux: repository/package signatures for the chosen distribution channel.

GitHub releases may additionally contain Windows Squirrel and portable builds
whose filenames contain `UNSIGNED`. They are preview artifacts, not the
canonical Windows installation channel. Windows will show Unknown Publisher or
SmartScreen warnings for them. Checksums and GitHub OIDC-backed Sigstore bundles
prove which workflow produced the files, but do not provide Authenticode trust.

Before company-backed publisher accounts are available, beta releases may also
contain macOS DMG and ZIP files whose names contain `UNSIGNED`. They are neither
Developer ID signed nor notarized and require a manual Gatekeeper override.
Their bundled warning, checksums, and Sigstore bundles describe the exact
trust boundary.

The `Desktop Release` workflow builds, verifies, signs, and publishes the
installers for a version tag. To enable trusted macOS output, configure these
secrets in the `desktop-release` GitHub Actions environment:

- `MACOS_CERTIFICATE_P12_BASE64`: base64-encoded Developer ID Application
  certificate and private key in PKCS#12 format;
- `MACOS_CERTIFICATE_PASSWORD`: password for that PKCS#12 file;
- `APPLE_API_KEY_P8_BASE64`: base64-encoded App Store Connect API key;
- `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`: API key identifiers used for
  notarization.

Reserve `mdbase connect` in Partner Center, then copy the following non-secret
values from **Product identity** into variables on the same GitHub environment
to additionally build a Store-submission package:

- `WINDOWS_STORE_IDENTITY_NAME`: the exact package Identity/Name;
- `WINDOWS_STORE_PUBLISHER`: the exact package Identity/Publisher;
- `WINDOWS_STORE_PUBLISHER_DISPLAY_NAME`: the exact publisher display name.

When those values are present, the Windows job creates a Store-submission AppX
whose manifest is checked against them. The workflow uses
`1.0.<GitHub run number>.0` as the
monotonically increasing Store package version; the fourth component remains
zero as required by the Store. The AppX is retained as the
`windows-store-submission` Actions artifact and is deliberately excluded from
the GitHub release. Upload it to the matching Partner Center submission. The
Store replaces its build-time development signature with Microsoft's
certificate after certification.

Before creating a release tag, run the workflow manually from the commit that
will be tagged:

```bash
gh workflow run desktop-release.yml --ref main
```

This preflight builds, verifies, signs provenance, and uploads
all platform artifacts without creating a GitHub release. Require the macOS
Apple Silicon, macOS Intel, Windows, Linux, and Windows Store smoke-test jobs to
pass before tagging.

The tag must exactly match the root and desktop package version:

```bash
git tag -a v0.1.0-beta.1 -m "mdbase connect 0.1.0-beta.1"
git push origin v0.1.0-beta.1
```

When platform publisher configuration is wholly absent, the workflow publishes
only explicitly labelled preview artifacts for that platform. Partially
configured Apple signing material or Partner Center identity values fail the
build. Fully configured trusted paths remain fail-closed when macOS
notarization, signature verification, or Store package identity checks fail.
The workflow also verifies that GitHub preview executables are unsigned before
labeling and publishing them. Every downloadable artifact receives a keyless
Sigstore bundle tied to the workflow's GitHub OIDC identity plus a checksum.

Before publishing a version, record the exact `mdbase-rs` revision, run the
local and oracle end-to-end suites, retain checksums for every artifact, verify
upgrade and clean-install paths, and publish the supported protocol and schema
versions. Automatic updates should be enabled only after signed rollback and
staged-rollout behavior has been exercised against a private channel.
