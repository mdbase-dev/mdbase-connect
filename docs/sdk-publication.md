# Source-built SDK publication

Status: implementation prepared, **not release approval**. The release freeze
remains in force. No package or workflow was published or dispatched for this
change. `sdkPublication.ready` is false until the separate runtime port and
qualification below are reviewed. Existing apps keep their current originals.

## Decision: separate package identities, build-time trust (model a)

| Environment | Embedded package identity | Distribution | Embedded trust |
| --- | --- | --- | --- |
| Production | `@mdbase-dev/sdk` | npmjs, exact version | Production only |
| Staging | `@mdbase-dev/sdk-staging` | `sdk-v<version>/sdk-staging.tgz` prerelease asset | Staging only |
| LAB | `@mdbase-dev/sdk-lab` | `sdk-v<version>/sdk-lab.tgz` prerelease asset | LAB only |

Only production goes to `registry.npmjs.org`, initially with the `next` tag.
Dist-tags are discovery pointers, **not security boundaries**. Production apps
pin a version, never a tag/range; staging/LAB pin the exact prerelease asset URL
and lockfile integrity. These internal-environment packages are publicly
downloadable assets, **not confidential packages**. Their trust roots are public.
Neither internal package has an npm publication path: its manifest is private
and has no `publishConfig`. There is no registry configuration or package-auth
setup for staging/LAB. Model b was rejected:
shipping every root would add a bundler-constant contract and require proving
constant replacement across every browser, Worker and native toolchain.

The source-reviewed `sdkPublication` inventory in
`config/release-components.json` selects the exact asset digest, length,
environment, CP/log origins and original source. CI never accepts an asset,
trust file, verifier, roots, origin or build-receipt override as an input.
Production retains beta.141's 840-byte asset, SHA-256
`7912e40838213e60b65848350d319a48019021317b112e3326429b250f0133d7`.
The trust release's original commit is distinct from the SDK producer commit.

CI compiles `mdbn-trust` from the checked-out source and reuses the existing
`buildAppTrust` generator, including certificate verification and its current
clock. There is no expiry override, duplicated cryptographic implementation,
fallback, discovery, mutable root array or runtime environment selector. Each
package contains one generated `appReleaseTrust()` literal; returned byte
buffers are fresh, so caller mutation cannot change subsequent trust. Its
arguments cannot provide trust. The existing application entry and Worker
both use that SDK-owned literal; the existing `selectAppEnvironment` refuses
a production declaration paired with staging/LAB release metadata.

This is not a claim that JavaScript can defend against an app deliberately
replacing its entire dependency or rewriting its bundle. Production publishers
must admit only the production package name, exact version, frozen-lock SRI and
verified npm provenance, and reject every alias, URL/tarball specifier,
linked/workspace SDK, patched source and installed-member drift. The shared
`production-version` admission command accepts only an exact npm version; the
first consumer migrations must wire this into their protected publishers before
installing, and verify the lock resolves to npmjs. Preserve the complete
installed-member comparisons introduced for npm UI in PR 1068. A bot changes
the dependency version and regenerated lock, not trust policy. Never migrate
by deleting the native publisher's SDK guard without replacing that intake.

## Build, provenance and qualification

`publish-sdk-npm.yml` separates an unprivileged shared build from the protected
`npm-sdk` production publisher and the internal prerelease publisher. It checks
out the workflow's exact main SHA; builds the
canonical verifier and application WASM with locked Cargo dependencies and
pinned Rust/binaryen tools; installs the SDK with its frozen npm lock; then
compiles TypeScript, replaces the refusal module, builds browser/Worker bundles,
tests cold consumers, packs and verifies each actual extracted archive.
It never downloads an operator-built SDK or builds from a caller's ref.
The run always builds all three variants: no environment-selection input remains.
The WASM and SQLite bytes are read and integrity-checked once, then the same
snapshotted bytes are embedded in all three variants at the same SDK version.
Each variant gets only its own verified trust. Temporary manifest changes are
restored between variants; the refusal module and bundles are rebuilt each time.

The rebuilt `runtime.wasm` must match both length and SHA-256 in
`runtime/packages/sdk/src/application/asset-pins.json`. SQLite WASM and
initializer keep their existing committed pins and package-lock integrity.
A source change producing different WASM fails until reviewed pins are
updated; CI must not auto-bless its output. No WASM ABI, wire protocol, bundled
`connect-protocol` dependency or protocol version is changed here. Keep that
exact bundled protocol and its archive for cold consumers; removing it needs
separate compatibility work, not an incidental publication cleanup.

`dist/native/provenance.json` binds the SDK producer commit, environment,
reviewed trust context and runtime pin. It replaces per-app SDK-original facts,
not release/grant authority. The GitHub artifact attestation binds the exact
packed tarball to this main workflow; npm OIDC `--provenance` additionally binds
the registry publication. Neither proves deployment, current CP membership or
per-app operations. Review of the committed pin is the trust authorization for
this source build; this is not an invented Ops handoff/signature receipt.

