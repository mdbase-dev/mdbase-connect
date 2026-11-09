# Runtime documentation map

The runtime crate map and checks are in [`../README.md`](../README.md).

## Contracts (`contracts/`, source for `mdbn-wire`)

- [00-overview.md](contracts/00-overview.md) — contract overview, encoding and conventions.
- [intent.md](contracts/intent.md) — mutations and their operations.
- [log-entry.md](contracts/log-entry.md) — log entries and how they are applied.
- [log-service-api.md](contracts/log-service-api.md) — log service API.
- [policy.md](contracts/policy.md) — devices, members, grants and revocation.
- [sealed-envelope.md](contracts/sealed-envelope.md) — encryption, keys and signatures.
- [snapshot.md](contracts/snapshot.md) — snapshots, install and join.
- [replica-client-api.md](contracts/replica-client-api.md) — replica client API.
- [push-envelope.md](contracts/push-envelope.md) — push delivery envelope.
- [timer-service-api.md](contracts/timer-service-api.md) — timer service API.
- [oversized-markdown-bootstrap-memory.md](contracts/oversized-markdown-bootstrap-memory.md) — oversized Markdown bootstrap memory exception.
- [unindexed-blob-read-custody.md](contracts/unindexed-blob-read-custody.md) — unindexed Blob read custody.
- [open-questions.md](contracts/open-questions.md) — unresolved contract questions.
- `wire.cddl` — wire CDDL, checked against golden fixtures by `scripts/check-wire-cddl.sh`.
- `device-approval.cddl` — device-approval peer envelope CDDL.

## Semantics and library

- [spec-notes.md](spec-notes.md) — gaps and interpretations in the rc.5 spec draft.
- [library/README.md](library/README.md) — the standalone mdbase library (Rust and JS).

## Daemon and CLI

- [cli-data-commands.md](cli-data-commands.md) — data commands in the `mdbase` CLI.
- [backup-verification.md](backup-verification.md) — offline native backup verification.
- [bases-list-grouping.md](bases-list-grouping.md) — Bases list grouping.
- `account-collection-quota-message.txt` — quota message text read by the daemon and `scripts/generate-connect-problems.mjs`.
