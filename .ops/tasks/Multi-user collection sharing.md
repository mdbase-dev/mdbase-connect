---
title: Multi-user collection sharing
status: in_progress
priority: high
owner: codex
tags:
  - collaboration
  - authorization
  - hosted
  - editor
  - tasknotes
created_at: 2026-08-23T00:00:00+10:00
updated_at: 2026-08-24T00:16:00+10:00
type: task
---

# Multi-user collection sharing

## Goal

Let an owner share one logical collection with verified mdbase users while every
application and mirror retains an independent, least-privilege replica. Start
with hosted authorities. Local-authority sharing follows after hosted lifecycle,
consumer, and operational behavior is proven.

## Product contract

- A stable logical collection identity survives authority transfer.
- Roles are UI presets over immutable, revisioned, exact policy ceilings.
- Viewers may read/query/watch/validate, use files read-only, authorize
  read-scoped applications, and create read-only mirrors.
- Editors additionally mutate records/files, provision types/contracts/setup,
  manage timers and views, rename the collection, authorize write applications,
  create writable mirrors, and manage non-owner viewer/editor memberships.
- Only owners transfer authority, permanently delete, change ownership, or
  manage billing and seats.
- Membership determines delegation authority; provider replicas continue to
  enforce exact application or mirror capabilities without interpreting roles.
- Downgrade and revocation immediately deny control-plane use and revoke local
  grants/tokens. Membership remains `changing` or `revoking` until durable
  provider cleanup is acknowledged; downgrade then requires reauthorization.
- Existing users are invited without account enumeration. Acceptance, not invite
  creation, consumes an owner-funded seat transactionally.

## Milestones

### 1. Policy and capability foundation

Implemented on `feature/collection-sharing`:

- expand-only logical identity, membership, immutable policy, grant, and replica
  binding migrations;
- hosted owner/member access resolution and shared collection catalog visibility;
- exact action, operation, scope, and file ceilings in authorization planning;
- transaction-time membership revalidation at approval and token issuance;
- relational user/collection/membership/policy binding for grants and replicas;
- durable downgrade/revocation state with provider cleanup reconciliation;
- editor rename support while delete and authority transfer remain owner-only;
- deterministic IDOR, malformed-policy, migration, binding, lifecycle, race,
  and full hosted-member authorization tests.

Validation evidence:

- `pnpm test:fast`
- workspace typecheck and architecture/operation checks
- PostgreSQL 18 provider system suite (`pnpm e2e:provider`)
- adversarial schema, access, authorization-race, and lifecycle reviews

### 2. Invitations and management API

Implemented:

- Dedicated hashed invitation tokens and one-use invitee-generated codes.
- Existing verified-user acceptance without account enumeration; unresolved
  email invitations are deliberately unclaimable in this initial scope.
- Transactional owner-funded seat enforcement at acceptance and release only
  after provider-backed revocation completes.
- Owner/editor list, invite, cancel, role-change, and revoke APIs.
- Exact invitation policy snapshots copied into immutable membership revisions.
- Owner-only enforcement for authority, billing, seat, and permanent deletion
  controls, with privacy-safe audit events and errors.
- Account, inviter, invitee-code, collection-deletion, expiry, replay, IDOR, and
  cascade regression coverage.

### 3. Editor UX

Implemented:

- People & sharing panel with verified-email and sharing-code invitations,
  role presets, copyable fragment-bound links, pending invitations, and explicit
  changing/revoking states.
- Account-level one-use sharing-code generation.
- Shared collection discovery and permission-aware rename/delete controls.
- Invitation acceptance that preserves unrelated sensitive fragment state.
- Management-client and Editor component coverage, including viewer gating.

### 4. Consumer and LAB acceptance

Deterministic server, management-client, Editor, full workspace, and provider
system coverage is complete. Disposable PostgreSQL 18 executions passed for the
foundation lifecycle, all control-plane migrations, and a concurrent final-seat
invitation race (exactly one acceptance succeeded and one received the typed seat
limit error).

LAB preflight now passes, but the sharing branch is not deployed there. Complete
isolated multi-account Editor and TaskNotes acceptance against the PR build before
production enablement:

- viewer/editor/owner, stale-write, files, provisioning, revocation, and transfer;
- browser, daemon, restart, provider-outage, privacy, and IDOR regression passes.

### 5. Local authority sharing

- Deliver only after the hosted model and cleanup lifecycle are stable.
- Bind local connector snapshots to member policy revisions and eliminate cached
  loopback access after downgrade/revocation.

## Rollout gate

Production enablement remains gated on replication/availability hardening and a
fresh operational review. Foundations and inactive APIs may land before the
feature is exposed.