Every live publication requires the exact commit's successful full Server CI
and Runtime CI, `ready: true`, main and an explicit non-dry-run dispatch.
Production additionally requires approval of protected environment `npm-sdk`.
The first release-preparation commit must include the final SDK version/pin
updates so Runtime CI is triggered for that exact SHA; a documentation-only
successor without Runtime CI cannot reuse an older commit's qualification.
The build job has no OIDC permission. The production publisher verifies and
publishes only the fixed `sdk-production.tgz`, unchanged, with scripts disabled,
explicit npmjs registry and OIDC provenance. Nonproduction tarballs cannot match
that command's path or production package/registry admission checks. A conflicting
npm version is an error, never a skip.

Owner setup: configure **one npm trusted publisher**, for `@mdbase-dev/sdk` only,
for repository
`mdbase-dev/mdbase-connect`, workflow `publish-sdk-npm.yml`, environment
`npm-sdk`; require owner approval and main-only deployment in that environment.
Disallow token publication once the trusted publisher is established. Do not
add an npm token or publish a placeholder. If a package needs first-name
bootstrap, Callum must resolve it separately under the release freeze; do not
use the old local SDK publication recipe. Existing production SDK trusted-publisher
settings pointing at `publish-runtime-npm.yml` must be moved before the cut.
Do not create npm trusted publishers or registry entries for staging/LAB.

### Immutable staging/LAB prerelease

The same run's `attest-internal` job downloads the shared build artifact and
attests each internal tarball individually. It has only `contents: read`,
`attestations: write` and `id-token: write`; OIDC is used solely for these
attestations. It stages the exact tarballs and their Sigstore verification bundles
as one run-local transfer artifact. It has no npm setup or credentials.

`publish-internal` runs only after the approved `npm-sdk` production publish
succeeds, so an unapproved, rejected or failed run never consumes an immutable
`sdk-v<version>` tag. It downloads those four fixed files. Its only granted permission
is `contents: write`: no OIDC, attestation-write, packages permission or npm
credentials. GitHub's contents permission is repository-scoped, not per-release;
the script limits its writes to one newly created `sdk-v<version>` tag/release
and its fixed assets. It does not modify any other release or a latest pointer.

The prerelease contains exactly:

- `sdk-staging.tgz` and `sdk-staging.tgz.sigstore.json`;
- `sdk-lab.tgz` and `sdk-lab.tgz.sigstore.json`.

Before any write, the script verifies package identity, common version, source
commit, environment/trust metadata and the presence of both bundles. It requires
404 absence proof for the exact tag and release; authorization/server errors
are not absence. It atomically creates a new tag pointing at the full producer
SHA, so a racing/pre-existing tag is an error, not a reused tag. It creates a
new draft prerelease, refuses existing assets, uploads without replacement,
rechecks the tag SHA, then publishes with `prerelease: true` and
`make_latest: "false"`. Both creation and final publication explicitly refuse
Latest status. No update/delete operation on an existing tag or asset exists.

A partial failure stops: do not delete, retarget, replace or automatically replay
the same version. An owner must investigate and prepare a new version if the
tag was already created. The npm and prerelease jobs are not a transaction; one
may succeed while the other fails. Neither is silently republished or repaired.

The workflow defaults to `dry_run: true`. A later owner-authorized main dry run
has only the dry-run boolean, builds and verifies all three packages but does
not request npm credentials, attest, create a tag/release or publish. PRs run the
dependency-free contract regressions only. Neither a passing contract test nor
this implementation claims a successful complete SDK build. Missing ported
source, missing current build inputs, a stale WASM pin or failed consumer tests
must remain a failure, never an archived-original fallback.

## Versioning and consumption

Keep the existing independent runtime version train, not the legacy server's
beta counter: initial source-build candidate `0.0.1-next.0`, then
`0.0.1-next.1`, etc. The three environment packages use the same source version;
their package names distinguish trust. Every trust/native/protocol/code change
needs a new SDK version. The exact producer SHA is in provenance, not the npm
version string. The Obsidian runtime's exact SDK peer and local lock follow the
candidate version; its own release remains separate. Stable SDK versions and
the first `latest` promotion need a separate owner decision.

Production manifest:

```json
{"dependencies":{"@mdbase-dev/sdk":"0.0.1-next.0"}}
```

Dedicated staging builds preserve imports with the exact asset dependency:

```json
{"dependencies":{"@mdbase-dev/sdk":"https://github.com/mdbase-dev/mdbase-connect/releases/download/sdk-v0.0.1-next.0/sdk-staging.tgz"}}
```

