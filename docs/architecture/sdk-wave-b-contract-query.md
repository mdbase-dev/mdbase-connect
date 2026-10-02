# Wave B B5: Contract bodies and filters within the approval boundary

Status: proposed; security review required before implementation. Depends on
[B1](sdk-wave-b-capability-negotiation.md); B2/B3 integration follows their shared
row/read contracts. Baseline/provenance: B1. This does **not** revive type-scoped grants.

## Current behaviour and the important correction

The survey's “contract-only approval” terminology predates the current decision.
[ADR 0012](../decisions/0012-collection-level-application-authorization.md) and
`PRODUCT.md` make the collection the data boundary. Contracts are compatibility /
semantic views, not record authorization. ADR 0013 makes action groups immutable.

Evidence at this baseline:

- Local `crates/connect-core/src/registry/operations.rs::resolve_operation_contract_scope_loaded`
  constructs ContractScope from collection resources only when an operation has a
  portable selector. It is not deriving a selective visibility grant.
- Hosted `crates/connect-hosted-provider/src/provider/operation_dispatch.rs::contract_scope`
  first calls `ensure_canonical_application_replica`; provider
  `capabilities.rs` rejects non-full-collection/nonempty legacy scope. A historical
  scoped credential must be rejected/revoked, never silently widened.
- `crates/connect-runtime/src/contract_scope.rs:105–137` admits only provider
  selection/pagination/frontmatter mode. `project_record` delegates normalized
  values to mdbase-rs, builds identity and path/types/revision, and strips body,
  document and other file facts. Its mapped writes also reject body/document.
- mdbase-rs `src/data_contracts` owns projection, field references, validation and
  mapping (`project_resolved_record_contract`). Local and hosted share Connect's
  allowlist/projector today; neither merely needs a TypeScript flag removed.
- Protocol `packages/protocol/src/index.ts::RecordDocument` says body is omitted
  from contract-scoped results; client `src/operation-types.ts` documents restricted
  queries while `src/collection-client.ts` still forwards invalid combinations.
  Update that wording to semantic projection, not a second grant model.
- Reports: Writer queries raw implementing types then maps fields; Reader uses
  starter annotation fields and point reads; TaskNotes builds per-provider models.
  Editor already uses normalized contract queries; MCP forwards generic query keys.

## Decision and proposed API/wire

A collection-read approval already permits record bodies in that collection.
`contract-query-v1` permits **body reads of records selected by a semantic view**,
not a claim that their bodies contain only contract data. Consent remains “Entire
collection — read”; no new hidden approval flag or type-derived security state.
Contracts with sensitive unrelated prose must live in a separate collection if the
user wants isolation. New capability support never implies action permission.

Allow `include_body:true` on contract read/query and B3 batch read. Return the usual
contract identity and normalized frontmatter, plus **the complete Markdown body of
that same source revision**. Never relabel it “contract-owned body”. Continue to
reject `include_document:true` on semantic views: exact document includes unmapped
frontmatter and is not a contract-shaped result. An approved collection reader can
explicitly perform a native point read for that document. Contract body mutations
remain rejected; this item does not alter mapped-patch or write authority.

Add `contract_filter`, a bounded typed predicate tree, not raw CEL rewriting:

```json
{"contract":{"id":"dev.example.task","version":"1.0.0","type":"custom-task"},"contract_filter":{"all":[{"field":"/status","op":"eq","value":"open"},{"field":"/due","op":"lt","value":"2026-10-03"}]},"include_body":true}
```

