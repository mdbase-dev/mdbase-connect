# Current hosted-provider upgrade qualification

Entry point: `test/upgrade/provider-from-previous --current-upgrade`, run by the
Server CI job `current-provider-upgrade` ("Current provider upgrade and
recovery"). It selects the published predecessor pinned in
`.github/previous-release.env` and builds the actual checkout with
`deploy/docker/Dockerfile.hosted-provider`.

## Local execution

Use Node 24 and build the protocol package first. The pinned predecessor image
must already be in the local Docker cache.

```sh
pnpm --filter @mdbase-dev/connect-protocol build
docker pull "$(sed -n 's/^MDBASE_CONNECT_PREVIOUS_PROVIDER_IMAGE=//p' .github/previous-release.env)"
env -u DATABASE_URL -u MDBASE_CONNECT_R2_ENDPOINT \
  test/upgrade/provider-from-previous --current-upgrade
```

`CANDIDATE_IMAGE` with `SKIP_CANDIDATE_BUILD=true` reuses a local candidate
build for this disposable scenario only.

The harness verifies the pinned published, non-draft release by tag, its exact
annotated origin commit, and the cached predecessor image's OCI source and
revision labels. Image labels are not signature verification; the release
contract's signature and attestation checks remain separate. No release or
deployment authority is emitted.

Each run creates its own UUID-named PostgreSQL and provider containers, an S3
readiness stub and private logs. It rejects external database and R2 targets
and never cleans globally named resources. Docker and loopback socket access are
prerequisites. Raw logs and generated fixture keys stay in the private directory
reported on completion or failure.

## Assertions and limits

The predecessor creates a disposable account, collection, v1 grant and v2
grant through HTTP. The candidate then migrates that database and must:

- keep the canonical authority inventory (records, resources, versions,
  changes, files and outbox authority) and the predecessor's migration ledger
  prefix unchanged, without inventing migration revocation ownership;
- replay exact terminal receipts, reject changed input, enforce the exact
  operation ceiling, and keep a cancelled authority import from returning,
  across a candidate restart;
- record the predecessor's real startup outcome on the migrated database: a
  newer ledger must cause the predecessor's unknown-prefix refusal with
  unchanged state, unless the predecessor has the tolerant runner and every
  newer migration is recorded rollback-compatible
  ([hosted-provider migrations](../../docs/hosted-provider-migrations.md)), in
  which case it must serve the fixture. Other failures never count as the
  expected refusal;
- recover forward when the candidate starts again, then write, narrow,
  reupgrade and revoke.

SQL is read-only observation. This scenario is sequential image upgrade and
predecessor start, not concurrent rolling deployment, control-plane OAuth,
local daemon authority, backup restore or Worker storage. The Server CI job
`provider-migration-rollback` separately runs the previous release's PostgreSQL
provider tests against the candidate's migrations.
