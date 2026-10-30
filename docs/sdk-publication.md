# Source-built SDK npm publication

Status: implementation prepared, **not release approval**. The release freeze
remains in force. No package or workflow was published or dispatched for this
change. `sdkPublication.ready` is false until the separate runtime port and
qualification below are reviewed. Existing apps keep their current originals.

## Decision: separate package identities, build-time trust (model a)

| Environment | Immutable npm identity | Embedded trust |
| --- | --- | --- |
| Production | `@mdbase-dev/sdk` | Reviewed production asset only |
| Staging | `@mdbase-dev/sdk-staging` | Reviewed staging asset only |
| LAB | `@mdbase-dev/sdk-lab` | Reviewed LAB asset only |

Dist-tags are discovery pointers, **not security boundaries**. All previews use
`next`; production does not mean the npm `latest` tag. Consumers pin a version,
never a tag/range. Separate names prevent an environment republish from moving
an existing production name/version to different roots. Model b was rejected:
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
verified npm provenance, and reject nonproduction aliases, linked/workspace
SDKs, patched sources and installed-member drift. Preserve the complete
installed-member comparisons introduced for npm UI in PR 1068. A bot changes
the dependency version and regenerated lock, not trust policy. Never migrate
by deleting the native publisher's SDK guard without replacing that intake.

## Build, provenance and qualification

`publish-sdk-npm.yml` separates an unprivileged build from a protected
`npm-sdk` publisher. It checks out the workflow's exact main SHA; builds the
canonical verifier and application WASM with locked Cargo dependencies and
pinned Rust/binaryen tools; installs the SDK with its frozen npm lock; then
compiles TypeScript, replaces the refusal module, builds browser/Worker bundles,
tests cold npm consumers, packs and verifies the actual extracted archive.
It never downloads an operator-built SDK or builds from a caller's ref.

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

Live publication requires the exact commit's successful full Server CI and
Runtime CI, `ready: true`, main, and approval of protected environment `npm-sdk`.
The first release-preparation commit must include the final SDK version/pin
updates so Runtime CI is triggered for that exact SHA; a documentation-only
successor without Runtime CI cannot reuse an older commit's qualification.
The build job has no OIDC permission. The publisher downloads the build's exact
artifact and publishes unchanged with scripts disabled. It does not rebuild or
skip a conflicting version. npm's immutable version conflict is an error.

Owner setup: configure each package's npm trusted publisher for repository
`mdbase-dev/mdbase-connect`, workflow `publish-sdk-npm.yml`, environment
`npm-sdk`; require owner approval and main-only deployment in that environment.
Disallow token publication once the trusted publisher is established. Do not
add an npm token or publish a placeholder. If a package needs first-name
bootstrap, Callum must resolve it separately under the release freeze; do not
use the old local SDK publication recipe. Existing SDK trusted-publisher
settings pointing at `publish-runtime-npm.yml` must be moved before the cut.

The workflow defaults to `dry_run: true`. A later owner-authorized main dry run
uses only the environment choice and dry-run boolean, builds and verifies the
package but does not request npm credentials, attest or publish. PRs run the
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

Dedicated staging builds can preserve imports using the exact npm alias
`"@mdbase-dev/sdk": "npm:@mdbase-dev/sdk-staging@0.0.1-next.0"`; LAB uses
`sdk-lab`. Native/web publishers must reject those aliases for production and
retain their target-origin/declaration checks. Do not dynamically select an
environment at runtime, retarget production roots, or fall back to production
when staging is unavailable. Local isolated rehearsal keeps its existing
nonpublished local build path; there is no npm local-trust package.

After the first guarded consumer migration, routine bot updates are one
dependency version edit plus the mechanical lockfile change. Trust roots,
archive facts and Dockerfile SHA values no longer need parallel repins. CI
derives the allowed package and registry archive from that dependency and checks
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
remains OCI-only v1. Private contract readers must explicitly adopt v2 before
the release coordinator resumes promotion; no private mapping is changed here.

Consumer follow-ups, only after the first qualified npm cut:

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

Rollback is an exact prior **same-environment** npm version and frozen lock,
followed by existing app publication qualification. Never unpublish, overwrite,
move a dist-tag as a rollback substitute, cross environments, or supply new
roots at runtime. If the prior trust certificate is no longer acceptable,
rollback fails closed and needs a newly reviewed SDK version. Until the first
npm cut, the already-approved originals remain the rollback baseline.
