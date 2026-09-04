# ADR 0013: Versioned application capability groups

- Status: accepted
- Date: 2026-09-04

## Context

Application manifests currently describe user-facing intent with 32 capability
identifiers. Most map one-for-one to the 27 internal collection operations, and
files duplicate the independently structured file requirement. Consent then
asks a user to reason about implementation distinctions such as `read` versus
`query`, four timer methods, and assess/apply pairs.

That granularity has not produced meaningful least-privilege behavior in the
published applications. Editor and TaskNotes request nearly every operation in
the areas they use. Reader, Workouts, Planner, Pickle, and MCP request smaller
subsets, but their useful authority still falls into a few stable groups. Several
manifests request operations that their production paths do not invoke.

Users are primarily deciding whether to trust an application with the selected
collection. The public permission model should preserve distinctions that a
person can understand and reasonably deny, without making internal dispatch
operations a permanent manifest, grant, and consent contract.

The collection remains the data-visibility boundary established by ADR 0012.
Exact operations remain the enforcement boundary at the local connector and
hosted provider.

## Consumer evidence

The inventory covered Editor, TaskNotes, TaskNotes Planner, mdbase Reader and
its capture extension, Workouts, Pickle, MCP, desktop tooling, and SDK/devkit
fixtures.

- Every record consumer needs read authority, write authority, or both.
- Read behavior repeatedly combines collection description, record reads and
  queries, change watching, saved-view execution, validation, and definition
  inspection.
- Full editors combine create, update, rename, and delete, but focused consumers
  demonstrate coherent smaller authority: Pickle creates responses without
  updating or deleting records, and TaskNotes Planner updates tasks without
  creating or deleting them.
- Editor performs ongoing type and type-pack administration. Reader and
  TaskNotes manage saved-view sources without needing arbitrary type-pack
  authority, while application setup is a separate declaration-driven flow.
- TaskNotes is the only published timer consumer found. It reconciles one
  application-owned reminder set rather than selecting timer methods
  independently.
- No published application requests an offline replica.
- Files, notification criteria, contracts, and setup provisions already have
  dedicated structured declarations and enforcement. Mirroring them with empty
  or one-operation capability identifiers creates two public representations of
  the same authority. The file declaration must first gain explicit required
  and optional action sets; Editor currently uses optional file addition, which
  the existing duplicate capability represents.

Read-only degradation could be useful for Reader, Workouts, Pickle, Planner,
and Editor, but their current manifests generally mark writes as required. The
new taxonomy makes such product choices possible without exposing individual
operations.

## Decision

Application capability contract version 2 has eight public capability groups.
Each versioned identifier has one immutable exact expansion:

| Capability | Internal operations |
| --- | --- |
| `collection.read` | `describe`, `changes`, `read`, `query`, `list_views`, `execute_view`, `read_view_source`, `validate`, `read_type` |
| `records.create` | `create` |
| `records.edit` | `update`, `rename` |
| `records.delete` | `delete` |
| `views.manage` | `create_view_source`, `update_view_source`, `delete_view_source` |
| `definitions.manage` | `create_type`, `update_type`, `assess_type_pack`, `apply_type_pack` |
| `background.schedule` | `list_timers`, `put_timer`, `cancel_timer`, `reconcile_timers` |
| `offline.replica` | `sync` |

The three record-mutation groups remain visually summarized as write access when
an application requests them together. They stay independently requestable
because published capture, planning, and inbox consumers demonstrate useful
create-only and update-only authority. Permanent deletion remains explicit.
This is semantic grouping by user effect, not retention of arbitrary operation
selection.

Capabilities are atomic. Required capabilities cannot be narrowed. Optional
capabilities may be denied only as a complete group, and an application that
declares one must define useful degraded behavior.

The following remain independent structured parts of the application contract,
not capability aliases:

- required and optional file actions with one folder scope;
- notification criteria and delivery registration;
- portable contract requirements;
- configuration and type-pack provisions;
- collection selection, origin, credentials, epochs, leases, and replica mode.

