---
title: Beta hardening 03 - local durable mutation journal
status: in_progress
priority: critical
owner: codex
parent: SDK and authority beta hardening
delivery_slice: 3
phase: 2
depends_on: [Beta hardening 01 - contracts and baseline, Beta hardening 02 - SQLite migrations and recovery]
tags: [beta, idempotency, sqlite, filesystem, recovery]
created_at: 2026-08-04T17:48:28+10:00
updated_at: 2026-08-04T19:43:48+10:00
progress_summary: SQLite schema 2 journal, canonical fingerprints, fenced takeover, durable terminal and unknown states, revocation replay material, compaction and tombstones, privacy-safe diagnostics, and local loopback recovery tests are green. mdbase-rs durability primitives now flush create, replace, delete, and both rename parents; CI is expanded to Linux, macOS, and Windows. Remaining gate is the full canonical mutator fault matrix and observed green platform runs.
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
