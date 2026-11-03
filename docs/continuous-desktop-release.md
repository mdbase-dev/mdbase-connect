# Continuous desktop releases

Green `main` is the release authority; a server release number is not. Desktop
Release wakes after successful main-push Server CI, every six hours at minute 17,
or a manual run on **main**. Only a full, exact Server CI qualification can
start a build. Superseded main commits are skipped. Workflow-run data is never
used to run PR code with publication credentials.

**Current escalation:** the repository's immutable-releases API reports
`enabled: true`. The frozen updater bootstrap is a signed release asset, so
automatic widening cannot coexist with that policy unchanged. The coordinator
checks the setting and refuses **before creating a tag or publishing anything**.
The release owner must resolve this design conflict explicitly. This PR does
not disable immutability, introduce a new trusted channel, change keys, or claim
that a permanently stuck 10% release is continuous delivery.
An unreadable immutable-releases settings endpoint also fails closed; resolving
the channel design must include its read authorization, not an unreviewed
administration token or a skipped protection check.

## One release line

The coordinator compares the desktop and its bundled dependencies with the
last published desktop tag. Server-only, documentation-only and test-only
changes do not create a release. Releases are at least 24 hours apart, and a
new release cannot replace an in-progress staged rollout. Before publication,
all four existing platform builds, signing/provenance steps and platform
verification remain in place. The Linux build also runs desktop regressions,
browser UI/accessibility flows and the packaged daemon CLI smoke. The required
full Server CI qualification retains the existing client end-to-end lanes.

CI allocates `0.1.0-beta.N`, using the globally increasing GitHub run ID as a
floor, greater than the source version, every existing
`v*` version tag and every published desktop version. A published version that
cannot be exceeded on this beta line stops allocation for owner review. An
annotated `v0.1.0-beta.N` tag reserves the version on the qualified main commit;
the tag records the originating run and time. The source tree is not rewritten
and no version PR is created. The tag worker stamps the root and desktop
package versions only in its disposable build checkout; `MDBN_RELEASE_VERSION`
continues to stamp the bundled daemon. No server images are published.

The coordinator dispatches **the same** `desktop-release.yml` on that automatic
tag. This is intentional: existing installations require Sigstore identities
of `desktop-release.yml@refs/tags/v…`. Signing on `main`, changing the updater's
trusted identity, or introducing another signer would break that contract.
The current release-tag rules prevent updates/deletions, not creation; neither
those rules nor any trust or policy keys are changed here.

An unfulfilled automatic tag is an ambiguous or failed attempt, not permission
to skip to another version. The line stops until the owner inspects its exact
run. No side-effecting operation is retried automatically. The coordinator and
tag workers share one non-cancelling live concurrency group.

## Compatibility, not a human-typed server SHA

`scripts/lib/continuous-client-release.mjs` uses the existing fixed production
Connect, MCP and provider readiness checks. Redirects, staging and caller-
supplied origins do not qualify. It verifies that the exact client commit is
on main, then permits publication only when production contains that commit,
or the exact production-to-client tree diff is off the server-facing contract
axis. The provider's independently observed version is resolved through its
protected annotated server tag and checked separately; Connect ancestry does
not stand in for provider ancestry. Missing commits, unrelated history, unknown paths, protocol/authorization,
trust, server, shared runtime and dependency-lock changes fail closed. Only
static visual assets, locale data, documentation/tests and known release tooling
are off-axis; application JavaScript/TypeScript is not automatically classified
as UI-only. Package-version equality is
not a compatibility test. See [the contract matrix](connect-contract-compatibility.md).

This is deliberately conservative: a shared runtime or SDK source change may
wait for production even when a reviewer considers it compatible. Do not widen
the allowlist as a release workaround. Each build and the final publication
recheck readiness and compatibility without `production_verified_commit`.

## Rollout and stopping

