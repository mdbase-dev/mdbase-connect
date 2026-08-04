# ADR 0005: Durable mutation identity and recovery state machine

- Status: accepted for the beta-hardening program
- Date: 2026-08-04

## Context

The beta.31 connector durably claims an encrypted request before executing it,
but a process death can leave a row with no response forever. A retry then sees
`in_progress` even though the original effect may already exist. The hosted
provider has stronger receipts for several paths, but not one contract shared by
all mutating operations. Neither implementation may turn disappearance of the
original process into a definitive rejection.

This ADR defines the contract that the local connector, hosted provider, SDK,
sync adapters, and controlled consumers must implement. It does not claim
exactly-once execution across arbitrary external systems. It defines one durable
identity, fenced ownership, deterministic recovery, and the narrow conditions
under which Connect admits that the outcome is unknown.

## Decision

### One request identity

A logical mutation is identified inside an authority by this immutable tuple:

1. application installation ID;
2. grant ID;
3. request ID (UUIDv7 generated once by the SDK).

The authority/replica namespace is implicit in the database holding the row and
is included in all database uniqueness constraints. The request ID survives
transport retries, route changes, token refresh, SDK restart, and application
restart. A UI retry of an unresolved mutation resumes this tuple; it never
creates a new request ID.

The tuple owns exactly one canonical request fingerprint. Reuse with a different
fingerprint is the permanent typed conflict `mutation_request_conflict` and can
never execute either payload again under that tuple.

### Canonical mutation identifiers

`packages/protocol/schemas/operation-catalog.v1.json` is the source of truth.
Generated TypeScript and Rust expose the same public mutation identifiers. The
catalogue covers record CRUD/rename, types and type packs, view sources, timers,
sync mutation batches, and mutating file-control messages. Dry-run collection
requests and non-mutating sync/file-control messages are not mutations.

No SDK retry layer, connector dispatcher, or hosted dispatcher may maintain a
second mutation allow-list.

### Canonical fingerprint v1

The fingerprint is SHA-256 over this byte transcript:

```text
"mdbase-connect mutation fingerprint v1\0"
u32be(fingerprint_schema_version = 1)
field(UTF-8 canonical mutation identifier)
u32be(operation_input_schema_version)
field(UTF-8 RFC 8785 JSON Canonicalization Scheme payload)
```

`field(x)` is `u64be(byte_length(x)) || x`. Inputs must be I-JSON: object keys
are Unicode strings; numbers are finite IEEE-754 binary64 values; lone Unicode
surrogates, duplicate object names, non-finite numbers, `undefined`, functions,
symbols, bigint values, and cyclic structures are rejected before dispatch.
RFC 8785 defines string escaping, property ordering, and number formatting; the
contract must not call a runtime's ordinary object serializer and assume its
output is canonical.

The operation input schema version comes from the canonical operation protocol,
not the npm package version. The canonical payload contains only semantic input.
It excludes access/refresh tokens, cookies, signatures, encryption envelopes,
request counters, retry attempts, routes, deadlines, cancellation signals,
trace IDs, and other transport metadata. The digest is encoded as unpadded
base64url for public/TypeScript values and stored as 32 bytes where the database
supports binary data.

TypeScript and Rust must share positive and adversarial byte fixtures before the
fingerprint is used for durable claims.

### Journal states

The durable state machine is:

| State | Meaning | May cause a new logical effect? |
| --- | --- | --- |
| `claimed` | Identity/fingerprint exist and a fenced owner holds a bounded lease. | No |
| `prepared` | Deterministic execution plan and before-state evidence are durable. | Only the current fenced owner may apply it. |
| `applied` | The intended side effect is proved present and post-apply evidence is durable. | No; recovery only finalizes. |
| `completed` | Final encrypted receipt is durable. | No; retries return the receipt. |
| `acknowledged` | A client acknowledged receiving the completed receipt. | No |
| `abandoned` | The authority proved the effect never began and permanently closed the request. | No |
| `outcome_unknown` | Recovery exhausted all supported evidence and cannot distinguish applied from not applied. | No automatic replay; human/domain reconciliation is required. |

Every row also stores the canonical mutation identifier, input digest,
operation-input schema version, owning process epoch, lease owner and expiry,
monotonic fencing generation, prepared execution data, privacy-minimized
before/after evidence, final receipt metadata, grant snapshot digest, and state
timestamps.

The legal forward transitions are:

```text
absent -> claimed -> prepared -> applied -> completed -> acknowledged
                  \-> abandoned
          prepared/applied -> outcome_unknown
```

An implementation may atomically skip persisted intermediate states only when
the side effect and completed receipt commit in the same database transaction.
It must still expose equivalent fault-injection points in conformance tests.
`completed`, `acknowledged`, `abandoned`, and `outcome_unknown` are terminal.

