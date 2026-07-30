---
id: local:task:tasks/Filesystem mirror materialization hardening.md
provider: local
kind: task
key: tasks/Filesystem mirror materialization hardening.md
external_ref: tasks/Filesystem mirror materialization hardening.md
target_path: tasks/Filesystem mirror materialization hardening.md
remote_title: Filesystem mirror materialization hardening
remote_state: done
remote_url: tasks/Filesystem mirror materialization hardening.md
remote_updated_at: 2026-07-30T19:03:42+10:00
last_seen_remote_updated_at: 2026-07-30T19:03:42+10:00
local_status: done
priority: critical
difficulty: hard
risk: high
owner: codex
tags: [security, sync, filesystem, portability, testing, performance]
sync_state: clean
last_analyzed_at: 2026-07-30T19:03:42+10:00
type: item_state
---

## Summary

Close the residual first-contact trust gaps in filesystem mirror
materialization without weakening portability, maintainability, mobile
compatibility, or performance.

## Analysis

The authority is entitled to describe collection semantics, but it must not be
able to expand the set of filesystem objects a remote mirror may create.
Document-bearing snapshots also cross a trust boundary: paths, stable
identities, revisions, exact source, parsed metadata, and page boundaries must
agree before any write. Case and Unicode aliases must be evaluated against the
most conservative supported filesystem rather than the filesystem currently
running the client.

## Plan

Use a fixed remote `.md` ceiling, centralize snapshot preflight, share the
portable path corpus between Rust and TypeScript, align writable preview with
capture, derive revisions from exact document bytes, and run the full static,
unit, performance, live-vault, sync, and PostgreSQL provider matrices.

## Notes

The sync-specific E2E initially failed after hardening because both hosted
template implementations used the stale label `mdbase-config:1` for exact
configuration bytes. The TypeScript reference authority and Rust hosted
provider now derive the resource revision from the document, and the same E2E
passes.

## Handoff

Completed in `bd10d21`. All listed validation gates pass. No reviewed
materialization blocker remains; unrelated prerelease release-readiness risks
retain their existing status.
