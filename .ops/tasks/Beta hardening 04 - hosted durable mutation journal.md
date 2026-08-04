---
title: Beta hardening 04 - hosted durable mutation journal
status: in_progress
priority: critical
owner: codex
parent: SDK and authority beta hardening
delivery_slice: 4
phase: 2
depends_on: [Beta hardening 03 - local durable mutation journal]
tags: [beta, idempotency, postgresql, r2, recovery]
created_at: 2026-08-04T17:48:28+10:00
updated_at: 2026-08-04T20:35:52+10:00
progress_summary: The provider-neutral PostgreSQL journal now owns record/resource operations, sync, timers, and all five public file mutations with fenced takeover, encrypted terminal/applied evidence, retired-credential replay, retention/tombstones, and privacy-safe diagnostics. Legacy record requests and sync receipts are archived and removed from runtime; an immutable beta.28 provider upgrade migrates and exactly replays an encrypted sync receipt. File controls retain their durable R2 lifecycle as the journal's resumable inner effect, with active-lease/takeover/conflict E2E and the 12-scenario adversarial R2 suite green. Hosted readiness advertises required durability capabilities and the control plane fails closed; relay negotiation reports and enforces minimum connector beta.31. Remaining gate is the generated cross-authority termination matrix and observed supported-platform runs.
type: task
---

# Beta hardening 04 - hosted durable mutation journal

## Outcome

Generalize hosted receipts into the same provider-neutral durable journal,
coordinate PostgreSQL and external side effects safely, enforce constraints and
capabilities, and pass the cross-authority mutator conformance suite.
