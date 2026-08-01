---
id: local:task:tasks/First-class collection file support.md
provider: local
kind: task
key: tasks/First-class collection file support.md
external_ref: tasks/First-class collection file support.md
target_path: tasks/First-class collection file support.md
remote_title: First-class collection file support
remote_state: in_progress
remote_url: tasks/First-class collection file support.md
remote_updated_at: 2026-08-01T12:40:38+10:00
last_seen_remote_updated_at: 2026-08-01T12:40:38+10:00
local_status: in_progress
priority: critical
difficulty: complex
risk: high
owner: codex
tags: [files, protocol, sdk, encryption, sync, mirrors, hosted, infrastructure, testing]
sync_state: clean
last_analyzed_at: 2026-08-01T12:40:38+10:00
type: item_state
---

## Summary

Build production-quality first-class collection file support across local and
hosted authorities, application SDKs, encrypted transport, replication,
filesystem mirrors, authority transfer, desktop controls, and deployment.

## Analysis

The current record operation envelope and replication model intentionally
carry UTF-8 Markdown and bounded JSON. Treating arbitrary files as records
would weaken filesystem materialization policy, while base64 payloads would
couple large transfer limits and memory behavior to the operation protocol.
The safe design is a logical file namespace with stable metadata and one
authoritative change history, backed by a separate staged binary data plane.

Breaking changes are acceptable before release. This permits namespaced,
independently versioned capabilities and wire contracts instead of extending
the current flat operation list into a permanent cross-domain API.

## Plan

Specify executable cross-runtime contracts first, implement local direct and
relay behavior as the first complete vertical slice, add hosted storage and
infrastructure, then extend sync, mirrors, transfer, product controls, and
release verification. Keep commits reviewable and preserve full test evidence
in the corresponding task record.

## Notes

The primary repository checkouts contained unrelated user changes and are not
being used for implementation. Dedicated worktrees and branches were created
from their current HEAD commits.

The isolated baseline is fully green across Rust, Node 24, architecture,
generated schemas, and registry validation. `docs/files.md` now owns the
foundational design and the existing architecture, encryption, sync, and threat
model documents point to it.

## Handoff

Current next step: write and validate the architecture decision and protocol
fixtures, including the precise capability, file metadata, transfer, mutation,
change, snapshot, and error shapes.
