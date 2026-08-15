# Hosted storage-model benchmark

- Status: pending
- Decision: none
- Governing proposal: `docs/decisions/0011-server-trusted-queryable-hosted-execution.md`
- Stop gate: user review before storage-model selection or implementation continues

This directory is the tracked, durable evidence record for the hosted storage-model
decision. The local `.ops/` registry coordinates execution but is intentionally not
tracked by Git.

The implementation agent must replace the pending sections below with reproducible
artifacts and exact revisions. Do not use production content or production services.

## Revisions and environment

The frozen capture and sampling rules are in `measurement-protocol.md`. Exact run
revisions and machine/container values are populated by the Phase 3 harness rather
than copied by hand.

## Frozen workload corpus

Defined in `consumer-inventory.md`, `workload-contract.json`, and
`fixture-contract.json`. `selectivity-summary.md` and the three tracked fixture
expected-result artifacts are generated only after the mdbase-rs oracle verifies
the independent generator seed; until then this section is not frozen.
The corpus was derived from current TaskNotes, Reader, Editor, Pickle, MCP, Workout,
and generic SDK call sites. It distinguishes provider predicates from current
client-side filtering and distinguishes canonical results from acceptable typed
budget outcomes.

## Confidentiality inventory

Frozen in `confidentiality-inventory.md`. The Candidate B hypothesis deliberately
exposes the persisted/effective frontmatter required by current Editor/SDK contracts
while retaining encrypted exact Markdown and bodies; measurement does not presume
that this trade is acceptable or sufficient.

## Projection, rebuild, and authorization protocol

Frozen in `projection-authorization-protocol.md`. Unversioned persisted `types` are
not an authorization authority in any prototype.

## Physical schemas and indexes

Frozen under `schemas/`; `schemas/README.md` records the complete index policy. All
files pass PostgreSQL 18 syntax validation in isolated disposable databases.

## Fixture manifests

Pending canonical regeneration for 10,000 records, 100,000 records, and the first
complete record at or above 1 GiB of canonical Markdown. Large NDJSON payloads are
reproducible and intentionally ignored; their SHA-256 digests and exact terminating
record/byte counts will be tracked after oracle verification. Superseded generated
fixtures were preserved outside the worktree and are not evidence.

## Results

Pending. Include raw machine-readable samples plus summarized storage, WAL, HOT,
TOAST, vacuum, latency, throughput, rows, decryption, memory, CPU, IO, pool,
snapshot, cancellation, rebuild, and recovery results.

## Semantic and security evidence

Pending. Include differential results, candidate-completeness properties, stale
projection behavior, authorization races, failure injection, and typed budget
outcomes.

## Candidate assessment

Pending. State which frozen workloads each candidate satisfies, which fail, why,
and whether Candidate C materially improves a Candidate B failure enough to warrant
considering its confidentiality-irreversible change.

## Recommendation

Pending. A recommendation is evidence for user discussion, not an accepted decision.

## Decision log

No decision has been made. Stop and request user review after completing this record.
