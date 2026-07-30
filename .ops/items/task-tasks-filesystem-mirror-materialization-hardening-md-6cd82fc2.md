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
remote_updated_at: 2026-07-30T22:20:17+10:00
last_seen_remote_updated_at: 2026-07-30T22:20:17+10:00
local_status: done
priority: critical
difficulty: hard
risk: high
owner: codex
tags: [security, sync, filesystem, portability, testing, performance]
sync_state: clean
last_analyzed_at: 2026-07-30T22:20:17+10:00
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

A follow-up review found that physical-path aliases were still snapshot-only
and that the container engine pin had not advanced. Incremental change pages
now preflight atomically, individual materialization and writable capture
recheck the invariant, durable state rejects aliases, and the engine pin and
server-first prerelease rollout documentation are current.

The refined preflight initially simulated transitions that the apply loop can
defer for conflicts or malformed local files. It now preserves those records'
occupied paths for the whole page. Same-record case-only and Unicode-equivalent
renames are deferred until a recoverable cross-platform rename transaction is
designed; they fail before any write just like aliases owned by another record.

The TypeScript mirror orchestrator was reduced from more than 1,000 lines to
682 by extracting integrity, local capture, physical-path, materialization, and
rebuild responsibilities. Both runtimes use named materialization options.
Performance, mobile, workspace, sync E2E, PostgreSQL provider E2E, and the
pinned locked Docker build all pass.

## Handoff

Completed through `7b99485`. All listed validation gates pass.
The pinned engine commit
`8f72aeb75ec98ca8ff2ae9849bd1fc107f2504f2` is published on
`origin/agent/exquisite-codebase`, and a clean container build resolved and
compiled it. Unrelated prerelease release-readiness risks retain their existing
status.
