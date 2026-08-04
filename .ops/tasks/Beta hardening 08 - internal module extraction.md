---
title: Beta hardening 08 - internal module extraction
status: in_progress
priority: medium
owner: codex
parent: SDK and authority beta hardening
delivery_slice: 8
phase: 4-follow-up
depends_on: [Beta hardening 07 - public SDK surface]
blocking_beta_invitation: true
tags: [beta, architecture, refactor, testing]
created_at: 2026-08-04T17:48:28+10:00
updated_at: 2026-08-05T07:21:00+10:00
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
