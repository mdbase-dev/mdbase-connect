# Replica client API

Status: draft for review, 2026-10-04.

This is what apps and plugins call on a replica: the desktop daemon, the shared runtime
in an Obsidian app process, or the hosted replica. It is the same API whether the
client is in the same process, on the same machine, or remote through the relay. Only
the transport differs (§12).

**What changes from the prior SDK protocol:**

| Today | Here |
|---|---|
| 1 s polling of `changes` | live queries and change feeds are pushed (§4) |
| 117 problem codes, with internal states leaking (`fresh_request_required`, `generation_expired`, `file_index_warming`, `cursor_capacity_exhausted`, `connector_busy`) | 15 codes, each with one recovery action (§9). Internal states become status or stream events, never errors. |
| Whole-file `if_revision` filled in by default | field-level intents. CAS only when the caller asks (`intent.md` §5). |
| A custom per-grant relay envelope (per-request ECDH, counters, replay windows) | one Noise session per connection (§12) |
| Writes acknowledged when a connector committed them locally | receipts that say exactly what is known: optimistic, then confirmed at a log position, or rejected (§6) |

## 1. Framing

Every transport carries the same frames, `mdb-cbor/1` encoded (except in-process, §12.1):

```cddl
; ---- client frames (replica-client-api.md §1) ----
client-frame = c-request / c-response / c-push

c-request  = { 0: 0, 1: uint, 2: tstr, 3: any }        ; request ID, method, params
c-response = { 0: 1, 1: uint, ? 2: any, ? 3: problem }  ; request ID, result | problem
c-push     = { 0: 2, 1: tstr, 2: any }                 ; push type, payload
```

- **Request IDs** are chosen by the sender and unique per session.
- **Both directions.** The replica also sends requests to a client that offered a
  callback service (the editor fence, §14).
- **Cancellation.** A client cancels a request with `cancel {id}`. The cancelled
  request completes with `cancelled`.

## 2. Session

```cddl
; ---- session (replica-client-api.md §2) ----
hello-params = {
  0: [+ version],        ; api versions the client supports
  1: tstr,               ; client name (app ID)
  2: tstr,               ; client version
  ? 3: [* tstr],         ; features the client wants: "fence", "presence", "attachment-v1", ...
  ? 4: tstr,             ; timezone: IANA zone used for this session's writes and queries
}
hello-result = {
  0: version,            ; negotiated api version
  1: tstr,               ; runtime version
  2: sem,                ; the replica's semantics version
  3: uuid,               ; collection
  4: grant-info,         ; what this session may do
  5: sync-status,        ; current status (§7)
  ? 7: bstr,             ; head witness: the replica's latest signed head-witness (log-entry.md §11), remote sessions
  6: [* tstr],           ; features granted
}
grant-info = {
  ? 0: uuid,             ; grant ID (absent for the hosting app itself)
  1: [+ capability],     ; capabilities (policy.md §5)
  2: role,               ; the granting member's role
}
```

`hello` is the first request. Before it, every other request fails with
`unauthenticated`. Version negotiation is in §13.

## 3. Record views

```cddl
; ---- records (replica-client-api.md §3) ----
record-view = {
  0: uuid,               ; id
  1: path,
  2: hash,               ; revision of the exact bytes
  3: fm-map,             ; frontmatter (persisted)
  ? 4: fm-map,           ; effective_frontmatter (spec 03; on request)
  ? 5: tstr,             ; body (on request)
  ? 6: tstr,             ; document: exact source (on request)
  7: [* tstr],           ; types
  8: record-state,
  ? 9: [* issue],        ; diagnostics (on request)
  ? 10: fm-map,          ; values: canonical select output (order is in columns)
}
record-state = {
  0: &( confirmed: 0, pending: 1 ),   ; pending: the local view includes unconfirmed changes
  1: seq,                ; confirmed_seq: the last log position that changed this record
  ? 2: hold-ref,         ; present when the record is held on this replica (§8.1)
  ? 3: uint,             ; unresolved: number of unresolved conflicts on this record
}
issue = { 0: tstr, 1: &( warning: 0, error: 1 ), 2: tstr, ? 3: value }   ; code, severity, message, details
```

Reads return the **local view**: confirmed state plus this replica's pending mutations.
That is the optimistic view an app wants to display. `record-state` says which parts
are not yet confirmed.

## 4. Reads, live queries and change feeds

All of these require `collection.read`.

| Method | Params | Result |
|---|---|---|
| `describe` | — | `describe-result` (§4.1): typed catalog summary and registered contracts |
| `describe_typing` | `{0: [* tstr] types (≤ 64), 1: [* path] paths (≤ 256)}` | `{0: uint catalog_generation, 1: [* {0: path, 1: typing}]}`, one entry per requested path in request order; `typing = &(none: 0, date: 1, date_time: 2)` is `date`/`date_time` only when every listed type declares that format at the path (top-level field paths only; nested or unknown → `none`, empty `types` → `none`). `too_large` over the bounds |
| `get` | `{0: uuid / path, ? 1: include}` | `record-view`, or `not_found` |
| `get_resource` | `{0: path}` (exactly one field) | `resource-view`, or `not_found`; unrestricted collection READ required |
| `list_resources` | `list-resources-params` below | `list-resources-result`; unrestricted collection READ required |
| `query` | `{0: query, ? 1: include}` | `query-result` |
| `subscribe` | `{0: query, ? 1: include}` | `{0: sub ID}`, then `query-update` pushes |
| `unsubscribe` | `{0: sub ID}` | — |
| `changes` | `{0: cursor?, ? 1: limit, ? 2: watch: bool}` | `{0: [change], 1: cursor, 2: reset: bool}`, then `changes` pushes if `watch` |
| `list_views`, `execute_view`, `read_view_source` | spec 12 shapes | spec 12 shapes |
| `validate` | `{? 0: [uuid / path]}` | issues per record (spec 04) |
| `list_files`, `get_file`, `read_file` | §10 | §10 |

`get_resource` reads the exact authoritative local definition source (including
pending resource replacements), never a Describe projection or filesystem read.
Portable paths must be classified as resources by the current local catalog.
Folder-scoped grants cannot read collection-wide definition sources. Missing rows
are `not_found`; Store read failures remain `unavailable`. The source response is
limited to 1 MiB; larger sources refuse with `resource_budget_exceeded`, never a
partial document. This output limit does not bound the Store's existing row
allocation or catalog compilation.

