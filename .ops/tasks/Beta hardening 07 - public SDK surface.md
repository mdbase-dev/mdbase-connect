---
title: Beta hardening 07 - public SDK surface
status: done
priority: critical
owner: codex
parent: SDK and authority beta hardening
delivery_slice: 7
phase: 4
depends_on: [Beta hardening 05 - bounded IO and typed outcomes]
tags: [beta, sdk, developer-experience, packages, bundle]
created_at: 2026-08-04T17:48:28+10:00
updated_at: 2026-08-04T21:58:03+10:00
progress_summary: The real root SDK now implements the frozen Connect → application session → connection path, uniform request defaults, external-store adapter, advanced/crypto subpaths, URL config, bounded watch subscription, and independently recoverable multi-request mutation handles. Obsolete beta.28 factories and root low-level exports are absent. Real-surface consumer/negative fixtures, docs, CSP, package audit, and enforced 182 KB raw/46 KB gzip bundle gates are green.
type: task
---

# Beta hardening 07 - public SDK surface

## Outcome

Land the frozen golden path, external-store adapter, explicit advanced and
crypto subpaths, removal of obsolete beta.28 exports, API fixtures, negative
fixtures, documentation, and bundle/CSP/tree-shaking budgets.

## Exit evidence

- Commits `05e9207`, `31f046f`, and `0e6f95b` implement the public façade,
  subpaths, request defaults, durable recovery, docs, and package gates.
- The unexported candidate path now aliases the actual root entry point; Editor,
  Workouts, Pickle, and TaskNotes compile spikes therefore test shipped types.
- Negative fixtures reject `createApplicationSession`,
  `resumePendingMutation(input)`, and removed root low-level imports.
- Durable handles retain exact plaintext/encrypted requests and crypto context,
  survive authorization loss, migrate the previous single slot, support
  multiple request IDs, and clear independently (155 client tests).
- `pnpm package:audit` is green. Browser output is 179,638 raw / 45,406 gzip
  under enforced 182,000 / 46,000 limits, with no eval/CSP violation.
