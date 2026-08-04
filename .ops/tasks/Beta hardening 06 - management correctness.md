---
title: Beta hardening 06 - management correctness
status: done
priority: high
owner: codex
parent: SDK and authority beta hardening
delivery_slice: 6
phase: 5
depends_on: [Beta hardening 05 - bounded IO and typed outcomes]
tags: [beta, management, concurrency, user-experience]
created_at: 2026-08-04T17:48:28+10:00
updated_at: 2026-08-04T22:13:17+10:00
progress_summary: Complete. Management mutations have explicit not-sent versus outcome-unknown semantics, lifecycle cancellation, duplicate suppression, generation-aware refresh, exact partial completion, and persisted connector upgrade-required presentation. The focused management, Editor, and live server matrices are green.
type: task
---

# Beta hardening 06 - management correctness

## Outcome

Make refresh invalidation generation-aware, make revocation atomic or exactly
report partial completion, and prove timeout, cancellation, ordering, unmount,
offline, and upgrade-required presentation.

## Evidence

- Commit `05e9207` contains the generation counter, batch revocation endpoint,
  management outcome handling, and focused Editor/server tests.
- Commit `c78c22a` adds not-sent versus outcome-unknown mutation semantics,
  component-lifecycle cancellation, rapid duplicate suppression, exact partial
  revocation refresh behavior, and durable connector compatibility state.
- Management 9/9, Editor 257/257, and the 18 focused live authorization and
  migration tests are green. Management, Editor, and server typechecks pass.
- The broader server suite remains green at 270/270 from the immediately
  preceding Phase 4/5 verification run.

## Next

Use Connect commit `c78c22a` as the candidate artifact source unless packaging
or consumer verification exposes a defect that requires a new source commit.
