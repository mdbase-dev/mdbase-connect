---
title: Beta hardening 10 - rollout and beta gate
status: open
priority: critical
owner: codex
parent: SDK and authority beta hardening
delivery_slice: 10
phase: 7
depends_on: [Beta hardening 09 - candidate and consumer migrations]
tags: [beta, deployment, canary, observability, rollback]
created_at: 2026-08-04T17:48:28+10:00
updated_at: 2026-08-05T09:58:36+10:00
progress_summary: Waiting for delivery slice 9 to reclose after the independent-contract audit invalidated e1c as a release candidate. Production and staging remain untouched. Resume only with one immutable post-correction Connect commit and four exact-artifact consumer repins, then perform guarded activation, rollback proof, ordered canaries, observation, and the final audit.
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
