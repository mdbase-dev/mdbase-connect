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

Pending. Record Connect, mdbase-rs, harness, schema, PostgreSQL, compiler/runtime,
container, fixture, configuration, and machine/container-limit revisions.

## Frozen workload corpus

Pending. Record every query/mutation shape, source consumer, input, selectivity,
fixture distribution, required fields, ordering/pagination, canonical expected
result, and whether a typed budget outcome is acceptable.

## Confidentiality inventory

Pending. Compare database/backup visibility for Candidate A encrypted scans,
Candidate B encrypted exact documents plus readable projections, and Candidate C
provider-readable exact documents plus projections.

## Projection, rebuild, and authorization protocol

Pending. Record exact state, transitions, CAS rules, snapshot binding, currentness
predicate, completion proof, crash recovery, grant/catalog behavior, and fail-closed
authorization rules.

## Physical schemas and indexes

Pending. Record exact DDL for every disposable benchmark variant and name every
indexed mutable/immutable column. Include no-GIN and GIN variants where applicable.

## Fixture manifests

Pending. Record deterministic generators and manifests for 10,000 records, 100,000
records, and approximately 1 GiB canonical Markdown across the required consumer
shapes.

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
