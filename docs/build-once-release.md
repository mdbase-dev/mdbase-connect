# On-demand Worker builds with decoupled source

Status: proposed, draft PRs only. The release freeze remains. Nothing here
authorizes dispatch, publication, deployment, or variable/secret changes.

## Lifecycle

There is one owner-dispatched `release-workers.yml`. Its only dispatch input is
a full `source_revision`. The public canonical repository, protected main ref,
owner actor and triggering owner are required for both build and sign jobs.
The source may be any qualified ancestor of main, not necessarily the workflow
revision. Main can advance between source qualification and dispatch.

The workflow checks out the signing/orchestration revision at its root. Before
using private checkout credentials or executing selected source, its canonical
public helper verifies main ancestry and resolves qualifying Runtime CI evidence.
Each unprivileged build matrix job then checks out that exact source in the fixed
`target/worker-release-source` directory. Neither tier has OIDC signing permission.
Both staging and production are built; no environment selector is needed.

The existing private assembly and pinned trust verifier remain the only managed
assembly/authentication implementations. The assembly reads the explicit source
root exported by the reviewed public helper, while importing orchestration from
the workflow checkout. This is necessary for source commits that predate the new
workflow: no new helper is executed from the selected source. Until the previous
producer is superseded, the assembly also accepts its existing same-root caller;
the old immutable product fixture exercises that compatibility. Native compilation,
real PostgreSQL, zero-skip hosted tests and native-workerd checks remain in the
build job. Source-built programs never run in the signer.

Each tier uploads one immutable temporary artifact, retained for three days.
Tier-specific build-job outputs bind its manifest SHA-256 and artifact ID, so the
build matrix's completion order cannot cross tiers. Only after the whole build
matrix succeeds does the signing matrix download those exact current-run IDs.
It checks the build-job digest, complete file inventory and trust custody, and
rechecks source qualification before and after signing. It never rebuilds, installs
compiler dependencies, uses the private read token, or executes downloaded code.
The signed staging and production candidates are publication evidence, not
permission to deploy either environment.

## Automatic qualification, not latest-run selection

The resolver lists Runtime CI runs for the exact source SHA and main branch.
Only successful completed main pushes or owner/triggering-owner dispatches with
all required execution jobs qualify: WASM, SDK, Obsidian runtime, Hosted worker,
and the log-service DO job. Both legacy `ci` and `log` receipt slots name that
same complete run and its exact observed current attempt.

Exactly one qualifying run is required. Zero candidates or multiple qualifying
runs refuse; there is no timestamp ordering, newest-run choice, or manual override.
A listed attempt must still equal the current run API response. A failed or
in-progress rerun cannot fall back to an older successful attempt. Attempt-specific
jobs are inspected and the current attempt is rechecked to catch racing reruns.
The signer resolves again; its result must equal the receipts already bound by
the build manifest and build-job digest. It cannot silently replace qualification.

## Signature and provenance

The existing `mdbase-<tier>-next-stack/1` schema already has separate fields:

- `next_source`: the exact runtime source commit.
- `publication.publisher_commit`: the workflow revision that signs, from
  `GITHUB_SHA`, not the selected source.
- `publication.run_id/run_attempt`: this owner-dispatched build/sign run.
- `qualification.ci/log`: the exact qualified source run and current attempt.

No `/2` schema, extra build receipt, independent build-run selector or archive
custody contract is needed. File digests/sizes, authenticated trust context and
source-built verifier identity remain bound by the unchanged manifest inventory.
Worker/config/trust bytes do not change during signing.

Who can mint an accepted signed Worker candidate is unchanged: only
`callumalpass` as actor and triggering actor on protected main. The fixed Sigstore
identity remains `release-workers.yml@refs/heads/main`; the certificate SHA binds
to the signer revision. The unsigned build job has read-only GitHub permissions;
only private checkout actions receive the existing read token. The separate
signer has OIDC and no private assembly/credential or source compilation.

Ops remains the verifier and deployment authority. It binds signature and owner
publication run to the signer revision, source qualification/ancestry to the
runtime source, and requires the signer to remain on main. Historical NEXT stays
same-source and historical Connect `/1` publications still verify. Frozen profiles,
independent operator trust pins, code-only update checks, deployment authorization
and exact rollback do not change. There is no new deployed-state schema.

**Merge ops #1325 first, then Connect #1077.** The additive ops reader/assembly
supports the previous producer. Old ops deliberately refuses a decoupled manifest;
Connect pins the revised assembly commit, while the trust verifier pin is unchanged.

## Trust rotation, not dispatch input

Callum owns the `WORKER_BUILD_TRUST` repository variable. It contains the approved
public trust build inputs for both tiers:

```json
{
  "staging": {
    "source_commit": "<40-hex Connect trust source>",
    "image_run": 123,
    "trust_run": 124,
    "publisher_commit": "<40-hex trust publisher>",
    "asset_sha256": "<64-hex canonical trust asset digest>"
  },
  "production": {
    "source_commit": "<40-hex Connect trust source>",
    "image_run": 125,
    "trust_run": 126,
    "publisher_commit": "<40-hex trust publisher>",
    "asset_sha256": "<64-hex canonical trust asset digest>"
  }
}
```

This variable replaces `trust_release`; it is not set by these PRs. Callum changes
it only on trust rotation and records the changed pins in that release's deployment
report. Missing, malformed or unauthenticated inputs refuse. Trust is embedded at
compile time and cannot be replaced after building. Rotation during a build/sign
run can cause a refusal rather than substituting bytes. Independent ops trust
approval is still mandatory. No signing secret or deployment authority is stored
in the variable.

## Retention and cost

Signed candidates request 90 days of GitHub artifact retention, subject to actual
repository/organization policy. There is no durable registry/R2 custody extension.
If a candidate expires, dispatch a new build; do not recover it through an
unverified mirror or infer equivalent artifacts. Required source qualification
and trust evidence must still verify, otherwise the new dispatch also refuses.

There are no additional per-main builds. Existing path-filtered OCI publication,
owner-dispatched image rebuilds, Server CI cancellation and Runtime CI push/PR
filters are unchanged. Compilation cost is incurred only on Worker dispatch:
two existing managed assemblies, each with its existing 90-minute build ceiling,
plus up to 15 minutes per signing job. These are timeout ceilings, not measured
billed duration. Matrix tiers duplicate native compilation as before the revision;
no cost-saving claim relies on unmeasured cache reuse. SDK/WASM publishing is not
changed by this work.

## What this replaces and deletes

- Removes the source/signing SHA equality that required freezing main.
- Removes four manual CI/log run/attempt inputs and the trust dispatch input.
- Deletes `build-workers.yml`, the select/unpack scripts, archive extraction and
  independent build-run receipts introduced by the earlier draft.
- Removes the earlier draft's OCI and per-main CI behavior changes completely.
- Keeps one dispatch workflow, one existing assembly, one verifier and one signer
  identity; no selection pipeline, storage extension or deployment transition.

The remaining rollout decision is authorization after the freeze. Source tests
are not a real signed publication or ops-acceptance qualification; those require
a separately authorized dispatch. These PRs stay drafts and do not perform one.