V1 language: `all`/`any` arrays, `not`, and schema-declared JSON-Pointer leaves with
`eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `in`, `exists`. Require exactly the keys for
each variant; `in` is scalar membership in a literal list. Missing/null/type and
comparison rules belong to mdbase-rs, shared with its normalized query evaluation:
missing comparisons do not match; explicit null equality is distinct; `exists`
means present, including null; incompatible ordered types are invalid input, not
string coercion. Enforce depth ≤8, nodes ≤128, `in` length ≤100, plus existing query
budgets. Validate literals against schema, including date representation. Pointer
escaping and nested/literal-dot fields use mdbase field references.

Contract queries reject native `where`, `context`, expressions/projections, group /
summary and raw ordering in V1. No field spelling can address `file`, body, raw
frontmatter, implementing-type fields, resource definitions or `this`. B2 select may
name only declared contract pointers; retain path/types/revision/contract identity
in its narrow envelope. Body searching, sorting and resolved-link predicate leaves
are deferred, rather than exposing an accidental raw-CEL escape. Native approved
queries retain today's richer language. Without `contract`, `contract_filter` is
invalid. Return existing semantic invalid-input diagnostics, not new scope states.

mdbase-rs compiles a contract plan from exact contract schema/implementation
identity, projects effective fields **before** predicates/pagination, and exposes a
shared local/hosted evaluation contract. Simple pushdown may use its certified plan;
SQL/client code cannot substitute raw-field filtering (defaults, coercion and computed
fields may differ). Body bytes are loaded only for included page records. Ambiguous
providers require exact `type`; do not pick one or duplicate one record silently.
Count/limit/cursor operate on included normalized records. Cursor pins selector,
filter, output mode and catalog/implementation digests; incompatible catalog changes
produce existing cursor reset/expiry, never reinterpret a continuation. Per-record
projection failures remain explicit diagnostics, not “missing because unauthorized”.

## Threat analysis and approval matrix

| Threat | Required control |
| --- | --- |
| Raw-field inference via predicate, order, projection, diagnostics or counts | Closed normalized AST; reject undeclared paths before evaluation; errors identify caller field, not underlying secret values/mappings. Counts cover only valid selected semantic records. No raw expression backdoor. |
| Traversal through `asFile`, `this`, backlinks or resource metadata | No such nodes in V1 contract filters/select. A future traversal contract needs separate versioned design; B6 alone does not authorize it here. |
| Body contains unrelated/sensitive prose | Explicit full-body semantics and collection-wide consent; never promise type isolation. No body delivery without read approval. |
| Mixed provider types, defaults or mapping drift change visibility | mdbase-owned projection/validation, explicit ambiguity, catalog-bound cursor; contract membership is query semantics, not grant scope. |
| New SDK on legacy scoped daemon accidentally discloses more | Refuse scoped sessions; require explicit ordinary collection-wide reauthorization, never retry natively or request broader consent automatically. |
| Revocation / delayed results / batch / relay bypass | Authority checks current exact operation grant, origin and epoch/lease; check authorization at cursor use and before delivery. No service/client-supplied type list substitutes for a grant. |
| Resource exhaustion / expensive normalization | Validate bounded tree before work; existing admission, CPU/bytes/cursor limits and cooperative cancellation; no unbounded full-query fallback inside authority. |
| Payload leakage to control plane/logs | Bodies and projected values stay at data authority/application; content-free errors/telemetry, collection-relative paths only on authenticated data channel. |

An app that declares only a contract requirement and has **no** collection-read
capability may discover setup/readiness as its approved setup operations permit;
it may not read/query bodies, normalized records, metadata rows or arbitrary files.
A contract requirement is not an action grant. An app with collection-read and that
requirement may use the view and also read/query **all records** natively, even ones
not implementing the contract; it may not mutate without explicit create/edit/delete
approval or read binary bytes without file-read scope. A historical app approved
only for selective contract data may see **nothing through a retired credential**:
reauthorize, rather than treating this body feature as an upgrade of its grant.
A canonical contract view does not expose unmapped frontmatter/document implicitly,
but this is an API projection invariant, not protection against its approved native
read. Denying body in the view would not create real isolation under ADR 0012.

## Consumer migration and fallback

On absent B1 flag, canonical collection readers retain existing semantic pagination
and client-side normalized filtering; body reads use bounded native point reads for
selected paths. Raw implementing-type workarounds may remain explicitly for Writer /
TaskNotes/Reader until the new view meets their semantics; they must verify provider
identity and use mdbase-authoritative normalized fields, not invent mapping rules.
Never fallback from a denial or malformed filter. Remove those compatibility paths
only under B1's authority/adoption/rollback gate **and** per-consumer parity tests.

- Writer: migrate annotations/comments first; bodies and scalar predicates become
  canonical. Source-resolution/reply compiler policy and mapped writes stay until
  a separately supported link predicate/write facade replaces them.
- Reader: custom annotation provider listing and ordered body batches; retain legacy
  SourceId acceptance and native resolved-link query until traversal is designed.
- TaskNotes: canonical task predicates/bodies, retaining provider binding/path/recurrence
  model and RMW locks; resolved assignee query remains native in V1.
- Editor: contract list predicates can move server-side; generic property editing,
  Person/Contact lossless raw writes and definition UI are unaffected.
- MCP: expose typed `contract_filter` and document accepted contract keys; do not
  imply its generic CEL passthrough is allowed in a semantic view. Obsidian unaffected.

## Tests and size

L, 8–15 engineer-days plus independent security review. Differential local/hosted
projection→filter→page tests across custom mappings, defaults, null/missing, pointer
escapes, multiple providers, invalid records and catalog drift; exact body/revision
pairing with B3. Attack corpus for every rejected raw key/node, nested AST exhaustion,
indirect computed-field semantics and error-content leakage. Approval matrix: no read,
collection-read/no files, full files, denied mutations, legacy scoped, revoked/expired
and changed-origin grants over direct/relay/hosted; zero effects/disclosure on denial.
Test cursor replay after revocation and schema drift, old-authority non-probing fallback,
and consumer custom-type parity. Request-path e2e is mandatory on implementation.
