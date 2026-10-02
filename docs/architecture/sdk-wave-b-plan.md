# SDK Wave B: Design index and implementation split

Status: proposed; docs-only phase. No runtime, public API or persisted representation
has changed. Evidence baseline: Connect `dfc28fd9`, read-only shared mdbase-rs
`sdk-upgrade/authority` at `f60adfe`; consumer/benchmark reports under
`~/projects/sdk-review/reports` describe older working trees. Source inspection is
not deployed compatibility qualification or a newly executed benchmark.

## Dependency order

| Order | Design | Reason |
| --- | --- | --- |
| 1 | [B1: authority feature negotiation](sdk-wave-b-capability-negotiation.md) | Every authority-dependent input needs positive selected-authority evidence. Reuse capability strings, not a new grant taxonomy. |
| 2a | [B3: revisions and document batches](sdk-wave-b-query-revisions.md) | B2's narrow row requires a source revision; enables Reader/TaskNotes stage-2 hydration. |
| 2b | [B4: files.stat](sdk-wave-b-file-stat.md) | Independent file-list effect and protocol; parallel with B3. |
| 2c | [B6: link rules/options](sdk-wave-b-link-resolution.md) | Rules/fixtures can start immediately; options ship after B1. |
| 3 | [B2: narrow output](sdk-wave-b-narrow-query-output.md) | Integrates B3 source revisions and existing select, rather than inventing a second field selector. |
| 4 | [B5: contract bodies/filters](sdk-wave-b-contract-query.md) | Security decision first; integrates B2/B3. No traversal language in V1, so B6 implementation is not a blocker. |

B5 security review and mdbase normalized-filter planning can run at order 1, but
shipping follows collection-approval, capability and row/batch qualification.
B6 scope means eligible target types, not a type-based approval boundary. B4 batch
stat, shared generation pins, contract body writes, raw contract CEL, alias lookup
options and a general offline SDK resolver are intentionally deferred.

## Agent ownership (proposed assignments, not worktree permission)

| Agent | Repositories / owned files | Parallelism and merge gate |
| --- | --- | --- |
| `sdk-protocol` | Connect `packages/protocol/src`, protocol schemas/catalog generation as needed, `crates/connect-protocol`; B1 discovery and all opt-in wire fixtures | Single owner for shared wire definitions; land B1 first, then small B3/B4/B2/B5 additions coordinated with semantics. Do not expand immutable action groups. |
| `sdk-authority` | mdbase-rs `src/api`, `src/query/{canonical,cache_source}`, hosted runtime row types/plans; B3 then B2 | Sole writer to the currently shared authority worktree **only after coordinator authorization**. Current phase remains read only. B3/B2 share candidates/renderers and should not be parallel overlapping PRs. |
| `sdk-contract-semantics` | Separate coordinator-created mdbase-rs worktree: `src/data_contracts`, contract query plan/evaluation and semantic conformance fixtures | B5 security review/compiler work can proceed alongside B3, integrating row API only after its contract lands. Semantics stay in mdbase-rs. |
| `sdk-link-semantics` | Separate mdbase-rs worktree: `src/links`, `src/cel`, `src/runtime/record_resolution.rs` and spec/conformance fixtures | Parallel rules/fixtures and CEL options; coordinate common hosted query-plan types with authority owner. No changes to default graph policy. |
| `sdk-record-authorities` | Connect `crates/connect-core/src/registry/{operations,operation_execution}`, `crates/connect-runtime/src/contract_scope.rs`, hosted `provider/operation_{dispatch,reads,queries}` | Adapter work after engine API/wire agreement. One owner for local/hosted row renderers; no independent semantic implementation. B5 removes/replaces allowlist/projection staging, not a parallel semantic engine. |
| `sdk-files` | Connect `crates/connect-core/src/{collection_files,registry/files}`, `crates/connect-agent/src/server/files.rs`, hosted `provider/files` and `http/files.rs` | Parallel with record authority work after B1/B4 wire fixture. Reuse file identity/path-token indexes and current actions. |
| `sdk-client` | Connect `packages/client/src/{collection-client,connection,files,operation-types}`, advanced injected transport, testing fixtures; package README/docs/CHANGELOG | Can develop against agreed protocol fixtures in parallel; merge only with positive discovery, old-authority and real-producer tests. Preserve Wave A readMany conventions. |
| consumer agents | Fresh assigned worktrees in Writer, Reader, TaskNotes; Connect editor and MCP worktrees | After published SDK/provider qualification: Writer reference migration first, then editor/Reader/TaskNotes in parallel; MCP wire/tool migration separately. No canonical checkout edits. |

This is a logical ownership split, not a requirement to run eight agents at once.
Combine protocol+client and record adapters for a smaller fleet; do not combine away
independent B5 security review. The coordinator creates worktrees, resolves shared
file conflicts, approves PRs and releases; implementation agents do not push/release
without their separate instructions. Current docs author stops after handoff.

## Rollout and acceptance

1. Freeze cross-language fixtures and review B5's collection-wide consent correction
   against ADRs 0012/0013. No new type-scoped authorization design by accident.
2. Implement semantics, then local and hosted adapters; advertise only implemented,
   qualified profile features. Old defaults and exact approved action ceilings remain.
3. SDK uses B1 discovery; mixed old/new authority tests must assert **no error-based
   probing** and no new input sent when unsupported. Each fallback's actual consumer
   and deletion gate are in its item doc. Unsupported extension errors on an advertised
   authority are invariant/compatibility failures, not permission to silently downgrade.
4. Qualify direct, encrypted relay and hosted request paths, revocation/cursor use,
   N-1 response readers, restart/catalog drift and producer semantics. Runtime changes
   run relevant narrow tests, `pnpm ci:local` once and request-path `pnpm e2e`; mdbase
   engine conformance and consumer acceptance are additional gates, not replaced by
   synthetic SDK transport benchmarks. Re-run sdk-review scenarios without altering
   other agents' harness code; add scenario files if needed.
5. Publish protocol/client with README/docs/CHANGELOG/migration notes. Writer adopts
   narrow indexes/document batches and unique source-scoped options; Reader drops N
   point hydration/folder lookups; TaskNotes drops revision rereads but keeps model/RMW
   locks; editor adopts partial summaries/targeted assets while keeping UI/drafts;
   MCP exposes opt-in wire/tool shapes, retaining tenant/OAuth ownership. Obsidian's
   sync track and explicitly legacy Vault resolution remain separate.
6. Delete old paths only after minimum-authority policy, consumer pins, parity evidence
   and bounded N-1/rollback windows all meet B1's removal condition. No payload migration
   or automatic reapproval; legacy selective credentials require ordinary reauthorization.

## Rough size and simplification target

B1 S–M (3–5 days), B3 M–L (6–10), B4 M (4–6), B6 M–L (5–9),
B2 M (4–7), B5 L (8–15 plus security review). These are engineer-day estimates
including focused tests, not commitments; shared protocol/adapter work overlaps and
consumer rollout/qualification is additional. Net replacement targets: app path-CEL
builders for hydration, revision rereads, single-file folder enumeration and raw-type
read workarounds. Keep domain models, compiler/draft indexes, RMW locks, exact-write
recovery, UI suggestions and sync mirrors. Do not add a second authorization model,
query renderer, resolver or persistent feature cache.
