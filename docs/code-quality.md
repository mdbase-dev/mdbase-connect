# Code quality and internal architecture

MDBASE Connect is a feature-oriented modular system. Deployable boundaries stay
coarse, while implementation modules remain cohesive, independently testable,
and explicit about security and transaction ownership.

This document defines the intended internal shape. The system trust model and
runtime responsibilities remain in [Architecture](./architecture.md).

The reviewed seed-upgrade protocol adds four Rust public declarations: the
optional manifest resource member, its typed baseline struct, and the baseline's
digest/document members. The public-declaration budget moves from 3177 to 3181;
one extracted portal review component adds one TypeScript export (2466 → 2467).
File-size, package-count, and cycle limits are unchanged. Upgrade semantics stay
in the collection engine, not Connect adapters.

The mark-motion vocabulary adds one production module (730 → 731; app-ui
16 → 17): `mark-activity.ts`, the page-wide store that lets a save, failure,
upload or busy state anywhere in an app reach the app switcher's mark without
threading state through the tree. Its public API, the loop and entrance lists,
the signal and progress types, and `saveToneSignal` raise TypeScript exports
from 2622 to 2639; its wiring into `SaveNotice`, `AppSwitcher` and itself adds
four relative imports (1593 → 1597).

## Reviewed recovery and review boundaries

The user-experience recovery changes add five net production modules (717 → 722):
three desktop boundaries for main-process pairing, row-local action results, and
on-demand exact conflict review; shared permission-review state; and browser-local
draft recovery. The existing bounded text diff moves from editor to shared UI,
without retaining a forwarding adapter, so editor and desktop use one algorithm.
The obsolete record-subset scope description is deleted.

The new local-control conflict review is versioned (`review_version: 1`) and
checks the same decision ID and exact bytes as conflict resolution. Its typed
request/response and the mirror/agent boundary add 16 Rust public declarations
(3258 → 3274); no remote protocol, authorization scope, or control-plane payload
storage changes. Browser-local draft storage is separately versioned, isolated by
server/collection/path, and expires after seven days; it is not an offline replica
or a substitute for exact pending-write recovery. Restoring metadata uses the SDK
record session's conflict boundary, not an editor-side interpretation of mdbase.

Reviewed TypeScript exports become 2590 (from 2583), relative imports 1571 (from
1564), desktop modules 46 (from 43), and shared UI modules 16 (from 14). No package
dependencies, package-count, cycle, or file-size limits are increased. Regression
tests cover equivalent grant refreshes, changed access, pairing request reuse and
configuration recovery, unsent draft restore/discard and expiry, metadata conflicts,
demand-driven indexing, and browser dialog focus and action-local failures.

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

## Module and dependency structure

Production modules should normally remain between 100 and 600 lines. A cohesive
module may exceed that range; crossing it is a design prompt, not an invitation
to move unrelated functions into another large file.

`pnpm check:architecture` rejects relative source import cycles,
workspace-package dependency cycles, and the runtime/engine boundary seams it
names. These checks are architectural alarms rather than substitutes for review.

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
