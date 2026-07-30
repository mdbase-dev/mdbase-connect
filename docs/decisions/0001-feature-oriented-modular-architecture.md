# ADR 0001: Feature-oriented modular architecture

- Status: accepted
- Date: 2026-07-30

## Context

MDBASE Connect expanded from its initial MVP into local, relay, hosted,
replication, notification, portable-application, and authority-transfer
workflows in a short pre-release period. The system-level trust boundaries are
sound, but new vertical slices repeatedly entered central server, SDK,
registry, provider, desktop, and synchronization files.

The project needs lower change coupling and clearer invariant ownership before
its public APIs and operational contracts stabilize.

## Decision

Keep the existing deployable boundaries and refactor their internals into
feature-oriented modules. Use thin composition roots and public facades.
Separate transport translation, application orchestration, deterministic
policy, and infrastructure concerns when doing so clarifies ownership.

Do not create microservices solely to reduce file size. Do not introduce a
dependency-injection framework or an interface for every function. Preserve
direct calls where ownership and substitution are already clear.

Application use cases own transaction boundaries. Security checks remain at
the connector or provider that can make the final authorization decision.
Collection semantics stay in `mdbase-rs`.

Production source files have a default 1,000-line ceiling. Existing exceptions
are explicit and ratchet downward during extraction. Relative source and
workspace-package dependency cycles are prohibited.

## Consequences

- Feature work has one obvious implementation home.
- Public SDK imports can remain stable while internals change.
- Security and lifecycle review follows named policy and state-machine modules.
- Refactoring requires temporary compatibility facades and deliberate
  migration commits.
- Some code remains close together when transaction atomicity or a security
  invariant is clearer that way.