`list_resources` enumerates the actual tracked definition inventory: configuration,
rows in type/contract folders, registered or managed schemas, and pack/provisioning
receipts. It is not a Describe projection or a valid-catalog filter: malformed,
conflicting and orphan tracked definitions remain visible. It reads the existing
resource store, never the filesystem or a caller-supplied resource inventory.
`folder` is an optional portable relative directory prefix (at most 4096 UTF-8
bytes), not an authorization scope. `text` defaults to false; true includes each
complete exact source. `limit` defaults to 64 and must be 1–128. Returned paths
are at most 4096 UTF-8 bytes, each source at most 1 MiB, and the encoded list-result
CBOR at most 2 MiB. No successful document is truncated, and over-bound rows are
not silently omitted. These are paging/output bounds, not a native heap/CPU or
existing Store source-allocation certificate.

An intermediate page has `complete: false` and a nonempty progress cursor; the
terminal page has `complete: true` and no cursor. Only all pages starting without
a cursor, drained without errors, form a complete inventory. The opaque,
replica-local continuation uses the existing resident cursor registry and binds
session, grant, folder/text/limit selection, head, local view version and Store
generation. Bindings are checked before and after reads. Continuations retain no
source bodies or catalog. Existing shared per-session limits (16 cursors, 1 MiB
resident payload, five-minute expiry) and session-close cleanup apply.

Any pending **resource** overlay, including a deletion, refuses with
`unavailable` / `resource_inventory_pending`. An install, apply fault or unqualified
inventory refuses with `unavailable` / `resource_inventory_unavailable`; neither
can produce a successful confirmed-empty or partial inventory. A folder-scoped
grant refuses with the existing `resource_full_collection_required` reason.
Unknown keys, malformed params/path/cursor are `invalid_request` with
`unknown_param`, `invalid_resource_params`, `invalid_path` or
`invalid_resource_cursor`. Changed or expired bindings are `invalid_request` /
`cursor_stale` or `cursor_expired`. Request/path/page bounds are `too_large` /
`resource_budget_exceeded`; the inherited oversized-source refusal remains
`unavailable` / `resource_budget_exceeded`. Store read failures remain
`unavailable`, never absence. Callers discard an interrupted multi-page inventory;
they must not silently restart or combine pages from different snapshots.

```cddl
resource-view = {
  0: path,
  1: hash,               ; source revision for resource_put/resource_delete CAS
  2: uint,               ; complete UTF-8 source byte count
  3: &(confirmed: 0, pending: 1),
  ? 4: tstr,             ; complete exact source; get_resource always supplies it
}
list-resources-params = {
  ? 0: path,             ; portable folder prefix, <= 4096 UTF-8 bytes
  ? 1: bool,             ; exact text; default false
  ? 2: tstr,             ; opaque resident continuation
  ? 3: 1..128,           ; maximum rows; default 64
}
list-resources-result = list-resources-complete / list-resources-page
list-resources-complete = {
  0: [0*128 resource-view],
  1: true,
}
list-resources-page = {
  0: [1*128 resource-view],
  1: false,
  2: tstr .size (1..4096), ; nonempty progress cursor
}
query = value            ; spec 11: types, where, projections, select, order_by, group_by, summaries, summary_functions, limit, offset, timezone, context
include = { ? 0: bool, ? 1: bool, ? 2: bool, ? 3: bool }   ; effective, body, document, diagnostics
query-result = {
  0: [* record-view],
  ? 1: tstr,             ; cursor for the next page
  2: bool,               ; complete: false while a snapshot install is in progress (snapshot.md §8)
  3: uint,               ; as_of: local view version
  ? 4: [* tstr],         ; columns: canonical select output names
  ? 5: uint,             ; total_count: complete filtered match count BEFORE pagination
  ? 6: [* issue],        ; query diagnostics
  ? 7: view-ref,         ; resolved execute_view source
  ? 8: [* query-group],  ; complete filtered groups/summaries BEFORE pagination
  ? 9: bool,             ; has_more: flat matches AFTER the requested window
}
view-ref = { 0: path, 1: tstr }   ; path, named view
query-group = {
  0: fm-map,             ; values: named grouping tuple ({} without grouping)
  1: uint,               ; count: group matches BEFORE pagination
  ? 2: fm-map,           ; summaries: canonical named reduction outputs
}
query-metadata = {
  ? 0: [* tstr],         ; columns
  ? 1: uint,             ; total_count
  ? 2: [* issue],        ; diagnostics
  ? 3: view-ref,
  ? 4: [* query-group],
  ? 5: bool,             ; has_more
}
query-update = {
  0: uint,               ; sub ID
  1: &( snapshot: 0, diff: 1, reset: 2 ),
  ? 2: [* record-view],  ; added (snapshot: the full result)
  ? 3: [* record-view],  ; changed
  ? 4: [* uuid],         ; removed
  ? 5: [* uuid],         ; order: the full ordered ID list, when the order changed (sorted queries)
  6: bool,               ; complete
  7: uint,               ; as_of
  ? 8: query-metadata,   ; FULL metadata replacement at this as_of, never a delta
}
change = { 0: uuid, 1: path, 2: &( put: 0, remove: 1 ), 3: uint }   ; id, path, kind, view version
```

**Query metadata** follows canonical Core/spec 11 semantics. Counts, grouping and
summaries describe the complete filtered match set before offset/limit, including
`limit: 0`. Groups do not duplicate record bodies or IDs and retain canonical
ordered tuple semantics (missing/null share one group, typed/default/projection
values are not reconstructed by an app). Summaries without grouping use one group
with an empty values map; an empty grouped match set has no groups. `complete`
continues to describe install/local-view completeness, not exact total coverage.

All modes use one request-wide hydration budget of at most 1000 records AND 1 MiB
source, including paging, retries and restarts. Group/summary/CEL allocations need
separate real bounds. An exact indexed aggregate is permitted only with qualified
Core parity and current catalogue/generation/head coverage. Unsupported semantics
or insufficient whole-query budget fail explicitly; no full-row fallback, page
counts, partial groups or approximate totals presented as exact. Schema/codec
availability alone is not native executor or feature qualification.

