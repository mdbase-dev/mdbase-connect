# Sync execution responsibility map

This map freezes the residual exact-document implementation before the
plan-only executor cut-over. It is an implementation constraint, not a
description of an acceptable permanent architecture.

| Existing location | Existing decision or effect | Future owner |
| --- | --- | --- |
| TypeScript `DirectoryMirrorPlanner.inspectSnapshot` | Compare exact local and authority bytes; choose local collision, write, move, delete, and initial upload outcomes | Inspector observes bytes and ownership; Planner chooses every outcome |
| TypeScript `DirectoryMirrorPlanner.inspectIncremental` | Capture local edits, merge pending work and change pages, mark conflicts, and choose projected actions | Inspector captures immutable facts and payloads; Planner constructs the closed action list |
| TypeScript `DirectoryMirror.applyUnlocked` | Re-inspect, compare fingerprint, invoke a nested sync, infer completion from status | Revalidator creates a validated lease; Orchestrator invokes Executor and Checkpoint only |
| TypeScript `DirectoryMirror.syncUnlocked` | Discover work, rebuild, capture, upload, interpret receipts, apply remote events, skip echoes, and advance cursors | Planner owns choices; Executor dispatches commands; Journal records receipts; Checkpoint advances only after effects complete |
| TypeScript `rebuildMirror` | Re-check collisions while materializing and build checkpointed state | Inspector validates; Executor materializes named actions; Checkpoint publishes the prepared state |
| TypeScript `flushPending*` | Re-read current paths, choose mutation order, interpret receipts, mutate state | Revalidator checks revision-bound payloads; Executor sends exact commands; Journal persists typed receipts |
| Rust `DirectoryMirror::inspect_snapshot` | Observe and decide snapshot reconciliation in one method | Inspector plus pure Planner |
| Rust `DirectoryMirror::inspect_incremental` | Capture local changes, fetch changes, and choose actions | Inspector plus pure Planner |
| Rust `apply_fingerprint` / `apply_current_unlocked` | Re-inspect and call `sync_unlocked` | Revalidator plus thin Orchestrator |
| Rust `sync_unlocked` | Rebuild, capture, upload, consume change pages, resolve deferrals, and checkpoint | Executor, Journal, and Checkpoint, operating only on planned commands |
| Rust `apply_rebuild` | Materialize a broad durable rebuild plan with internal branching | Command-only Executor |
| Rust `flush_pending` | Validate mutable local state, issue remote mutations, interpret receipts, and checkpoint periodically | Narrow action preconditions, Executor, and Journal |

The cut-over is complete only when the old orchestration entry points are
deleted and architecture checks prevent executor modules from importing
inspector or planner implementations.

## Required phase boundaries

1. `sync-inspection` returns an immutable content-free summary and a private,
   revision-bound payload set.
2. `sync-planner` is a pure function and is the only production module allowed
   to construct actions.
3. `sync-plan-codec` canonicalizes and fingerprints the complete decision.
4. `sync-revalidation` checks the global lease and each narrow precondition.
5. `sync-executor` dispatches the ordered actions and cannot inspect or plan.
6. `sync-journal` owns `prepared -> applying -> effects_complete` transitions.
7. `sync-checkpoint` is the only module that publishes the next cursor.
8. `sync-status` projects durable state for every consumer.
