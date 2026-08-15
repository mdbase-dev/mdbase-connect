---
title: Beta hardening 03 - local durable mutation journal
status: done
priority: critical
owner: codex
parent: SDK and authority beta hardening
delivery_slice: 3
phase: 2
depends_on: [Beta hardening 01 - contracts and baseline, Beta hardening 02 - SQLite migrations and recovery]
tags: [beta, idempotency, sqlite, filesystem, recovery]
created_at: 2026-08-04T17:48:28+10:00
updated_at: 2026-08-05T08:49:15+10:00
progress_summary: Complete. The fenced SQLite mutation journal, recovery, compaction, tombstones, revocation replay, and privacy-safe diagnostics are green. The generated 19-mutator by 6-termination-boundary matrix passes all 114 cases, and filesystem durability is green on Ubuntu, macOS, and Windows in Server CI run 30954941302.
type: task
---

# Beta hardening 03 - local durable mutation journal

## Outcome

Implement the fenced, lease-based local mutation journal and prove restart,
replay, compaction, revocation, and real Linux/macOS/Windows filesystem
durability for every canonical mutator.

## Gate

Do not begin implementation until delivery slices 1 and 2 are independently
green.

Gate opened 2026-08-04: delivery slices 1 and 2 are independently green with
their exit evidence recorded in their task sidecars.

## Exit evidence

- One canonical catalogue drives the 19 public mutators exercised by the
  recovery harness. Every mutator passes all six termination boundaries:
  before claim, after claim, after prepare, after effect, after applied
  evidence, and after terminal receipt (114 cases total).
- Identical retries return or resume the durable outcome; live owners remain
  bounded; expired or prior-process leases are fenced; conflicting request-ID
  reuse is permanent and typed; genuinely indeterminate effects retain the
  stable request ID and report `operation_outcome_unknown`.
- Linux, macOS, and Windows durability jobs are green in Server CI run
  `30954941302`, including create, replace, delete, rename-parent flushes,
  response loss, restart, takeover, and registry-backup behavior.
- Journal compaction preserves fingerprint tombstones for the replay horizon,
  retired-grant replay remains authorization-safe, and diagnostics disclose no
  record plaintext.

Exit gate closed green on 2026-08-05.