Live metadata is a full replacement bound to the update's `as_of`. A snapshot
provides requested metadata; an update changing counts/groups/summaries includes a
same-as_of replacement even if the visible record page is unchanged. Reset drops
old metadata. Consumers cannot treat prior metadata as current across an as_of
advance without a replacement. If bounded exact live evaluation is unavailable,
reset or fail explicitly rather than publish stale/approximate metadata. Existing
session, mode, grant, revocation and currentness checks still apply.

**Live queries** are state-based.
- **Updates.** The first push is a `snapshot`, then `diff`s. A diff is sent when a
  changed record matches the query or was in its last result (FEASIBILITY §2.6).
- **Coalescing.** Diffs are coalesced while the client is slow. Because they describe
  state, coalescing loses nothing.
- **`reset`.** Sent instead of an error after a snapshot install, a catalog change that
  alters the query's meaning, or a re-subscribe after reconnect. The next push is a new
  `snapshot`.

**Change feed cursors** are opaque, replica-local view versions. A cursor the replica
can no longer serve (after an install, or after a long gap) returns `reset: true` with
a fresh cursor, never an error. The app re-reads what it caches. That replaces
`cursor_capacity_exhausted` and `generation_expired`.

**While installing** (`snapshot.md` §8), queries answer over installed rows with
`complete: false`, and point reads fetch the record's bucket first. That replaces
`file_index_warming`.

### 4.1 Describe

The existing `describe` response has the same shape across the replica frame
encoder and SDK decoder:

```cddl
; ---- describe (replica-client-api.md §4.1) ----
describe-result = {
  0: tstr,                   ; spec_version the collection declares
  1: [* type-summary],       ; valid types, in canonical catalog order
  2: value,                  ; settings slot (currently null from the replica)
  3: file-inclusion,         ; current file inclusion policy (§10.3)
  4: [* issue],              ; catalog issues
  5: [* contract-summary],   ; registered contracts, in canonical catalog order
}
type-summary = {
  0: tstr,                   ; type name
  1: path,                   ; type resource path
  2: [* implementation],     ; valid resolved implementations, in catalog order
}
implementation = {
  0: tstr,                   ; contract ID
  1: tstr,                   ; exact resolved contract version
  2: { * tstr => tstr },     ; contract field reference -> record field reference
  ? 3: value,                ; binding, omitted when empty
}
contract-summary = {
  0: tstr,                   ; contract ID
  1: tstr,                   ; exact version
  2: path,                   ; contract resource path
  3: hash,                   ; canonical contract digest
  4: tstr,                   ; contract_type
  5: [* tstr],               ; types implementing this exact version
}
```

Types are summary maps, not type-name strings. The `types`, `issues` and
`contracts` arrays are required even when empty. Only registered contracts and
valid resolved implementations are projected from the current local catalog;
Describe is not a substitute for `get_resource`'s exact source. The shared
`conformance/describe/populated.hex` fixture covers the existing response
encoding. This shape does not add a query contract filter or saved-view RPC.

## 5. Writes

```cddl
; ---- submit (replica-client-api.md §5) ----
submit-params = {
  0: [+ op],             ; ops (intent.md §3), texts as tstr
  ? 1: uuid,             ; mutation ID; the SDK SHOULD always send one (UUIDv7)
  ? 2: conflict-mode,
  ? 3: tstr,             ; timezone for this write (overrides the session's)
  ? 4: bool,             ; allow_partial: split into one mutation per op (intent.md §8)
  ? 5: [+ uuid],         ; mutation IDs per op when allow_partial
  ? 6: bool,             ; dry_run: plan at the local view, capture nothing
  ? 7: include,          ; what to return in the optimistic record views
  ? 8: &( pending: 0, confirmed: 1, published: 2 ),   ; wait: return now (default), after confirmation, or after local file publication
}
submit-result = [+ receipt]     ; one per mutation (several when allow_partial)
```

1. **Capture.** The replica checks the session's capabilities against every operation
   (`policy.md` §5), then captures the mutation (`intent.md` §1):
   - the mutation ID, if the client sent none;
   - `origin`, the clock with the session or request time zone, and the seed;
   - `on_behalf`, the session's grant.

   Clients never set those fields.
2. **Optimistic plan.** The replica plans the mutation at its local view, applying the
   submit-time checks (`intent.md` §6).
   - **Rejection** returns a receipt in state `rejected` immediately.
   - **Acceptance** queues the mutation, applies it to the local view, and returns a
     receipt in state `pending` with the **optimistic results**: the affected records
     as they now read locally.
3. **Confirmation.** The append loop confirms or rejects the mutation later (§6).
   `wait: confirmed` holds the response until then, or until the request is cancelled.
   That is useful for scripts, and wrong for interactive UIs.

**Wait for files.** `wait: published` holds the response until publication is final
(`published` or `not_published`), or the receipt is rejected. This is useful when an
app immediately re-reads a file after writing it. Publication is local: a synced
replica may publish the optimistic view before log confirmation. It does not imply
confirmation at the log. A deferred publication wait is capped at five minutes; if
still unresolved then, it becomes `not_published`, and a later batch result cannot
change that final receipt. Transport holds have the same five-minute ceiling.

**Idempotent resubmission.** Submitting a mutation ID the replica already knows returns
its current receipt and does nothing else. If the client never got the first response,
it simply resubmits with the same ID.

**Offline.** With no log service reachable, submits still succeed as `pending`. Status
shows the backlog (§7). Nothing about being offline is an error.

## 6. Receipts

```cddl
; ---- receipts (replica-client-api.md §6) ----
receipt = {
  0: uuid,               ; mutation ID
  1: receipt-state,
  ? 2: seq,              ; position, when confirmed
  ? 3: status,           ; applied | merged | conflicted, when confirmed (log-entry.md §2)
  ? 4: [+ conflict],     ; when conflicted
  ? 5: [* record-view],  ; optimistic results (pending) or confirmed results (confirmed)
  ? 6: problem,          ; when rejected or unknown
  ? 7: publish-state,    ; file-backed replicas only, while pending or confirmed
  ? 9: seq,              ; relocated_from: earlier position after a lost tail (log-entry.md §3.3); key 8 reserved for preflight
}
receipt-state = &( pending: 0, confirmed: 1, rejected: 2, unknown: 3 )
publish-state = &( publishing: 0, published: 1, not_published: 2 )
```

| Method or push | Meaning |
|---|---|
| `receipt {0: uuid}` | the current receipt |
| `await {0: uuid, ? 1: timeout_ms}` | resolves when the receipt leaves `pending`, or at the timeout with the pending receipt |
| push `receipt` | sent to the submitting session at every state change of its mutations |

