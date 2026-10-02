# Product release contract

`config/release-components.json` is the public, non-secret inventory of every
product artifact promoted together as an mdbase Connect server release. It owns
component IDs, GHCR repositories, Dockerfiles, build contexts, runtime
platforms, and release-attestation types. It intentionally contains no Render
resource IDs, deployment order, capacity, credentials, or private topology.

`node scripts/release-components.mjs --check` validates the contract and its
repository inputs. Server CI runs this check. Both normal and isolated-staging
image publishers obtain their GitHub matrix from
`node scripts/release-components.mjs --github-matrix`; adding an image only to a
workflow or only to the contract therefore cannot silently produce a partial
release. The required release set is currently `connect`, `hosted-provider`,
`mcp`, and `client`.

After every successful normal publication, `publish-images.yml` downloads the
four exact component records and creates `release-bundle.json`. The bundle is
bound to:

- the full product commit and workspace version;
- the pinned `mdbase-rs` revision;
- the exact successful Server CI run and attempt;
- the exact publication run and attempt; and
- each component's digest-only image, platform, and attestation type.

The workflow signs the JSON blob keylessly and publishes it with its Sigstore
bundle as the `release-bundle` workflow artifact. The signature is an index of
release evidence, not a replacement for it. Private release preparation must
verify the workflow identity and GitHub run identities, then independently
verify every image signature, release-image attestation, source commit, and
registry digest.

## Changing the contract

1. Update `config/release-components.json` and, if the format changes, both
   checked-in schemas.
2. Add or update the Dockerfile and narrow validator tests.
3. Run:

   ```sh
   node scripts/release-components.mjs --check
   node --test scripts/lib/release-components.test.mjs
   ```

4. Review the private mapping in `mdbase-cloud-ops` separately. Public contract
   changes never authorize or identify a private deployment target.

Schema versions are monotonic. Readers fail closed on unknown versions and
unknown, missing, duplicated, mutable, wrong-platform, or wrong-repository
components.

## Upgrade predecessor and historical regressions

`.github/previous-release.env` identifies a versioned published upgrade fixture,
not a live newest-release pointer. Advance its annotated tag, full commit and
immutable server/provider digests deliberately during release preparation.
Ordinary CI queries the exact pinned release, requires non-draft published
metadata, verifies its annotated origin tag resolves to the pinned commit, and
checks pulled image source/revision labels. A newer publication cannot invalidate
an unchanged candidate or retroactively change the tested upgrade pair. Missing,
draft, malformed or mismatched fixture identities still fail; no latest-release
fallback or verification bypass exists.

These checks prove compatibility with the recorded fixture, not the currently
deployed predecessor. The actual deployment pair remains independently bound
and qualified by private release preparation and staging below. The retained
beta95 and beta94 lanes do not move. A fixture refresh itself neither publishes
nor deploys a release.
The current fixture is beta105 (`21d035cc31b9b16548c3a57b51ecdc3c1b8c9dde`),
with server/provider images from verified publication run `35313866662`.

Historical regressions and candidate qualification are separate. The beta94
schema-38→41 prelude and beta95 retained-v2 provider rollback scenarios use the
immutable beta99/schema41 successor pinned in `test/upgrade/historical-provider.sh`.
The historical predecessor pins, complete scenarios and deadlines remain intact;
both sides now identify real historical images rather than permanently requiring
current migrations to equal beta95. The beta95 pending-server regression remains
required independently. Historical image digests, source labels, published release
metadata and annotated origin tags are checked. These tests do not qualify the
current candidate or authorize restoring beta95/beta99 in production.

The same required provider CI job separately runs `--current-upgrade` against
`.github/previous-release.env`, retaining exact published-fixture identity
verification. It exercises predecessor-issued v1/v2 authority and exact receipts through
candidate migration and restart, verifies an unchanged historical ledger prefix
and canonical authority, installs a cancellation fence, and actually attempts
predecessor startup on the resulting database. Same-schema predecessors must
serve the fixture correctly. A newer schema must produce the exact unknown-ledger
refusal without altering the database; unrelated failures and timeouts fail CI.
The candidate must then recover forward with receipts, permissions and the
cancellation fence intact. Refusal is reported as incompatibility, never as
successful rollback. No migration is reversed or removed to make the test pass.

