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
  ? 4: [+ path],         ; file_folders: the grant's file-namespace folder scope (API 1.2); key 3 reserved
}
```

From API 1.2, `file_folders` is the effective grant's folder scope: present means
file reads, listings and writes are limited to those folders, absent means the whole
file namespace. Before API 1.2 its absence says nothing about the scope. `capabilities`
are the role-effective capabilities in force; file actions follow from them
(`policy.md` §5): list and read need `collection.read`, add needs `records.create`,
replace and move need `records.edit`, delete needs `records.delete`.

`hello` is the first request. Before it, every other request fails with
`unauthenticated`. Version negotiation is in §13.

From API 1.3, session status responses and pushes include the current effective
`grant` at key 12. Clients use it to update role-dependent controls without
reopening the collection. Earlier producers omit it; retain their negotiated
hello grant. Synced hosting applications follow their device account's signed
membership once bootstrap establishes it. Their pre-bootstrap Host authority
is unchanged. During recovery, status remains available even if the current
grant cannot be resolved; its optional grant is then absent.

### Feature negotiation is not operation or permission discovery

`hello-result.features` is the intersection of the features requested in this
hello and the markers this producer admits. It is not a complete feature catalog.
Retain the exact requested list alongside the current hello: distinguish **not
requested**, **requested / negotiation pending**, **requested but not negotiated**,
and **negotiated**. A failed hello or an unavailable current session is an error,
not a negative feature result. Absence of an unrequested marker says nothing about
support. Do not use a prior session's hello to certify a new session.

The current Replica producer's marker list is `presence` and `attachment-v1`
(bare codec support), plus qualified `attachment-v1.read` and
`attachment-v1.materialize` directions when that replica admits them.
`attachment-v1.write` is not granted by this producer. Directions are not implied
by the bare codec marker. This source list is not a qualification of a deployed
producer, transport, app session or UI; testing substitutes may advertise
other markers and are not evidence of native negotiation.

Legacy Connect names `query-metadata-v1`, `read-many-documents-v1`, and
`query-record-revisions-v1` are **not native aliases**. Ordinary reads use
`collection.read` and the corresponding public operation, not one of these hello
markers. Typed query/selection metadata belongs to `query-result` (§4); record
identity/revision belongs to `record-view` (§3). SDK `queryPages` preserves ordinary
query pages/cursors; SDK `readMany` composes ordinary gets, not a native bulk RPC,
transaction or common snapshot. No negotiation marker proves those stronger
semantics. `describe` is catalog/contract inspection, not a feature catalog.

The hello grant capabilities and role are snapshots, separate from negotiated
markers and current RPC authorization. Every RPC must retain its existing current
authority checks; read failures, revocations, stale cursors and unsupported query
semantics remain their real errors, never converted to `false` capability or an
unrequested fallback. See the SDK's operation mapping for legacy consumers.

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
| `describe` | `null` or `{? 0: bool definitions}` | `describe-result` (§4.1): typed catalog summary and registered contracts; `definitions` adds type definitions/schemas and contract schemas |
| `query_contract_v1` | versioned exact contract + bounded continuation (§4.1.1) | ordinary query page + canonical inspection projections |
| `describe_typing` | `{0: [* tstr] types (≤ 64), 1: [* path] paths (≤ 256)}` | `{0: uint catalog_generation, 1: [* {0: path, 1: typing}]}`, one entry per requested path in request order; `typing = &(none: 0, date: 1, date_time: 2)` is `date`/`date_time` only when every listed type declares that format at the path (top-level field paths only; nested or unknown → `none`, empty `types` → `none`). `too_large` over the bounds |
| `get` | `{0: uuid / path, ? 1: include}` | `record-view`, or `not_found` |
| `get_contract_v1` | `{0: 1, 1: uuid / path, 2: tstr contract, 3: tstr exact version, ? 4: tstr type}` | `{0: 1, 1: uuid id, 2: path, 3: hash revision, 4: tstr type, 5: data-map fields, 6: hash contract_digest, 7: hash implementation_digest}`: the record's valid contract view through Core's resolved mapping in the local view. `not_found` (no record; `data_contract_not_found`; `data_contract_not_implemented` when the record has no implementing type), `invalid_request`/`data_contract_ambiguous` (several of its types implement it; details: the types), `invalid_record`/`data_contract_record_invalid` (with issues). Unknown keys are `invalid_request`. READ required |
| `map_contract_write_v1` | `{0: 1, 1: tstr contract, 2: tstr exact version, ? 3: tstr type, ? 4: uuid / path target, ? 5: data-map contract fields, ? 6: [* tstr] contract field refs to unset (≤ 256), ? 7: bool promote}` | `{0: 1, 1: tstr type, 2: data-map patch, 3: [* tstr] unset, 4: [* base-field] base, 5: hash contract_digest, 6: hash implementation_digest, ? 7: uuid id, ? 8: path, ? 9: hash revision}`: contract fields as ordinary top-level record changes, for a `create` of `type` (no target) or an `update` of the target, which must implement the selection (7–9 describe it). Nested record fields are merged with the target's current values and their observed values returned as `base`. Core refuses unmapped contract fields (`invalid_request`/`data_contract_field_unmapped`, details: the pointer), conflicting mappings (`data_contract_field_conflict`), and a write whose resulting view is invalid (`invalid_record`/`data_contract_record_invalid`); selection errors as `get_contract_v1`. With `promote` (API 1.x additive; older producers refuse key 7 as `invalid_request`), an untyped target (no type membership) is mapped through the selected implementing type and the plan also sets the first `explicit_type_keys` key to that type, with the key's observed absence in `base`, so one `update` promotes and writes. A target that already implements the selection maps as usual; one with other types is `invalid_request`/`data_contract_promote_typed`; a collection without explicit type keys is `data_contract_promote_unsupported`. Nothing is written. READ required |
| `plan_type_pack_v1` | `{0: 1, 1: data-map provision {manifest, resources: [{source, document}], ? provides}, 2: tstr installed_by, ? 3: data-map adopt (target → "sha256:…" text, ≤ 256), ? 4: [* tstr] preserve_seed_targets (≤ 256), ? 5: data-map target_overrides (target → target, ≤ 256), ? 6: bool allow_downgrade, ? 7: hash expected_assessment_digest}` | `{0: 1, 1: data-map assessment, ? 2: [* {0: path, ? 1: tstr doc, ? 2: hash base_revision, 3: bool must_not_exist}] writes}`: a Core type pack assessment (spec 05A) over the local view; nothing is written. The assessment has `status` (`install`, `upgrade`, `downgrade`, `reconfigure`, `current`, `conflict`; `downgrade` only when refused for lack of `allow_downgrade`), `applicable`, `definitions_manage` (whether this session may submit the apply), `assessment_digest`, `? current` and `desired` receipts (`id`, `version`, `digest`, `installed_by`, `resources` with `origin_digest` for seeds), `resources` (per target: `source`, `target`, `kind`, `mode`, `action`, `? digest`, `? current_digest`, `? installed_digest`, `? adopted_from_digest`, `? upgrade_baseline {digest, ? version}`, `? reason`), `lock {target, action, digest}` and `? issues`. With key 7 the replica re-assesses and returns `writes`: one mutation's resource puts/deletes, each bound to the reviewed revision (creates are `must_not_exist`), including a same-bytes guarded put for every adopted byte-identical target and the lock; an empty list means the pack is current. `provides` is accepted and unused. Refusals: `invalid_request`/`invalid_type_pack_request` (malformed input), `invalid_request`/`invalid_type_pack` (pack or staged collection invalid), `conflict`/`type_pack_conflict` (key 7 on an inapplicable plan), `conflict`/`concurrent_modification` (key 7 no longer matches), `conflict`/`type_pack_downgrade`, `forbidden` (key 7 without `definitions.manage`), `upgrade_required`/`type_packs_unsupported` (older replica). READ on an unrestricted session required (as `list_resources`) |
| `get_resource` | `{0: path}` (exactly one field) | `resource-view`, or `not_found`; unrestricted collection READ required |
| `new_type_file` | `{0: tstr source}` (exactly one field) | `{0: tstr name, 1: path}`: where a type file created from `source` goes in the local view, `<types_folder>/<name>.md`, for a `resource_put` with `mustNotExist` (`definitions.manage`). Core derives it: `invalid_record`/`invalid_type_definition` (with the issue) for a missing or unusable name, `conflict`/`type_conflict` (details: existing path) when the name exists under any casing, `conflict`/`path_taken` (details: revision) for an occupied path. The definition is validated when written. READ required |
| `list_resources` | `list-resources-params` below | `list-resources-result`; unrestricted collection READ required |
| `query` | `{0: query, ? 1: include}` | `query-result` |
| `subscribe` | `{0: query, ? 1: include}` | `{0: sub ID}`, then `query-update` pushes |
| `unsubscribe` | `{0: sub ID}` | — |
| `changes` | `{0: cursor?, ? 1: limit, ? 2: watch: bool}` | `{0: [change], 1: cursor, 2: reset: bool}`, then `changes` pushes if `watch` |
| `validate` | `{? 0: [uuid / path] / null}` | `[validation-record]`, bounded current-record diagnostics below |
| `list_files`, `get_file`, `read_file` | §10 | §10 |

Spec 12 saved views (`mdbase.view` records) are not replica methods: the SDK's
`views.list/execute/readSource` resolve them over `query_contract_v1`,
`get_contract_v1`, `get` and `query` with spec 11 named-view resolution.
`packages/sdk/test/runtime-method-contract.test.ts` checks every SDK request
against the pinned runtime's frame dispatch.

`validate` is a read-only operation over the actual current local records and
catalog, including pending record/definition changes. It reuses Core's
single-record and cross-record checks and explicit-validation severity policy
(`warn`/`off` report warnings). It does not validate an unsaved draft, install
any definitions, or authorize a write. READ is reauthorized before delivery;
existing file-folder visibility applies to file link targets.

A `validation-record` is `{0: uuid, 1: [validation-issue], 2: path, 3: hash}`.
The path and SHA-256 revision belong to the exact current document validated.
A `validation-issue` preserves `issue` fields 0–3 and adds optional field 4
(location), optional field 5 (type name), and required field 6 (Core tier:
`request`, `single_record`, or `cross_record`). Fields 0/1 of the original
validation record result remain unchanged. Generic `issue` elsewhere is unchanged.
Explicit targets retain request order and duplicates. Missing targets, invalid
catalogs, storage faults, or exceeded budgets refuse the whole operation, never
return partial rows or an empty diagnostic substitute.

At most 1000 selections/types/local touched entries are admitted. Paths are
nonempty and at most 4096 UTF-8 bytes; each examined document is at most 1 MiB.
The producer meters at most 4096 record/index work units and 8 MiB of examined
source/overlay data. The encoded result is at most 1 MiB, 4096 issues, 65536 CBOR
nodes and depth 32. Absent/null targets request all current records, enumerated
in bounded pages of 128 with a 1000-record ceiling. Cross-record uniqueness checks
also need that bounded collection inventory, even for an explicit target.
Exhaustion returns `too_large` / `validation_budget`, not truncated diagnostics.
These are selection/read/serialization bounds, not a peak-heap, kernel CPU,
existing Store allocation or downstream UI qualification certificate.

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
change = {
  0: uuid,                     ; id
  1: path,
  2: &( put: 0, remove: 1 ),   ; kind
  3: uint,                     ; view version
  ? 5: &( record: 0, file: 1 ), ; entity (API 1.2); key 4 reserved
}
```