- **`pending` → `confirmed`** at log position `seq`, with the status. A `conflicted`
  status carries the conflicts: what the record kept, and what this mutation lost.
  The app may show them or resolve them (§8.2).
- **`pending` → `rejected`** with a problem. That happens when an S-class check fails
  at head (CAS, enforced uniqueness, an explicit path taken, a rename race, a body
  conflict) or the grant was revoked. The local view drops the mutation, and live
  queries push the correction.
- **Relocated after a lost tail** (`log-entry.md` §3.3). A confirmed mutation that
  the log service lost, and that had to be re-appended at a new position, stays
  `confirmed`. Its submitter gets a receipt push with the new `seq` and
  `relocated_from` set to the old position. In the one case where its grant was
  revoked in the meantime, it moves to `rejected` (`forbidden`, reason
  `revoked_after_loss`) with `relocated_from`.
- **`unknown`**, with `outcome_unknown`, is rare: a mutation possibly sent before the
  receipts horizon (`snapshot.md` §6).

**Local publication (`published`, key 7).** Present only on file-backed replicas
while the receipt is `pending` or `confirmed`:
- `publishing`: the store has not finished making the mutation's effects visible.
- `published`: the files hold its effects, or a later local view including them. A
  mutation requiring no file change is published immediately.
- `not_published`: final; bytes were not written because a hold or a user's edit
  prevented it, or the five-minute publication deadline elapsed.

A final publication result pushes the updated receipt. Stores that publish inside
`commit` can return the final publication state immediately. In local-only mode,
confirmed implies published; in synced mode, publication may precede confirmation.
Publication does not bypass the store's durability fence: a transport must not
acknowledge a capture or push a receipt before its preceding commits are durable.

The replica keeps receipts for at least 24 hours after they leave `pending`, and
confirmed ones for the receipts horizon.

## 7. Status: "confirmed through N, plus pending"

```cddl
; ---- status (replica-client-api.md §7) ----
sync-status = {
  0: &( local-only: 0, synced: 1 ),
  1: seq,                ; confirmed_through: highest log position applied
  2: seq,                ; head_known: highest log head this replica has heard of
  3: uint,               ; pending: unconfirmed mutations
  ? 4: time-ms,          ; oldest_pending: capture time of the oldest pending mutation
  5: uint,               ; holds on this replica
  6: uint,               ; unresolved conflicts in the collection
  7: &( online: 0, connecting: 1, offline: 2 ),
  ? 8: { 0: uint, 1: uint },    ; installing: chunks done, chunks total
  9: [* incident],       ; conditions that need attention
  ? 10: resyncing,       ; present while repairing a lost tail (log-entry.md §3.3)
  ? 11: confirmed-head,  ; authoritative confirmed-prefix handover fence
}
confirmed-head = {
  0: seq,               ; committed applied position
  1: hash,              ; chain at exactly position 0
  2: hash,              ; policyGeneration = ctl(seq)
  3: hash,              ; neutral confirmed resource+SEM catalogGeneration
}
applied-prefix-params = {
  0: seq,               ; requested historical handover fence
}
applied-prefix = {
  0: seq,               ; local appliedThrough (zero for local-only)
  1: seq,               ; requested handover fence, echoed
  ? 2: hash,            ; historical chain at exactly position 1, never a head hint
}
resyncing = {
  0: &( probing: 0, repairing: 1, rolling_back: 2, awaiting_control: 3 ),
  1: uint,               ; positions still to restore
}
incident = {
  0: &( upgrade_required: 0, waiting_for_key: 1, integrity: 2, access_revoked: 3,
        quota_exceeded: 4, read_only: 5, verification_mismatch: 6, voided_items: 7,
        key_inconsistent: 8, foreign_sync_tool: 9, gone: 10, lost_entries: 11,
        log_regressed: 12 ),
  ? 1: value,            ; details (counts, positions, the other tool's name)
}
```

- **`resyncing`** is present while the replica repairs a lost tail. UIs show
  "Re-syncing…". It is not an incident, and it needs no action. Resurrected mutations
  are counted there, not in `pending`.
- **`lost_entries`** reports items that could not be recovered. Details:
  `{0: author device, 1: count, 2: lowest lost seq, ? 3: [* mutation ID]}`, one
  incident per author. "Control plane" counts as an author.
- **`waiting_for_key`** blocks apply at a sealed item this device has no key for.
  While waiting, the replica reads control items ahead for a `key_grant` to itself
  (`log-entry.md` §4.2). Details, once that read-ahead has run: `{"position": seq,
  "reason": text, ? "at": seq}`. Reasons: `reading`; `no_grant` (none up to `at`);
  `grant_void` (the grant at `at` is void at its position, for example its
  recipient or signer was revoked first); `key_inconsistent`; `unusable` (the grant
  cannot supply the waiting epoch's key); `blocked` (an item at `at` that apply
  could not pass either); `limit` (the work bound). UIs show "waiting for another
  device to approve this one" for `no_grant`.
- **`log_regressed`** is non-blocking and informational. It is raised on every
  lost-tail detection, for ops. Details: `{0: from, 1: to, 2: outcome
  (repaired 0, fallback 1, pending 2)}`.

`get_status`, and `subscribe_status` (which pushes `status` on change, coalesced to at
most 4 per second), require a session with `collection.read`.

`applied_prefix` takes `{0: seq}` and returns `applied-prefix`, with the same READ
authorization. An ahead local replica returns the retained historical chain at that
exact fence. Behind, zero, unretained or ineligible evidence omits key2; storage read
failure returns `unavailable`/`prefix_unavailable`, without raw I/O details. Missing
facts or any error keep the client hosted. Never infer a fence from `asOf`,
`confirmed_through` or `head_known`. Handover uses generation identities, consistent
capture and mandatory session/readiness gates.

**What UIs show.** "Synced through N", plus "k changes waiting" when `pending > 0`.
`confirmed_through < head_known` means catching up. Holds and conflicts are counted
separately, so edits never look silently stuck. The replica handles
`waiting_for_key`, `integrity` and the others by itself where it can. Incidents tell the
UI what the user must act on (update the app, approve on another device, free space).

## 8. Holds, conflicts and device approval

### 8.1 Holds

A hold is local to one file-backed replica. A file there keeps the user's bytes and
does not propagate until resolved (`log-entry.md` §4.4). Holds are visible to every
client of that replica.

