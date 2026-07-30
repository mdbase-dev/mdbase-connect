---
title: Codebase architecture and quality transformation
status: in_progress
priority: critical
owner: codex
tags: [architecture, maintainability, security, testing, ci, documentation]
created_at: 2026-07-30T11:31:26+10:00
updated_at: 2026-07-30T11:44:23+10:00
type: task
---

## Context

MDBASE Connect grew from its first recorded MVP into a broad local, relay, and
hosted platform in less than two weeks. Its behavioral coverage and product
boundaries are strong, but several central implementation files now contain
multiple domains and thousands of lines. Pre-release is the best opportunity
to establish durable internal boundaries before public APIs and operating
assumptions become expensive to change.

## Desired outcome

Turn the repository into a feature-oriented modular system with:

- thin composition roots and public package facades;
- explicit application, policy, persistence, and transport boundaries;
- one authoritative owner for every security and lifecycle invariant;
- stable, versioned Rust and TypeScript protocol contracts;
- focused unit, integration, compatibility, fault-injection, accessibility,
  and end-to-end coverage;
- enforceable formatting, dependency, architecture, migration, release, and
  rollback quality gates;
- concise architecture, threat-model, ownership, and operational documentation.

## Plan

1. Capture the current architecture, dependency graph, quality baseline, and
   critical invariants.
2. Add quality guardrails that prevent further concentration while allowing
   deliberate behavior-preserving extraction.
3. Decompose the control-plane server by feature.
4. Decompose the client SDK behind a stable public facade.
5. Decompose the local registry by invariant-owning domains.
6. Decompose the hosted provider while preserving transaction ownership.
7. Model daemon targeting, capability revocation, cryptographic trust, and
   authority lifecycle states explicitly.
8. Expand narrow tests and fault injection around every extracted boundary.
9. Harden CI, dependency policy, documentation, ownership, and release checks.
10. Run the complete local and Docker-backed test matrix and audit the result.

## Working rules

- Preserve collection semantics in `mdbase-rs`.
- Keep the local connector as the final local authorization boundary.
- Do not send local paths or record payloads to the control plane.
- Keep each commit cohesive, reviewed through its diff, and green at the
  narrowest relevant test level.
- Run the full request-path and live integration suites at phase boundaries.
- Do not mix the original checkout's uncommitted desktop work into this branch.

## Notes

Work is isolated on `agent/exquisite-codebase` in the
`mdbase-connect-quality` worktree, based on `v0.1.0-beta.20`.

### Baseline and first guardrails

- The build-first baseline passes 142 Rust tests and 447 JavaScript/TypeScript
  tests.
- A clean install initially could not run `pnpm typecheck` or `pnpm test`
  without a separate build because workspace declarations resolve from
  generated `dist` directories. Root lifecycle scripts now build package
  prerequisites explicitly.
- Strict Clippy exposed one nine-argument hosted-provider mutation function.
  It now takes a typed operation context without suppressing the lint.
- The architecture check covers 138 production source files, 173 relative
  imports, and 11 workspace packages. Its own four tests bring the
  JavaScript/TypeScript total to 451.
- The first graph run found a real `db.ts` and `migrations.ts` dependency
  cycle. Database interfaces, connection composition, and the immutable legacy
  baseline are now separate modules and the cycle is removed.
- Existing production files above 1,000 lines are explicit debt entries.
  Newly extracted modules must stay below the default budget.
