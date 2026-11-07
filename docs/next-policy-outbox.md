# mdbase-next policy outbox verification

The control plane's `PolicyEmitter` (`services/server/src/features/next/policy-outbox.ts`)
appends signed policy batches to each collection's log and keeps the exact bytes
the log acknowledged. It then checks that the log still holds those bytes at
their positions. If a log loses acknowledged policy (a restore, rollback or
overwritten position), `recoverLostPolicy` marks the lost batches and reissues
their ops in order.

## What a lost rule exposes

Until a lost batch is detected and reissued, the log enforces the policy it
still holds. Lost grants, enrolments or member additions only deny access.
Lost access-reducing ops do not take effect: `device-revoke`, `grant-revoke`,
`member-remove`, a `member-set` downgrade, `cp-key-revoke`, a
`migration-cutover` revocation list, `freeze` and `root-handover`. A revoked
device or grant could keep using the collection for the detection delay.

## Verification

Each poll (every 2 s) runs within 500 ms and at most 32 probes. Its order is:

1. Fresh deliveries (`drainPending`). They never wait for verification.
2. Full recovery for a collection with a loss hint (owner
   `POST /v1/next/collections/:id/lost-policy`) or a failed check. That
   collection takes no fresh delivery until the recovery succeeds.
3. Tip checks. Every 5 minutes, each collection whose newest acknowledged batch
   was appended within the last 7 days is queued once. The check reads that
   batch's position and compares the exact stored bytes. It does not trust the
   log's head: a rollback removes a suffix, so it is caught at the tip, and a
   restore followed by a fresh append at the same position has different bytes.
4. History. At most one healthy-history probe per poll checks one older batch.
   The full sweep is reseeded every 10 minutes but runs continuously, at about
   30 batches per minute.

Every probe is a single exact-position read. A mismatch in any probe runs the
complete fenced recovery.

## Worst-case detection delay

| Lost policy | Worst case |
|---|---|
| Newest batch appended within 7 days (tip check) | about 5 minutes |
| Older batches (history sweep) | about 1 hour at today's size; it grows by about 1 minute per 30 acknowledged batches |
| Owner loss hint | the next poll |

Before November 2026 every acknowledged batch was swept continuously, which
took about 5–6 minutes. That cost about 60% of the log service's rows written.
The 7-day tip window keeps the old delay for recent changes, which include
every recent revocation. Policy that has not changed for 7 days is detected
within the history sweep instead.

Every 5 minutes the server logs `mdbase-next policy verification sweep` with
`recentCollections` (collections in the tip window), and the tip and history
probes made since the previous sweep. The log line has counts only.
