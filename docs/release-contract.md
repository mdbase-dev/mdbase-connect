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

For semantic-v2 enablement, use this order:

1. Qualify the exact candidate with full Server CI and retain the build-once
   signed image bundle. Create the matching immutable annotated version tag;
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
