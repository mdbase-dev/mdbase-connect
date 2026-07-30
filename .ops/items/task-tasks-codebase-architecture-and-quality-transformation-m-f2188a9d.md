---
id: local:task:tasks/Codebase architecture and quality transformation.md
provider: local
kind: task
key: tasks/Codebase architecture and quality transformation.md
external_ref: tasks/Codebase architecture and quality transformation.md
target_path: tasks/Codebase architecture and quality transformation.md
remote_title: Codebase architecture and quality transformation
remote_state: in_progress
remote_url: tasks/Codebase architecture and quality transformation.md
remote_updated_at: 2026-07-30T12:11:30+10:00
last_seen_remote_updated_at: 2026-07-30T12:11:30+10:00
local_status: in_progress
priority: critical
difficulty: complex
risk: high
owner: codex
tags: [architecture, maintainability, security, testing, ci, documentation]
sync_state: clean
last_analyzed_at: 2026-07-30T12:11:30+10:00
type: item_state
---

## Summary

Transform MDBASE Connect into the agreed ideal modular, maintainable, secure,
well-tested, and operationally disciplined pre-release codebase.

## Analysis

The repository has strong system boundaries and broad behavioral tests, but
rapid feature delivery concentrated control-plane routes, client behavior,
local registry concerns, and hosted-provider behavior into four oversized
files. The refactor must improve change locality without weakening exact-grant
authorization, transaction atomicity, protocol compatibility, or the
control-plane privacy boundary.

## Plan

Follow the ten-phase plan in the linked task, committing and validating each
cohesive extraction independently.

## Notes

The original checkout contains unrelated uncommitted desktop changes and is
intentionally left untouched. This work runs from a clean `origin/main`
worktree.

The baseline, architectural quality contract, no-growth budgets, cycle checks,
clean-checkout package prerequisites, strict Rust CI, and first database
boundary extraction are complete. The control-plane composition root has
dropped from 8,738 to 6,840 lines as system, authentication, session, pairing,
connector-management, inventory, and shared platform boundaries were
extracted. The server suite passes 188 tests across 41 files and all
language-level checks remain green.

## Handoff

Resume from the earliest incomplete phase in the task record. Before changing
behavior, inspect the most recent commit, status, task notes, and test results.
