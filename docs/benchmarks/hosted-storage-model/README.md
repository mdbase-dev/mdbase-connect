# Hosted storage-model benchmark

- Status: benchmark complete; Candidate B selected; production implementation active
- Decision: Candidate B-no-GIN baseline, accepted 2026-08-16
- Governing decision: `docs/decisions/0011-server-trusted-queryable-hosted-execution.md`
- Production gate: explicit user approval before existing-data migration or traffic enablement

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

Frozen in `consumer-inventory.md`, `workload-contract.json`,
`fixture-contract.json`, `selectivity-summary.md`, and the three tracked fixture
expected-result artifacts. Each expected artifact was independently seeded, then
recomputed and accepted only after exact mdbase-rs equivalence.
Tracked `expected-results-v2.json` artifacts freeze the same canonical workloads
under the rebuild catalogue so post-rebuild validation does not run an oracle inside
the measured provider process; their digests are recorded in each fixture manifest.
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

Tracked manifests cover 10,000 records / 46,208,841 bytes, 100,000 records /
465,653,392 bytes, and 230,128 records / 1,073,743,117 canonical Markdown bytes.
Large NDJSON payloads are reproducible and intentionally ignored; their SHA-256
digests are tracked. Superseded generated fixtures were preserved outside the
worktree and are not evidence.

## Results

Complete in `results/2026-08-16-postgres18-local/`. `report.md` is the reviewed
narrative; `summary.json` contains deterministic distributions and gates;
`raw/samples.ndjson` retains all 3,981 schema-valid samples. The run covers storage,
WAL, HOT, TOAST, vacuum, latency, throughput, rows, decryption, memory, CPU, IO,
pool, snapshot, cancellation, rebuild, and recovery evidence.

## Semantic and security evidence

Complete. Canonical differential results, candidate completeness, stale/absent and
corrupt projection behavior, grant-backed authorization races, CAS/catalogue races,
fault injection, durable recovery, and typed budgets are in the raw and summarized
evidence. No semantic, authorization, or ambiguous-recovery mismatch was observed.

## Candidate assessment

No candidate passes the frozen gates. Candidate B-no-GIN is the strongest research
baseline but fails default ordering, metadata-latency, and largest-tier cancellation
gates. GIN adds substantial rebuild/WAL/vacuum cost without a material gate win.
Candidate C does not materially turn a B common-workload failure into a pass and is
not recommendation-eligible.

## Selected follow-up

Candidate B is selected as the production architecture, beginning from B-no-GIN.
The selection preserves encrypted exact Markdown and body prose while accepting
provider-readable semantic projections. Production work must correct the prototype
projector by extracting and persisting structurally significant body relationships
through mdbase-rs, and must replace repeat-to-completion top-K behavior with true
bounded deterministic pages.

The report remains an immutable record of the original comparison. Its failed
ordering, latency, and cancellation gates are implementation targets, not permission
to change frozen expected results or silently widen budgets.

## Decision log

- 2026-08-16: Candidate B selected. Candidate B-no-GIN is the physical baseline;
  narrow indexes require new plan and write-pressure evidence. Candidate C remains
  rejected because it did not materially resolve B's common-workload failures.
- Existing beta/production data migration and production traffic remain gated on a
  final explicit user approval after staging and rollout review.
