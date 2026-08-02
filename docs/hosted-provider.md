# Hosted provider architecture

Status: accepted implementation architecture for the production hosted path

The provider does not report readiness until its SQL migrations, embedded
runtime migration, persisted grant validation, and an initial notification
recovery pass all succeed. `/ready` includes the current notification recovery
state; deployment and external smoke checks treat anything other than `ok` as a
failed candidate. Serialized grant and runtime JSON therefore follows the same
version-and-migrate discipline as ordinary SQL columns.

## Boundaries

The hosted provider is a Rust data-plane service. PostgreSQL is the durable
authority. A provider process may keep a derived working set for a collection,
but the working set is disposable and is valid only for the PostgreSQL head it
was built from.

The Connect control plane owns accounts, applications, grants, and replica
enrollment. It issues short-lived, grant-bound capabilities to the provider.
Record payloads go directly between an authorized client and the provider; the
control plane does not proxy or persist them. The provider rechecks collection,
operation, mode, contract scope, scope epoch, expiry, and revocation before it
opens authoritative state.

Application capabilities also authorize the scoped replication stream used by
offline caches. Session and snapshot reads require record-read access, change
pages require change access, and each queued mutation requires its corresponding
create, update, rename, or delete permission. Browser requests are checked
against the exact origin stored on that application capability. Opaque `null`
capabilities used by downloaded portable applications also require a P-256
signature over the request and consume a one-use nonce. Missing origins, stale
or replayed proofs, and body or credential substitutions are rejected. Mirror
credentials have no browser origin and are rejected when presented by browser
JavaScript.

`mdbase-rs` remains the only collection-semantics implementation. The provider
materializes a collection working set from canonical PostgreSQL documents and
resources, invokes the normative v0.3 operation facade, captures the resulting
write set, and commits it with replication state. This is an adapter around the
engine, not a second implementation of matching, validation, querying, links,
or lifecycle behavior.

## Durable model

The production schema is normalized around these relations:

- `hosted_collections`: owner, provider, authority epoch, head sequence,
  resource revision, wrapped data key, state, and quota counters;
- `hosted_resources`: versioned `mdbase.yaml`, type definitions, and other
  collection resources;
- `hosted_records`: stable record ID, current path token/path ciphertext,
  revision, encrypted canonical Markdown, matched type labels, size, and
  current sequence;
- `hosted_record_versions`: retained record versions and tombstones needed for
  pinned snapshots and conflict responses;
- `hosted_changes`: the ordered per-collection replication log;
- `hosted_mutation_receipts`: durable idempotency results keyed by replica and
  mutation ID;
- `hosted_replicas`: mode, contract/type scope, scope epoch, acknowledgement,
  credential state, and revocation;
- `hosted_snapshot_leases`: bounded leases pinning an authority sequence and
  resource revision while pages are downloaded; and
- `hosted_provider_backup_holds`: short-lived administrative leases fencing
  deletion of committed objects while a database export and object manifest
  are captured.

Canonical documents and retained content are encrypted with a per-collection
data key. Type labels, identifiers, revisions, sequences, sizes, deletion state,
and keyed path tokens may remain visible as documented routing metadata.

## Managed key wrapping

Hosted deployments select the data-key writer with
`MDBASE_CONNECT_HOSTED_KEY_WRAPPER`. `local` requires
`MDBASE_CONNECT_HOSTED_PROVIDER_MASTER_KEY`; `aws-kms` requires
`MDBASE_CONNECT_HOSTED_KEY_ENVIRONMENT`, `MDBASE_CONNECT_HOSTED_KMS_KEY_ID`,
and `MDBASE_CONNECT_HOSTED_KMS_REGION`. AWS credentials come from the standard
SDK credential chain. The database URL, provider internal token, legacy master
key, and R2 credentials are environment-only settings rather than command-line
arguments so they do not enter shell history or process listings.

The service resolves a configured KMS alias to an immutable enabled symmetric
key ARN at startup. Its least-privilege identity needs `DescribeKey`, plus only
`Encrypt` and `Decrypt` on that environment's key under the exact encryption
context in [ADR 0003](decisions/0003-managed-provider-key-wrapping.md). `/ready`
re-verifies the stored provider key-check at a bounded interval; a short failed
probe cache prevents health polling from amplifying a KMS outage.

The release image also contains `mdbase-hosted-key-admin`. It accepts database
and legacy-key secrets only from `DATABASE_URL` and
`MDBASE_CONNECT_HOSTED_PROVIDER_MASTER_KEY`. With the same non-secret KMS
configuration as the provider, the migration sequence is:

```bash
mdbase-hosted-key-admin inspect
mdbase-hosted-key-admin rewrap --dry-run
mdbase-hosted-key-admin rewrap --finalize-key-check
mdbase-hosted-key-admin inspect
```

Inspection streams aggregate envelope counts and never emits collection IDs,
ciphertexts, or plaintext keys. Dry-run performs real exact-context decrypt and
wrap operations but rolls back every row. Rewrap locks and commits one row at a
time, is resumable and idempotent, and refuses to finalize the key-check until
every collection uses the active key ARN. Keep the legacy key configured until
a KMS-only cold restart and semantic staging exercise pass.

