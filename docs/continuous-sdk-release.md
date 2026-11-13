# Continuous SDK publication

The existing `publish-npm.yml` and `publish-sdk-npm.yml` workflows are the only
publishers for their packages. Each runs in two roles:

- On **main** it is the *coordinator*. It wakes on green main qualification,
  every six hours (workspace packages at minute 47, source-built SDK at minute
  37) and, for the source-built SDK, on successful main Runtime CI. After
  production servers, enabled Workers and Editor verify, ops Server CD
  dispatches both coordinators on main with `dry_run=false`. Dispatch failure is
  advisory, never a server-release failure or rollback.
- On a coordinator-reserved **`v0.1.0-beta.N` tag** it is the *publisher*. Only
  tag runs build, pack and publish.

A coordinator selects the production commit and decides what changed. When a
live plan selects packages, its `reserve` job creates an annotated tag
`v<version>` at that production commit and dispatches the same workflow on it,
like the Desktop coordinator. The tag run's ref and commit are the production
commit, so npm's standard provenance names it: workflow
`.github/workflows/<publisher>.yml@refs/tags/v<version>`, source digest equal to
the run's own commit. Nothing overrides `GITHUB_SHA` or checks out another
commit. Every consumer verifier already accepts `refs/tags/v<exact version>`.

PRs never enter publishing environments. A manual coordinator run is on
**main** with `dry_run: true` by default and reserves nothing; no human version
tag or `production_verified_commit` is accepted.

## Package selection and versions