From API 1.2 every change names its entity, except a removal the producer cannot
classify (it left no tombstone, so its path is empty too). A client that
follows one entity treats an unclassified removal as possibly its own and an
unclassified put as a reason to re-read.

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
  ? 3: int,                  ; the type's declared `version`
  ? 4: hash,                 ; revision of the type source in the local view
  ? 5: value,                ; whole type frontmatter (definitions only)
  ? 6: value,                ; resolved schema the type validates with (definitions only)
}
implementation = {
  0: tstr,                   ; contract ID
  1: tstr,                   ; exact resolved contract version
  2: { * tstr => tstr },     ; contract field reference -> record field reference
  ? 3: value,                ; binding, omitted when empty
  ? 4: hash,                 ; implementation digest (spec 05A)
}
contract-summary = {
  0: tstr,                   ; contract ID
  1: tstr,                   ; exact version
  2: path,                   ; contract resource path
  3: hash,                   ; canonical contract digest
  4: tstr,                   ; contract_type
  5: [* tstr],               ; types implementing this exact version
  ? 6: { * tstr => value },  ; resolved schemas by member (definitions only)
}
```

Describe reads the local view, including pending definition changes, so a type's
revision (key 4) equals the revision `get_resource` returns for its path and is a
valid resource CAS base. The implementation's type version is the owning
type-summary's key 3. Keys 5 and 6 of a type and key 6 of a contract are present
only when the request sets `definitions`; their combined encoding is bounded at
8 MiB, over which the request fails `too_large` with reason
`describe_budget_exceeded` and the caller reads definitions with `get_resource`.
Any other param key is `invalid_request` (`unknown_param`). Producers that
predate these keys ignore the param and omit keys 3–6 and implementation key 4,
so a client that asked for definitions treats a type without key 5 as
`upgrade_required`.

Types are summary maps, not type-name strings. The `types`, `issues` and
`contracts` arrays are required even when empty. Only registered contracts and
valid resolved implementations are projected from the current local catalog;
Describe is not a substitute for `get_resource`'s exact source. The shared
`conformance/describe/populated.hex` fixture covers the existing response
encoding. This shape does not add a query contract filter or saved-view RPC.

### 4.1.1 Version-one contract inspection

`query_contract_v1` is an additive, explicitly versioned read method, independent
of the ordinary `query` params (which still refuse an unsupported contract param).
It uses the same READ capability, local view, Core type membership, effective
frontmatter and resolved `Implementation` projector as other reads. It neither
creates contracts nor guesses fields from names. Old producers refuse the method;
SDK callers never fall back to projecting raw frontmatter themselves. It changes
no generic Client API negotiation or persisted representation.

```cddl
contract-query-v1 = {
  0: 1,
  1: tstr,                 ; exact registered contract ID, max 1024 bytes
  2: tstr,                 ; exact resolved version, max 128 bytes
  ? 3: uint,               ; page size 1..128, default 128
  ? 4: tstr,               ; session-bound ordinary query cursor
  ? 5: tstr,               ; CEL filter over contract fields, 1..4096 bytes
}
contract-query-result-v1 = {
  0: 1,
  1: query-result,
  2: [* {0: uuid, 1: [* {0: tstr, 1: data-map, 2: [* issue]}]}],
  3: hash,                 ; registered contract digest
}
```

Projection rows match query record UUIDs and order exactly. Each implementation
entry contains its type name, mapped effective fields and record-schema issues.
Nonempty issues mean inspection data, **not** a valid contract view: retaining
mapped identities lets a directory report an invalid claimant without guessing.
Strict Core `Implementation::view` still rejects those records unchanged.

Key 5 filters projections: the CEL is compiled like a record `where` (an invalid
one is `invalid_request`/`invalid_query`) and evaluated on each implementation's
mapped fields as top-level names (no types, so no defaults; `file.*` is the
record's file). Non-matching projections are dropped, then records left with none;
the page's query records are filtered to match, `total_count` is omitted, and the
cursor continues the underlying walk, so a page may hold fewer than the page size.
Producers before key 5 refuse the envelope (`invalid_request`), never ignore it.

The contract/version/digest (and filter) are included in the ordinary cursor fingerprint;
all existing session, catalog, head and view-version invalidation rules apply.
The method selects every type implementing that exact record contract, with a
128-implementation/128-mapping cap and a fixed 1 MiB projection/response budget.
A valid registered contract with no implementations returns a complete empty
page; a missing contract is `not_found` / `data_contract_not_found`. Invalid
catalogs are `collection_invalid`. No cursor is fabricated for whole-scan stores:
a short fixed-type window proves completeness, but a full window without terminal
metadata refuses with `upgrade_required` / `contract_query_cursor_required`.
Readers must consume all continuations, require `complete`, keep one `as_of` and
digest, and reject missing continuations when `has_more` is true. They must not
present a prefix as a complete directory.

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

### SDK editor leases are local, not distributed locks

SDK `records.open` composes ordinary reads, observation, updates and receipts into
one shared editor draft/session per UUID/client. Its lease is a local lifetime
reference, not a replica-issued exclusive lock, token or renewable remote lease.
Writer's open/edit/autosave/conflict/recovery/release uses map to that existing
[SDK session contract](../../packages/sdk/README.md#writer-lease-mapping).

Saves explicitly use the actual full record base/revision CAS and captured
mutation identity. Unknown outcomes retain the original receipt recovery rather
than submit another mutation. Saved requires confirmed, unprotected, same-UUID
full current readback, not receipt confirmation alone. Release does not certify
save, roll back a captured write or unlock other clients. Settled CAS conflict
choices do not authorize resolving native held/unresolved records (§8).

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

### 6.1. Pending-write inventory

`list_pending {? 0: uuid cursor}` returns `{0: [* pending-mutation], ? 1: uuid next}`.
A pending-mutation is `{0: receipt, 1: time-ms captured, 2: [+ runtime-op]}`.
These are actual durable PendingRows in increasing capture order, with their original
mutation UUID, capture clock and exact runtime operations (including FileAttach).
It is not an inventory of upload references, metadata keys, holds or settled receipts.
Legacy Submit admission is unchanged; runtime operations here are recovery evidence,
not permission to submit them through the legacy API.

A current authenticated grant sees only rows submitted under that grant; Host sees
all rows in this replica. Like receipt recovery, no READ capability is required.
Each request scans at most 64 rows plus one lookahead, retaining only one source
row at a time, and returns at most 4 MiB of encoded entries;
a single entry exceeding that budget refuses `too_large / pending_inventory_budget`.
Hidden rows count toward work but their IDs/operations never enter output. Thus an
empty page can have `next`: callers must continue until `next` is absent.

The opaque UUID continuation is bound to the original live session, not a mutation
ID or authority token. At most 16 positions are retained per session for five
minutes; closing/revoking the session drops them. Unknown, expired or foreign
positions refuse `invalid_request / invalid_pending_cursor`. Restart inventory
explicitly on refusal; do not infer an empty queue. Pages are live, not an atomic
snapshot: confirmation can remove rows between pages, and subsequent captures may
appear. Continuation remembers capture order even after the preceding row settles.
This read never captures, retries, remints, confirms or publishes a mutation.

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
  ? 12: grant-info,      ; API 1.3: this session's current role-effective grant
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

`resolve_hold` requires `records.edit`, or `records.delete` for `delete`. With
`records.edit`, the resolving mutation also dismisses the record's conflicts (§8.2),
so no replica lists a conflict the hold decision settled. `<device>` in a `keep_both`
path is the host's computer name when it sets one, else the device ID's first eight
hex digits.

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

`mtime` is optional persisted producer metadata from native upload commit's
writing-device capture clock. Old/absent values remain absent, not inferred from
sequence or local filesystem stat. Replay, snapshots and captured upload recovery
preserve the original value; metadata-only moves do not retimestamp the bytes.

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
  ? 8: int,              ; mtime: writing-device commit/capture clock, milliseconds
  ? 9: tstr,             ; IANA media type from the extension (Core paths::media_type); absent when unknown; never sniffed
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
  ? 4: uuid,             ; file_id: natively minted CREATE identity (API 1.1)
}
upload-chunk-params  = { 0: uuid, 1: uint, 2: bstr }      ; transfer, index, bytes (exactly chunk_size except the last)
upload-chunk-result  = { 0: uint }                        ; chunks received
commit-upload-params = { 0: uuid }
commit-upload-result = receipt                            ; for the file_put mutation
abort-upload-params  = { 0: uuid }
```

