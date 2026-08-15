---
title: Beta hardening 08 - internal module extraction
status: done
priority: medium
owner: codex
parent: SDK and authority beta hardening
delivery_slice: 8
phase: 4-follow-up
depends_on: [Beta hardening 07 - public SDK surface]
blocking_beta_invitation: true
tags: [beta, architecture, refactor, testing]
created_at: 2026-08-04T17:48:28+10:00
updated_at: 2026-08-05T08:49:15+10:00
progress_summary: Complete. The five hardened production modules that exceeded the 1,000-line review budget were split behind their frozen façades without raising an exception. The clean-checkout architecture gate now passes across 481 production files, 1,031 relative imports, and 14 workspace packages; Editor CI and Desktop Release run 30954941644 are green.
type: task
---

# Beta hardening 08 - internal module extraction

## Outcome

Where justified after behavioral hardening, extract oversized internals behind
the frozen façades with focused tests and no behavior or bundle regression.

## Constraint

Keep this non-blocking unless module size directly prevents a correctness
change or safe review. Never mix large movement into a behavioral slice.

## Activation evidence

PR #183 made this slice blocking on 2026-08-05: the clean-checkout
`check:architecture` gate reports five hardened production modules above the
1,000-line review budget. Preserve the frozen public façades and extract
cohesive internals without raising or adding legacy line-budget exceptions.

## Exit evidence

- Cohesive implementation modules were extracted only after their behavioral
  hardening landed; public façades and package exports remain frozen.
- No architecture budget or legacy exception was raised. `pnpm
  check:architecture` passes across 481 production files, 1,031 relative
  imports, and 14 workspace packages.
- Editor CI run `30954941837` and every built Desktop Release target in run
  `30954941644` are green, covering Linux, Windows, macOS Intel and Apple
  Silicon, Windows Store packaging, and release-regression tests.

Exit gate closed green on 2026-08-05.