Hosted collection files use a separate object data plane. PostgreSQL retains
encrypted paths and descriptors, capabilities, transfer journals, exact
idempotent receipts, revision history, quotas, and the shared record/file
sequence. Cloudflare R2 retains only opaque staging and immutable committed
objects. Presigned URLs address staging objects only; the provider streams an
exact size and SHA-256 verification, copies verified bytes to a non-presigned
committed key, verifies that copy, and then commits PostgreSQL. Downloads pin a
stored revision and use short-lived signed ranges, while SDKs hide single-PUT,
multipart, and range mechanics from applications.

Hosted moves update only encrypted PostgreSQL metadata and retain the immutable
R2 object key. Deletes commit a PostgreSQL tombstone while retained versions
continue to pin the object. Compaction removes old version rows first and queues
an R2 deletion only after no current or retained PostgreSQL reference remains,
so multiple move revisions can safely share one object without double-counting
or premature deletion.

## Mutation transaction

Every mutation follows one failure-atomic transaction:

1. Verify the provider capability and current replica/grant state.
2. Return the recorded receipt when the mutation ID already exists.
3. Lock the collection head and verify authority and scope epochs.
4. Bring the disposable working set to that exact head or rebuild it.
5. Verify the submitted base revision.
6. Execute the operation through `mdbase-rs` and capture all changed documents,
   including reference rewrites.
7. Validate the complete write set and calculate revisions/type membership.
8. Persist current records, retained versions, the ordered change, quota deltas,
   and mutation receipt.
9. Advance the collection head and commit once.
10. Mark the working set valid for the new head only after commit.

A process failure before commit leaves no authoritative change. A failure after
commit may leave a stale working set, which is detected from its head and
rebuilt or incrementally refreshed. Provider instances never coordinate through
process-local locks alone.

## Reads, queries, and snapshots

Point reads can load one encrypted document by stable ID or keyed path token.
Queries use a revision-keyed warm working set and the canonical `mdbase-rs`
query engine. Type scope selects candidates without exposing frontmatter.

Snapshots are pinned to an authority sequence. Pages select record versions
visible at that sequence; they are not copied into process memory. Snapshot
leases expire and compaction never removes versions needed by a live lease.
Change pages advance across invisible changes so scoped replicas cannot stall.
Each provider process also runs idempotent retention maintenance. It compacts
collections past `MDBASE_CONNECT_HOSTED_RETAIN_CHANGES`; a replica older than
that boundary takes the ordinary snapshot-reset path instead of pinning an
unbounded log. `MDBASE_CONNECT_HOSTED_MAINTENANCE_INTERVAL_SECONDS` controls the
scan interval. The same bounded, multi-instance-safe pass expires abandoned
ordinary file transfers. It persists object-deletion intent before contacting
R2, resumes interrupted multipart cleanup, and drains deletions only after
rechecking that no durable file metadata references the object.

## Consistent backup boundary

The release image contains `mdbase-hosted-backup-admin` for coordinating a
logical PostgreSQL export with the committed R2 objects named by that export:

```bash
mdbase-hosted-backup-admin acquire --ttl-seconds 14400
mdbase-hosted-backup-admin inspect
mdbase-hosted-backup-admin release --hold-id <uuid>
```

Acquisition takes a database advisory lock exclusively, so it waits for an R2
deletion already in progress before creating the lease. Every queued committed
object deletion takes the same lock in shared transaction mode, discards no
object while any unexpired hold exists, and keeps its durable deletion intent
for a later maintenance pass. The shared lock remains held through the object
store call, closing the check/delete race across provider instances.

Holds are limited to 60 seconds through six hours and expire in PostgreSQL if
the backup worker disappears. Multiple holds compose safely: deletion resumes
only after all of them are released or expired. Administrative output contains
only hold IDs, timestamps, and aggregate counts. A backup must acquire the hold
before exporting PostgreSQL, derive its committed-object manifest from that
export, durably publish the database and every referenced object, and write its
completion marker before releasing the hold. Disposable multipart and import
staging objects are outside this recovery set.

## Mirrors and authority transfer

Application caches and filesystem mirrors are replicas. Receive-only mirrors
materialize configuration, types, and canonical Markdown with atomic writes.
Local divergence is reported before replacement. Writable mirrors translate
filesystem changes into conditional mutations, isolate a conflict to its record,
and never resolve conflicts with implicit last-write-wins behavior. Mirror
credentials, cursors, journals, and conflict receipts remain in device-local
application state rather than the synchronized directory.

A writable mirror imports existing ordinary Markdown through the same
conditional mutation path during its first sync. A future atomic bulk-import
path will instead build an uncommitted hosted collection, validate it through
`mdbase-rs`, and commit sequence zero only after the source manifest is still
current. Export is already available by enrolling a receive-only directory
mirror, which reconstructs a complete ordinary directory. Future promotion in
either direction creates a new authority epoch.

## Initial performance budgets

Measure these in the same deployment region with 10,000 ordinary Markdown
records and realistic type/query fixtures:

- point read p95 below 100 ms;
- mutation p95 below 200 ms;
- warm query p95 below 300 ms;
- 200-event change page p95 below 150 ms;
- initial 10,000-record snapshot below 10 seconds;
- incremental mirror convergence below two seconds after notification;
- two provider instances preserve correctness and remain horizontally usable.

Budgets are gates, not promises. Benchmark results may change them, but a code
path may not silently regress them.

## Deliberate non-goals for the first hosted release

- multi-owner collaboration;
- billing;
- private/zero-knowledge hosted collections;
- peer-to-peer or multi-authority merging;
- plaintext frontmatter indexes that weaken the documented encryption model.
