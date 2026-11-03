# Owner-independent runtime Worker publication

`Release integrated Workers` (`.github/workflows/release-workers.yml`) accepts
protected-main `workflow_dispatch` from either `callumalpass` or the installed
`mdbase-dev-release-automation[bot]` GitHub App. The original actor and rerun
actor must be the **same** authorized identity. Other users, other bots,
cross-identity reruns, PR refs, unprotected refs and source-SHA mismatches are
refused. This is publication authority, never deployment or trust-rotation
authority. No additional trigger or parallel publisher is introduced.

## Main commit to signed publication

1. The upstream pipeline waits for successful `Runtime CI` at the exact Connect
   main SHA. Main pushes and owner/App dispatches qualify; every existing
   mandatory native-WASM, SDK, Obsidian, Hosted worker and Log service DO job
   must succeed. Skipped jobs and racing reruns do not qualify.
2. Using its installation token with Connect **Actions: write**, the pipeline
   dispatches `release-workers.yml` on `ref: main` for each required tier. It
   supplies the existing inputs: `environment`, `source_revision`,
   `ci_run_id`, `ci_run_attempt`, `log_run_id`, `log_run_attempt`, `trust_release`.
   Both evidence pairs can identify the same fully qualified Runtime CI run.
   `source_revision` must equal the dispatch's `github.sha`; if main has moved,
   qualify the new commit rather than relabeling an old one.
3. `trust_release` must be the independently approved tier pin described below;
   it is not selected from the newest image/trust run or from the candidate.
4. The existing read-only build job authenticates trust with the pinned ops
   verifier and builds/tests all three Workers. The separate OIDC job checks
   the build's exact artifact ID and manifest digest, rechecks source CI and
   approved trust, signs/verifies with cosign, rechecks byte custody and uploads
   the signed bundle. No signing, provenance, trust proof or verification step
   is removed. No private read token enters the OIDC job.
5. Wait for the entire publication run to conclude `success` before invoking
   ops' reusable `.github/workflows/runtime-workers.yml`. The resolver does not
   dispatch or wait for publication. Its unchanged-source no-op needs no new
   bundle; changed sources without one hold.

Option (b) deliberately does **not** publish automatically on main push. The
upstream pipeline must dispatch the publication before its existing resolver
call; granting the App access alone does not cause publication.

## Independent trust approval and hold

An owner must provision repository Actions variables
`WORKER_BUILD_TRUST_STAGING` and `WORKER_BUILD_TRUST_PRODUCTION`. Each is public
JSON with exactly these five fields, matching that tier's **already approved**
ops trust baseline:

```json
{
  "source_commit": "<40 lowercase hex characters>",
  "image_run": 123,
  "trust_run": 456,
  "publisher_commit": "<40 lowercase hex characters>",
  "asset_sha256": "<64 lowercase hex characters>"
}
```

The workflow reads only the selected tier's variable, independently in the build
and sign jobs. No dispatch input controls this selection. Missing, malformed,
duplicate-key or different approval pins fail with **`hold: trust change`**
before any cross-repository read credential use, compilation or signing. Every
field must match (JSON whitespace/key order is irrelevant). The same rule
applies to owner dispatch: approve the independent pin first, then dispatch.
The App needs no Variables write permission and must not be granted one.
These variables are not trust authentication: all existing signed release,
context, receipt and asset checks still run. Ops retains its independent
approved pins and its pre-upload deployed-trust comparison.

A trust change requires human approval of the new trust release and coordinated
updates to the relevant independent approval pins. Never update these variables
from a candidate bundle, choose the latest trust release, or retry around a
hold. This PR creates no trust release and sets no approval values.

## Ops compatibility and rollout prerequisites

The publication format stays exactly the ops resolver's existing lookup:

- Workflow path/name: `release-workers.yml` / `Release integrated Workers`.
- Event/ref/source: `workflow_dispatch`, `main`, exact requested commit.
- Final signed artifact: `<tier>-workers-<sha>-<run_id>-<run_attempt>`, retained
  for 14 days; the separate `unsigned-...` transfer is not a publication.
- Manifest schema: `mdbase-<tier>-next-stack/1`; source, publisher SHA,
  qualification runs/attempts, all inventory and Sigstore identity are unchanged.
- The whole run must complete successfully; skipped or unsigned runs do not
  become successful accepted publications. Ops selects the lowest eligible run
  ID, never a newer unauthenticated pin.

**Integration prerequisite:** ops main at `f3af8731` still requires
`callumalpass` for both actor fields in
`bin/lib/staging-worker-publication.py:verify_run`. It explicitly rejects App
publications (and App qualification runs). Before unattended consumption, ops
must admit the same exact owner/App identity pairs for **Connect Worker
publication and Runtime CI receipts only**, preserving its legacy NEXT rules,
signature and qualification checks. Its independent Connect trust-release
verifier remains owner-approved. This Connect-only PR does not change that
private verifier and does not claim end-to-end App acceptance before that
companion change. No event/artifact/schema change is needed in the resolver.

There is no GitHub environment attached to either publisher job, so this
workflow adds no reviewer gate or environment branch-policy requirement. Keep
protected main and the existing `WORKER_RELEASE_READ_TOKEN` read-only private
ops access. Required operator actions are the two approval variables above,
the ops identity-verifier prerequisite, and arranging the upstream App dispatch
before its resolver call. No secret/settings changes or dispatch are performed
by this implementation. PR review requirements are unchanged.

## Tests

`node --test scripts/release-workers.test.mjs` covers exact owner/App identities,
cross-identity rerun refusal, owner/App CI qualification, independent tier trust
holds, duplicate pins, CLI hold redaction, both tiers' immutable custody and
the ops-facing event/workflow/artifact/schema/signature contract. These are
hermetic checks, not live signing, dispatch, deployment or proof that the
current ops actor verifier accepts the App.
