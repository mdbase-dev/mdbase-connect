# Wave B authority implementation (B3 → B2)

Collection semantics live in `mdbase-rs`. Connect authenticates, selects exact
storage inputs, binds cursors and transports the canonical result.

## Surface and ownership

- Ordinary native query rows now carry exact-source `revision`, including local
  fast/general/cache/invalid-stub paths, hosted projected/residual/exact paths,
  and local/hosted Obsidian Base rows. Revisions certify source bytes, **not**
  freshness of schema/default/computed projections; consumers must also invalidate
  semantic caches when the catalog/description changes.
- Native `read` accepts `paths` (1–100 input occurrences), mutually exclusive with
  `path`. Bodies default on, exact documents default off. Output is ordered
  `items` with `found`/`missing`/`error` outcomes. Duplicate paths share storage and
  semantic work, not output slots. Source, body, fields and revision are evaluated
  together by the existing point-read evaluator. There is no cross-record atomic
  snapshot promise. Responses over **8 MiB**, including the operation envelope,
  fail explicitly with a split instruction. Hosted reads additionally bound
  retained exact source to **32 MiB** and execution to 15 seconds.
- Native query `output:"metadata"` emits only `{path,revision,types,values}` and
  marks the result envelope. Existing select keys, projection aliases, nulls,
  filters/order/counts/groups/diagnostics are unchanged. Unselected values are
  `{}`. `include_body:true` is rejected. Explicit selections can still be large.
- `QueryRecordMaterial::render` is the shared normal/narrow renderer, including
  Base output. Shared projection/selection evaluation also serves local and
  hosted candidates. Simple hosted selections/projections no longer force exact
  document hydration; body/relationship/context requirements still do.
- Cursor output is pinned. Local continuations may omit output or repeat the same
  mode; attempting to change it fails before consuming/releasing state. Hosted
  continuations retain the existing full-query digest contract, which includes
  output. Release remains the existing cursor-only hosted request.
- Contract batches and contract metadata queries are explicitly rejected until
  B5 provides that semantic surface. Native collection approval is unchanged.
  These additions do not narrow collection authorization.

Wire types, SDK overloads, old-authority fallbacks and B1 discovery are owned by
`wb-protocol`; qualification is coordinated in `sdk-review/fleet/WIRE.md`. The
canonical wire commit `c40fc15d` is adopted; batch input is checked against its
closed `ReadInput` before engine semantics, and producer tests decode its batch
and metadata results. Local **v0.3 descriptions** advertise the qualified native
features below; v0.2 descriptions omit them. Hosted advertisement remains off
until the guarded PostgreSQL integration test passes (disposable Docker startup
is currently blocked). File-page feature publication remains the files owner's
integration boundary. Do not infer capabilities from failed requests. Only
qualified **v0.3** native producers may advertise `query-record-revisions-v1`, `read-many-documents-v1`, and
`query-metadata-v1`. v0.2 compatibility rejects the new request modes.

## Release and rollback: projection 9 / hosted plan 13

1. Land/pin the mdbase-rs revision with Connect's format assertion and architecture
   guard set to **9**. The coordinator updates `deploy/docker/mdbase-rs-revision`;
   this implementation does not change that pin or deploy anything.
2. Format 9 adds exact-source revision to the **derived semantic projection JSON**.
   Existing format 8 projections are deserializable but cannot serve format 9
   projection-only queries. Rebuild each collection's projection generation from
   its exact records/resources using the existing projection-indexer `upgrade`
   workflow, after predecessor provider/indexer processes stop serving. New
   generations activate atomically. No SQL schema migration, record rewriting,
   key rotation or control-plane payload migration is introduced by B3/B2.
   This refers to hosted SQL: private local SQLite file caches gain a
   `source_revision` column, and legacy empty-token rows are reindexed before
   revision-bearing query execution. Older engines can ignore that extra column.
3. During transition, existing online-v1 behavior bypasses an incompatible active
   generation for exact fallback. A write unbinds an incompatible generation
   rather than maintaining it with the wrong engine; existing generation data is
   retained. Exact fallback has existing scan/byte/time limits, so availability
   at large cardinalities is not equivalent to indexed performance. Finish and
   verify the rebuild before treating the release as fully qualified at scale.
4. Hosted query plans are **13**, not 12: output shaping and projection-safe
   selection requirements changed. Plans/cursors are not converted in place.
   A predecessor plan fails integrity/version validation on the new engine;
   consumers must restart discovery. Drain/release old cursors before cutover
   where possible. New and old provider processes must not share a plan as if it
   were version-independent. Local process-epoch cursors expire on restart too.
5. This is **not a forward-only payload/database migration**. Rollback to an
   older engine still has exact source records and existing database schema.
   However format 9 generations and plan 13 cursors are **not backward-compatible
   executable derived state**. A rollback must retire/restart those cursors and
   rebuild/rebind projections with the predecessor engine's format (8/plan 12),
   using the same guarded workflow. It must not simply relabel generation JSON.
   Rebuilt generations should not be activated while opposite-version providers
   can continue writing; either version can unbind the other's generation.

## Reproducible transfer measurement

Run `node ~/projects/sdk-review/bench/wb-authority.mjs`; its engine fixture is
`tests/query_metadata_discovery_bench.rs`. It creates 50,000 synthetic Markdown
records, of which 30,000 are annotations with wide fields and 2,048-byte bodies.
Both modes select `source` and `file.path` and return identical paths, types,
revisions and values. Before is ordinary select **with B3 revisions**, after is
metadata output.

| 30,000 rows, 30 × 1,000-row payloads | Ordinary | Metadata |
| --- | ---: | ---: |
| Serialized response bytes | 28,903,371 | 6,181,081 |
| Bytes/row | 963.45 | 206.04 |
| AES-GCM encrypted payload bytes | 28,903,851 | 6,181,561 |
| Base64url ciphertext bytes | 38,538,481 | 8,242,082 |

Reduction: **78.61%**, without client stripping. Complete responses come from the
real canonical evaluator/renderer; page envelopes are re-framed for encryption
size measurement. Synthetic keys/AES-GCM are real, but relay framing/signatures,
network/SDK latency, hosted database execution, CPU comparisons and browser long
tasks are not measured. Full evidence/caveats are in `wb-authority-results.json`.