API 1.1 upload producers return `file_id` in `open-upload-result`; CREATE never
accepts a caller-selected file identity. The optional wire slot preserves API 1.0
responses; newer SDK uploads refuse absent identity before transmitting file bytes,
never substituting a post-confirmation path lookup. `FilesApi.upload` returns a
Write-compatible `FileWrite` with the original native `fileId`. The `file_id` input
continues to mean replacement only; it is not a CREATE identity parameter.

**Replace.** `open_upload` with both `file_id` and `if_revision` replaces the content
of a live Ordinary File, keeping its ID. Only one of them is `invalid_request`
(`attachment_replace_requires_revision`). The session needs `records.edit`, plus the
grant's folder scope for the path. `path` must be the file's current path
(`conflict`, `attachment_replace_target_changed`). `if_revision` must be its current
whole-plaintext digest (`conflict`, reason `revision`). A file with a pending local
change is `conflict` (`attachment_replace_pending`). These checks run at open, at
every staging boundary and at capture. The captured `file_attach` carries
`if_revision`, so the log order enforces the same CAS. The encrypted resume journal
binds the replacement (file and original `if_revision`; create journals keep their
original bytes), and a cold resume whose request does not restate it exactly is
`conflict`, `attachment_upload_scope_changed`. Without `file_id`, an
occupied destination is `conflict`, reason `attachment_destination_exists`.

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
| `cancel_stream` | `{0: stream ID}` | idempotent cancellation of this session's matching stream only |
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