For migration0042, beta99's startup rejects the unknown ledger. This is a
forward-recovery candidate, not an image-only rollback-compatible release.
Private release preparation must bind the actual last known-good deployed
artifacts, not infer them from the newest published fixture or historical tests.
Staging must qualify the exact deployment pair and its explicitly registered
recovery mode before production. CI's non-authorizing fixture evidence cannot
register a transition, waive migration checks, or grant deployment permission.

## Local LAB experiments

`pnpm deploy:lab --confirm LAB` builds the current checkout, pushes immutable
LAB-only images, and delegates mutation and rollback state to the adjacent
private `mdbase-cloud-ops` checkout. The resulting state is disposable and
cannot authorize promotion.

When testing unreleased ops changes from a worktree, select that checkout
explicitly with an absolute canonical path:

```sh
MDBASE_CLOUD_OPS_CHECKOUT=/absolute/path/to/mdbase-cloud-ops \
  pnpm deploy:lab --confirm LAB
```

The command still verifies the checkout's Git top level, private repository
origin, and fixed executable. Omit the variable for ordinary use. Roll back with
the exact state path printed by deployment:

```sh
MDBASE_CLOUD_OPS_CHECKOUT=/absolute/path/to/mdbase-cloud-ops \
  pnpm deploy:lab --rollback /absolute/path/to/state.json --confirm LAB
```

## Independent Editor production publication

Editor is a separate deployment artifact. UI-only changes do not require a new
backend, npm package, or desktop release. Dispatch **Editor CI and release**
(`editor-pages.yml`) from `main`, choose `target=production`, and leave
`production_verified_commit` blank:

```sh
gh workflow run editor-pages.yml --repo mdbase-dev/mdbase-connect \
  --ref main -f target=production
```

The protected `cloudflare-pages` environment still approves production access.
The workflow retains Editor unit/browser tests, manifest/CSP/bundle checks,
exact full Server CI qualification, and post-deployment manifest/asset checks.
Both production paths share one non-cancelling concurrency group, separate from
staging, so a main push or tagged publication cannot cancel an active Editor
production deployment.

Immediately before publishing, `scripts/verify-editor-publication.mjs` requires:

- an exact, clean `main` dispatch whose source is contained in fetched main;
- ready canonical production Connect, hosted provider and MCP services, matching
  backend revisions, protocol 1 and fresh-v2 capability evidence;
- a remote annotated release tag binding that observed backend version/commit;
- that backend commit as an ancestor of the Editor source; and
- unchanged backend-facing build inputs relative to that release: client SDK,
  protocol and management packages, dependency manifests/lockfile, build/type
  configuration, environment files, Editor scripts and authorization manifest.

Editor source/presentation and shared UI changes are independently eligible.
This conservative source gate is not a proof of every application behavior;
review and CI remain mandatory. Changed backend-facing inputs require the
coordinated tagged path below, not an override or fabricated verified SHA.
The independently deployed Editor revision need not equal the backend revision,
and publishing it creates no backend release or backend promotion evidence.
The workflow records the Editor revision in its assets and prints the observed
backend release identity. Retain the dispatch and deployment evidence normally.

For an Editor-only rollback, review and merge a revert, then dispatch the new
main commit through the same checks. Do not publish an arbitrary old branch or
replace an existing backend tag. If the backend-facing inputs changed meanwhile,
stop for coordinated release review.

## Consumer SDK canary (before version tag and ops preparation)

`consumer-canary.yml` directly checks out the public `main` branches of
`callumalpass/tasknotes-app`, `mdbase-dev/mdbase-writer`, and
`mdbase-dev/mdbase-reader`. All three are publicly readable across organization
boundaries; no new secret, GitHub App, reusable workflow, dispatch receiver, or
cross-repository write permission is needed. Checkout credentials are not
persisted and consumer jobs have read-only permissions, no deployment secrets,
and no production mutation. If a consumer becomes private, stop and review a
read-only GitHub App installation token; do not silently skip it.

For every coordinated SDK release, **before creating its version tag or
accepting the ops preparation PR**:

1. Let full Server CI qualify the exact version-prepared candidate on `main`.
2. Dispatch the canary from that exact candidate ref (normally `main`, only
   while it still resolves to that SHA):

   ```sh
   gh workflow run consumer-canary.yml --repo mdbase-dev/mdbase-connect --ref main
   ```