### Lease ownership and fencing

Each authority process starts with a random durable-process epoch. Claiming or
taking over work records that epoch, a unique owner ID, a bounded lease expiry,
and increments the fencing generation transactionally. A restart makes every
lease from the previous process epoch immediately stale; correctness never
depends only on wall-clock expiry.

Every prepare, side-effect coordination, evidence, receipt, abandonment, and
unknown transition compares the request key, fingerprint, owner, process epoch,
and current fencing generation in the same committing transaction. Updating
zero rows is a lost-fence result. A stale owner cannot publish evidence or a
receipt after takeover even if its external call returns late.

### Retry, cancellation, acknowledgement, and abandonment

An identical retry has exactly one of these results:

- return the durable receipt for `completed` or `acknowledged`;
- return the durable abandoned result (`operation_outcome: not_sent`);
- report a live owner and wait only within the caller's remaining budget;
- take over an expired/stale lease, increment the fence, and recover;
- return the durable recovery handle for `outcome_unknown`; or
- reject conflicting request-ID reuse before execution.

Cancellation before claim returns `not_sent`. Cancellation in `claimed` may
abandon only after the owner proves no preparation or side effect began.
Cancellation after `prepared` stops the caller waiting but does not erase the
journal; recovery continues or the SDK returns the same pending handle.
Cancellation after `applied` can only defer receipt recovery. Acknowledgement is
an optimization for retention and diagnostics, never permission to forget the
request identity early.

### The only valid unknown outcome

`operation_outcome: unknown` is valid only when all of the following hold:

1. the authority durably accepted the request;
2. the mutation may have crossed its apply boundary;
3. the final receipt is absent;
4. the current fenced recovery owner inspected all defined database,
   filesystem, object-store, and prepared-plan evidence;
5. that evidence cannot prove either the exact intended post-state or the exact
   pre-state; and
6. retrying the effect could produce a duplicate or overwrite external work.

Timeout, cancellation, process death, stale ownership, a busy database, and a
missing response do not by themselves satisfy these conditions. `unknown` is a
durable journal state with a stable recovery handle and diagnostics; it is never
rewritten to `rejected` merely because the original owner disappeared.

### Replay after grant revocation

Revocation prevents new claims and prevents a prepared request from performing
a new external effect. The authority retains the original grant's public
verification material and immutable authorization snapshot solely to
authenticate a replay of an already accepted request.

After revocation:

- a completed/acknowledged receipt may be returned to the same authenticated
  application installation;
- an applied request may be finalized without adding another domain effect;
- a prepared request may inspect/reconcile existing evidence but may not begin a
  new effect; it becomes abandoned when non-application is proved, otherwise
  `outcome_unknown`;
- a request never claimed before revocation is rejected as not applied.

Historical authorization material cannot authorize any other request or widen
scope.

### Retention, compaction, and recovery horizon

The supported online recovery horizon is 180 days after completion or
abandonment and at least 30 days after acknowledgement, whichever is later.
Full encrypted receipts and recovery evidence remain available during that
horizon. Operators may configure a longer horizon, never a shorter one for an
advertised beta contract.

Compaction after the horizon replaces large receipt/preparation data with a
privacy-minimized tombstone containing the identity tuple, fingerprint,
terminal state, completion time, and receipt digest. Tombstones remain until
the grant/application is deliberately purged and for at least 365 additional
days. Protocol-v2 requests carry an authenticated creation time and expire at
the tombstone horizon; an authority rejects an older request before lookup.
Therefore pruning can return `mutation_recovery_expired`, but can never turn an
old retry into a fresh execution.

Compaction is fenced and transactional. It never removes grants, audit history,
unresolved requests, or the last evidence needed to distinguish an outcome.

## Consequences

The local and hosted implementations converge on one behavioral contract while
retaining storage-specific execution strategies. PostgreSQL operations may
commit effect and receipt atomically. Filesystem and object-store operations
need explicit prepare/apply/finalize evidence. The SDK gains a durable pending
mutation object instead of asking callers to remember and resupply the payload.

The contract intentionally breaks beta.28 wire and authorization formats. Data
and completed-receipt migration remain mandatory.

## Required proof

For every identifier in the generated mutator catalogue, conformance tests must
terminate execution at claim, prepare, apply, reconcile, receipt commit, and
response send; restart; resend the same request; and prove one logical effect
and one final receipt. The suite must also cover conflicting reuse, concurrent
duplicates, expiry/takeover, stale fenced commits, clock movement, process epoch
change, revocation, compaction boundaries, and every incompatible contract
combination failing before write.