The signed permanent channel and legacy bootstrap start at **10%** with the
existing version-tag seed. On later runs the **same** release widens to 50%
after 24 hours and to 100% after 48 hours, at most one stage per run. No binary
is rebuilt. The tag worker verifies the existing manifest's original signature,
preserves every field except `rollout.percentage`, signs both channel documents
with the same tag-bound identity, and replaces their signatures/checksums.
Immutable GitHub releases are refused rather than circumvented.

There is no machine-readable desktop crash/error aggregation in this repository.
This is a time-based staged rollout, **not** crash-qualified automatic promotion.
Fixed production readiness includes the existing provider recovery/failure
signal; a failed widening or an unknown upload outcome latches
`Continuous desktop status: stopped` into that release's notes. The coordinator
will not resume it automatically. Removing that marker requires owner review
of the failed run and both signed channel assets first.

Set repository variable **`DESKTOP_RELEASE_STOPPED=true`** for a reported crash,
error or operational stop. It stops subsequent builds/publication/widening, not
downloads already offered or updates already installed. For an in-flight stop,
disable **Desktop Release** and cancel its active runs: the workflow's active
state is also read through the API immediately before publishing/widening.
Malformed/unreadable state fails closed. There is no automated rollback or
user-data deletion, and no token with variable-management authority is needed.

The existing committed minimum and `UPDATE_BLOCKED_VERSIONS` remain in force:
required updates bypass rollout, and manual downloads/Store submissions are
not cohort-gated. In particular, installations below the current beta.130
minimum are required updates even at 10%. Altering that policy is a separate
owner decision, not part of this PR. `UPDATE_ROLLOUT_PERCENTAGE` is replaced by
the fixed staged policy and is no longer read.

## Setup and first release (release owner)

1. `DESKTOP_RELEASE_STOPPED` is optional and defaults to running. To hold the first release until an explicit owner run,
   set it to `true` **before merging**, then change to `false` when ready.
   First resolve the immutable-channel escalation above; do not disable the
   repository's protection as an ad-hoc workaround.
2. Keep the existing `desktop-release` environment. Its publication job must
   be allowed to run unattended for continuous delivery; required reviewer
   approvals would intentionally pause it. Its branch policy must allow `v*`.
   No environment or repository settings are changed by this PR.
3. Preserve existing `desktop-release` environment secrets `MACOS_CERTIFICATE_P12_BASE64`,
   `MACOS_CERTIFICATE_PASSWORD`, `APPLE_API_KEY_P8_BASE64`, `APPLE_API_KEY_ID`,
   `APPLE_API_ISSUER` for signed/notarized macOS builds. The existing all-absent
   unsigned-preview mode and partial-configuration refusal are unchanged.
   Preserve `WINDOWS_STORE_IDENTITY_NAME`, `WINDOWS_STORE_PUBLISHER`,
   `WINDOWS_STORE_PUBLISHER_DISPLAY_NAME`, `WINDOWS_STORE_PRODUCT_ID` variables
   for Store output; actual Partner Center submission is still manual.
4. Preserve website dispatch variable `RELEASE_AUTOMATION_CLIENT_ID` and secret
   `RELEASE_AUTOMATION_APP_PRIVATE_KEY`. No new secret is required. Workflow
   permissions grant the coordinator contents/actions write and the signing
   jobs OIDC; the built-in token creates tags and dispatches the tagged worker.
5. After merge and a green full main Server CI, run
   `gh workflow run desktop-release.yml --repo mdbase-dev/mdbase-connect --ref main`.
   Do not supply a version, server SHA or tag. Review the coordinator and
   automatic tagged worker runs. Subsequent main events/scheduled runs do this
   without a person. This PR does not dispatch or publish anything itself.

The supervisor must also retire the old tagged desktop dispatch in ops
`bin/publish-clients`; its `production_verified_commit` input is no longer
accepted. The website's same-version npm intake needs a separate reviewed
change for independent desktop/SDK versions. Neither consumer is modified here.

Tests: `node --test scripts/lib/continuous-client-release.test.mjs scripts/lib/continuous-desktop-release.test.mjs`.
