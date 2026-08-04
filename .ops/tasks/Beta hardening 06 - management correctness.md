---
title: Beta hardening 06 - management correctness
status: in_progress
priority: high
owner: codex
parent: SDK and authority beta hardening
delivery_slice: 6
phase: 5
depends_on: [Beta hardening 05 - bounded IO and typed outcomes]
tags: [beta, management, concurrency, user-experience]
created_at: 2026-08-04T17:48:28+10:00
updated_at: 2026-08-04T21:58:03+10:00
progress_summary: Generation-aware refresh discards out-of-order reads; mutations refresh in finally; application revocation uses one validated server batch with local transaction atomicity and exact hosted queue results; management calls are bounded/cancellable and preserve partial failure details. Core server, management, and Editor race/batch tests are green. Remaining gate is the complete double-click, unmount/navigation, offline, upgrade-required, and presentation matrix.
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
- Server 270/270, management 7/7, and Editor 252/252 tests are green after the
  SDK surface changes.

## Next

Complete explicit double-click, navigation/unmount, stale-response,
partial-hosted-failure, connector-offline, and upgrade-required presentation
coverage before closing this slice.