Workspace publication covers the nine packages in `scripts/public-packages.mjs`.
Each package is compared with **its own highest published npm version**, not a
dist-tag, server release or global release counter. The planner verifies the
baseline npm Sigstore/SLSA provenance, publisher workflow, fixed repository,
full source commit and SHA-512 subject against npm's SRI. Unknown/unbootstrapped
packages, unavailable provenance and registry errors fail closed. If the verified
baseline is ahead of the checked-out source, the whole package line stands down
successfully until production catches up; dependency expansion cannot republish
older source. If neither commit contains the other, planning fails with
`publication-baseline-diverged`. An ancestry invocation failure (rather than
Git's status 1 for non-ancestry) fails with `publication-ancestry-unavailable`.
It never guesses a baseline from a mutable pointer or version string.

Changes to a package's shipped inputs select it. Version-only release-prep
edits and tests do not. Shared workspace dependency/build inputs select all
affected packages. A changed workspace dependency also selects its transitive
runtime dependants because their shipped exact dependency will change. Unrelated
packages do not publish. The source-built SDK similarly tracks its own package,
shared runtime/Cargo/build inputs, committed asset/trust pins and packer.

Every package a tag publishes carries that tag's version, so a package version
always names the tag it was built from. The coordinator allocates
`0.1.0-beta.N` above every published version and source manifest version of
the line's packages and above every existing `v0.1.0-beta.*` tag; Desktop,
retired server trains and these reservations share that namespace, and each tag
is used once. Versions may therefore skip numbers; they never go backwards. The
tag run refuses with `publication-version-superseded` if any selected package
has since published a higher version. A published stable or another
incompatible version line stops this beta allocator for release-agent review.
Versions are stamped only into CI outputs; no release-version commits/PRs are
created.

The tag message is a one-line JSON record
`{"schema":"mdbase-npm-release/1","kind":"workspace"|"source","commit":...,"reserved_at":...,"run_id":...}`.
`kind` records which line's coordinator created the tag. A reservation names a
version for a production commit, not for a line: a tag run requires an annotated
reservation at its own commit, made by either line. Both coordinators allocate
from the same namespace, so after a promotion both usually choose the same
`v0.1.0-beta.N` for the same commit. Whichever creates the ref first makes the
reservation. The other coordinator finds that tag among the commit's
reservations, or loses the ref creation to it, and dispatches its own publisher
on the same tag. A tag at any other commit, or one that is not an annotated
reservation, still refuses. A tag run executes the planner committed at its tag,
so until production contains shared reservations, a coordinator uses only its
own line's tags (transition guard; remove once production contains them).
Sharing is safe because the lines publish disjoint
packages, each line's npm provenance names its own workflow file at
`refs/tags/v<version>`, the SDK's GitHub prerelease uses its own `sdk-v<version>`
tag, and run history and "already published" checks are per workflow. The
`Protect release tags` ruleset forbids updating or deleting `v*` tags.

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

Coordinators observe live production and select the newest green first-parent
commit in the common ancestry of main, Connect/MCP and the provider. They check
out that source and require its exact successful **full Server CI main-push**
qualification artifact; a source-SDK coordinator reserves only once the same
commit's exact Runtime CI has passed. A green badge alone, PR,
documentation-only successor or stale qualification cannot substitute.
Missing/unreadable evidence fails closed. However far main has moved, the
coordinator plans the production commit itself; it never waits for production
to reach main's tip. A tag run executes the workflow committed at its tag, so
until production contains tag publication the coordinator reserves nothing and
reports `waiting for production to contain tag publication`.

A tag run qualifies its own commit again: the exact Server CI artifact (which
names the workspace tarballs it packs) and, for the SDK build, exact Runtime CI.
It recomputes the plan against npm, so a rerun after publication selects
nothing.

Each package has a log line and Actions summary naming the selected production
commit, the run commit, verified baseline version/commit and decision (the tag
reserved or dispatched, or publishing from the tag). Fresh production
compatibility still applies before reservation and before each publish.
Planner diagnostics use fixed reasons rather than command stderr.

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

Nonempty workspace planning runs this same `verifyCompatibility` proof before
packing, for **every** public workspace package, including `@mdbase-dev/connect`, protocol,
devkit and webhooks. There are no server-independent
exemptions: i18n, UI and newly added public packages are gated too. The existing
fail-closed contract-path classification is shared unchanged with the source SDK.

The workspace `npm-release-plan.json` records `compatibility.status` as `passed`
with the exact Connect/MCP and provider commit evidence, or `blocked` with the
fixed reason `production-compatibility-unproven`. The Actions job summary also
shows the result. A manual `dry_run: true` reports incompatibility or unavailable proof without failing the
plan, so operators can still inspect and pack the proposed versions. A live
plan fails before packing if this proof is blocked. The protected publisher
still obtains fresh production proof immediately before **each** npm publish;
a passed plan is not reusable publication authority. Source-SDK build
qualification and both publishers' stop switches remain unchanged.

Empty plans do not run compatibility or prior-publication reconciliation: they
cannot enter build/pack/publish jobs. Nonempty live plans still require both,
and an unreconciled prior attempt fails with
`publication-prior-attempt-unreconciled`.

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

An attempted publisher in a failed/cancelled prior main or tag run latches its
line; a tag run still in flight is not an outcome yet. Tag runs share one
non-cancelling concurrency group per workflow and so publish in reservation
order. Coordinators use a separate group and never displace a pending tag run.
A coordinator that finds its production commit already reserved, by either
line, reuses that tag: it dispatches nothing while its own workflow's run on the
tag is in flight, redispatches it if the
run ended without publishing, and fails with `publication-reservation-unconsumed`
if that run succeeded yet the change is still unpublished. Existing Actions run/job history is the attempt journal; there is no new
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

Publication uses the existing grants. npm trusted publishers bind owner,
repository, workflow file and environment, not the ref; workspace versions
beta.118 to beta.149 were published through OIDC from version tags under the
same `publish-npm.yml`/`npm` publisher. The `npm`
environment's deployment policy admits `v*` tags and `npm-sdk`'s admits
`v0.1.0-beta.*` tags. The coordinator's `reserve` job uses the workflow token
with `contents: write` and `actions: write`, as the Desktop coordinator does;
it installs no dependencies. For unattended operation these environments must
not require a human approval per run. Keep npm token publication disabled.
OIDC/provenance and GitHub environment protection remain authoritative. The
`main` branch policies are now used only by historical runs and may be removed.

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
