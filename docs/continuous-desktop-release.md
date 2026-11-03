# Continuous desktop releases

Green `main` is the release authority; a server release number is not. Desktop
Release wakes after successful main-push Server CI, every six hours at minute 17,
or a manual run on **main**. Only a full, exact Server CI qualification can
start a build. Superseded main commits are skipped. Workflow-run data is never
used to run PR code with publication credentials.

Repository immutable releases stay **enabled**. Desktop releases ship at
**100% rollout**. All binaries, signed channel documents, Sigstore bundles and
checksums are uploaded to a **draft** release before it is published. Nothing
rewrites or replaces a published release asset. No immutable-releases settings
API access, new signer, trusted channel or policy-key change is required.

## One release line

The coordinator compares the desktop and its bundled dependencies with the
last published desktop tag. Server-only, documentation-only and test-only
changes do not create a release. Releases are at least 24 hours apart, and an
unfinished automatic release attempt blocks new versions. Before publication,
all four existing platform builds, signing/provenance steps and platform
verification remain in place. The Linux build also runs desktop regressions,
browser UI/accessibility flows and the packaged daemon CLI smoke. The required
full Server CI qualification retains the existing client end-to-end lanes.

CI allocates the next `0.1.0-beta.N` above the source version, every existing
`v*` version tag and every published desktop version, so the desktop stays on
the same numbered beta line as earlier releases. Tags cannot be deleted or
moved, so a reserved number is never reused. A published version that
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

The signed permanent channel and legacy bootstrap both contain **100%** rollout
with the existing version-tag seed. There is no widening job or later channel
replacement. The coordinator still verifies the last published channel's
original signature before selecting a new release.

The tag worker signs and verifies both manifests, computes their checksums,
then creates a draft with every release asset. Only after all uploads succeed
does it recheck production compatibility, the stop switch and the workflow's
active state, then publish that complete draft. An upload or final-check failure
leaves an unpublished attempt for owner inspection. An unknown publication
outcome must be reconciled against the exact tag, run and release; never retry
blindly. The coordinator refuses any unfinished automatic tag reservation and
still respects an existing `Continuous desktop status: stopped` notes marker.

Set repository variable **`DESKTOP_RELEASE_STOPPED=true`** for a reported crash,
error or operational stop. It stops subsequent builds/publication, not
downloads already offered or updates already installed. For an in-flight stop,
disable **Desktop Release** and cancel its active runs: the workflow's active
state is also read through the API immediately before publication.
Malformed/unreadable state fails closed. There is no automated rollback or
user-data deletion, and no token with variable-management authority is needed.

The existing committed minimum and `UPDATE_BLOCKED_VERSIONS` remain in force:
required updates bypass rollout, and manual downloads/Store submissions are
not cohort-gated. In particular, installations below the current beta.130
minimum remain required updates. Altering that policy is a separate
owner decision, not part of this PR. `UPDATE_ROLLOUT_PERCENTAGE` is replaced by
fixed 100% rollout and is no longer read.

## Setup and first release (release owner)

1. `DESKTOP_RELEASE_STOPPED=true` is already set and remains set during this
   implementation and review. Keep repository immutable releases enabled.
   Only the release owner should change the stop switch to `false` when ready
   to enable publication; the default for an unset switch remains running.
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
5. After review, merge and a green full main Server CI, the owner may clear the
   stop switch and either wait for the next six-hour coordinator wake or run
   `gh workflow run desktop-release.yml --repo mdbase-dev/mdbase-connect --ref main`.
   Do not supply a version, server SHA or tag. Review the coordinator and
   automatic tagged worker runs, including the draft-to-published boundary.
   The same client-diff and 24-hour gates apply to this first run.
   Subsequent main events/scheduled runs do this
   without a person. This PR does not dispatch or publish anything itself.

The supervisor must also retire the old tagged desktop dispatch in ops
`bin/publish-clients`; its `production_verified_commit` input is no longer
accepted. The website's same-version npm intake needs a separate reviewed
change for independent desktop/SDK versions. Neither consumer is modified here.

## Follow-up: staged rollout

Serve the channel manifest from a mutable location we own, such as the update
Worker or R2, signed as today with the existing tag-bound Sigstore identity.
Widening would rewrite only that owned manifest and its signature, never any
asset of a published GitHub release. Binary releases, bootstrap assets and
their provenance remain immutable. A separate reviewed change must wire client
discovery and verification to that location and define widening/stop authority
and recovery. This PR does not build that service or change updater trust.

Tests: `node --test scripts/lib/continuous-client-release.test.mjs scripts/lib/continuous-desktop-release.test.mjs`.
