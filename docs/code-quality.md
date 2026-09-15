# Code quality and internal architecture

MDBASE Connect is a feature-oriented modular system. Deployable boundaries stay
coarse, while implementation modules remain cohesive, independently testable,
and explicit about security and transaction ownership.

This document defines the intended internal shape. The system trust model and
runtime responsibilities remain in [Architecture](./architecture.md).

## Dependency direction

Within a deployable, dependencies point inward:

```text
entry point or transport adapter
              ↓
      application use case
              ↓
   domain policy or state machine
              ↓
 repository or transport interface
              ↓
 database, filesystem, or network adapter
```

Routes translate protocols. They authenticate the actor, validate input, invoke
one named use case, and translate its result. Routes do not own policy or
multi-step persistence.

Application use cases own orchestration and transaction boundaries. Domain
policy is deterministic wherever possible and does not depend on Fastify,
Axum, SQL rows, browser storage, or filesystem APIs. Infrastructure adapters
implement persistence and transport details without deciding authorization.

Avoid generic `utils`, `common`, and `services` dumping grounds. A shared
abstraction is justified only when it expresses one stable concept used by
multiple features.

## Feature ownership

The control plane is organized by account authentication, OAuth, pairing,
connectors, grants, hosted collections, authority transfer, relay, and
notifications. Each feature owns its routes, schemas, use cases, and
persistence queries. Features use another feature through a named public
service rather than importing its internal helpers.

The browser SDK keeps `index.ts` as a compatibility facade. Authorization,
session selection, connections, operations, notifications, storage,
cryptography, and direct, relay, and hosted transports live in focused modules.
There is one authorization and connection-state owner; optional sync and
notification packages consume its public seams rather than constructing
parallel clients.

The local connector separates collection registration, exact grants, replay
protection, mirrors, authority transfer, activity, and persistence. `mdbase-rs`
continues to own collection semantics. Repository code stores state; it does
not make grant or authority decisions.

The hosted provider separates capabilities, replicas, synchronization,
snapshots, operations, authority transfer, maintenance, quotas, and
persistence. A use case owns one database transaction from authorization
through mutation and receipt. Module extraction must never split an atomic
security decision across independently committed transactions.

## Invariant ownership

Every consequential invariant has one named owner and is enforced at the
authority that can make the final decision:

- the connector rechecks the exact local grant before every local operation;
- the provider validates every hosted capability and request proof;
- the control plane stores no local path or record payload;
- one explicit state machine owns authority transfer and fencing;
- one explicit lifecycle owns capability revocation and provider cleanup;
- daemon targeting distinguishes the default installed service from an
  isolated profile process;
- protocol schemas and compatibility fixtures are authoritative across Rust
  and TypeScript.

Represent lifecycle states with enums or tagged unions instead of combinations
of booleans and optional fields. Cryptographic key roles use distinct types and
lifecycles. Errors crossing a process or package boundary are structured,
stable, and versioned.

## Module and dependency budgets

Production modules should normally remain between 100 and 600 lines. A cohesive
module may exceed that range, but new production files may not exceed 1,000
lines. Existing exceptions are recorded in
`config/architecture-budgets.json`; their budgets only move downward as
features are extracted.

`pnpm check:architecture` enforces production-file budgets, rejects relative
source import cycles, and rejects workspace-package dependency cycles. It also
requires every npm package and Cargo crate to appear in the per-package file
inventory, and every production `dead_code` reference to appear in the exact
file inventory in `config/architecture-budgets.json`.

The reviewed-surface counts are flexible upper bounds, not minimization targets
or assertions that the source must keep an identical count. A decrease passes
without budget churn; an increase requires an evidence-backed configuration
change. The baseline at `0620ff3` is 663 production files, 1,375 relative
imports, 24 workspace package paths, 3,090 conservative Rust public visibility
references, 2,292 TypeScript export references, 16 `mdbase::Collection`
references, and one `TypedCollection` reference. These checks are architectural
alarms rather than substitutes for review.

The installed-desktop daemon fix adds one 26-line `daemon-lifecycle.ts` module
shared by startup and update recovery. Its two internal exports and two imports
replace duplicated CLI profile selection, keeping packaged default-service
selection and development isolation at one boundary. Its reviewed limits were
40 desktop files, 677 production files, 1,435 relative imports and 2,400
TypeScript exports. No package, file-size or cycle limit changes, new service,
public protocol, or alternate daemon lifecycle is introduced.

Public provider signup adds two server modules: `external-signup.ts` owns the
short-lived verified-identity proof and the account-creation transaction;
`public-account-onboarding.ts` replaces the password-only legal/entitlement/
welcome/starter sequence with one implementation used by both signup methods.
The corresponding reviewed-surface increase is two production files, fourteen
relative imports and five TypeScript exports, bringing the integrated limits to
679 production files, 1,449 relative imports and 2,405 TypeScript exports. This
does not relax file-size or cycle checks. Route tests and real PostgreSQL replay,
cross-provider email-race, same-subject concurrency and rollback tests cover the
new persisted boundary.

