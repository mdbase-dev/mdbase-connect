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
updated_at: 2026-08-05T00:07:29+10:00
progress_summary: The replacement beta.32 candidate is packaged from Connect commit 8edc7b327c2a after Workouts dogfood closed full-collection capability and contract-projection defects. Workouts is migrated and fully green at f61217f against that exact candidate. Editor's API migration remains green at 8ef38b9 but must be repinned from the superseded beta.31 artifacts; Pickle and TaskNotes remain on their prior artifacts.
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
- The replacement artifact source is Connect commit
  `8edc7b327c2a62127e8757dabce483e5869c24b3`. Its six beta.32 packages and
  SHA-512 hashes are recorded in the generated candidate manifest.
- Editor integration found that `operation_outcome_unknown` did not always
  include the durable request ID. Commits `51bc556` and `79c6e43` bind that
  problem to `details.request_id`, update generated protocol contracts, and
  keep all fixtures type-valid.
- mdbase Editor commit `8ef38b9` completed the API migration against the now-
  superseded beta.31 artifacts. Its
  229 unit tests, 42 Playwright tests, typecheck, build, bundle/CSP checks, and
  manifest validation pass. Rename, delete, and type-pack response-loss paths
  resume the exact stored request ID.
- Workouts integration found two authority defects instead of papering over
  them in the consumer. Commit `79176cc` makes full-collection access satisfy
  semantic contract capabilities, while `8edc7b3` translates explicit portable
  contract selectors under full access in both local and hosted dispatch.
- mdbase Workouts commit `f61217f` consumes the exact `8edc7b327c2a` Connect and
  protocol artifacts. It uses bounded/cancellable reads and writes, generation-
  aware shared scans, durable unknown-write recovery, explicit definition
  review, and an isolated HTTPS Connect dogfood path. Offline install reported
  zero vulnerabilities; typecheck, 24 unit tests, manifest verification,
  production build, 10 browser tests, and the real authorize/read/create/pause
  dogfood test are green.
- The earlier beta.31 and `48af56d` beta.32 candidate directories are retained
  only as immutable rejected evidence. They are superseded and must not be
  copied into another consumer.

## Next

Repin mdbase Editor from the superseded beta.31 files to the final
`8edc7b327c2a` beta.32 artifacts and rerun its artifact-sensitive gates. Then
migrate Pickle and TaskNotes to that same immutable set.
