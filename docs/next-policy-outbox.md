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

1. Fresh deliveries (`drainPending`). They never wait for verification. Before
   it signs a new batch, a delivery checks the collection's newest acknowledged
   batch (the tip check below). A new batch at a rolled-back head would become
   the newest batch and hide the loss, so on a mismatch the delivery stops and
   the collection goes to step 2.
2. Full recovery for a collection with a loss hint (owner
   `POST /v1/next/collections/:id/lost-policy`), a failed check or a refused
   delivery. That collection takes no fresh delivery until the recovery
   succeeds; then the reissued ops and the fresh delivery go out in the same
   poll, in that order.
3. History. Each poll reserves one probe for one older batch, so a backlog of
   tip checks cannot starve it. The full sweep is reseeded every 10 minutes
   but runs continuously, at about 30 batches per minute.
4. Tip checks. Every 5 minutes, each collection whose newest acknowledged batch
   was appended within the last 7 days is queued once. The check reads that
   batch's position and compares the exact stored bytes. It does not trust the
   log's head: a rollback removes a suffix, so it is caught at the tip, and a
   restore followed by a fresh append at the same position has different bytes.

Every probe is a single exact-position read. A mismatch in any probe runs the
complete fenced recovery.

## Worst-case detection delay

| Lost policy | Worst case |
|---|---|
| Newest batch appended within 7 days (tip check) | about 5 minutes |
| Older batches (history sweep) | about 1 hour at today's size; it grows by about 1 minute per 30 acknowledged batches |
| Owner loss hint | the next poll |
| Loss of the newest batch, when the collection's next policy change is delivered or retried | that delivery's poll |

Hints are held in memory. A hint that arrives just before a server restart is
lost; the loss is then found by the tip check if it is within 7 days, or by the
history sweep (about 1 hour) if it is older.

Before November 2026 every acknowledged batch was swept continuously, which
took about 5–6 minutes. That cost about 60% of the log service's rows written.
The 7-day tip window keeps the old delay for recent changes, which include
every recent revocation. Policy that has not changed for 7 days is detected
within the history sweep instead.

Every 5 minutes the server logs `mdbase-next policy verification sweep` with
`recentCollections` (collections in the tip window), the tip and history
probes made since the previous sweep, and `tipBacklog` (tip checks still
queued from the previous sweep; above 0 means the tip window is not being
covered in 5 minutes). The log line has counts only.
