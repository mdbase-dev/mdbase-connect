# Reader startup: compatible SDK and authority improvements

No public SDK methods, options or session statuses change.

## Readiness

Registration still precedes live readiness. Setup assessment and structured contract description
run concurrently; ready remains gated on both. Setup requiring review is not applied implicitly,
and cached verification does not substitute for live contract evidence. Generation guards and
cancellation protect against stale publication; both parallel reads share startup cancellation.
Prospective managed-resource adoption remains an assessment/review operation.

Payload-free browser-local User Timing measures use fixed names:
`mdbase:startup:{registration,setup-assessment,contracts}`. Only the latest measure for each name
is retained. No identifiers or response data are emitted or uploaded.

The dedicated timing helper adds one internal module. Existing pure readiness helpers move
out of the session owner to keep its 1,000-line budget; the architecture budget adjustment
accounts for that module, three internal exports and two imports, not new public SDK exports.

## Cursor pages

The existing `firstPageSize` and `pageSize` options now also control cursor-mode requests.
A continuation sends `{cursor, limit: pageSize}`. On `operation_invalid` only, it retries the
same cursor without `limit` and uses that legacy form for the remaining pages. Authorization,
transport, budget and other errors are not interpreted as unsupported sizing.

| SDK / authority | Behavior |
| --- | --- |
| Old SDK / updated authority | Original fixed initial-page behavior remains valid. |
| Updated SDK / updated authority | Small first page, larger continuation pages. |
| Updated SDK / authority rejecting continuation limits | Same-cursor retry without a limit. |
| Updated SDK / authority ignoring continuation limits | Original smaller pages remain valid. |

Cursor identity, snapshot generation and explicit release are preserved. The authority accepts
only positive integer continuation limits, clamps page sizes to the engine's 1,000-record maximum,
and binds the first effective size at each cursor offset so replay is deterministic. Conflicting
explicit sizes are rejected. Per-offset state is charged against retained-state limits.

The filesystem engine can hold a read-only WAL snapshot and frozen definitions instead of
materializing every result for simple metadata queries. General queries retain materialized
snapshot behavior. Snapshot readers have bounded capacity and leases; runtime reads, writes
and watcher reconciliation also reap abandoned leases so they cannot indefinitely obstruct
checkpointing during activity. See the engine's `docs/reader-startup-cursors.md`.

## Qualification and rollout

Regression coverage includes parallel readiness gating; supported and rejected continuation
sizes; no retries on authorization failure; scope-bound snapshot replay/release; variable-sized
engine pages across mutation; bounded retained cursor state; filtered offsets; and abandoned WAL
reader cleanup. Current engine main already contains definitions-only unchanged setup assessment;
this change retains it rather than reintroducing a full baseline scan.

Merge/release the engine and authority first, then publish the SDK, then update Reader's pinned
SDK dependency. Older combinations remain supported; performance benefits requiring authority
support appear only after that authority is updated. Local coordinated testing can use sibling
worktrees plus the workspace's `link-sdk.mjs`; this does not change Reader's committed lockfile.
No staging or production rollout is implied by local qualification.
