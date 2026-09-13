# Retained-v2 provider rollback qualification

Registered entry point: `test/upgrade/provider-from-previous --retained-v2`.
The default invocation runs this beta95 retained-v2 scenario. The explicit
`--legacy-prelude` invocation preserves the v1/beta94 migration scenarios against
`.github/historical-prelude.env`. That historical lane does **not** qualify
rollback after reachable v2 issuance. Server CI requires both lanes; the
30 minute deadline is unchanged.

## Inputs and local execution

Use Node 24 and build the protocol package first:

```sh
export PATH=/home/calluma/.local/share/fnm/node-versions/v24.19.0/installation/bin:$PATH
pnpm --filter @mdbase-dev/connect-protocol build
# The exact beta95 digest is read from .github/retained-v2-predecessor.env.
# It must already be in the local Docker cache. Overrides must match that pin.
env -u DATABASE_URL -u MDBASE_CONNECT_R2_ENDPOINT \
  test/upgrade/provider-from-previous --retained-v2
```

The immutable source binding is `v0.1.0-beta.95` at
`408c67bc10f128e0833f0da62cb3efb9d94657d7`, whose fresh policy is `[1]`.
The harness checks the local tag commit, that source's policy, the candidate's
`v2-enablement` `[1,2]` policy, and the cached predecessor image's OCI source and
revision labels. Server CI and the harness verify the fixed published, non-draft
beta95 release by tag and its exact annotated origin commit, then CI caches the
pinned digest. All four historical pin fields must match the immutable beta95
release/commit/image pair. A mutable repository variable cannot select the fixture.

This historical regression is intentionally independent of
`.github/previous-release.env`, which advances to the actual newest published
release (currently beta96) and retains its mandatory newest-release check.
Preserving beta95 coverage does not establish a later candidate's immediate-
predecessor provider rollback or authorize production recovery.
Image labels are not signature verification: the release contract's independent
signature/attestation verification remains required for release qualification.
No signature or deployment qualification is claimed by this local scenario.

The candidate is built with the existing provider Dockerfile. To reuse a local
candidate image, set `CANDIDATE_IMAGE` and `SKIP_CANDIDATE_BUILD=true`; actual
HTTP issuance and capability assertions still run. There is no native predecessor
substitute, SQL authority seed, proof rewriting, skipped phase, or repair step.

Each run creates its own UUID-named PostgreSQL and provider containers and private
logs. It rejects external database/R2 targets and never cleans globally named
legacy resources. It uses the existing startup/readiness helpers and S3 readiness
stub. Docker and loopback socket access are prerequisites. Raw logs and generated
fixture keys stay in the private directory reported on completion/failure.

## Assertions and limits

The actual beta95 provider creates a disposable account, collection and v1 grant
through HTTP. The candidate applies declaration-bound fresh v2 setup and issues
v2 through the dedicated internal API with an original signed declaration and
request proof key. It creates real terminal mutation receipts and rejects read,
edit, delete, view, definition, timer and sync operations outside the exact grant,
and a modified setup projection. Setup completion is checked separately from
replica publication; subsequent failure never implies setup was undone.

Candidate restart, beta95 rollback and candidate reupgrade observe persisted
semantic version 2, encrypted records/resources, exact policies, migration ledger
and journals without rewriting them. Exact receipt retries are compared as JSON;
changed input conflicts. Beta95 must retain the existing v2 registration/policy,
execute new permitted work, reject fresh v2 and new signed consent bindings, and
accept narrowing. Narrowing removes setup-apply while preserving create, so exact
create replay remains within the retained operation ceiling. The reupgraded
candidate must issue fresh v2 again. A separate final revocation denies new work.
V1 receipt recovery runs throughout. SQL is read-only observation. Comparison
uses the existing shared canonical-authority inventory (including record/resource
versions, changes, files and outbox authority) plus exact replica, journal and
migration rows. Private full collection snapshots are retained separately: an
observed restart first materialized the six operational projection/updated-time
fields, without changing authority. Those operational fields are not represented
as byte-stable authority. The fixture independently requires unchanged engine,
reader/operation catalogs and migration source bytes across the pair.

This scenario is sequential provider rollback, not concurrent rolling deployment,
control-plane OAuth activation, local daemon authority, consumer acceptance,
Reader conversion, backup restore, revocation restoration, or atomic rollback of
partially completed setup. Those remain separate qualification requirements.
The existing beta94 atomic38-to41 overlap scenario remains intact and is not run
on beta95's already-migrated schema. Never infer that beta94 is a rollback target
for the populated v2 fixture.
