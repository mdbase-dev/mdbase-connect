# Beta release checklist

mdbase connect desktop bundles contain the Electron client and the matching
Rust `mdbase` daemon/CLI. A release is one tested unit; mixing desktop
and daemon versions is unsupported.

Until the stable `0.1.0` contract is ready, releases use
`0.1.0-beta.N`. Beta tags are immutable test releases: increment `N` for every
published desktop build. Production and managed test deployments promote the
signed server image digests built from the exact tag commit and never build
from a tag, release branch, or Render.

## Local package verification

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm version:check
pnpm check:release-readiness
pnpm audit:dependencies
pnpm check:architecture
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm build
pnpm typecheck
pnpm test
pnpm package:audit
pnpm test:browser-storage
pnpm test:accessibility
pnpm e2e
pnpm e2e:container
pnpm e2e:desktop:container
pnpm e2e:relay
pnpm e2e:sync
pnpm e2e:provider
pnpm --filter @mdbase/connect-desktop package
```

The package command compiles the release daemon/CLI, creates the platform
Electron bundle, and verifies that `app.asar` and the `mdbase` executable are
both present. The release workflow also smoke-tests that exact native
executable's CLI and foreground-daemon entry points, then publishes it as a
standalone headless archive with the same tag-bound provenance and checksums.
Run the packaged application once with a fresh user-data directory and complete
pairing, collection registration, encrypted application authorization, one write,
pause/resume, and revocation.

Beta builds may proceed with the external risks recorded as `required` in
`config/release-readiness.json`. They remain visible in every CI run. A stable
release is different: the Desktop Release workflow automatically invokes
`pnpm check:release-readiness -- --stable`, which fails until every gate is
`complete` and includes a durable evidence reference. The required decision,
operational drill, or publisher control must actually have happened; changing
the status without evidence is itself rejected.

## Signing and publication

### First publication of a new npm package

npm trusted publishing cannot create a package. Before tagging a release that
adds a public package, a scope owner must bootstrap that package once:

1. Run the full local package verification above and pack the package from the
   exact reviewed commit.
2. Authenticate interactively with `npm login` and publish that audited tarball
   with `npm publish <tarball> --access public --tag next`.
3. Configure `publish-npm.yml` in `mdbase-dev/mdbase-connect` as the package's
   GitHub Actions trusted publisher, restricted to the `npm` environment and
   the `npm publish` operation.
4. Run `pnpm check:npm-bootstrap` before creating the release tag.

The tag workflow runs the same check before publishing anything. This keeps a
missing first-time bootstrap from leaving a release partially published. All
subsequent publications use short-lived GitHub OIDC credentials and provenance;
do not add a long-lived npm publication token to the repository.

Canonical public artifacts use each platform's trust channel:

- macOS: Developer ID signing and Apple notarization;
- Windows: Microsoft Store AppX packaging, certification, and Store signing;
- Linux: repository/package signatures for the chosen distribution channel.

GitHub releases may additionally contain Windows Squirrel and portable builds
whose filenames contain `UNSIGNED`. They are preview artifacts, not the
canonical Windows installation channel. Windows will show Unknown Publisher or
SmartScreen warnings for them. Checksums and GitHub OIDC-backed Sigstore bundles
prove which workflow produced the files, but do not provide Authenticode trust.
The standalone Windows headless archive follows the same `UNSIGNED` rule until
an Authenticode publisher path is configured.

Before company-backed publisher accounts are available, beta releases may also
contain macOS DMG and ZIP files whose names contain `UNSIGNED`. They are neither
Developer ID signed nor notarized and require a manual Gatekeeper override.
Their bundled warning, checksums, and Sigstore bundles describe the exact
trust boundary.

Standalone macOS headless archives use the `mdbase` executable copied from the
packaged application. A trusted archive is published only when that nested
binary passes strict code-signature verification; otherwise its filename
contains `UNSIGNED`. Linux headless archives are native release binaries with
workflow identity, checksums, and Sigstore bundles. See
[`headless.md`](headless.md) for the installation and daemon lifecycle.

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
- `WINDOWS_STORE_PRODUCT_ID`: the Store product ID used by the desktop's update
  action.

When those values are present, the Windows job creates a Store-submission AppX
whose manifest is checked against them. The workflow uses
`1.0.<GitHub run number>.0` as the
monotonically increasing Store package version; the fourth component remains
zero as required by the Store. The AppX is retained as the
`windows-store-submission` Actions artifact and is deliberately excluded from
the GitHub release. Upload it to the matching Partner Center submission. The
Store replaces its build-time development signature with Microsoft's
certificate after certification.

Before creating a release tag, require Server CI and `Publish Server Images` to
pass for the main commit that will be tagged. That publisher builds each managed
`linux/amd64` image once, attaches BuildKit SBOM and provenance attestations,
and adds a keyless signature plus an mdbase release attestation that binds the
component and source commit. Operations promotes those exact digests to staging
and production; tag creation never rebuilds them.

The tag must exactly match every package and the Rust workspace version:

```bash
pnpm version:check v0.1.0-beta.54
git tag -a v0.1.0-beta.54 -m "mdbase connect 0.1.0-beta.54"
git push origin v0.1.0-beta.54
```

If a tag-triggered npm or desktop run is lost during a GitHub Actions outage,
dispatch the same workflow manually and select that exact existing tag as the
workflow ref. The workflow's existing tag/version checks remain authoritative;
do not dispatch it from a branch or substitute a different commit.

The tag starts the only full desktop build. The four platform builders do not
open deployment records; the single publish job enters the `desktop-release`
environment, verifies every artifact, and creates one GitHub prerelease.

When platform publisher configuration is wholly absent, the workflow publishes
only explicitly labelled preview artifacts for that platform. Partially
configured Apple signing material or Partner Center identity values fail the
build. Fully configured trusted paths remain fail-closed when macOS
notarization, signature verification, or Store package identity checks fail.
The workflow also verifies that GitHub preview executables are unsigned before
labeling and publishing them. Every downloadable artifact receives a keyless
Sigstore bundle tied to the workflow's GitHub OIDC identity plus a checksum.
The publish job creates a strict manifest from those exact artifacts, signs it
with the same tag-bound workflow identity, verifies it, and only then creates
the GitHub release.

Set `UPDATE_ROLLOUT_PERCENTAGE` on the `desktop-release` environment to a number
from 0 through 100; it defaults to 100. Set `UPDATE_BLOCKED_VERSIONS` to a
comma-separated list of exact versions only when a higher recovery release
must bypass rollout for affected installations. Both values are captured in
the signed manifest and require a new immutable tag to change.

Before publishing a version, record the exact `mdbase-rs` revision, run the
local protocol-1, relay, sync, and production-provider end-to-end suites,
retain checksums for every artifact, verify upgrade and clean-install paths,
and publish the supported protocol and schema versions. Exercise the
interruption and recovery matrix in
[`desktop-updates.md`](desktop-updates.md) before raising rollout above zero.
After deployment,
verify the deployed revision and protocol-1 browser authorization path against
the actual release environment. Do not use a differently versioned oracle as a
release gate.
