---
title: Beta hardening 09 - candidate and consumer migrations
status: in_progress
priority: critical
owner: codex
parent: SDK and authority beta hardening
delivery_slice: 9
phase: 6
depends_on: [Beta hardening 06 - management correctness, Beta hardening 07 - public SDK surface]
tags: [beta, packaging, consumers, editor, workouts, pickle, tasknotes]
created_at: 2026-08-04T17:48:28+10:00
updated_at: 2026-08-04T22:13:17+10:00
progress_summary: Phase 5 is complete at Connect commit c78c22a, including the remaining management presentation and race matrix. No candidate artifacts have yet been generated or copied into the four canonical consumer checkouts. Next is to package this exact source commit, record the artifact suffix and hashes, then migrate Editor, Workouts, Pickle, and TaskNotes in order.
type: task
---

# Beta hardening 09 - candidate and consumer migrations

## Outcome

Build one candidate artifact set from one Connect commit, then migrate and
prove Editor, Workouts, Pickle, and TaskNotes in implementation order with
durable response-loss recovery and every product-specific gate.

## Current state

- The actual SDK root, rather than a parallel candidate declaration, compiles
  all four consumer spikes and their removed-API assertions.
- Workspace package audit and the in-repo Editor build/tests are green.
- The management UX matrix is complete and commit `c78c22a` is ready to be
  treated as the artifact source candidate.

## Next

Run `pnpm package:consumer` from commit `c78c22a`, record the source commit,
artifact suffix, and hashes, then migrate the canonical Editor checkout first
without mixing package builds.
