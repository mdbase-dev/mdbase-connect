# Editor continuous deployment

`editor-pages.yml` runs tests for pull requests and main pushes. Those events
publish nothing. The server pipeline in `mdbase-cloud-ops` dispatches publication
on `main`, supplying an immutable `source_sha` and `target` (`staging` or
`production`). There is no per-publish approval or release branch.

```sh
gh workflow run editor-pages.yml --repo mdbase-dev/mdbase-connect \
  --ref main -f target=production -f source_sha=<full-40-character-main-ancestor>
```

The checked-out source must be clean and reachable from `origin/main`. It need
not equal main's head or the workflow run's head. Main moving during the run is
not a refusal. Publication of the same source twice is supported; each run binds
its own artifact and captures its own recovery point.

## SDK and UI intake

The production SDK dependency remains an original committed archive. The guard
finds the one `vendor/sdk-production-*.json` record describing that dependency,
checks its archive length, SHA256, SHA512, facts, trust module, bundled dependency
archives and runtime metadata, and verifies the frozen importer/resolution. It
checks npm's integrity for that exact version and cryptographically verifies its
npm provenance through the shared SDK publisher verifier, including repository,
`publish-sdk-npm.yml`, source ref and producer commit. There is no unsigned or
off-CI authentication exception.

Staging downloads the **same version's** `sdk-v<version>/sdk-staging.tgz` and
`.sigstore.json`. Both digests must match the release assets. `gh attestation
verify` authenticates the archive with that bundle against
`mdbase-dev/mdbase-connect`, `publish-sdk-npm.yml`, the committed publication ref
and producer commit. A staging install is mechanically derived from the frozen
production lock by substituting only that SDK archive and its integrity; no
archive is rewritten. Production trust cannot be used on staging.

Both targets require the packaged trust hash, packaged provenance, and raw
`config/next-trust/<target>.json` hash to match `config/release-components.json`
and the protected environment's `EDITOR_TRUST_ASSET_SHA256`. No trust roots or
policy keys are generated or changed by this publisher.

UI uses the exact npm version in `package.json` and SHA512 integrity in the
ordinary frozen lock. The guard downloads that archive from npmjs, checks its
identity and integrity, and inventories it. Protocol uses its committed archive
and frozen lock integrity. There are no additional UI, SDK or protocol hash
variables or duplicated target configs.

The central ops SDK repin writes the production archive, matching versioned
metadata/facts, manifest, Dockerfile references and frozen lock. Those are the
inputs this guard reads; staging follows the same version automatically. The
pin tests derive the version instead of asserting a historical SDK. The ops
repin must not patch publisher test fixtures or preserve separate native
approvals. UI repins change only the manifest and regenerated lock.

## Build, upload and verification

1. The input job exports only the protected public trust hash. The build has no
   GitHub environment, persisted checkout credentials, deployment secrets or
   OIDC permissions. SDK authentication and original inventories precede install.
2. Frozen install disables lifecycle and pnpmfile hooks. Every installed original
   SDK/UI/protocol member is compared before any dependency execution. Installer
   dependency/CLI namespaces are ignored only if the archive owns no member in
   them. Bundled SDK dependencies remain included.
3. The build runs once, with explicit target-specific public feedback URL and
   Turnstile key. It checks bundle/CSP, target manifests, native bytes and hosting
   controls, then writes the complete static inventory and artifact envelope.
4. The protected upload job never installs or builds application dependencies.
   It installs only the isolated official Wrangler lock. Before and after
   download it binds artifact ID/digest, repository, workflow/ref, exact run and
   attempt, workflow SHA, source SHA/tree, plan and full inventory. Workflow SHA
   and source SHA are separate: dispatch can target an older main ancestor.
5. The existing `mdbase-editor` Pages project and `main` production channel are
   checked, never provisioned. Production captures its current canonical
   deployment UUID plus immutable index/manifest byte and header fingerprints
   before upload. Missing recovery evidence blocks production upload.
6. Inventory is rechecked immediately before upload. The actual deployment UUID
   is resolved from its exact URL, source and Pages channel, including repeated
   uploads of the same source. Only static assets are accepted; source-owned
   controls reject Pages Functions, Workers and additional routing controls.
7. Verify all served bytes, headers and routes on the immutable deployment URL
   within three minutes, then on the custom alias. After immutable success, the
   alias gets complete verification attempts every 15 seconds in a five-minute
   settle window. Failed attempts never count as success.
8. If the production alias fails verification, restore the captured deployment
   via `POST /accounts/<account>/pages/projects/mdbase-editor/deployments/<id>/rollback`.
   Verify the project reports that previous UUID and the alias serves its saved
   index/manifest bytes and headers, allowing five minutes to settle. An unknown
   verification result also triggers recovery. The job still fails after a
   successful rollback; recovery failure is retained, not hidden. Staging does
   not roll back. No automatic rebuild or redispatch is performed.

Receipts retain the plan, authenticated intake, immutable artifact binding,
complete inventory, project/deployment identity, verification attempts, previous
production evidence and rollback result for 90 days. They contain public
publication evidence, not raw Wrangler/API logs, secrets, customer identifiers,
account activity or an application health/admission claim.

## Owner setup before first publication

For **both** `editor-production` and `editor-staging` environments:

- Select a custom deployment branch policy allowing the literal branch `main`
  only (no tags). Remove release-branch policies, required reviewers and wait
  timers, including the separate production GO. Preserve the protected
  environment and its existing scoped Cloudflare credentials; do not add bypass.
- Set only this protected trust expectation, sourced from the committed SDK
  publication contract:

  | Environment | `EDITOR_TRUST_ASSET_SHA256` |
  | --- | --- |
  | `editor-production` | `7912e40838213e60b65848350d319a48019021317b112e3326429b250f0133d7` |
  | `editor-staging` | `18ae86a26f9c8b2442235c537b8d58dcc059c05e4bb0f175607fd0aeacc3f0ad` |

- Remove `NATIVE_SDK_SHA256`, `NATIVE_PROTOCOL_SHA256`,
  `NATIVE_TRUST_ASSET_SHA256` and any `NATIVE_UI_SHA256` inputs. No replacement
  archive/UI expectations are needed. A future trust rotation still requires an
  explicit environment-variable change as well as the reviewed contract change.
- Retain `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; the token needs Pages
  read/edit on the existing account/project, including deployment rollback.

Keep ordinary main PR protection. The release owner may retire unused release
branches after confirming no remaining consumers. No branch, environment or
credential settings are changed by this source.

The Release automation GitHub App must be installed on `mdbase-connect` with
**Actions: write** to dispatch this workflow from ops. Contents/PR write alone
is insufficient. The ops token-minting step must request `actions: write` for
this repository. No new App secret, OIDC grant or workflow-file write permission
is required by dispatch. The workflow's own token stays read-only.

## Local checks

From `apps/editor`, use `rpnpm --node 24.19.0 test:publisher`. Credential-free
rehearsals use `rpnpm --node 24.19.0 test:publisher:build production|staging <SHA>`.
They authenticate public SDK inputs and run the real build/inventory, but never
upload. The staging rehearsal requires `gh` on the builder; CI's Ubuntu runner
provides it. These rehearsals do not replace dispatch admission or live Pages
verification/rollback testing.