```cddl
; ---- holds (replica-client-api.md §8) ----
hold-ref = { 0: uuid, 1: hold-reason }
hold-reason = &( conflict: 0, unknown_provenance: 1, deleted_elsewhere: 2,
                 read_only: 3, editor_busy: 4, suspect_write: 5 )
hold = {
  0: uuid,               ; record or file ID
  1: path,
  2: hold-reason,
  3: time-ms,            ; since
  ? 4: tstr / blob-ref,  ; base: the last common version, when known
  5: tstr / blob-ref,    ; mine: the bytes in the file now
  ? 6: tstr / blob-ref,  ; theirs: the confirmed version (absent if deleted elsewhere)
  7: uint,               ; saves: user saves collected while held
}
```

| Method | Params | Result |
|---|---|---|
| `list_holds` | — | `[* hold]` (pushed as `holds` on change to subscribers via `subscribe_holds`) |
| `resolve_hold` | `{0: uuid, 1: &(keep_mine: 0, take_theirs: 1, use: 2, delete: 3, keep_both: 4), ? 2: tstr / uuid}` | a `receipt`: resolving submits an ordinary mutation. `keep_mine` for a record is a three-way merge preferring mine; for a file it is a replace. `take_theirs` takes the confirmed version, `use` takes the supplied document (or a completed upload's transfer ID, for a file), `delete` deletes it. `keep_both` (files, and records when wanted) writes mine as a new entry at a distinct path, `name (conflict <device> <date>).ext`, and takes theirs at the original path. **Binary files are never merged.** |

`resolve_hold` requires `records.edit`, or `records.delete` for `delete`.

**`suspect_write`** covers files whose provenance could not be verified: torn writes,
the first scan after an OS crash, and the rule that one "missing" observation is not
a delete. The exact rules are a `FilePlatform` concern, pending platform-specific implementation. The reasons
are listed here so apps can explain them.

### 8.2 Conflicts

Conflicts are recorded in the log and synced. They are listed on every replica until
dismissed (`snapshot.md` §3).

| Method | Result |
|---|---|
| `list_conflicts {? 0: record}` | `[* {0: uuid mutation, 1: seq, 2: conflict}]` |
| `subscribe_conflicts` | pushes `conflicts` on change |

To resolve one, the app submits an `update` with the chosen value, plus a
`conflict_dismiss` in the same mutation, or just the dismissal to accept what was kept.

### 8.3 Device approval (end-to-end collections)

The approval flow of `sealed-envelope.md` §5.3. It is offered only to the app hosting
the replica (sessions without a grant), never to granted clients.

| Method | Result |
|---|---|
| `pending_devices` | `[* {0: uuid device, 1: uuid account, 2: device-kind, 4: bool exchange_ready}]`. Legacy key 3 (`sas`) is optional/deprecated, never emitted and never reused |
| `start_approval {0: uuid}` | draws `r_A` only for the current verified enrolment/commitment, then carries it through the control plane's pending-approval channel. Push `approval {0: uuid, 2: bool exchange_ready}` when the current exchange is ready, or `approval_failed {0: uuid, 1: reason}`. Legacy approval key 1 (`sas`) is optional/deprecated and never emitted/reused |
| `approve_device {0: uuid, 1: tstr sas}` | the user **types the requester's six digits**; the replica checks them internally under current policy and appends the `key_grant`. At most 3 failures per commitment survive restart (or lost attempt state requires a fresh logged commitment). Success waits for actual log append/application/disposition |
| `reject_device {0: uuid}` | stops offering it here; revoking is a control-plane action |
| `account_key_setup {0: bstr .size 32 R}` | private collections with the default (password + recovery key) UX: appends the account-key `key_grant` for this account signed as the account-key device derived from `R` (owner or host session only; never over a cloud-copy session). Result: the `key_grant` mutation's `receipt`, `pending` until applied. `R` crosses only the in-process/IPC boundary and is derived and dropped |
| `account_key_unlock {0: bstr .size 32 R}` | this (enrolled, unkeyed) device unlocks with `R`: accepted for processing, result `{}`; progress by `account_key_status`. `invalid_request` if `R` is not 32 bytes; `unavailable` while local-only, installing or faulted |
| `account_key_status` | `{0: &(idle: 0, reading_ahead: 1, pending_grant: 2, keyed: 3, refused: 4), ? 1: problem}`; `refused` carries the typed refusal (`forbidden` for a revoked or wrong-account recovery device, `outcome_unknown` for an uncertain commit) with `details.reason`. No push in v1 (poll) |
| `pending_grants` | grants without an approval in an `e2e` collection: `[* {0: uuid grant, 1: tstr app ID, 2: [+ capability], ? 3: [+ path] folders, 4: tstr client fingerprint}]` (`policy.md` §5.1) |
| `approve_grant {0: uuid, 1: [+ capability], ? 2: [+ path]}` | appends the `grant_approval` with the capabilities and folders the user kept |

`exchange_ready` describes only the current challenge/reveal context, not approval or
key delivery. The approver never displays its computed SAS in pending output, pushes,
CLI, debug or telemetry. See `device-approval.cddl` for the existing-slot allocation.

The new device's side runs in the runtime that enrols it: it displays its own SAS only
once its logged keys/commitment are checked and its reveal state is durably persisted
before sending `r_N`. The user types that code on the approver. It accepts only a
`key_grant` signed by the verified approver it selected, including after restart
(`sealed-envelope.md` §5.3 step 6).

## 9. Errors

```cddl
; ---- problems (replica-client-api.md §9) ----
problem = {
  0: error-code,
  1: recovery,
  2: tstr,               ; message: for developers; apps show their own text keyed on code and reason
  ? 3: tstr,             ; reason: finer cause (stable, documented per code)
  ? 4: value,            ; details
  ? 5: uint,             ; retry_after_ms
  ? 6: [* issue],        ; issues (invalid_record)
  ? 7: tstr,             ; trace_id
}
error-code = tstr
recovery = &( fix_request: 0, refresh: 1, resolve_conflict: 2, reauthorize: 3,
              repair_collection: 4, retry: 5, free_space: 6, upgrade: 7,
              resolve_outcome: 8, none: 9, contact_support: 10 )
```

**The 15 codes.** Each has exactly one recovery action.

| # | Code | Recovery | When | Reasons and details |
|---|---|---|---|---|
| 1 | `invalid_request` | `fix_request` | malformed params or ops, mutually exclusive fields, bad offsets, unsafe paths, an invalid time zone, a type-membership change or lifecycle failure caused by the request | spec code in `reason` (`duplicate_batch_path`, `type_membership_changed`, `invalid_timezone`, …); files: `digest_mismatch`, `size_mismatch`, `chunk_mismatch`, `excluded` |
| 2 | `invalid_record` | `fix_request` | a write rejected by single-record validation at level `error`, or a resource write that leaves config or types invalid | `issues` |
| 3 | `not_found` | `refresh` | no such record, file, hold, subscription, view or transfer (including an expired transfer) | `transfer_expired` |
| 4 | `conflict` | `resolve_conflict` | the current state doesn't allow this write | `revision` (CAS), `path_taken`, `duplicate_value`, `body`, `body_base_unavailable`, `renamed`; `details` holds the current revision or path |
| 5 | `unauthenticated` | `reauthorize` | no or expired session, or a grant revoked during the session | — |
| 6 | `forbidden` | `reauthorize` | the grant lacks the capability, or the member's role doesn't allow it | `details.capability` |
| 7 | `collection_invalid` | `repair_collection` | the catalog can't be loaded, so writes can't be planned | `issues` of the config and type files |
| 8 | `unavailable` | `retry` | the replica is starting, moving its lease, or not reachable (no route, relay down, no device online in an end-to-end collection) | `retry_after_ms` |
| 9 | `rate_limited` | `retry` | the session is over its request or presence limits | `retry_after_ms` |
| 10 | `quota_exceeded` | `free_space` | the collection is over its storage quota; new content can't be confirmed | — |
| 11 | `too_large` | `fix_request` | a request, op count, presence state or file over its limit | `details.limit` |
| 12 | `upgrade_required` | `upgrade` | the client's API version is unsupported, or the replica cannot write this collection (semantics ratchet, unknown format) | `details.min_version` |
| 13 | `outcome_unknown` | `resolve_outcome` | a mutation's outcome can't be determined (`snapshot.md` §6) | re-read the records and decide |
| 14 | `cancelled` | `none` | the client cancelled the request | — |
| 15 | `internal` | `contact_support` | a bug; the request may be retried once | `trace_id` |

**Mapping from spec codes.** Spec diagnostics (spec 04, 12) keep their codes inside
`reason` and `issues`:
- `path_conflict` → `conflict` / `path_taken`;
- `concurrent_modification` → `conflict` / `revision`, `body` or `body_base_unavailable`;
- `duplicate_value` (enforced) → `conflict` / `duplicate_value`;
- schema issues → `invalid_record`;
- request-tier codes → `invalid_request` with the spec code as `reason`.

**Mapping from log service codes** (`log-service-api.md` §10). Apps never see these.
The replica absorbs most of them, as status or retries. The rest surface as:
- `quota_exceeded` → the `quota_exceeded` incident, plus that code on `wait: confirmed`
  submits;
- `gone` and `forbidden` (this device revoked) → incidents, plus `unavailable` for new
  sessions;
- `upgrade_required` → `upgrade_required`.

**Not errors any more:**

| Old | Now |
|---|---|
| offline, `connector_busy` | the submit is accepted as `pending`; status shows it |
| `generation_expired`, `fresh_request_required`, `change_cursor_reset` | `reset` in feeds and subscriptions |
| `file_index_warming` | `complete: false` |
| `cursor_capacity_exhausted` | cursors are local view versions with no server capacity |
| a held record | `record-state.hold`, and the holds list |

## 10. Files: handles, streams, progress and materialization

Non-record files (images, audio, video, PDFs, other files; `intent.md` §3.7) are
handled through **file handles and streams**. Apps never see:
- blob parts;
- keyed addresses;
- encryption;
- which transport carries the bytes.

The replica does all of that: it stages, hashes, seals, uploads, fetches, verifies and
reports progress.

### 10.1 File views

```cddl
; ---- files (replica-client-api.md §10) ----
file-view = {
  0: uuid,               ; file ID: the stable machine identity
  1: path,               ; human-readable path, suitable for Markdown links
  2: uint,               ; size
  3: hash,               ; content digest (SHA-256) = revision for CAS
  4: media-class,        ; from the extension; never a trusted content type
  5: file-state,
  6: seq,                ; confirmed_seq: last log position that changed it
  ? 7: hold-ref,
}
file-state = &(
  materialized: 0,       ; the bytes are on this device
  remote: 1,             ; included in the collection, not kept on this device; fetched on demand
  fetching: 2,
  pending_upload: 3,     ; a local add or replace not yet confirmed
)
```

| Method | Params | Result | Capability |
|---|---|---|---|
| `list_files` | `{? 0: path folder, ? 1: [media-class], ? 2: cursor, ? 3: limit}` | `{0: [file-view], ? 1: cursor, 2: complete}` | `collection.read` (within `file_folders`) |
| `get_file` | `{0: uuid / path}` | `file-view` | `collection.read` |

File changes appear in the change feed (§4) like record changes. Move and delete go
through `submit` (`file_move` with optional `update_refs`, `file_delete`), with the
file's digest as `if_revision` when the app wants CAS.

### 10.2 Transfers

**Upload** is a resumable, client-identified transfer into the replica. The replica
then turns it into blob parts in the log service.

```cddl
open-upload-params = {
  0: uuid,               ; transfer ID, chosen by the client: opening is retry-safe
  1: path,
  2: uint,               ; size: exact
  ? 3: hash,             ; digest: the client's SHA-256 commitment, verified at commit
  ? 4: uuid,             ; file ID to replace (absent = new file)
  ? 5: hash,             ; if_revision (CAS on replace)
  ? 6: uuid,             ; mutation ID for the resulting file_put
}
open-upload-result = {
  0: uuid,               ; transfer ID
  1: uint,               ; chunk_size: 1 MiB
  2: [* uint],           ; received: chunk indexes already held (resume)
  3: time-ms,            ; expires_at: 24 hours after the last activity
}
upload-chunk-params  = { 0: uuid, 1: uint, 2: bstr }      ; transfer, index, bytes (exactly chunk_size except the last)
upload-chunk-result  = { 0: uint }                        ; chunks received
commit-upload-params = { 0: uuid }
commit-upload-result = receipt                            ; for the file_put mutation
abort-upload-params  = { 0: uuid }
```

1. **Open and send.** `open_upload`, then `upload_chunk` in any order. A retried chunk
   must carry the same bytes; different bytes are `invalid_request`.
2. **Commit.** `commit_upload` checks the size, the digest commitment, the grant
   (including `file_folders`), the path, the inclusion policy and quota. It then
   captures a `file_put` mutation and returns its receipt as `pending`.
3. **Upload to the log service in the background.** The replica seals the parts and
   uploads them, skipping parts that already exist (deduplication). It appends the
   mutation only once every part is stored. **Confirmed therefore means the bytes are
   durable in the collection.**
4. **Restarts.** Transfer state is durable in the replica's store. A transfer survives
   a replica restart until it expires, and `open_upload` with the same ID reports the
   chunks already received.

**Download** streams a pinned revision:

| Method | Params | Result |
|---|---|---|
| `read_file` | `{0: uuid / path, ? 1: [offset, length], ? 2: hash revision}` | `{0: uint stream ID, 1: file-view}`, then `file-chunk` pushes |
| `ack_chunks` | `{0: stream ID, 1: uint offset}` | flow control: the replica keeps at most 8 MiB unacknowledged |
| `fetch_file` | `{0: uuid}` | materializes a remote file on this device (§10.3); progress pushes |

```cddl
file-chunk = {
  0: uint,               ; stream ID
  1: uint,               ; offset
  2: bstr,               ; bytes (≤ 1 MiB)
  3: bool,               ; last: when true, the whole-file digest has been verified
}
transfer-progress = {
  0: uuid / uint,        ; transfer ID (upload) or stream ID (download)
  1: &( receiving: 0, sealing: 1, uploading: 2, appending: 3, confirmed: 4,
        fetching: 5, streaming: 6, done: 7 ),
  2: uint,               ; bytes done
  3: uint,               ; bytes total
}
```

- **Pinning.** A download reads one blob for its whole life. A concurrent replacement
  doesn't disturb it: blobs are immutable, and GC keeps replaced blobs until the
  horizon.
- **Remote files.** For a file that isn't on this device, the replica fetches its parts
  from the log service (direct transfer, `log-service-api.md` §6), decrypting and
  streaming them as they arrive.
- **Verification.** Each part is authenticated by the AEAD. The whole-file digest is
  checked before the chunk marked `last` is sent. A consumer that must not act on
  unverified bytes waits for `last`. A digest failure ends the stream with `internal`
  and records an incident (`sealed-envelope.md` §4.2).
- **Convenience reads.** Clients cap `bytes`-returning helpers at 64 MiB, as today's
  SDK does. Larger files use streams.
- **Thin clients never write to object storage directly.** Sealing needs the collection
  key, so every byte goes through a replica. For web apps on a cloud-copy collection,
  that replica is the hosted one.

**SDK shape** (TS, informative), keeping today's facade:
- `files.upload(path, blob, {signal, onProgress, transferId, ifRevision})`;
- `files.uploadStream(path, {size, contentDigest, stream})`;
- `files.list({folder})`;
- `files.downloadStream(file, {signal, onProgress})`;
- `files.move(file, to, {updateRefs})`;
- `files.delete(file)`.

All of them are backed by the methods above.

### 10.3 Inclusion and materialization

Three policies stay independent (Connect `docs/files.md`, "Replication and selective
sync"):

1. **Namespace safety** is mandatory, applied by the core (`intent.md` §3.7), and
   never configurable.
2. **Inclusion** is collection-wide and in the log: which media classes and folders
   are synchronized at all, and an optional size cap. It is set by a `sync_settings`
   mutation (`definitions.manage`), and reported by `describe`.
3. **Device materialization** is per device, never in the log: which included files
   this device keeps on disk. It has no effect on authority or on other devices.

```cddl
materialization = {
  0: &( all: 0, on_demand: 1 ),   ; mode: download everything included, or fetch on demand
  ? 1: [* path],         ; pinned folders: always materialized under on_demand
  ? 2: [* media-class],  ; classes always materialized under on_demand
  ? 3: uint,             ; max_size: under all, larger files stay remote
}
```

| Method | Params | Who |
|---|---|---|
| `get_materialization` | — | any session |
| `set_materialization` | `materialization` | the hosting app only (no grant) |
| `fetch_file` | `{0: uuid}` | `collection.read` |
| `evict_file` | `{0: uuid}` | the hosting app only. It drops the local copy of a confirmed, unheld file and leaves it `remote` |

- **Records and resources are always materialized** on a file-backed replica.
- **What a remote file looks like on disk** (absent, or an OS placeholder through
  Windows Cloud Files or a macOS File Provider) is a `FilePlatform` matter, pending
  platform-specific implementation.
- **The default mode per platform** (desktop: everything; mobile: on demand?) is a
  product decision (`open-questions.md` Q27).
- **Deletions are not inferred from absence.** Changing the mode never deletes
  anything from the collection. A remote file's absence on disk is never ingested as a
  delete.
- **The hosted replica** keeps nothing locally: it serves file bytes straight from the
  log service.

## 11. Presence

Presence uses the ephemeral per-record streams of the log service
(`log-service-api.md` §8). Thin clients have no keys, so the replica relays for them.

| Method | Params | Notes |
|---|---|---|
| `presence_join` | `{0: uuid record, 1: value state}` | `state` ≤ 4 KiB: cursor, selection, "editing" |
| `presence_update` | `{0: uuid, 1: value}` | at most 10 per second per session per record; extra updates coalesce |
| `presence_leave` | `{0: uuid}` | also on session close |
| `subscribe_presence` | `{0: uuid record}` | pushes `presence {0: record, 1: [* peer]}` on change |

```cddl
peer = {
  0: bstr .size 16,      ; session: an opaque, per-session pseudonym
  ? 1: uuid,             ; account (display names come from the control plane)
  ? 2: tstr,             ; app ID
  3: value,              ; state
  4: time-ms,            ; last_seen (the receiving replica's clock)
}
```

Requires `collection.read`. The replica seals each session's state into the record's
presence stream as an ephemeral message `{session, account, app, state}`, and merges
what it receives with its own local sessions. Peers disappear 30 s after their last
update or on `left`. Presence never touches the log or the local store. Selections
SHOULD use positions relative to text, for example Yjs relative positions once rooms
exist, not absolute offsets (ADR 0014).

## 12. Transports

### 12.1 In-process (plugins sharing a runtime)

The shared runtime is one instance per app process. Plugins call
`runtime.connect(options)` and get a port that exchanges the same frames as JS
values, with no encoding:
- data maps are `Map`s;
- 64-bit integers outside ±2^53 are `bigint`;
- byte strings are `Uint8Array`.

The hosting plugin connects without a grant. Another plugin that attaches as a client
of the host (version skew, §13) uses the same port.

### 12.2 Local IPC (the desktop daemon)

- **Endpoint:**
  - Linux: a Unix domain socket at `$XDG_RUNTIME_DIR/mdbase/replica.sock`;
  - macOS: `~/Library/Application Support/mdbase/replica.sock`;
  - Windows: the named pipe `\\.\pipe\mdbase-replica-<user SID>`.
- **Access.** The socket is accessible only to the user. The pipe has an ACL for the
  user's SID only.
- **Framing.** `u32be(length) ‖ mdb-cbor frame`, at most 16 MiB per frame.
- **Authentication** uses the same Noise handshake as remote clients (§12.3), with the
  daemon's replica Noise key, so a local app proves its grant exactly as a remote one
  does. One collection per session; a daemon serving several collections multiplexes
  them by the collection ID in the prologue.

### 12.3 Remote: a Noise session through the relay

Thin clients (web apps, MCP, remote CLIs) reach a replica through mdbase's relay. That
is either an online device replica (in an end-to-end collection) or the hosted replica
(cloud copy). The control plane's routing endpoint lists the available targets for the
collection, with each target's device ID and Noise public key from its `device-enrol`
policy item.

- **Protocol:** `Noise_IK_25519_ChaChaPoly_SHA256` (the Noise Protocol Framework,
  revision 34).
  - The initiator is the client. Its static key is the grant's `client_pk`.
  - The responder is the replica. Its static key is its enrolled `noise_pk`.
  - IK gives mutual authentication with one round trip. The client already knows the
    responder's key from the control plane, the way WireGuard uses it.
- **Prologue:** `"mdbase/v1/client" ‖ collection ‖ grant ID ‖ target device ID`.
  That binds the session to one collection, grant and target.
- **First messages.** The first handshake message's payload is the `hello` request.
  The responder's handshake payload is its response.
- **Authorization.** The replica accepts the session only if an active grant in its
  confirmed policy has this `client_pk` and grant ID.
- **Frames** are `u32be(length) ‖ mdb-cbor frame`, carried across Noise transport
  messages of at most 65,535 bytes.
- **Lifetime.** Sessions end after 24 hours, or 2^30 messages, whichever comes first.
  The client then reconnects with a new handshake. A grant revocation closes them
  immediately (`policy.md` §7).
- **The relay** is a dumb pipe. It pairs the client's connection with the target
  replica's relay connection by session ID, and forwards opaque Noise messages. It
  sees who connects to which replica, sizes and timing, never content.
- **The hosted replica** terminates the same Noise sessions directly over a WebSocket.
  TLS is underneath on every hop.

**Keys for web apps.** A browser app generates its static key at installation and
keeps it in IndexedDB as a non-extractable key where the platform allows. Otherwise it
keeps the raw key in storage scoped to the app's origin. Its public key is registered
in the grant at consent time.

**Size for thin clients.** A thin client needs only Noise, X25519, ChaCha20-Poly1305,
SHA-256 and a strict `mdb-cbor/1` codec. That is a few tens of KiB of JS. It does not
need the WASM core.

## 13. Versioning and the version-skew rule

**API versions.**
- `hello` negotiates the highest common version.
- A replica serves its current minor and the two previous minors of its major
  (`00-overview.md` §6.4).
- New methods, push types and optional fields are minor changes. Clients ignore unknown
  push types and unknown fields.
- Removing or changing behaviour is a major change, shipped with one release that
  serves both majors.

**Shared runtimes in one app process.** Each plugin embeds a
byte-identical, versioned runtime build. At load:

1. **Registration.** The runtime registers itself on a well-known global,
   `globalThis.__mdbase_runtime__`, keyed by runtime ABI major. It records its runtime
   version, its `sem`, the API versions it serves, and its instance.
2. **The first runtime per collection hosts**, by taking the folder lease (a
   `FilePlatform` matter, pending platform-specific implementation), if its `sem.major` is at least the log's
   ratchet. Otherwise it attaches as a client: to the desktop daemon if there is one,
   or else it reports `upgrade_required` to its plugin.
3. **A later runtime that is newer** (a higher `sem`, or the same `sem` and a higher
   runtime version) asks the host for a **handoff**:
   1. the host finishes any in-flight append;
   2. it flushes its store and releases the lease;
   3. the newer runtime opens as host;
   4. the old runtime re-attaches as a client of the new host, as long as the new host
      serves its API version. Otherwise its plugin gets `upgrade_required`.

   Pending mutations survive the handoff, because they are in the store, not in
   memory.
4. **A later runtime that is older, or equal**, attaches as a client of the current
   host.
5. **There is never more than one host per collection per device.** The lease enforces
   it.

**The rule in one line:** a host older than the log's semantics major, or older than a
runtime that is present, attaches as a client instead of hosting.

## 14. Editor fence callbacks

A plugin with an in-process view of open editors (Obsidian) can offer the `fence`
feature. The replica then publishes changes to open files **through the editor buffer**
instead of the file. That is the only safe route
while Obsidian's editor saves blindly every 2 seconds.

| Direction | Message | Meaning |
|---|---|---|
| client → replica | `fence_report {0: [* {0: path, 1: bool dirty, 2: hash buffer}]}` | the files open in editors, sent on open, close, dirty change, and after each editor save |
| replica → client | request `fence_apply {0: path, 1: hash base, 2: [+ [uint, uint, tstr]] edits, 3: hash expected}` | apply these edits (Unicode scalar offsets, as `body_edits`, over the whole document) to the buffer whose content hashes to `base`, giving `expected` |
| client → replica | result `{0: &(applied: 0, not_open: 1, buffer_changed: 2), ? 1: tstr buffer}` | `buffer_changed` returns the current buffer, so the replica can re-plan or hold |

The replica treats a publish through the fence as confirmed on disk only when ingest
later observes the expected bytes.

**File-platform boundary.** When to route through the fence, and the fallbacks without the
plugin, are `FilePlatform` and file-layer rules. This contract fixes only the messages.
