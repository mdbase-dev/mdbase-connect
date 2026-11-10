# Source-built SDK publication

The SDK uses an independent CI-computed version and publishes changed qualified
main source after production-contract compatibility checks. See
[continuous SDK publication](continuous-sdk-release.md) for triggers, selection,
stop/recovery controls and required environment-policy setup. Editor authenticates its committed production original against npm integrity
and provenance and uses the same version's attested staging asset. See
[Editor continuous deployment](../apps/editor/NATIVE_PUBLISHER.md). Other apps
keep their current originals until their guarded npm intake migration lands.

## Decision: separate package identities, build-time trust (model a)

| Environment | Embedded package identity | Distribution | Embedded trust |
| --- | --- | --- | --- |
| Production | `@mdbase-dev/sdk` | npmjs, exact version | Production only |
| Staging | `@mdbase-dev/sdk-staging` | `sdk-v<version>/sdk-staging.tgz` prerelease asset | Staging only |
| LAB | `@mdbase-dev/sdk-lab` | `sdk-v<version>/sdk-lab.tgz` prerelease asset | LAB only |

Only production goes to `registry.npmjs.org`, with the `latest` tag.
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
verified npm provenance. Editor retains a committed original archive plus
repin-generated metadata, authenticated against that exact npm version; this is
not an arbitrary tarball override. Reject unverified aliases, URLs/archives,
linked/workspace SDKs, patched source and installed-member drift. The shared
`production-version` admission command accepts only an exact npm version; the
first consumer migrations must wire this into their protected publishers before
installing, and verify the lock resolves to npmjs. Preserve the complete
installed-member comparisons introduced for npm UI in PR 1068. A bot changes
the dependency version and regenerated lock, not trust policy. Never migrate
by deleting the native publisher's SDK guard without replacing that intake.

## Build, provenance and qualification

`publish-sdk-npm.yml` separates an unprivileged shared build from the protected
`npm-sdk` production publisher and the internal prerelease publisher. It checks
out the workflow's exact commit; builds the
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
updated; CI must not auto-bless its output. When updating pins, match the
workflow's Rust path remapping as well as its pinned tools and optimizer flags:
map the compiler host's checkout root to `/source` and Cargo home to `/cargo`.
Source paths can survive WASM stripping, so builds without these mappings do not
produce publication-compatible bytes. Verify the corrected pins with the actual
`scripts/sdk-publication.mjs pack-all` cold-consumer and archive checks.
After committing runtime changes and rebuilding `cargo xtask wasm-app` with
those mappings, run `node scripts/sdk-publication.mjs pin-runtime` to regenerate
the runtime integrity pin and its served-method inventory. Review that diff;
this is an explicit maintainer command, never an automatic CI acceptance step.
No WASM ABI, wire protocol, bundled
`connect-protocol` dependency or protocol version is changed here. Keep that
exact bundled protocol and its archive for cold consumers; removing it needs
separate compatibility work, not an incidental publication cleanup.

`dist/native/provenance.json` binds the SDK producer commit, environment,
reviewed trust context and runtime pin. It replaces per-app SDK-original facts,
not release/grant authority. The GitHub artifact attestation binds the exact
packed tarball to this exact main-ref workflow; npm `--provenance` additionally binds
the registry publication. Neither proves deployment, current CP membership or
per-app operations. Review of the committed pin is the trust authorization for
this source build; this is not an invented Ops handoff/signature receipt.

Every live publication requires the exact commit's successful full Server CI
and Runtime CI, `ready: true`, and production-compatible contract axes. Green main
changes publish automatically; manual dispatches default to dry-run. The shared
continuous-client gate checks fixed canonical production health/readiness and
source ancestry/diffs immediately before publication, without a human-typed SHA.
The owner must allow main in the existing `npm-sdk` environment policy; this PR
does not change the environment or add a human reviewer/token fallback.
Source/pin changes must pass Runtime CI for that exact SHA; a documentation-only
successor without Runtime CI cannot reuse an older commit's qualification.
The build job has no OIDC permission. The production publisher verifies and
publishes only the fixed `sdk-production.tgz`, unchanged, with scripts disabled,
explicit npmjs registry and OIDC provenance. Nonproduction tarballs cannot match
that command's path or production package/registry admission checks. A conflicting
npm version is an error, never a skip.