Native attachment CREATE uses one session-derived context for actual device Host
or Grant subjects. `start_attachment_create` returns the original native UUID and
mutation from the existing bounded positional-source writer; it does not perform
an identity lookup after confirmation. Host has no synthetic `on_behalf` grant.
Current CREATE/device/key/folder/health and collection/wake/store-generation/epoch
checks precede source/object work and capture. The existing hosted source/region
entry points remain HOSTED+Grant-only. Existing Grant V1 encrypted resume bytes
are unchanged. The same bounded codec supports a distinct tagged Host V2 owner
(device/account/transfer) and purpose, not a placeholder grant; see the
resume owner formats in the source.
This source seam may read its first chunk at start: it is not the streamed wire
`open_upload` producer. Native region start/resume now returns the original
(mutation, file) identity before input; device Host/Grant and hosted wrappers use
one writer/journal/rehash/commit implementation. Host resume authenticates its real
device/account owner, rebuilds the committed digest prefix after reopen, and keeps
the same native UUID. Hosted entry points still refuse device profiles and wipe
supplied regions on boundary failures. ClientApi open/chunk/abort now uses this
same leased backing: open returns the original UUID before input, 1MiB fragments
assemble in one bounded 8MiB window, and native authenticated LS staging must pass
its object probe and known encrypted-journal PUT before committed progress. Packet
acceptance is tentative RAM progress, not durability. Commit now drives the same
manifest/probe/capture loop (including empty files) and answers only with the
actual native receipt. Frames holds original upload/commit request IDs across
native backpressure, with at most four 1MiB fragment bodies in total (matching the
SDK's four concurrent requests). Held bodies are wiped on cancel, close or
completion; timeout reports unknown outcome, never a fabricated receipt. Within-
window out-of-order/retry and cross-window deferral are tested. Reconnect/restart
delivery of the authenticated checkpoint and end-to-end package/runtime
qualification remain unfinished; this is not qualified upload delivery. Native
ClientApi uploads persist only an opaque journal reference, scoped to the actual
HostV2/GrantV1 owner+transfer, after known journal PUT and settled local store
commit. Unknown local durability fences the instance; close retains the pointer
and explicit abort retires it. Stored-transfer open now defers its original RPC
while native authenticated LS fetches the bounded encrypted journal and rehashes
its committed prefix in the same exact region lease. Only then does it return the
original native UUID and committed fragment indexes; tentative RAM ACKs are not
resumed. Journal/chunk tamper and stale scopes refuse and wipe. Fresh wire open
also waits for known encrypted zero-prefix journal and local-pointer commits
before exposing identity or accepting file bytes. Zero-prefix cold restart keeps
the original UUID and expiry, including empty files; it claims no committed
chunks. Already-captured recovery authenticates the original journal and requires
its exact owner-scoped opaque reference coupled to the actual FileAttach capture
transaction, then reads the actual native receipt. A marker, journal, or file row
alone cannot certify an outcome. Same-session retries and cold opens keep the
original UUID/expiry; captured recovery neither creates a writer nor rehashes or
uploads the payload. Pending/rejected outcomes remain those actual outcomes.
Captured cleanup preserves recovery references and cannot withdraw the write or
release a successor read lease. Ordinary CREATE still requires an absent
destination. Full package/runtime qualification remains unfinished.

The shared native attachment read pin accepts active, keyed member devices of
kind desktop/mobile/app-runtime/CLI, including viewers without write authority,
or an actual cloud-copy hosted profile. Escrow/recovery, key-only and local-only
profiles do not serve attachment bytes. Pins bind the collection, wake and store
generation; current READ/folder/health checks precede input and output. Hosted
transports must additionally preserve live Noise/admission checks. The existing
hosted native API remains HOSTED-only and delegates to this same reader.

Replica owns one ephemeral read driver and leased region. ClientApi read/ACK/cancel
and the hosted engine's existing bounded object callbacks use this same state;
the hosted engine no longer owns a separate reader or backing. Pin capture precedes
region allocation. Close/revocation cleanup and idle expiry release the exact
lease; transport retirement scrubs pending ciphertext and invalidates old object tickets.
Device reads issue one native-ticket-bound `GetObject` at a time through the existing
authenticated LS capture/decode path. Each reply is at most one sealed chunk, checked
against its pinned size/address, then authenticated in the same leased region; the
transport copy is zeroized. The shared driver emits one bounded typed `file-chunk`
per push drain; the canonical frame encoder zeroizes its temporary plaintext copy.
Queued unsent frames are zeroizing and tagged with their native stream ID so scoped
cancellation can purge them without decoding or copying plaintext. ACK credit gates
both output and the next object read. Hosted reads retain their direct bounded R2
callbacks and live transport admission rather than issuing duplicate device LS calls.
Source-level device RPC/LS/frame tests do not establish complete SDK/native package
or runtime qualification; those remain separate end-to-end checks.

`fetch_file` checks the session's current `collection.read` grant and file-folder
scope before checking device storage support. It admits a request to the existing
attachment reconciliation/materialization driver, not a completed disk publish;
repeat requests reuse the same queued or in-flight fetch. Its current implementation
supports attachment-v1 files on synced device stores that materialize attachments.
Other stores return `unavailable` / `file_materialization_unsupported`; other file
content profiles return `upgrade_required` / `attachment_required`. An external-edit
or hold fence returns `unavailable` / `file_materialization_fenced`. A terminal native
fetch failure is returned unchanged, without restarting that content's fetch.

`evict_file` is host-only and reuses conditional unlink of the materializer's
tracked copy. Held/external-edit-fenced files are refused; changed or locked bytes
are preserved with `conflict` / `file_eviction_drift`. A prior shown path now owned
by another confirmed entity is never unlinked. The confirmed file and collection
log remain unchanged. The remote state is persisted before unlink; the shown marker
is retained until success, so interrupted eviction can be reconciled or retried.
Unknown persistence/unlink outcomes require reopening the instance, not an invented
successful eviction. In-flight fetches are cancelled and late replies cannot publish.
The existing default `all` policy may refetch after reopen or later reconciliation;
eviction does not introduce a persistent on-demand policy.

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

**Current implementation:** the native Replica's join/update/leave/subscribe
methods below return `not_yet("presence")`. An admitted hello `presence` marker
is not proof that these RPCs are implemented. Writer's local editor lease flow
does not require presence; presence is never an exclusive editing/write permit.
The following describes the intended protocol, not a deployed qualification.

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
  (`00-overview.md` §6.4); 1.3 also retains 1.0 for published clients.
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
