---
title: Beta hardening 08 - internal module extraction
status: open
priority: medium
owner: codex
parent: SDK and authority beta hardening
delivery_slice: 8
phase: 4-follow-up
depends_on: [Beta hardening 07 - public SDK surface]
blocking_beta_invitation: false
tags: [beta, architecture, refactor, testing]
created_at: 2026-08-04T17:48:28+10:00
updated_at: 2026-08-04T17:48:28+10:00
type: task
---

# Beta hardening 08 - internal module extraction

## Outcome

Where justified after behavioral hardening, extract oversized internals behind
the frozen façades with focused tests and no behavior or bundle regression.

## Constraint

Keep this non-blocking unless module size directly prevents a correctness
change or safe review. Never mix large movement into a behavioral slice.