The publisher authenticates through GitHub OIDC alone, using **one npm trusted
publisher** for `@mdbase-dev/sdk`: owner `mdbase-dev`, repository
`mdbase-connect`, workflow `publish-sdk-npm.yml`, environment `npm-sdk`. It has
no token binding or token fallback. The npm package must disallow token
publishing. The scope owner confirmed this trusted publisher on 2026-11-01.

The protected beta.149 tag retains the one-time bootstrap binding used for the
first package publication, with the same exact-archive checks and `--provenance`
command. After successful publication, the owner revoked the short-lived
bootstrap token and deleted `NPM_SDK_BOOTSTRAP_TOKEN` from `npm-sdk`. That
historical tag is not modified. Never publish a placeholder or use an
interactive local SDK publish. Do not create npm trusted publishers or registry
entries for staging/LAB.

### Pinned staging/LAB prerelease

The same run's `attest-internal` job downloads the shared build artifact and
attests each internal tarball individually. It has only `contents: read`,
`attestations: write` and `id-token: write`; OIDC is used solely for these
attestations. It stages the exact tarballs and their Sigstore verification bundles
as one run-local transfer artifact. It has no npm setup or credentials.

`publish-internal` runs only after the verified `npm-sdk` production publish
succeeds, so a dry or failed run never consumes a
`sdk-v<version>` tag. It downloads those four fixed files. Its only granted permission
includes `contents: write` and `actions: read` for the stop check: no OIDC,
attestation-write, packages permission or npm
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
the same version. A release agent reconciles it until the outcome is known,
records the evidence, and prepares a new version if the tag was already created. The npm and prerelease jobs are not a transaction; one
may succeed while the other fails. Neither is silently republished or repaired.

