# ADR 0006: Exact-document reconciliation owns filesystem sync

- Status: accepted for prerelease sync v1
- Date: 2026-08-06

## Context

The original prerelease mirror loop mixed inspection, mutation capture,
network writes, filesystem writes, and status inference. Obsidian separately
reimplemented enough of that logic to preview synchronization. Records carried
both parsed projections and reconstructed Markdown, so different runtimes could
agree semantically while changing line endings, comments, key ordering, a BOM,
or trailing whitespace. Expected collisions and cancellation also escaped as
exceptions with no reliable account of partial progress.

There is no released sync-v1 compatibility obligation or production collection
data to migrate. Retaining the old shape behind a new version would preserve
the complexity that this change removes.

## Decision

### Exact documents are authoritative

Every record-bearing v1 message contains one required UTF-8 `document`.
`revision` is exactly `sha256(document bytes)`. Frontmatter, body, matched
types, validation results, and indexes are projections of that document and
must never be used to reconstruct it. Authority-owned collection resources use
the same rule. Accepted local bytes remain byte-identical through upload,
change-feed replay, snapshots, and another client's materialization.

The v1 mutation vocabulary is deliberately small:

- `put(record_id, base_revision?, path, document)` creates or replaces exact
  bytes;
- `move(record_id, base_revision, path)` changes only the path; and
- `delete(record_id, base_revision)` removes the record.

A raw mirror move never rewrites links. Semantic rename plus reference updates
is a separate authority operation with an explicit `update_references` choice.

Sessions declare `protocol_profile: exact_document_v1`. Old prerelease durable
mirror state is rejected with `mirror_state_upgrade_required`; browser/plugin
storage uses a fresh database namespace. There is no compatibility decoder or
dual-write path.

Hosted beta storage crosses the same boundary once. Its migration preserves
collection identity, replica grants, resources, files, quotas, notification
grants, and the shared sequence head, but clears wrapper-shaped records,
record changes, snapshot leases, and replay journals. Opaque archived receipts
remain audit evidence and are marked retired so startup cannot rehydrate them.
Record-bearing notification outbox and runtime execution state are also
retired, while notification grants remain. Exact-document clients then enter
through the ordinary fresh-snapshot path.

### One reconciliation owner

The mirror engine is the only owner of reconciliation decisions. Its lifecycle
is:

```text
inspect both sides -> deterministic content-free plan -> revalidate -> apply -> checkpoint
```

The plan contains record, resource, and file actions; direction; operation;
stable identity where known; revision/digest; reason; predicted conflict; and
blocking issues. Actions and issues are sorted before hashing. The fingerprint
commits to the replica, mode, plan kind, both cursors, scope epoch, and all plan
effects, but contains no document or file bytes.

Inspection may read the authority, local files, durable state, and isolated
temporary validation state. It must not alter the vault, durable mirror state,
blob cache, authority, or cursor. Apply reacquires the device lease, fully
reinspects, and refuses a different fingerprint with `sync_plan_stale` before
performing any write.

Obsidian, the native CLI, background synchronization, and the Node adapter use
this engine. UI code may project a plan into labels and counts but may not
calculate another diff. The CLI exposes `mirror plan` and requires its
fingerprint for `mirror sync --plan`.

### A plan is one durable batch

Already-journaled mutations are the next batch. Edits made after that journal
entry remain local and appear in the following inspection; an apply never
quietly expands to include them. An idempotent mutation receipt may advance the
state before its change-feed echo arrives. That echo advances the cursor but
does not overwrite newer unplanned local bytes.

Resources remain authority-owned. Resource drift and unsafe/colliding physical
paths are blocking plan issues. Expected record conflicts, provider rejections,
local collisions, and cancellation are domain outcomes. Cancellation reports
the reviewed fingerprint, applied count, pending count, and last durable cursor.
Programmer errors, corrupt protocol messages, and unavailable infrastructure
remain errors.

`status()` performs inspection and therefore makes a freshness claim.
`checkpointStatus()` is the cheap, explicitly local durable view.

## Consequences

- Protocol v1 is intentionally rewritten in place before release.
- Exact source preservation becomes a protocol invariant instead of an adapter
  convention.
- Preview and apply cannot drift because there is one decision engine.
- Apply has a stable review boundary and crash/restart semantics.
- The beta.39 hosted migration intentionally discards prerelease record data
  without carrying a second decoder; non-record collection state survives.
- A later wire version is needed only after v1 is released and an incompatible
  deployed contract must coexist; it is not used to shelter prerelease code.

## Required proof

- TypeScript and Rust validate the same wire schemas and portable path corpus.
- Inspection is deterministic and side-effect free; stale plans make no writes.
- Unit/contract tests cover byte-odd Markdown, malformed frontmatter, Unicode
  aliases, forbidden paths, raw moves, files, conflicts, cancellation, lost
  replies, restart, cursor reset, and selective-sync rebuilds.
- Network tests synchronize at least two independent clients and compare exact
  SHA-256 values after convergence.
- Production verification rejects an old protocol profile and confirms the
  exact-document profile end to end.
