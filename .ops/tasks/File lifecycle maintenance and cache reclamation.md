---
title: File lifecycle maintenance and cache reclamation
status: in_progress
priority: critical
owner: codex
tags: [files, hosted, mirror, selective-sync, maintenance, reliability]
created_at: 2026-08-01T21:04:40+10:00
updated_at: 2026-08-01T21:04:40+10:00
type: task
---

## Context

Three remaining lifecycle gaps can cause excluded content to materialize or
storage to grow indefinitely: excluded-folder matching does not use portable
path identity, ordinary hosted uploads expire only when touched, and
content-addressed mirror blob caches have no reclamation pass.

## Desired outcome

Keep Rust and TypeScript mirror selection semantics identical, recover
abandoned hosted transfers through bounded durable maintenance that is safe
against commit races, and prune mirror caches from an explicit durable
reference set without weakening crash recovery.

## Plan

1. Normalize folder and candidate paths before component-aware exclusion checks
   in both mirror implementations, with case and Unicode alias tests.
2. Add bounded ordinary-transfer recovery to hosted maintenance, using durable
   cleanup intent and adversarial commit/expiry coverage.
3. Add a cache-pruning contract and implementations that retain current,
   pending, and recovery-plan digests under the mirror lease.
4. Run focused and full verification and record exact evidence here.

## Handoff

Work is active in the isolated `agent/file-support` worktree. Preserve the
existing adversarial lifecycle harness as the scheduling boundary.