Approving concrete setup provisions derives only
`assess_collection_setup` and `apply_collection_setup`. It does not grant
ongoing `definitions.manage` or `views.manage` authority. Authorization must
persist a canonical digest of the exact approved requirements and provisions.
Both local and hosted dispatch must reject a setup payload whose canonical
projection differs from that approved projection; matching only application ID
and manifest digest is insufficient.

The version-2 file requirement replaces one flat action list with disjoint
`required` and `optional` action sets under one exact scope. Optional actions
may be denied independently; the resulting exact file capability remains the
sole file-enforcement input.

Contract readiness is derived from required contracts. Notification readiness
is derived from approved criteria and registration state. File readiness is
derived from required and approved optional file actions. Setup readiness is
derived from the approved provision projection. The SDK must expose these as
structured readiness results alongside application capability results,
including missing file actions and whether setup or registration is required.
They must not survive as empty compatibility capability IDs.

Applications declare capability groups. Connect compiles them and any approved
setup provisions into exact operations. Signed authorization requests, stored
provider policy, local grants, and dispatch checks may carry that materialized
operation set as an internal projection, but applications and users cannot add,
remove, or approve individual operations.

A capability version never gains operations. A changed expansion requires a
new capability-contract version and ordinary reauthorization.

## Migration

This is a coordinated breaking transition. Semantic capability version 1 is not
translated because every non-trivial group would broaden at least some existing
grants.

1. Publish controlled consumers and SDKs that declare version 2.
2. Stop creating version-1 pending authorizations and grants.
3. Retire active version-1 grants and credentials through the existing durable
   revocation paths.
4. Prompt for ordinary authorization on the next application use.
5. Revoke grant-owned timers and notification subscriptions as part of the old
   grant's durable cleanup. Do not transfer them to a new grant identity.
6. After reauthorization, applications explicitly reconcile their desired
   timers and recreate notification registrations under the new grant. Product
   messaging must state that background reminders may need to be enabled again.
7. Preserve collection records, files, views, definitions, and setup resources;
   authorization and grant-owned background registrations are replaced.
8. Remove version-1 manifest parsing, SDK aliases, consent code, fixtures, and
   migration state after the rollback and bounded policy-lease window.

Operation-transport N-1 compatibility is a separate protocol concern. It does
not justify accepting the old public capability model.

## Consequences

- Most applications request a small read/write profile, while focused capture
  and planning applications avoid unrelated mutation authority.
- Consent presents a short effect-oriented summary instead of operation counts
  and checkboxes.
- Read-only applications do not receive mutation authority.
- Create, edit, and permanent deletion remain understandable atomic effects;
  full editors can present them as one concise write summary.
- Saved-view management cannot escalate into arbitrary definition changes.
- Setup cannot escalate into arbitrary structure management.
- Files and notifications retain their exact scopes without duplicate
  capability names.
- The internal operation catalog remains available for dispatch, durable
  mutation identity, compatibility, and tests.
- Some version-1 grants could theoretically map to a narrower version-2 group,
  but all are reauthorized to keep one migration rule and avoid silent changes.

## Verification

The change is complete only when tests prove that:

- TypeScript, JSON Schema, and Rust advertise the same capability-contract
  version and immutable expansion;
- version-1 manifests and grants produce an explicit update/reauthorization
  outcome and never create live authority;
- a capability can be approved or denied only atomically, and optional file
  actions remain independently deniable without duplicate aliases;
- every compiled operation is inside both the signed application ceiling and
  the approving member's ceiling;
- denied read, write, structure, timer, sync, file, notification, and setup
  authority fails closed locally, through relay, and when hosted;
- setup provisions grant only exact declaration-bound setup operations and a
  changed setup payload is rejected at both data authorities;
- SDK readiness for files, notifications, contracts, and setup no longer
  depends on removed aliases;
- retired credentials cannot perform live work, old timers and notification
  registrations are durably cleaned up, and exact terminal mutation replay
  remains bounded where required;
- all published consumers complete their principal workflows after ordinary
  reauthorization; and
- temporary compatibility and migration code has an explicit deletion gate.
