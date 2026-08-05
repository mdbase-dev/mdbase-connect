---
title: Beta hardening 10 - rollout and beta gate
status: in_progress
priority: critical
owner: codex
parent: SDK and authority beta hardening
delivery_slice: 10
phase: 7
depends_on: [Beta hardening 09 - candidate and consumer migrations]
tags: [beta, deployment, canary, observability, rollback]
created_at: 2026-08-04T17:48:28+10:00
updated_at: 2026-08-05T22:23:00+10:00
progress_summary: Delivery slice 9 and both expanded successor tasks are complete. Phase 7 is ready to stage immutable beta.33 source 55b536aafa9a1ae1031171fa7e39ae99fa4530f0 with exact consumer heads Editor eb48e42, Workouts fa5684c, Pickle 5e3cbe0, and TaskNotes 6febc15. No deployment or database change has occurred. Next: exact artifact/image audit, recovery checkpoint, guarded staging activation, rollback exercise, ordered canaries, privacy-safe soak, final audit, and only then the external-beta invitation decision.
type: task
---

# Beta hardening 10 - rollout and beta gate

## Outcome

Stage the coordinated breaking release train, prove contract-aware activation
and whole-train rollback, canary Workouts, Editor, Pickle, then TaskNotes with
privacy-safe observation, and satisfy every external-beta invitation gate.

## Gate state

Initially opened 2026-08-05, then returned to `open` when the compatibility
audit reopened delivery slice 9. Production and staging remain untouched.
Staging must activate the complete release train behind explicit contract-aware
readiness, prove whole-train rollback, and retain the documented canary order
before any external-beta invitation.

## Ready-to-activate evidence — 2026-08-05

- Source and every consumer worktree are clean and pushed; exact artifact
  verification is green across all four applications.
- Connect's complete Rust/JavaScript, architecture, release-readiness, package,
  performance, and system gates are green at the frozen source commit.
- Consumer gates are green through TaskNotes' fresh relay-backed setup and
  durable response-loss/reload proof, including both Android emulator smokes.
- The beta.33 server/connector pair has been exercised locally with an isolated
  database, broker, account, connector, and collection. This is test evidence,
  not a staging or production activation.

The next action is the single production-shaped deployment workflow requested
by the user. Preserve the old stack and verified database checkpoint as the
rollback target before activating any schema that it cannot reopen.
