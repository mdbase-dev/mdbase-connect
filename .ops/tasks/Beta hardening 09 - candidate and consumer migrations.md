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
updated_at: 2026-08-04T21:58:03+10:00
progress_summary: The candidate SDK surface and package audit are green at Connect commit 0e6f95b; the in-repo Editor already uses connect.application(). No candidate artifacts have yet been generated or copied into the four canonical consumer checkouts. Next is to finish the management presentation gate, package one exact artifact set, record its source commit, then migrate Editor, Workouts, Pickle, and TaskNotes in order.
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
- Artifact generation is deliberately deferred until the remaining management
  UX test matrix is green, so all consumers receive one stable source commit.

## Next

Run `pnpm package:consumer`, record the source commit and artifact suffix, then
migrate the canonical Editor checkout first without mixing package builds.