LAB uses the same version's `sdk-lab.tgz` URL. Regenerate and commit the frozen
lockfile: its integrity pins the tarball bytes. Never follow a latest-release
URL, resolve a mutable tag, or omit integrity. Installation needs no `.npmrc`,
registry override, `GITHUB_TOKEN` or package credentials. Publisher verification
also checks the matching attached Sigstore bundle against the expected repo,
`publish-sdk-npm.yml`, main ref and reviewed producer SHA. For example, a
downloaded tarball/bundle can be checked with `gh attestation verify <tarball>
--bundle <bundle> --repo mdbase-dev/mdbase-connect --signer-workflow
mdbase-dev/mdbase-connect/.github/workflows/publish-sdk-npm.yml --source-ref
refs/heads/main --source-digest <producer-SHA>`.

Native/web production publishers must reject these URLs and all aliases,
including a URL claiming to contain the production package. Retain their
target-origin/declaration checks. Do not dynamically select an
environment at runtime, retarget production roots, or fall back to production
when staging is unavailable. Local isolated rehearsal keeps its existing
nonpublished local build path; there is no npm local-trust package.

After the first guarded consumer migration, routine bot updates are one
dependency version edit plus the mechanical lockfile change. Trust roots,
archive facts and Dockerfile SHA values no longer need parallel repins. CI
derives the allowed npm package or exact environment asset URL from that dependency and checks
the lock's SRI rather than maintaining a second version/integrity inventory.

## Migration dependency, deletions and rollback

**The SDK cannot be cut yet:** approximately 15 commits from `mdbase-next` still
need porting into Connect `runtime/`. That is a separate track; this PR ports
none. After the port, qualify real source-built WASM, review its integrity pin,
run full Runtime CI and the real cold/browser/native consumer gates, and obtain
release-owner approval before changing `sdkPublication.ready` to true in a
reviewed follow-up. Do not read that flag as a release-freeze waiver.

This PR replaces SDK use of the committed-archive `publish-runtime-npm.yml`
route with a source-build route and actively rejects SDK names in the old
workflow. The archive workflow remains only for `mdbase` and
`@mdbase-dev/obsidian-runtime`. The image inventory stays unchanged: release
component contract v2 adds the SDK inventory, while `release-bundle.json`
remains OCI-only v1. No current ops change is required: the inspected private
`bin/check-release-components`, `bin/prepare-release`, `bin/verify-release-bundle`,
`bin/write-release-lock`, `bin/check-release-locks` and `bin/verify-release-image`
read ops-owned `config/product-release-components.json` and/or the signed OCI
bundle, not the public source inventory. Those inputs and schema-v1 checks stay
unchanged. The public inventory's v2 addition is not an ops-promotion blocker;
this is a source audit, not live promotion qualification.

Consumer follow-ups, only after the first qualified npm/prerelease cut:

1. Migrate Editor, Reader and TaskNotes individually with the existing protected
   build/upload isolation, target admission, installed-member checks and served
   byte verification retained. Use PR 1068's npm UI intake as the starting point.
2. In each migrated app delete the SDK `file:` dependency, SDK-original `.tgz`,
   `mdbase-next-sdk.json`/environment SDK vendor records, SDK build receipts,
   source/tree/archive SHA and facts-SHA repins, SDK-only Dockerfile copies and
   production/staging config duplication. Do not delete unrelated UI/protocol
   pins or whole mixed vendor records until their remaining users are removed.
3. Remove the `tnapp/production-sdk-original/1` producers, parsers and tests once
   **all** active production/staging/LAB publishers have migrated. Keep immutable
   historical release/rollback evidence for the retention period; old facts are
   evidence only, never a parallel current install source. Retire the off-CI
   original builder and Ops handoff packaging route only when no other named
   consumer needs them; retain the shared verifier/generator.

Read-only consumer inspection on October 30, 2026 found Reader's
`packages/connect/package.json` still on `sdk-dce61ff5-production-beta141.tgz`
with `packages/connect/vendor/sdk-production-beta141.json` using the old facts
schema, and TaskNotes' `config/native-publish/production.json` still recording
`sdk-eaa4e697-production-beta141.tgz` and its facts hash. Editor's configs and
vendor record do the same. These repos/pins are deliberately not migrated by
this PR. No one-line bump is safe until their first npm-intake migration lands.

Production rollback is an exact prior npm version and frozen lock. Staging/LAB
rollback is the exact prior **same-environment** version's asset URL and its
lockfile, followed by existing app publication qualification. Never replace a
release asset, unpublish, overwrite, move a dist-tag as a rollback substitute,
cross environments, or supply new
roots at runtime. If the prior trust certificate is no longer acceptable,
rollback fails closed and needs a newly reviewed SDK version. Until the first
npm cut, the already-approved originals remain the rollback baseline.
