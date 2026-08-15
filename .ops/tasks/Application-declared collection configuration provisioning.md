---
title: Application-declared collection configuration provisioning
status: done
priority: high
owner: codex
parent: SDK and authority beta hardening
tags:
  - sdk
  - applications
  - manifests
  - configuration
  - mdbase-yaml
  - provisioning
  - tasknotes
  - hosted
  - relay
  - developer-experience
created_at: 2026-08-05T12:01:29+10:00
updated_at: 2026-08-05T22:23:00+10:00
type: task
---

# Application-declared collection configuration provisioning

## Context

TaskNotes stores portable views as Obsidian Base sources. Creating those sources
requires the selected collection's `mdbase.yaml` to admit their paths through
`x-obsidian.bases.include`.

PR #181 temporarily added that policy to the generic hosted collection template.
PR #182 reverted it before deployment because an application-specific Obsidian
policy does not belong in every mdbase collection. The application declaration
can currently provision type packs containing contracts, types, and schemas, but
cannot declare configuration requirements or propose narrowly scoped
configuration changes.

## Desired outcome

Allow an application to declare the collection configuration it requires and a
safe, deterministic provision that can satisfy that requirement. The SDK should
assess the selected collection, present any required setup for explicit review,
and apply the approved setup atomically. The same declaration and semantics must
work for hosted collections and relay-backed filesystem collections.

TaskNotes is the first consumer. Existing compatible collections should work
without a prompt; existing incompatible collections should be repairable through
the reviewed setup flow without recreation or a service-wide template change.

## Design constraints

- Keep the generic `mdbase` collection template application-agnostic.
- Do not give applications an unrestricted `mdbase.yaml` write operation.
- Keep canonical assessment, merge, conflict, and apply semantics in
  `mdbase-rs`; Connect, hosted providers, relays, and SDK consumers must not
  maintain independent merge implementations.
- Prefer typed, idempotent semantic operations such as set membership over raw
  JSON Patch or whole-file replacement.
- Initially restrict application provisions to approved `x-*` extension
  namespaces. Core settings such as `spec_version`, type storage, validation,
  security, and service limits remain collection-owner policy.
- Bind every apply to the registered application declaration, provision digest,
  reviewed assessment digest, and current collection revision.
- Apply configuration and type-pack setup atomically so an application cannot be
  left half-configured.
- Preserve user-authored configuration, return structured conflicts for wrong
  types or incompatible scalar values, and make retries idempotent.
- Record durable provision receipts and contribution ownership. Do not silently
  remove configuration when an application disconnects.
- Support multiple applications contributing the same set-like value without
  duplicate entries or unsafe cleanup.

## Proposed contract direction

Keep requirements and provisions distinct in the application declaration:

```json
{
  "requirements": {
    "configuration": [
      {
        "id": "tasknotes-base-sources",
        "path": "/x-obsidian/bases/include",
        "predicate": "contains",
        "value": "views/tasknotes/**/*.base"
      }
    ]
  },
  "provisions": {
    "configuration": [
      {
        "requirement": "tasknotes-base-sources",
        "operation": "set_add",
        "path": "/x-obsidian/bases/include",
        "value": "views/tasknotes/**/*.base"
      }
    ]
  }
}
```

This shape is provisional. Confirm the smallest reusable contract before
freezing the schema. TaskNotes should create explicit namespaced paths such as
`views/tasknotes/today.base`; it should not change global defaults such as
`create_folder` or `default_for_new_views`.

## Workstreams

1. Define canonical configuration requirement, assessment, provision, receipt,
   and conflict models in `mdbase-rs`.
2. Add atomic assess/apply operations with revision and digest preconditions,
   idempotent retries, extension-namespace policy, and multi-contributor tests.
3. Extend the Connect protocol application-manifest schema, runtime types,
   validator, semantic capability contract, and developer tooling with precise
   JSON-pointer diagnostics.
4. Route the canonical operations through the local connector, relay, hosted
   provider, authorization policy, and signed request machinery without
   duplicating configuration semantics.
5. Generalize the SDK application session's definition review into a collection
   setup review that combines type-pack and configuration changes and applies
   them atomically.
6. Update TaskNotes' generated application declaration, setup UX, and view-source
   creation to request the namespaced include and use explicit `.base` paths.
