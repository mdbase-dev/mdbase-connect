# Local filesystem runtime adoption

Connect's v0.3 local-authority path treats `CanonicalOperationOutcome` as the authoritative semantic result from request execution through prepare, commit, durable claim resolution, and generation-pinned query cursors. `ExecutionOutcome::operation` and `ChangeSet` remain the source of committed facts and feed evidence. The compatibility `OperationResult` envelope is produced by the single `v03_operation_result` adapter when a Connect response is formed.

Contract authorization resolves the grant before reading a record. Scoped update, delete, and rename first complete request mapping plus selector, path, and control-field validation without record access. They then acquire the executor's mutation gate once and hold it continuously across the typed preflight read, record/type authorization, revision binding, prepare, commit, resolution, and local acknowledgement. When the caller omits `if_revision`, the internal runtime request is bound to the preflight record revision without changing the outward request or response envelope. Explicit caller CAS remains authoritative. Query cursors retain and page `CanonicalOperationOutcome` values. Contract projection happens only after typed scope validation.

## Deliberately retained seams

- `registry/operation_setup.rs` consumes `OperationResult` only for collection/type-pack setup wire-only families.
- `registry/operations.rs` and the legacy helpers in `registry/scope.rs` retain JSON envelope inspection for explicit v0.2 compatibility. They are not used by coordinated v0.3 record execution.
- `connect-hosted-provider` remains on its existing `OperationResult`, `Collection`, and v0.3 facade implementation. Phase 4 only adapts public mdbase field/API changes required to compile it.
- The Docker mdbase source revision remains unchanged until the mdbase branch is published.

New local v0.3 code must not read deprecated `ExecutionOutcome::result` or `CommitRejection::result`, recover typed records with `serde_json::from_value`, or inspect `/result/frontmatter` and `/result/types`. Exact encrypted response and durable receipt envelopes remain protocol compatibility artifacts at the agent boundary.
