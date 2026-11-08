# Continuous SDK publication

The existing `publish-npm.yml` and `publish-sdk-npm.yml` workflows are the only
publishers for their packages. They now wake on green main qualification and
every six hours (workspace packages at minute 47, source-built SDK at minute 37).
The source-built SDK also wakes on successful main Runtime CI. After production
servers, enabled Workers and Editor verify successfully, ops Server CD dispatches
`publish-sdk-npm.yml` on **main** with `dry_run=false`. The existing release App
provides Actions write; no new secret, publisher identity or policy key is needed.
Dispatch failure is advisory, never a server-release failure or rollback.
PRs never enter
publishing environments. A manual run is on **main** with `dry_run: true` by
default; no human version tag or `production_verified_commit` is accepted.

## Package selection and versions

Workspace publication covers the nine packages in `scripts/public-packages.mjs`.
Each package is compared with **its own highest published npm version**, not a
dist-tag, server release or global release counter. The planner verifies the
baseline npm Sigstore/SLSA provenance, publisher workflow, fixed repository,
full source commit and SHA-512 subject against npm's SRI. Unknown/unbootstrapped
packages, unavailable provenance, non-ancestor source and registry errors fail
closed. It never guesses a baseline from a mutable pointer or version string.

Changes to a package's shipped inputs select it. Version-only release-prep
edits and tests do not. Shared workspace dependency/build inputs select all
affected packages. A changed workspace dependency also selects its transitive
runtime dependants because their shipped exact dependency will change. Unrelated
packages do not publish. The source-built SDK similarly tracks its own package,
shared runtime/Cargo/build inputs, committed asset/trust pins and packer.

Each selected package receives an independently computed `0.1.0-beta.N`, above
all its published versions and its source manifest version. Package versions
need not equal the server, desktop or each other. A published stable or another
incompatible version line stops this beta allocator for release-agent review. Versions
are stamped only into CI outputs; no release-version commits/PRs are created.

For workspace packages, exact full Server CI qualification supplies the already
built tarballs. The unprivileged pack job preserves their compiled files and
rewrites only package metadata: the computed version, exact selected/published
workspace dependencies, and source commit. It does not rebuild qualified code.
The protected publisher rechecks each archive's identity/source before OIDC
publication with `--ignore-scripts --tag latest --provenance`. Prerelease
versions need the tag stated, so `latest` stays explicit.

For `@mdbase-dev/sdk`, the existing locked verifier/WASM build, committed
WASM/SQLite/trust integrity checks, cold consumers and extracted-package checks
remain. CI stamps the root and SDK version only **after** frozen tool installs.
The three environment archives are built once from the same source and bytes.
Production goes only to npmjs `latest`; staging and LAB retain private manifests
and their individually attested `sdk-v<computed-version>` immutable prerelease
assets. All assets are uploaded to the draft before publication. The original
trust roots, pins, policy keys and consumer admission rules are not modified.

The reviewed prebuilt `runtime/npm` archives (`mdbase` and
`@mdbase-dev/obsidian-runtime`) are **not SDK source releases**. Their existing
`publish-runtime-npm.yml` manual, unchanged-archive path is unchanged and still
refuses SDK archives. Automating those independently versioned artifacts would
require a separate approved source-build/qualification contract.

## Qualification and compatibility

Both planners observe live production and select the newest green first-parent
commit in the common ancestry of main, Connect/MCP and the provider. They check
out that source and require its exact successful **full Server CI main-push**
qualification artifact; the source-built SDK additionally requires exact
successful Runtime CI. A green badge alone, PR, documentation-only successor or
stale qualification cannot substitute. Missing/unreadable evidence fails closed.
The selected commit is recorded in the plan and exported as a job output.

Build, pack and publisher checkouts use that plan commit, never a newly resolved
main tip. Source-sensitive shell commands explicitly export it as `GITHUB_SHA`,
including npm's provenance generation (a job-level default-variable override
would be ignored by Actions). The workflow and OIDC publisher identity remain
on main.

npm refuses provenance whose source commit differs from the commit the workflow
ran on, so a run publishes as its own commit. When main has moved past
production, the run still publishes if the selected production commit is an
ancestor of the run's commit and nothing between them changes a published
package's inputs (any manifest change counts, even version-only) or a
server-facing contract path. The production commit's qualified bytes are then
the run commit's bytes. The plan waits up to ten minutes for the run commit's
own Server CI to pass and, for the source-built SDK, up to twenty-five more for
its Runtime CI, which the build job requires. It then qualifies that commit and
packs its artifacts with provenance naming it. Otherwise the plan reports no changed packages and the
run ends successfully without publishing; a later run on a production-contained
main publishes the change.

Runtime CI now qualifies every main push, including documentation-only
successors, so a newer main commit cannot strand an otherwise changed SDK
waiting for a qualification that will never be scheduled. Its PR path filter
is unchanged. This expands main CI coverage; it does not reuse an older SHA.
Workflow-run
events are restricted to successful main pushes from this repository, and
publishers never consume artifacts from the triggering run as arbitrary input.
All plan/build transfers belong to this run and identify its selected source SHA.

`continuous-client-release.mjs` retains the fixed production Connect/MCP and
provider readiness observations. It proves compatibility independently against
Connect/MCP's revision and the revision the provider reports in `/ready`:
each must contain the client commit, or its exact tree diff to the client must
be off the contract axis. Unknown paths, authorization/protocol, server, shared
runtime, dependency-lock and trust changes fail closed. Only documentation/tests,
known release tooling, static visual assets and locale data are off-axis;
application JavaScript/TypeScript is not assumed safe merely because it is UI.
No equality between unrelated package/server
version numbers is required. Readiness/compatibility and workflow-active state
are rechecked immediately before every npm publication.

