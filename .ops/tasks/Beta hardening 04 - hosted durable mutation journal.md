---
title: Beta hardening 04 - hosted durable mutation journal
status: done
priority: critical
owner: codex
parent: SDK and authority beta hardening
delivery_slice: 4
phase: 2
depends_on: [Beta hardening 03 - local durable mutation journal]
tags: [beta, idempotency, postgresql, r2, recovery]
created_at: 2026-08-04T17:48:28+10:00
updated_at: 2026-08-05T08:49:15+10:00
progress_summary: Complete. The provider-neutral PostgreSQL journal covers the full canonical mutator catalogue, the shared 114-case termination matrix is green across local and hosted authorities, the hosted and adversarial R2 provider suites pass, beta.28 provider upgrade/replay passes, and previous-provider notification recovery is green in Server CI run 30954941302.
type: task
---

# Beta hardening 04 - hosted durable mutation journal

## Outcome

Generalize hosted receipts into the same provider-neutral durable journal,
coordinate PostgreSQL and external side effects safely, enforce constraints and
capabilities, and pass the cross-authority mutator conformance suite.

## Exit evidence

- The same generated 19-mutator catalogue and six termination boundaries used
  for the local authority pass against hosted PostgreSQL dispatch; there is no
  handwritten or reduced hosted operation list.
- PostgreSQL mutation effects and journal transitions are atomic where one
  transaction can own them. External R2 effects use durable prepared/applied
  evidence, fenced takeover, and resumable cleanup; the 12-scenario adversarial
  suite is green.
- Immutable beta.28 upgrade fixtures migrate legacy record/sync receipts,
  preserve encrypted completed outcomes, remove legacy runtime paths, and
  replay the exact result after upgrade.
- Hosted provider, server-container, previous-release upgrade/OAuth, and
  previous-provider notification-recovery jobs are green in Server CI run
  `30954941302`. Readiness and relay negotiation fail closed when a required
  protocol, authorization, semantic-capability, or durable-mutation contract is
  absent.

Exit gate closed green on 2026-08-05.
