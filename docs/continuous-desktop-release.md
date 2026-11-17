# Continuous desktop releases

Green `main` is the release authority; a server release number is not. Desktop
Release wakes after successful main-push Server CI, every six hours at minute 17,
or a dispatch on **main**. Ops Server CD dispatches it after production servers,
enabled Workers and Editor have verified successfully; schedules are a fallback,
not the production-completion signal. Dispatch failure is advisory and cannot
fail or roll back the server release.

The coordinator observes the live production Connect/MCP and provider revisions,
then selects the newest green first-parent commit in their common main ancestry.
It checks out that exact source and requires its full Server CI main-push
qualification artifact, not just a green badge. Unknown readiness, history or
qualification evidence fails closed. The workflow's launch SHA need not have
reached production, and main moving again never invalidates the selected source.
Workflow-run data is never used to run PR code with publication credentials.

Repository immutable releases stay **enabled**. A release's signed channel
document says **100%**; its stage lives in a separate signed rollout document
(see [Rollout and stopping](#rollout-and-stopping)). All binaries, signed
channel documents, Sigstore bundles and checksums are uploaded to a **draft**
release before it is published. Nothing rewrites or replaces a published release
asset. No immutable-releases settings API access, new signer, trusted channel or
policy-key change is required.

## One release line

The coordinator compares the desktop and its bundled dependencies with the
last published desktop tag. Server-only, documentation-only and test-only
changes do not create a release. Releases are at least **6 hours** apart while
staged rollout is enabled (`DESKTOP_ROLLOUT_SERVICE` is set) and 24 hours apart
otherwise; installations without early access space their own updates a day
apart. An unfinished automatic release attempt blocks new versions.

An urgent fix can skip the gap, and only the gap: dispatch on main with
`expedite_reason` naming the pull request it ships, e.g. ops
`bin/release desktop expedite "Crash on launch, https://github.com/mdbase-dev/mdbase-connect/pull/1700"`.
The diff, unfinished-attempt, latch and compatibility gates still apply, and
the reason is recorded in the tag reservation. An expedited release still
starts at early access; widen or hold it like any other. Before publication,
all four existing platform builds, signing/provenance steps and platform
verification remain in place. The Linux build also runs desktop regressions,
browser UI/accessibility flows and the packaged daemon CLI smoke. The required
full Server CI qualification retains the existing client end-to-end lanes.

CI allocates the next semver version above every existing `v*` version tag and
every published desktop version, shared with the npm lines. The first release
after the `0.1.0-beta.N` line is `0.1.0`; after that a `## Breaking`
`changelog.d` fragment added since the highest version's tag bumps the minor
version, and anything else the patch. Tags cannot be deleted or moved, so a
reserved version is never reused. A version form it cannot order, or a 1.0
release, stops allocation for release-agent review. Until production contains
semver tag support, the coordinator waits rather than reserve a tag whose tag
worker would refuse it. An annotated `v<version>` tag reserves the version on
the qualified main commit;
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
to skip to another version. The line stops until a release agent inspects its
exact run. No side-effecting operation is retried automatically, with one
exception: the macOS jobs package again, at most three times in all, when Apple's
stapling service fails or the packaged app fails its signature check, because
nothing has been uploaded at that point. The check itself still has to pass.
Ticket validation asks Apple again, at most five times, when the lookup itself
fails with exit 68; it changes nothing, and a missing ticket stops at once. The
coordinator and tag workers share one non-cancelling live concurrency group.

Tags cannot be moved, and a tag worker runs the code at its tag, so a failed
attempt cannot be fixed in place. Release agents own this acknowledgement and
need no owner approval. Once an agent has confirmed that the attempt published
nothing, reconciling a partial or unknown outcome until it is known and
recording the evidence in the deployment report or release dashboard, it runs
the ops front door `bin/release app-line clear desktop`. That is the only way
to acknowledge: it refuses a draft or an unfinished run, then sets repository
variable **`DESKTOP_RELEASE_ACKNOWLEDGED_TAG`** to the newest unfinished
reservation and closes the ops hold. Never set the variable by hand. The
coordinator then ignores unfinished reservations up to and including it and
takes the next number. Acknowledgement is not a retry command and changes no
tag or release.

## Compatibility, not a human-typed server SHA

`scripts/lib/continuous-client-release.mjs` uses the existing fixed production
Connect, MCP and provider readiness checks. Redirects, staging and caller-
supplied origins do not qualify. It verifies that the exact client commit is
on main, then permits publication only when production contains that commit,
or the exact production-to-client tree diff is off the server-facing contract
axis. The provider's independently observed `/ready` revision is checked separately; Connect ancestry does
not stand in for provider ancestry. Missing commits, unrelated history, unknown paths, protocol/authorization,
trust, server, shared runtime and dependency-lock changes fail closed. Only
static visual assets, locale data, documentation/tests and known release tooling
are off-axis; application JavaScript/TypeScript is not automatically classified
as UI-only. Package-version equality is
not a compatibility test. See [the contract matrix](connect-contract-compatibility.md).

Services report the commit their image was built from, so `publish-images.yml`
also rebuilds images for any commit `contractSensitive` flags, even if the
services' own inputs are unchanged. Otherwise a release that reuses images could
never prove that production contains the commit.

This is deliberately conservative: a shared runtime or SDK source change may
wait for production even when a reviewer considers it compatible. Do not widen
the allowlist as a release workaround. Each build and the final publication
recheck readiness and compatibility without `production_verified_commit`.

## Rollout and stopping

The signed permanent channel and legacy bootstrap both contain **100%** rollout
with the existing version-tag seed, and are never replaced. The coordinator
still verifies the last published channel's original signature before selecting
a new release.

Staged rollout is enabled by the repository variable
**`DESKTOP_ROLLOUT_SERVICE=https://updates.mdbase.dev`** (ops
`workers/updates`). While it is set:

- the publish job signs a rollout document at stage `early` and uploads it
  after the draft is complete and **before** the release is published, so a
  published release always has one. An upload failure leaves an unpublished
  attempt, like any other publish failure;
- `operation=rollout` with `stage` (`held`, `early`, `5`, `25`, `100`),
  dispatched **on the release tag**, signs and uploads that stage. It runs from
  the tag so the document carries the release's own signing identity, requires
  the release to be published, takes its own concurrency group per tag, and
  never waits for a build. Uploads authenticate with the run's GitHub OIDC
  token (audience `https://updates.mdbase.dev`); the Worker accepts only this
  repository's `desktop-release.yml` at that same tag. There is no stored
  credential;
- every coordinator run (after the release plan's stop, latch and
  unfinished-attempt gates) reads and verifies the rollout of the four newest
  releases, and moves each one stage along `early → 5 → 25 → 100` once it has
  held its current stage for **6 hours**. Each release keeps its own clock, so
  a new release does not stop an older one reaching everyone. The coordinator
  never moves a release out of `held` or a stage set by hand outside that
  sequence.

Repository variable **`DESKTOP_ROLLOUT_HELD=true`** pauses all automatic
widening; ops `bin/release desktop rollout hold` sets it and
`bin/release desktop rollout release` deletes it. To stop one release for
everyone, early access included, publish its `held` stage:
`bin/release desktop rollout set <tag> held`. Installations that already took
it keep it; a release that blocks it in `blocked_versions` moves them on.
`bin/release desktop rollout set <tag> <stage>` also widens by hand, and
`bin/release desktop rollout status [<tag>]` shows the verified stages.

Unset `DESKTOP_ROLLOUT_SERVICE`, publication is as before: no rollout
document, 24-hour gap, every installation takes each release (older apps read
only the channel document in any case).

The tag worker signs and verifies both manifests, computes their checksums,
then creates a draft with every release asset. Only after all uploads succeed
does it recheck production compatibility, the stop switch and the workflow's
active state, then publish that complete draft. An upload or final-check failure
leaves an unpublished attempt for release-agent inspection. An unknown publication
outcome must be reconciled against the exact tag, run and release; never retry
blindly. The coordinator refuses any unfinished automatic tag reservation and
still respects an existing `Continuous desktop status: stopped` notes marker.

Repository variable **`DESKTOP_RELEASE_STOPPED=true`** stops the line for a
reported crash, error or operational stop. It stops subsequent
builds/publication, not downloads already offered or updates already installed.
The coordinator cannot read the private ops repository, so an open ops
`desktop` hold does not stop it by itself. Hold Desktop with
`bin/release app-line stop desktop desktop-held`, which sets this variable
before opening the hold and refuses if it cannot. For an in-flight stop,
disable **Desktop Release** and cancel its active runs: the workflow's active
state is also read through the API immediately before publication.
Malformed/unreadable state fails closed. There is no automated rollback or
user-data deletion, and no token with variable-management authority is needed.
Release agents own this switch too, including a stop set for a reported crash:
an agent reconciles the cause, records the evidence, and runs
`bin/release app-line clear desktop`, which deletes the variable.

The existing committed minimum and `UPDATE_BLOCKED_VERSIONS` remain in force:
required updates bypass rollout, and manual downloads/Store submissions are
not cohort-gated. In particular, installations below the current beta.130
minimum remain required updates. Altering that policy is a separate
owner decision, not part of this PR. `UPDATE_ROLLOUT_PERCENTAGE` is replaced by
fixed 100% rollout and is no longer read.

## Setup and first release

1. `DESKTOP_RELEASE_STOPPED=true` is already set and remains set during this
   implementation and review. Keep repository immutable releases enabled.
   A release agent clears it with `bin/release app-line clear desktop` when
   ready to enable publication; the default for an unset switch remains running.
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
5. After review, merge and a green full main Server CI, a release agent may clear the
   stop switch as above and either wait for the next six-hour coordinator wake or run
   `gh workflow run desktop-release.yml --repo mdbase-dev/mdbase-connect --ref main`.
   Do not supply a version, server SHA or tag. Review the coordinator and
   automatic tagged worker runs, including the draft-to-published boundary.
   The same client-diff and 24-hour gates apply to this first run.
   Subsequent production-completion dispatches, main events and scheduled runs do this
   without a person. This PR does not dispatch or publish anything itself.

The supervisor must also retire the old tagged desktop dispatch in ops
`bin/publish-clients`; its `production_verified_commit` input is no longer
accepted. The website's same-version npm intake needs a separate reviewed
change for independent desktop/SDK versions. Neither consumer is modified here.

## Enabling staged rollout

1. Deploy the ops updates Worker (`bin/deploy-updates`) and check
   `https://updates.mdbase.dev/desktop/v1/rollout/v0.0.0.json` answers 404.
   This must happen **before** a desktop release with staged-rollout support
   ships: such an app treats an unreachable rollout service as "not yet" and
   defers automatic updates, while a 404 means "follow the release".
2. Wait for a published desktop release that contains staged-rollout support in
   the app, so that most installations space their own updates.
3. Set `DESKTOP_ROLLOUT_SERVICE=https://updates.mdbase.dev`. The next release
   starts at early access and widens automatically; the gap becomes 6 hours.

Tests: `node --test scripts/lib/continuous-client-release.test.mjs scripts/lib/continuous-desktop-release.test.mjs scripts/lib/desktop-rollout.test.mjs`.
