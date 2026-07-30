---
id: local:task:tasks/Codebase architecture and quality transformation.md
provider: local
kind: task
key: tasks/Codebase architecture and quality transformation.md
external_ref: tasks/Codebase architecture and quality transformation.md
target_path: tasks/Codebase architecture and quality transformation.md
remote_title: Codebase architecture and quality transformation
remote_state: done
remote_url: tasks/Codebase architecture and quality transformation.md
remote_updated_at: 2026-07-30T14:56:47+10:00
last_seen_remote_updated_at: 2026-07-30T14:56:47+10:00
local_status: done
priority: critical
difficulty: complex
risk: high
owner: codex
tags: [architecture, maintainability, security, testing, ci, documentation]
sync_state: clean
last_analyzed_at: 2026-07-30T14:56:47+10:00
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
clean-checkout package prerequisites, strict Rust CI, and control-plane
decomposition are complete. The control-plane composition root has dropped
from 8,738 to 351 lines and now only assembles platform plugins, lifecycle
workers, and feature-owned route modules. The client SDK entry point has
dropped from 4,168 to a 66-line facade, with connection transport,
authorization, sessions, notifications, persistence, errors, and collection
operations independently owned. Both legacy size exceptions are removed.
The server suite passes 188 tests, the client suite passes 74 tests, and the
complete workspace build, typecheck, and JavaScript/TypeScript test gate is
green. The local registry is now a 220-line facade over invariant-owned
modules, its scenario coverage is grouped by capability, and local sync
persistence is separated from orchestration. Every core production and test
module is below 1,000 lines, both core legacy size exceptions are removed, and
all 41 core tests plus strict Clippy and architecture checks pass. The hosted
provider is now a 292-line facade over complete transaction-owning feature
modules, with every hosted production and test module below 1,000 lines and
its legacy exception removed. All 24 hosted tests and the 142-test full Rust
workspace gate pass with strict Clippy.

Protocol domains now sit behind a 39-line facade, hosted authority lifecycle
states are closed enums, and CLI daemon targeting explicitly separates the
installed service from isolated profiles. The CLI facade is 732 lines with
focused command, daemon, login, output, and test modules, so its legacy size
exception is removed. Hosted grant and mirror-replica revocation now denies
local authority and queues provider cleanup atomically before any network
attempt. The server passes 189 tests and the architecture gate covers 239
production files without dependency cycles.

## Handoff

The transformation is complete on `agent/exquisite-codebase`. Every production
module is below 1,000 lines with no legacy size exceptions or import cycles.
The full Node 24, Rust 1.94, real-browser, performance, local, relay, sync,
PostgreSQL provider, Docker control-plane, and Docker-backed Electron matrices
pass. The five explicitly accepted beta risks remain stable-release blockers
until their independent or operational evidence exists; do not mark them
complete merely to publish.