Workspace planning runs this same `verifyCompatibility` proof before packing,
for **every** public workspace package, including `@mdbase-dev/connect`, protocol,
sync, devkit, testing, webhooks and pickle. There are no server-independent
exemptions: i18n, UI and newly added public packages are gated too. The existing
fail-closed contract-path classification is shared unchanged with the source SDK.

The workspace `npm-release-plan.json` records `compatibility.status` as `passed`
with the exact Connect/MCP and provider commit evidence, or `blocked` with the
verifier's error. The Actions job summary also shows the result. A manual
`dry_run: true` reports incompatibility or unavailable proof without failing the
plan, so operators can still inspect and pack the proposed versions. A live
plan fails before packing if this proof is blocked. The protected publisher
still obtains fresh production proof immediately before **each** npm publish;
a passed plan is not reusable publication authority. Source-SDK build
qualification and both publishers' stop switches remain unchanged.

This conservatively waits for production on shared SDK/runtime or otherwise
unclassified changes; it does not assert semantic compatibility from green CI
alone. See [the contract matrix](connect-contract-compatibility.md).

## Stopping and failure recovery

Set repository variable **`SDK_RELEASE_STOPPED=true`** to stop subsequent SDK
plans/jobs. Empty/`false` means running; malformed values stop. For an in-flight
stop, disable **Publish npm packages** and **Publish source-built SDK** and
cancel their active runs. The publisher rechecks the relevant workflow's active
state through the API before each external mutation. Nothing retracts versions
already on npm or automatically rolls back consumers.

An attempted publisher in a failed/cancelled/unknown prior main run latches its
line. Existing Actions run/job history is the attempt journal; there is no new
release database. Authorization failures and timeouts are not absence proof. An
exact npm-version **404** is required before publishing. Concurrency is
non-cancelling and global per existing publishing workflow, so a run can queue
behind another for the same commit and plan while npm still hides the version.
When the recheck then reads HTTP 200 with verified provenance for this exact
commit and publisher workflow, the run publishes nothing and ends successfully.
Any other HTTP 200 still fails for release-agent reconciliation.

Release agents own acknowledgements and stops; they need no owner approval. An
agent must inspect all outcomes, immutable package provenance and internal
release assets before acknowledging a failed attempt, reconcile a partial or
unknown outcome until it is known, and record the evidence in the deployment
report or release dashboard. Only then does the agent set repository variable **`NPM_RELEASE_ACKNOWLEDGED_RUN`** (workspace line) or
**`SDK_RELEASE_ACKNOWLEDGED_RUN`** (source-built line) to that reviewed run's
numeric ID. Acknowledgement is not a retry command and does not modify packages,
tags or assets. The next plan independently verifies registry history and
selects only still-changed packages. An SDK npm success followed by an internal
release failure is not silently repaired: retain the original run artifacts
and follow the existing SDK prerelease recovery contract. An agent clears
`SDK_RELEASE_STOPPED` the same way, once the cause is reconciled and recorded.
Never delete or retarget a tag, replace an immutable asset, or replay an
uncertain npm publish.

## Setup and first release

No new publication secret or long-lived npm token is required. Preserve:

- `npm` environment and each workspace package's existing npm trusted publisher:
  owner `mdbase-dev`, repository `mdbase-connect`, workflow `publish-npm.yml`,
  environment `npm`.
- `npm-sdk` environment and `@mdbase-dev/sdk`'s existing trusted publisher:
  the same owner/repository, workflow `publish-sdk-npm.yml`, environment `npm-sdk`.
- `npm-runtime` and its existing trusted publisher are unchanged. There are no
  new staging/LAB npm publishers or secrets.

**Required owner action:** allow **main** in `npm` and `npm-sdk` environment
deployment branch policies; `npm-sdk` previously admitted only version tags.
For unattended operation these environments must not require a human approval
per run. These are not changes this PR makes, and no workflow is dispatched by
its implementation. Keep npm token publication disabled. OIDC/provenance and
GitHub environment protection remain authoritative.

`SDK_RELEASE_STOPPED` and the two acknowledgement variables are optional; no
acknowledgement should be set during healthy setup. To hold a first release, set
`SDK_RELEASE_STOPPED=true` **before merging**, then clear it after reviewing main
CI and environment policy. Dry-run from main first:

```sh
gh workflow run publish-npm.yml --repo mdbase-dev/mdbase-connect --ref main -f dry_run=true
gh workflow run publish-sdk-npm.yml --repo mdbase-dev/mdbase-connect --ref main -f dry_run=true
```

Review each exact run, plan and packed artifacts. To make the first real
publication, a release agent uses the same commands with `dry_run=false`. Subsequent
qualified package changes publish automatically. Packages without a qualified
baseline still require their documented one-time scope-owner bootstrap; this
workflow never creates placeholder packages or bypasses first-publication policy.

The existing ops `bin/publish-clients` still dispatches tagged workflows with
`production_verified_commit`. The supervisor must retire those SDK invocations
when adopting this producer; they are no longer accepted and must not become a
parallel publication path. This product PR does not edit the ops repository.

Downstream publishers that admit only `refs/tags/v<version>` provenance must
explicitly review intake of these **main-ref** SDK publications, retaining their
exact workflow, producer-SHA, registry, SRI and environment checks. This PR does
not weaken those consumers or claim automatic admission. Desktop/website
consumers must not infer an SDK version from the independently versioned desktop.

Tests: `node --test scripts/lib/continuous-client-release.test.mjs scripts/lib/continuous-sdk-release.test.mjs scripts/lib/sdk-publication.test.mjs scripts/lib/sdk-prerelease.test.mjs`.
