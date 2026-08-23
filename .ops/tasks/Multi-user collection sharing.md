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
updated_at: 2026-08-23T23:05:00+10:00
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

- Dedicated invitation records and opaque tokens/codes.
- Existing verified-user acceptance without account enumeration.
- Transactional seat enforcement at acceptance.
- Owner/editor list, invite, resend/cancel, role-change, and revoke APIs.
- Owner-only enforcement for owner, authority, billing, seat, and permanent
  deletion controls.
- Audit events and non-leaking errors for every lifecycle transition.

### 3. Portal and Editor UX

- Collection sharing panel with members, pending invitations, role presets, and
  explicit transition states.
- Shared collection labels and permission-aware controls in Editor.
- Reauthorization UX after downgrade or authority transfer.

### 4. Consumer and LAB acceptance

- Isolated users and vaults in `mdbase-env` LAB.
- Viewer/editor/owner, stale-write, files, provisioning, revocation, and transfer
  scenarios in Editor and TaskNotes.
- Browser, daemon, restart, provider-outage, and privacy/IDOR regression passes.

### 5. Local authority sharing

- Deliver only after the hosted model and cleanup lifecycle are stable.
- Bind local connector snapshots to member policy revisions and eliminate cached
  loopback access after downgrade/revocation.

## Rollout gate

Production enablement remains gated on replication/availability hardening and a
fresh operational review. Foundations and inactive APIs may land before the
feature is exposed.
