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
pairing, collection registration, encrypted TaskNotes authorization, one write,
pause/resume, and revocation.

## Signing and publication

Public artifacts must be signed with the platform owner's credentials:

- macOS: Developer ID signing and Apple notarization;
- Windows: Authenticode signing for the application and installer;
- Linux: repository/package signatures for the chosen distribution channel.

Unsigned local packages are test artifacts. Do not present them as public beta
downloads. Release automation should receive signing material from the CI
secret store, never repository files or developer environment files.

The `Desktop Release` workflow builds, verifies, attests, and publishes the
installers for a version tag. Configure these secrets in the
`desktop-release` GitHub Actions environment before creating a tag:

- `MACOS_CERTIFICATE_P12_BASE64`: base64-encoded Developer ID Application
  certificate and private key in PKCS#12 format;
- `MACOS_CERTIFICATE_PASSWORD`: password for that PKCS#12 file;
- `APPLE_API_KEY_P8_BASE64`: base64-encoded App Store Connect API key;
- `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`: API key identifiers used for
  notarization;
- `WINDOWS_ESIGNER_USERNAME`: SSL.com account username for the eSigner-enrolled
  Windows code-signing certificate;
- `WINDOWS_ESIGNER_PASSWORD`: SSL.com account password;
- `WINDOWS_ESIGNER_TOTP_SECRET`: automation TOTP secret issued by eSigner.

Windows releases use SSL.com eSigner Cloud Key Adapter on the ephemeral GitHub
Actions runner. The workflow downloads a pinned CKA release, verifies its
SHA-256 checksum, loads the cloud-held certificate into the runner certificate
store, and signs both the application and Squirrel installer through
`signtool.exe`. Exportable PFX files and physical USB tokens are unsupported.

The tag must exactly match the root and desktop package version:

```bash
git tag -a v0.1.0-beta.1 -m "mdbase connect 0.1.0-beta.1"
git push origin v0.1.0-beta.1
```

The workflow refuses to publish when signing material is absent, macOS
notarization or signature verification fails, or the Windows application and
installer do not have valid Authenticode signatures. Linux packages receive
keyless Sigstore bundles, checksums, and GitHub artifact attestations.

Before publishing a version, record the exact `mdbase-rs` revision, run the
local and oracle end-to-end suites, retain checksums for every artifact, verify
upgrade and clean-install paths, and publish the supported protocol and schema
versions. Automatic updates should be enabled only after signed rollback and
staged-rollout behavior has been exercised against a private channel.
