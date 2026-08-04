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
updated_at: 2026-08-05T08:49:15+10:00
progress_summary: Phase 6 is independently green and the rollout gate is open. The immutable candidate is Connect e1c1f49cca00 with four exact-artifact consumer draft PRs. Next is guarded staging activation, compatibility and rollback proof, canaries in Workouts-Editor-Pickle-TaskNotes order, privacy-safe observation, and the final external-beta audit.
type: task
---

# Beta hardening 10 - rollout and beta gate

## Outcome

Stage the coordinated breaking release train, prove contract-aware activation
and whole-train rollback, canary Workouts, Editor, Pickle, then TaskNotes with
privacy-safe observation, and satisfy every external-beta invitation gate.

## Gate state

Opened 2026-08-05 after delivery slice 9 closed green. Production remains
untouched. Staging must activate the complete release train behind explicit
contract-aware readiness, prove whole-train rollback, and retain the documented
canary order before any external-beta invitation.
