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
updated_at: 2026-08-04T22:36:55+10:00
progress_summary: The immutable beta.31 candidate set is packaged from Connect commit 79c6e43267d6 after Editor integration exposed and closed a missing request-ID binding on unknown outcomes. mdbase Editor is migrated and committed at 8ef38b9 with all required local gates green. Workouts is next; Pickle and TaskNotes remain on their prior artifacts.
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
- The final artifact source is Connect commit
  `79c6e43267d6fe9ef799768f999dd47b366a2101`. Its six beta.31 packages and
  SHA-512 hashes are recorded in the generated candidate manifest.
- Editor integration found that `operation_outcome_unknown` did not always
  include the durable request ID. Commits `51bc556` and `79c6e43` bind that
  problem to `details.request_id`, update generated protocol contracts, and
  keep all fixtures type-valid.
- mdbase Editor commit `8ef38b9` consumes the exact candidate artifacts. Its
  229 unit tests, 42 Playwright tests, typecheck, build, bundle/CSP checks, and
  manifest validation pass. Rename, delete, and type-pack response-loss paths
  resume the exact stored request ID.

## Next

Migrate mdbase Workouts to the same `79c6e43267d6` artifact set, thread its
repository and sheet lifecycles through request options, make cache refresh
generation-aware, and prove its ordinary and Connect-specific gates.