The active repository tag ruleset blocks updates and deletions of `v*` and
`sdk-v*` tags with no bypass actors, while allowing tag creation. Repository
immutable releases are enabled: these newly published prereleases lock their
tags and assets after all four files have been uploaded to the draft. Existing
published releases are not retroactively locked. See
[release tag and asset integrity](release-contract.md#release-tag-and-asset-integrity).
Consumers must still pin the exact URL and lockfile integrity and verify the
attached attestation against the reviewed producer SHA.

Manual dispatch defaults to `dry_run: true`. PRs and changed-package dry runs
build and verify all three packages without npm credentials, attestations or
publication. Healthy main changes publish automatically once production
contains them: the main coordinator reserves a `v<version>` tag at the
production commit and publishes from a run on that tag (see
[continuous SDK publication](continuous-sdk-release.md)). A live coordinator
dispatch is on main, for example:

```sh
gh workflow run publish-sdk-npm.yml --repo mdbase-dev/mdbase-connect \
  --ref main -f dry_run=false
```

A stale WASM pin or failed consumer test remains a failure, never an
archived-original fallback. A successful dry run is build evidence and grants
no production or publication authority.

## Versioning and consumption

CI computes `0.1.0-beta.N` above every published SDK version and the source
manifest version. It stamps the root and SDK manifests only in the build
workspace, after frozen installs; no version PR, hand-created tag or human
version input is needed. Server release-preparation versions are no longer SDK
publication authority. The three environment packages share the computed
version; their package names distinguish trust. The internal `sdk-v<version>`
tag records the producer SHA after npm publication; it is not a source-version
commit. The publishing ref is the reserved `v<version>` tag at that SHA. The Obsidian runtime's own version remains independent.
Continuous delivery moves `latest` on every publish. A package only moves when
it has a qualified change, so an unchanged package keeps its older `latest`. The
`next` tag is retired: nothing reads it, and it stays frozen on npm because
removing a tag needs an interactive login. Versions below are illustrative
historical pins, not latest selectors.

Production manifest:

```json
{"dependencies":{"@mdbase-dev/sdk":"0.1.0-beta.149"}}
```

Dedicated staging builds preserve imports with the exact asset dependency:

```json
{"dependencies":{"@mdbase-dev/sdk":"https://github.com/mdbase-dev/mdbase-connect/releases/download/sdk-v0.1.0-beta.149/sdk-staging.tgz"}}
```

LAB uses the same version's `sdk-lab.tgz` URL. Regenerate and commit the frozen
lockfile: its integrity pins the tarball bytes. Never follow a latest-release
URL, resolve a mutable tag, or omit integrity. Installation needs no `.npmrc`,
registry override, `GITHUB_TOKEN` or package credentials. Publisher verification
also checks the matching attached Sigstore bundle against the expected repo,
`publish-sdk-npm.yml`, exact version tag and reviewed producer SHA. For example, a
downloaded tarball/bundle can be checked with `gh attestation verify <tarball>
--bundle <bundle> --repo mdbase-dev/mdbase-connect --signer-workflow
mdbase-dev/mdbase-connect/.github/workflows/publish-sdk-npm.yml --source-ref
refs/tags/v<version> --source-digest <producer-SHA>`. Use the exact producer workflow
ref recorded for that version: `refs/heads/main` for beta.153 to beta.168, the
protected version tag otherwise.

Production publishers must reject staging/LAB URLs and all unverified aliases,
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

## Editor consumption and deployment

Editor uses its ordinary manifest, matching `vendor/sdk-production-*.json`
metadata/facts and frozen lock as its SDK pin. The central ops repin writes
those inputs and must not preserve publisher fixtures or separate native
approvals. The guard discovers the matching metadata from the manifest, checks
its bytes against the committed archive and npm, verifies npm provenance, and
compares all installed members before execution. UI version/integrity comes
only from the manifest and lock; protocol uses its committed file pin.

Staging derives the same SDK version's exact `sdk-staging.tgz` and bundle URL,
checks both release digests, and verifies the repository, publication workflow,
producer ref and commit with `gh attestation verify`. Its unprivileged frozen
install substitutes only that authenticated SDK and integrity. The packaged
trust hash must match the release-components contract and the protected
`EDITOR_TRUST_ASSET_SHA256` for the target. Repins never change that variable.

The ops server pipeline dispatches Editor on main with an immutable source SHA
reachable from main. Main advancing is allowed. Production alias verification
failure triggers the Pages rollback API to the captured prior deployment,
verifies the restored alias, retains a receipt and fails the job. This static
rollback does not change any SDK version, trust roots, policy keys or registry
release. See `apps/editor/NATIVE_PUBLISHER.md` for the full procedure.

## Migration dependency, deletions and rollback

PRs 1075 and 1080 brought Connect `runtime/` up to the production hosted source
and f9da6acd serving fixes. Publication still requires qualified source-built
WASM with its reviewed integrity pin, full exact-commit Runtime CI and real
cold/browser/native consumer gates. `sdkPublication.ready` records source-build
qualification; it never substitutes for staging acceptance, production
verification or unchanged production trust.

The application pin is 3,732,264 bytes, SHA-256
`34079d5404c501b28069779a37f38ca84febc704074a8bafd607b6595925a076`,
built with Rust 1.94.0 and the locked Binaryen optimizer from the runtime inputs
at `bf558f23da9d53cb361c495d36a5bcb619f4cc4e`, including PRs 1099, 1110, 1108,
1100, 1119, 1123 and 1124 (beta.149 shipped 3,720,400 bytes, `643eef62…`, from `e161f426`). The build uses
the SDK publication workflow's canonical source and Cargo path remaps. Qualification
includes canonical verification of all three trust assets, the actual-WASM
SQLite/backfill smokes and cold installs/typechecks of all three packed variants.
The release workflow must reproduce that pin and pass exact-commit CI again.

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

1. Migrate Reader and TaskNotes individually with the existing protected
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
`sdk-eaa4e697-production-beta141.tgz` and its facts hash. Those consumers need
their own authenticated intake migration. Editor uses the authenticated
metadata/archive path described above.

Production rollback is an exact prior npm version and frozen lock. Staging/LAB
rollback is the exact prior **same-environment** version's asset URL and its
lockfile, followed by existing app publication qualification. Never replace a
release asset, unpublish, overwrite, move a dist-tag as a rollback substitute,
cross environments, or supply new
roots at runtime. If the prior trust certificate is no longer acceptable,
rollback fails closed and needs a newly reviewed SDK version. Until the first
npm cut, the already-approved originals remain the rollback baseline.