7. Add TaskNotes unit and end-to-end coverage for already-compatible,
   provisionable, declined, conflicting, retried, and upgraded setup flows.
8. Add cross-runtime hosted and relay conformance tests and include the exact
   TaskNotes declaration in release validation and live acceptance.

## Acceptance criteria

- A new generic hosted collection contains no TaskNotes- or Obsidian-specific
  configuration.
- Connecting TaskNotes to an already compatible collection requires no setup
  mutation.
- Connecting TaskNotes to a collection missing the include produces a clear,
  human-readable setup review rather than `Invalid input` or a raw engine error.
- Approval adds exactly the declared include, preserves unrelated YAML, records
  a receipt, and enables TaskNotes to create, list, execute, update, and delete
  its `.base` views.
- Declining the required provision leaves the collection unchanged and explains
  why the affected TaskNotes feature is unavailable.
- Wrong-type and incompatible-value cases return structured, actionable
  conflicts and never overwrite user policy.
- Applying or retrying setup is atomic and idempotent across process restart and
  ambiguous transport outcomes.
- Hosted and relay-backed collections pass the same behavioral fixtures using
  the same `mdbase-rs` semantics.
- Existing collections can adopt the provision through application setup; no
  collection recreation or blanket hosted-template migration is required.
- TaskNotes' generated declaration validates through local tooling, Connect's
  registration boundary, consumer CI, and release acceptance.

## History

- mdbase Connect PR #181 demonstrated the required `x-obsidian` configuration
  and complete hosted Base-view lifecycle, but placed the policy in the generic
  template.
- mdbase Connect PR #182 reverted that change before production deployment.

## Handoff

Start by specifying the canonical `mdbase-rs` assessment and apply contract,
including merge algebra, receipts, conflicts, and transaction boundaries. Do
not begin with TaskNotes UI or a hosted-only endpoint; those should consume the
shared semantics once the contract is settled.

## Progress — 2026-08-05

- The canonical atomic assessment/apply contract and receipts merged in
  mdbase-rs PR #40 at `179cf4a`; Connect's declaration binding, hosted setup,
  relay/local semantics, and authorization coverage are implemented on the
  beta-hardening train.
- TaskNotes has a preliminary collection-setup migration checkpoint, but it is
  intentionally not the final pin. It will consume the same immutable successor
  artifact set as the other three applications after release readiness is
  frozen, avoiding a second consumer/deployment cycle.
- The task remains open until that exact TaskNotes artifact migration and its
  local, hosted, consumer-CI, and release-acceptance proof are complete.

## Completion — 2026-08-05

- Canonical assessment, merge, conflict, receipt, contribution ownership, and
  atomic apply semantics live in mdbase-rs (`179cf4a`) and are consumed by both
  filesystem and hosted authorities. Connect does not carry a second merge
  implementation, and the generic hosted template remains free of TaskNotes or
  Obsidian policy.
- Connect commit `55b536aafa9a1ae1031171fa7e39ae99fa4530f0` freezes the
  beta.33 manifest schema, `collection.setup.apply` capability, signed
  assessment/apply operations, relay and hosted routing, reviewed setup session
  API, diagnostics, idempotency, conflict, receipt, restart, and cross-authority
  fixtures.
- TaskNotes commit `6febc15` pins only that immutable artifact set. Its
  declaration requests `views/tasknotes/**/*.base`, its setup UI distinguishes
  review from access, and its five ordinary editable sources use explicit
  `views/tasknotes/*.base` paths.
- Fresh relay-backed live acceptance applied the reviewed setup to collection
  `84ad01aa-268f-4f21-88ea-8e9e22600c74`, preserved generic collection
  ownership, wrote the one namespaced include, created all five sources, and
  executed the Today view. The run also dropped a successful create response,
  reloaded, recovered the original durable request, and proved exactly one
  task. It exposed and fixed a date-string comparison in the application-owned
  Today source before release.
- TaskNotes' 356-test verification, manifest registration/validation,
  desktop/mobile 8/8 matrix, seven production checks, Android notification and
  process-restart smoke, and repeated real-authority dogfood are green. The
  unit/system suites cover already-compatible, missing, declined, conflicting,
  retried, upgraded, hosted, and relay-backed setup paths.

All acceptance criteria are satisfied. No intermediate deployment occurred.
