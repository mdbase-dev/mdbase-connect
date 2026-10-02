# Wave B B3: Record revisions and revision-bearing batch reads

Status: proposed; depends on [B1](sdk-wave-b-capability-negotiation.md).
Baseline and report provenance are recorded there. This is stage 2 of readMany,
not a new mutation protocol or a collection-generation proposal.

## Current behaviour with evidence

- Protocol `packages/protocol/src/index.ts::RecordDocument` and client
  `src/operation-types.ts` require a revision for point reads; `QueryRecord` has
  none. Client `src/collection-client.ts::wireQueryRecord` consequently cannot
  expose a usable top-level query revision.
- Local `crates/connect-core/src/registry/operation_execution.rs` adapts mdbase
  reads/queries; shared mdbase-rs `src/operations/read.rs` hashes exact document
  bytes. `src/query/cache_source.rs::FileRecord` already retains source revisions,
  but `src/query/canonical/{model,result}.rs::Candidate/serialize_candidate` do
  not carry/emit a top-level revision. Invalid stubs have `file.revision` in
  `canonical/execute.rs`; that is not a uniform QueryRecord contract.
- Hosted `crates/connect-hosted-provider/src/provider/operation_dispatch.rs`
  uses direct typed point reads and hosted query execution. Its
  `operation_queries/query_top_k.rs:272–280` Base renderer omits revision;
  other projected/residual/exact renderers must also be covered. Stored records
  and query projection bindings already have record revisions.
- Reports: Reader `packages/connect/src/annotation-record-cache.ts` and
  `docs/annotation-loading-performance.md` use a 15-second bounded cache because
  query rows lack revisions; `annotation-repository.ts` hydrates with point reads.
  TaskNotes `src/storage/mdbase-repository.ts:1949–1971,2107–2159` batches bodies
  then rereads for revision. Writer batches paths; editor does serial point reads.

## Proposed API and wire

Advertise `query-record-revisions-v1`: every record row of a normal or narrow query
has top-level `revision`, the existing opaque exact-source token accepted by
`if_revision`. Normal QueryRecord types gain optional `revision` for old producers;
B2's negotiated narrow rows and document batches require it. Empty/group-only results have no synthetic revision. The source
bytes, body, persisted/effective fields and token must come from the same record
version. mdbase-rs carries source revision through its candidate/typed query and
hosted evaluation results; Connect transports it, never hashes reconstructed JSON.
A token does not certify freshness of schema/defaults/computed values: unchanged
source can have a new semantic projection after catalog changes. Cache semantic
rows only with description/catalog invalidation as well as record revision.

Advertise `read-many-documents-v1`: extend **existing `read`**, not the mutating
`batch` operation or an immutable approval group's operation list:

```json
{"paths":["a.md","b.md"],"include_body":true,"include_document":true}
```

Exactly one of `path` or nonempty `paths` is accepted. Single-path read defaults
remain unchanged; batch `include_body` defaults true, `include_document` false.
`contract:{id,version,type?}`
is optional subject to B5. Under the existing `OperationResult` envelope:

```json
{"valid":true,"result":{"items":[{"path":"a.md","status":"found","record":{"path":"a.md","revision":"sha256:…","types":[],"frontmatter":{},"effective_frontmatter":{},"body":"text","document":"exact Markdown","file":{"path":"a.md"}}},{"path":"b.md","status":"missing"}]}}
```

Per-item expected parse/semantic failures use `status:"error", error:{code,message}`
with existing semantic diagnostic codes. Authentication, revoked grants, deadlines,
inconsistent internal bindings and capacity failures fail the operation, not a
successful set of missing files. One ordered item per input occurrence; duplicate
paths share physical work, not output slots. Start with 100 paths and an 8 MiB
serialized-response ceiling (qualify/tune with benchmarks); over-budget work fails
explicitly and tells the caller to split, never truncates. No batch cursor.

SDK adds a document overload to Wave A `readMany(paths, {output:"documents",
includeBody, includeDocument, contract})`, retaining its per-path ordering/outcome
conventions; finalize spelling against the landed Wave A API before implementation.
`includeDocument` is exact source, not regenerated Markdown; contract projections
cannot request it. No readMany summary is cast into a RecordDocument.

Per-record coherence is mandatory; cross-record atomic snapshot consistency is
**not** promised. Query continuations retain existing cursor guarantees, but a
subsequent batch is a later read. If its revision differs from discovery, install
new content+revision together, invalidate derived indexes and re-evaluate membership
when needed. Never attach a query token to a later point read's content. This design
does not claim editor's two separate queries become one pinned generation.

## Compatibility, security and migration

Optional query response revision fits existing transport; old SDKs ignore it.
Old authorities receive no `paths` input. For Writer/Reader/TaskNotes/editor,
document fallback is bounded point reads using existing `read`; Wave A path queries
remain suitable for summaries only. Revision-dependent consumers on older query
producers continue point reads, not local hash fabrication. MCP can add an optional
batch tool routed through `read`, retaining the single-read tool and wire shape.
Remove fallbacks under B1's minimum-authority/adoption/rollback gate.

Reader replaces N hydrations and validates cache tokens; TaskNotes deletes revision
rereads but retains RMW locks and its bounded document cache. Writer adopts revisioned
body batches; editor batches unopened-note refreshes while open sessions keep their
write queues. MCP has no cache to replace. Obsidian needs separate sync ID/snapshot
ports and is not migrated here. Raw native documents require existing read approval;
contract projected reads follow B5. Local exact-grant checks apply before all work
and current authorization before delivery; do not log/persist bodies in the control
plane or disclose absolute collection roots in per-item errors.

## Tests and size

M–L, approximately 6–10 engineer-days across mdbase-rs, protocol, local/hosted and
SDK. Conformance across canonical fast/general/invalid-record paths, hosted Base,
projected, residual and exact fallback; CRLF/comments/Unicode round trips; external
edit during cache refresh; source/catalog skew fails explicitly. Race query→edit→
batch→conditional update; all returned revision/content pairs must agree and stale
writes must conflict. Batch missing/duplicate/invalid paths, byte caps, cancellation,
revocation and mixed item failures; old-authority request-count assertions. Re-run
Reader/TaskNotes hydration scenarios and sdk-review bench with real producer fixtures;
measure calls/bytes, not synthetic performance claims. Run request-path e2e on implementation.