The [exact-recovery changes](exact-recovery-and-health.md) add six narrow modules:
three desktop modules for boot admission, canonical readiness presentation, and
resource-local refresh results; one editor helper for existing SDK pending
handles; one relay retry policy within the existing owner; and one server
transaction boundary for local revocation. They replace bypasses/duplicated
policy rather than adding a supervisor, reconciliation bus, credential store,
or mutation journal. The measured surface adjustment is six production files,
17 relative imports, 22 Rust public declarations and 18 TypeScript exports:
691 files, 1,504 imports, 3,185 Rust declarations and 2,462 TypeScript exports.
Per-package file limits become desktop 43, editor 111, daemon 35 and server 139.
File-size, cycle, package-dependency and dead-code limits are unchanged. Evidence
belongs at each boundary: boot/update races, pending-handle/component tests,
exact-ACK and real PostgreSQL serialization tests, and real isolated-process
credential retry. These limits do not replace review or platform qualification.

The rollback-admission correction reuses the control client's existing protocol
constant in updater health verification: one additional relative import and one
export, making the reviewed totals 1,505 imports and 2,463 TypeScript exports.
No production module, file-size limit, or cycle allowance is added. The existing
update record now binds a verified fallback to its app version and distinguishes
that daemon version during subsequent handoff; it is not a second journal.

Authority-transfer recovery (#345) adds ten conservative Rust visibility
references for the durable transfer summary, exact-ID cancellation command,
and their two internal accessors. The local control protocol advances to v5.
One TypeScript export, `finishAuthorityImportAbort`, replaces duplicated
cancellation/expiry cleanup and atomically retains a connector-scoped abort
receipt before cascading deletion. A reproduced first-import lost-response
failure justifies this new persisted boundary; restart, refusal, replay,
migration, desktop and PostgreSQL transaction/race tests cover it. Reviewed
limits become 3,173 Rust visibility references and 2,445 TypeScript exports;
file-count, file-size, dependency-cycle and package budgets are unchanged.

Integrating both series retains 691 production files and 1,505 relative imports,
with combined reviewed totals of 3,195 Rust declarations and 2,465 TypeScript
exports. The additional export moves ordinary CLI launch out of the composition
root into its existing daemon-lifecycle owner without relaxing its file limit.
Both recovery mechanisms and the current local control protocol v5 remain intact.

The Windows task-registration repair (#428) replaces the unscoped `schtasks
/SC ONLOGON` command with one current-user task definition. A small CLI-owned
module holds native token/SID access and the UTF-16 XML encoder; its two helpers
are visible only to the parent module. Native standard-user tests cover the
actual installer, alongside pure encoding tests. This adds one production file
(CLI package: 8; total: 694) and two counted Rust visibility declarations
(total: 3,200), not a second service owner, recovery state, or public protocol.
File-size and cycle budgets are unchanged.

Composition roots and package facades should approach these end-state shapes:

- server `app.ts`: registration and lifecycle wiring only;
- client `index.ts`: public exports only;
- registry `mod.rs`: a narrow facade over invariant-owning modules;
- provider `mod.rs`: provider construction and public use-case composition.

## Test ownership

Tests live at the narrowest boundary that proves the behavior:

- pure unit and property tests for policy and state machines;
- repository integration tests against real SQLite or PostgreSQL;
- cross-language golden fixtures for every wire contract;
- route and component tests for authentication and error translation;
- end-to-end tests for complete local, relay, hosted, desktop, and upgrade
  journeys;
- fault-injection tests for retry, crash, partition, replay, and recovery;
- accessibility tests for keyboard, focus, semantics, contrast, and reduced
  motion.

Every defect receives a regression test at the narrowest reliable level.
End-to-end coverage remains a release boundary, but ordinary feature failures
must be diagnosable without running the entire environment.

## Definition of done

A change is complete when:

1. Its behavior has one obvious module and owner.
2. Authorization, privacy, transaction, and protocol invariants remain
   explicit in code and tests.
3. New APIs use narrow types and structured errors.
4. Unit and integration tests cover success, denial, retry, and malformed
   input where relevant.
5. Formatting, strict linting, architecture, type, dependency, migration, and
   compatibility checks pass.
6. User, operator, security, and architectural documentation changes accompany
   the implementation that makes them true.
7. The relevant local or containerized end-to-end boundary passes.

Refactors proceed as cohesive behavior-preserving commits. Public behavior
changes, schema migrations, and module movement are separate commits whenever
that separation makes review or rollback safer.
