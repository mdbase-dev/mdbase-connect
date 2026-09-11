# Bounded server retained-v2 pending-state rollback

Run the registered scenario through the existing server upgrade entry point:

```sh
export PATH=/home/calluma/.local/share/fnm/node-versions/v24.19.0/installation/bin:$PATH
# Preload postgres:17-alpine and the exact server digest from .github/previous-release.env.
# This scenario neither pulls predecessor images nor accesses registry credentials.
env -u DATABASE_URL -u UPGRADE_SERVER_URL test/upgrade/server-from-previous --retained-v2-pending
```

The default `server-from-previous` lane remains intact, including its historical
v1 migration, OAuth and account-deletion checks. The new mode owns UUID-named
PostgreSQL/server containers and a private `/tmp/mdbase-server-retained-v2.*`
directory. It builds the candidate by default. To use an already built candidate:

```sh
env -u DATABASE_URL -u UPGRADE_SERVER_URL \
  SKIP_CANDIDATE_BUILD=true CANDIDATE_IMAGE=mdbase-connect-server:upgrade-candidate \
  test/upgrade/server-from-previous --retained-v2-pending
```

Inputs require beta.95, commit `408c67bc10f128e0833f0da62cb3efb9d94657d7`,
and the digest-only server image in the parent's pin file. The helper verifies
OCI source/revision labels, source policy phases, and the actual images'
generated fresh semantic ceilings `[1]` and `[1,2]`. Containers run by resolved
image ID throughout. This is local binary evidence, not signature/attestation,
newest-release, signed-publication, unique-deployment, or production evidence.
The checkout SHA in evidence identifies context; a dirty checkout is not an
immutable candidate source claim.

The actual candidate control plane registers v1/v2 declarations, accepts new
installation-signed OAuth requests, and claims them with a real local development
session cookie. Requests preserve their original ten-minute proof lifetimes.
Populated pending state survives candidate restart, unchanged beta.95 rollback,
and reupgrade. During rollback both a newly signed v2 request and replay of the
retained signed request must hit the exact fresh-issuance error. Portal approval
of the retained pending v2 request must hit that same gate. The candidate reaches
the subsequent live-offer check. Read-only database hashes cover the migration
ledger, pending requests, grants, access tokens and refresh tokens across these
phases. Reupgrade accepts new v1/v2 requests again.

## Qualification boundary

This server harness has no native connector or hosted authority. The approval
probe deliberately supplies a nonexistent offer and collection, and asserts the
specific missing-live-offer error on candidate. It is **not a valid collection
approval**, successful activation, or evidence of selected-authority readiness.
The beta.95 result proves the server's issuance gate precedes that offer lookup.
No SQL creates authority, no signed proof is rewritten, and no fake activation
receipt is supplied. Zero grants is an explicit assertion.

Activated v2 grants, existing token refresh/adoption, native/provider enforcement,
mutation replay/recovery and revocation across rollback remain **unqualified**.
Completing them requires a real paired native connector and live inventory offer,
or a real hosted authority provisioned and activated through the control plane.
Provider-only retained-policy fixtures do not close this boundary. Reader is
excluded. Do not use this scenario's passing exit code to authorize v2 rollout.

## Parent wiring and verification

Add a separate CI invocation of the mode above after reviewing these files;
preload the exact beta.95 server image and `postgres:17-alpine`. Do not pass the
existing job's `DATABASE_URL`: this mode owns its database. Preserve the default
v1 lane. Parent owns workflow registration and signed artifact qualification;
no workflow changes are made here. Logs/state contain disposable session material
and stay private; only `evidence.json` is appropriate for a reviewed evidence
artifact. Failure produces no success evidence file.

Targeted hermetic verification (Node 24):

```sh
node --test scripts/lib/server-retained-v2-upgrade.test.mjs
bash -n test/upgrade/server-from-previous
bash -n test/upgrade/server-retained-v2.sh
```

On this sandbox the five hermetic tests passed. The actual fixture was attempted
and stopped at `docker info`: `permission denied while trying to connect to the
docker API at unix:///var/run/docker.sock`. No image, migration, HTTP, restart or
rollback phase ran here. The parent must execute the command above on a local
Docker-capable runner; this document is not a fixture-pass claim.

Broader checks were also attempted in this sandbox:

- `pnpm test:fast`: package builds passed; the scripts test stage reported 20
  passing files and 9 failing files, including the concurrently changing release
  and provider upgrade contracts. It did not reach the Rust runner.
- `pnpm test:integration`: stopped in browser-storage at loopback `listen EPERM`;
  accessibility checks did not run.
- `pnpm test:system -- --suite container --no-prepare`: this local pnpm wrapper
  forwarded the extra `--`, which the runner rejected. The corrected local
  invocation `pnpm test:system --suite container --no-prepare` reached the
  container suite and failed at loopback `listen EPERM`.

The existing shared `scripts/lib/upgrade-test-contract.test.mjs` also needs the
parent's coordinated pin/provider-lane updates: its exact pin assertion still
expects beta.94, and its provider release-verification and success-message
assertions still expect the old immediate-predecessor lane. Those provider
assertions were not edited by this server-only task.