3. Require a successful **Consumer canary gate** for that exact SHA. Retain the
   run ID/attempt and all three `consumer-canary-*` reports. Use the existing
   `scripts/ci/verify-qualified-commit "$candidate_sha"` with
   `GITHUB_REPOSITORY=mdbase-dev/mdbase-connect` and a `GITHUB_OUTPUT` file to
   obtain `artifact_run_id`, then run:

   ```sh
   GITHUB_REPOSITORY=mdbase-dev/mdbase-connect \
     scripts/ci/verify-consumer-canary "$candidate_sha" "$artifact_run_id"
   ```

   The verifier rejects PR/advisory runs, incomplete/failed/cancelled runs,
   mismatched candidate/artifact identities, missing reports, and different
   tarball bytes. Requalification that changes the package-producing run ID
   requires a new canary. `publish-npm.yml` repeats this check before publication;
   there is no skip input. A failed canary requires a reviewed SDK or consumer
   correction and another exact run, not an emergency patch in the canary.

Release dispatches download `qualified-npm-packages` through the same full
qualification verifier and `artifact_run_id` used by npm publication; they do
not rebuild or test already-published npm versions. PRs touching `packages/client`
(and canary implementation files) build/pack once and run the same suites as an
**advisory** check. Do not make this check required for ordinary PRs during the
initial rollout, and never use its synthetic-merge result as release evidence.
The release dispatch and publication check are strict regardless of that PR
branch-protection choice. No workflow creates a tag or deploys a consumer.

`scripts/ci/consumer-canary.mjs CONSUMER DISPOSABLE_CHECKOUT TARBALL_DIRECTORY`
requires a clean disposable checkout, installs the consumer's locked tooling,
replaces direct and transitive `@mdbase-dev/*` pins with `file:` tarballs, removes
SDK patches from both pnpm configuration locations, and checks the resulting
lockfile for non-candidate SDK resolution. Other dependencies and patches remain
locked. Each report records the consumer's actual full commit, candidate package
version and SHA-256 hashes; the workflow adds the SDK commit and qualification,
artifact and canary run identities. The suites are:

- TaskNotes: run its deterministic
  `src/cloud/startup-reconciliation.test.ts` regression with Vitest, then
  `build:e2e` and `test:e2e --project=desktop` against its local built preview.
  The regression forces the #557 supersession race; the browser assertion alone
  is timing-sensitive and can pass a broken SDK. This is
  `production-smoke.yml`'s desktop lane, including
  `e2e/cloud-connection.spec.ts`'s ordinary encrypted relay startup test that
  caught #537/#557. Its live production HTTP checks are not candidate SDK tests
  and are not substituted for this browser lane.
- Writer: start its Vite dev server on loopback port 5320, then
  `apps/writer`'s `test:browser` (`browser-test.mjs` and
  `browser-reliability-test.mjs`), using the isolated `?demo` collection. Set
  `CHROME` to the installed Playwright browser, overriding the current
  workstation-specific reliability-suite default.
- Reader: start its Vite dev server on loopback port 5193, then
  `apps/reader`'s `test:browser` (`scripts/audit-reader.mjs`) with
  `READER_AUDIT_ORIGIN` set to that origin. Its fixture/source routes require a
  dev server, not a production preview. This compatibility check does not
  authorize Reader's semantic-v2 enablement or change its rollout exclusion.

These are consumer-owned isolated browser fixtures, not LAB or a live daemon;
no Docker or production collection is required. For a focused local TaskNotes
reproduction, append `--grep 'opens an ordinary relay collection without requiring
hosted sync'` and use `CANARY_PORT=54273` if the default port is occupied;
release workflow runs never narrow the desktop suite.

### Coordinator follow-ups and consumer ownership

No consumer workflow addition is required for this direct-checkout design. Keep
these entry points runnable without deployment credentials. Precisely:

- TaskNotes: retain the desktop project, its ordinary-relay startup assertion
  in `e2e/cloud-connection.spec.ts`, and the deterministic cancellation/error
  distinction in `src/cloud/startup-reconciliation.test.ts` (already present
  after its emergency-patch commit). No new workflow receiver is needed.
- Writer: preferably replace the hardcoded `/home/calluma/...` fallback in
  `apps/writer/scripts/browser-reliability-test.mjs` with
  `chromium.launch({ executablePath: process.env.CHROME })`, matching
  `browser-test.mjs`. The canary's `CHROME` setting makes this non-blocking.
- Reader: retain `apps/reader/package.json`'s `test:browser` entry point and
  loopback `READER_AUDIT_ORIGIN` support; no new receiver is needed.
