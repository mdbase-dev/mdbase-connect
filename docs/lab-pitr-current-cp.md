# Fixed-run LAB CP adapter

This optional profile supports `gate4-pitr-lab-20261009-01` only. It is not a
production recovery interface or permission to operate a drill. Every G0–G7
operation requires its exact run/target/cost GO.

`MDBASE_NEXT_LAB_PITR` is exact JSON with `run`, `active`, `deleted`, `owner`,
`createdAfter` (immutable admission time in milliseconds), `logUrl`, and
`hostedUrl`. It requires the real Next CP/factories, LAB environment, exact LAB
CP origin, distinct original nonnil UUIDs, and fixed Worker origins in the same
workers.dev account. `MDBASE_NEXT_PITR_AUTHORITY_TOKEN` is a distinct credential,
separate from inbound and outbound hosted/escrow/migration credentials.

Startup rejects existing mapped rows older than admission or bearing another
owner/label, before constructing the mapped clients/emitter. Real bootstrap
requires owner and exact labels `[test] <run> ACTIVE` / `[test] <run> DELETED`.
Namespace/object IDs, original signed genesis and device identities still must
be independently bound in the guarded admission ledger before operations.

Only A/D log requests and nil deletion writes naming A/D select the isolated
origin. Ordinary global origins are unchanged. Both real stateless factories
retain their original role tokens; isolated escrow activation is excluded before
query LIMIT and produces no fabricated ACK or actor wake.

The internal POST endpoints below authenticate the authority-read credential,
limit bodies to 4096 bytes, return no-store metadata, and never unwrap keys:

- `/internal/v1/next/lab-pitr/current`: exact `run`, `collection`,
  `genesisSha256`, `device`, original `kind`, `signPublicKey`, `policyKeyId`.
  Checks original genesis, current owner/member/root/cloud-copy state, deletion,
  all queued/delivered device and security-key revocations, and appended exact
  three-key enrolment. A positive result with `checkedAt` is a point observation,
  not a cached lease. The actor must still verify the signed original identity
  and repeat current checks before keys, custody, serving and final effects.
- `/internal/v1/next/lab-pitr/registry`: exact `run`, nullable `after` and
  nullable decimal-u64 `expected`. Generation-pinned isolated nil page only;
  absent profile/foreign member/unavailability refuses, with no shared fallback.
  An empty page is not CP liveness authority. Ordinary registry scans remain
  shared. Issuer/transport keys stay in the CP; only metadata is returned.

`POST /v1/next/lab-pitr/delete-revoke` requires exact LAB Origin and an actual
current owner session. Exact body: `run`, `activeGenesisSha256`,
`deletedGenesisSha256`, `device`. It locks both originals in sorted order,
rechecks live session/identity/floors, keeps a separately current hosted survivor,
and journals D deletion plus A caller-device revocation in one CP transaction.
Its response is CP journal/outbox acknowledgement, NOT native `Deleted`, purge
or erasure. A lost/failed response remains UNKNOWN; do not blindly retry.

The runner still must establish G3 current-authorized mutation,
`delete.confirmed`, and reclose/drain/requiesce all five before G4. None of these
routes implement actor fencing, quiescence, bookmarks, restart or PITR.
