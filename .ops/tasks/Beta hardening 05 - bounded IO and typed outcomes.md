---
title: Beta hardening 05 - bounded IO and typed outcomes
status: done
priority: critical
owner: codex
parent: SDK and authority beta hardening
delivery_slice: 5
phase: 3
depends_on: [Beta hardening 04 - hosted durable mutation journal]
tags: [beta, sdk, timeout, cancellation, postgresql]
created_at: 2026-08-04T17:48:28+10:00
updated_at: 2026-08-04T21:58:03+10:00
progress_summary: Uniform signal/timeout options and workload defaults now bound SDK, sync, files, notifications, watch startup, management, HTTP decoders, and both PostgreSQL services. Live PostgreSQL 18 probes exhaust production pools and force statement and row-lock timeouts with typed outcomes. Client, server, management, package, and Editor gates are green.
type: task
---

# Beta hardening 05 - bounded IO and typed outcomes

## Outcome

Apply the frozen request-options contract across public operations, make retry
budgets deadline-aware, decode every boundary into typed outcomes, bound all
PostgreSQL waits, and eliminate indefinitely pending promises and UI state.

## Exit evidence

- Commits `05e9207`, `31f046f`, and `075fd1b` implement boundary decoders,
  request budgets/defaults, abortable watch startup, management bounds, and
  live database saturation probes.
- Client: 155 tests, typecheck, build, public API fixture, browser CSP and
  bundle budget green.
- Server: 270 tests green. Management: 7 tests and typecheck green.
- Disposable PostgreSQL 18: control-plane and hosted-provider pool exhaustion,
  statement cancellation (`57014`), and row-lock cancellation (`55P03`) green;
  hosted failures map to typed `pool`, `statement`, and `lock` classes.
- `pnpm package:audit` builds all workspace packages/apps and validates every
  published package boundary.