- All consumers: remove their beta.123 emergency `@mdbase-dev/connect` pnpm
  patches on the normal upgrade past beta.123. The canary removes these only in
  its disposable checkout so a patch cannot mask a broken release candidate.
- Private ops coordinator: add the exact-SHA/package-run verifier above to the
  guarded preparation workflow **before generating/accepting the release PR**,
  and record the canary run ID/attempt with preparation evidence. That private
  workflow change is outside this repository. Until it lands, the release owner
  must enforce the pre-tag/preparation command; npm publication is already
  machine-enforced here. GitHub cannot prohibit a human creating a tag using a
  workflow check alone. No repository settings or new secrets are required for
  the initial optional-PR rollout.

## Public client release publication

The explicitly dispatched `desktop-release.yml` workflow owns the public desktop
channel after production verification. It creates and verifies `mdbase-connect-channel-v1.json`, publishes the
GitHub release, and only then sends a `connect-client-release-published`
repository dispatch containing the immutable tag to `mdbase-dev/mdbase.dev`.
The receiving repository verifies the signed public channel, release assets,
tag commit, and matching npm package before opening a Downloads update pull
request. It never pushes the website's protected branch directly.

Both repositories require `RELEASE_AUTOMATION_CLIENT_ID` and
`RELEASE_AUTOMATION_APP_PRIVATE_KEY` for a GitHub App installed on
`mdbase-dev/mdbase.dev`. The installation token is restricted to website
contents and pull requests. A failed dispatch is recovered by manually running
the website's **Update Connect release** workflow with the same tag; the public
release is not republished.

Client publication follows server production promotion; it cannot be triggered
by creating a tag. `mdbase-cloud-ops` does not trigger, receive, or hold
credentials for client or website publication.

For coordinated client releases (including Editor deployments from version
tags), and for semantic-v2 enablement, use this order:

1. Qualify the exact candidate with full Server CI and retain the build-once
   signed image bundle. Require the exact qualified-package consumer canary
   described above before creating the matching immutable annotated version tag;
   ops preparation still requires that tag. Tag creation publishes no npm,
   desktop release/feed, or production Editor.
2. Prepare and promote those signed digests through the existing guarded ops
   staging and production process. The parent release owner independently
   verifies the exact enabled candidate on each actual canonical production
   service, including unique service/deployment identity, image digests, hosted
   provider fresh-v2 readiness, and fresh authorization behavior.
3. Only after that verification, dispatch `publish-npm.yml`, then
   `desktop-release.yml`, then `editor-pages.yml` (target `production`), selecting
   the existing version tag as the workflow ref in each case. Supply the full
   verified candidate SHA as `production_verified_commit`. Desktop builds begin
   on this dispatch; no pre-production desktop build is required. Consumers may
   update only after their dependencies are published. Reader remains excluded
   from this enablement rollout.

Immediately before each public mutation, `scripts/verify-client-publication.mjs`
requires a dispatch, matching workspace version/tag/checkout/full verified SHA,
checks the current annotated tag through the existing GitHub API, and reads only
fixed canonical production endpoints. Connect `/health` must identify production,
its canonical origin, the exact revision, protocol 1 and fresh-v2 issuance;
Connect `/ready` must succeed; canonical `sync.mdbase.dev/ready` must identify
the candidate provider version, fresh-v2 issuance and successful notification
recovery with zero consecutive failures; MCP `/health` must identify the exact
revision.
Missing fields, disabled capability, mismatches, redirects, HTTP failures and
timeouts fail closed. Existing exact Server CI qualification and release gates
remain in force. No caller-supplied service URL or cross-repository ops credential
is accepted.

These live public responses supplement the parent's verification. They do not
prove unique service deployment identity, the hosted-provider source revision
(its public readiness exposes version, not source), or successful end-to-end fresh
authorization. Provider fresh-v2 readiness is checked directly, not inferred from
Connect readiness. The full SHA input records the parent's explicit assertion;
it is not a signed receipt or independent readiness evidence. If independent ops
verification is unavailable, do not dispatch. A rollback or service change between
verification and publication requires re-verification; publication is not atomic
with deployment and cannot retract already published packages. Retry a failed
publication only while the same exact candidate is still verified in production.
GitHub environment protection remains authoritative. In particular,
`cloudflare-pages` must permit reviewed release-tag refs for production Editor;
a branch-only environment policy will block this transition and must be reviewed
by the release owner, not bypassed by the workflow. Earlier v1 release history is
unchanged.
