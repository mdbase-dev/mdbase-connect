# Hosted execution Phase 0 baseline

Date: 2026-08-15 (Australia/Melbourne)

This freezes the legacy hosted execution baseline before the record-source
vertical slices. The measurements are diagnostic, not acceptance of the legacy
architecture.

## Source and environment

- Connect source: `6ea62cf2593e91a0e0b17e9e931ebf0ec23dc805`
- mdbase-rs source: `818866705dcc4b6dcfd3bbc1ba63f83fdaec406f`
- Linux 7.1.3 x86-64
- Node.js 24.13.0
- rustc/cargo 1.94.0
- Docker 29.7.2

The Phase 0 containment and measurement instrumentation was applied on top of
those pins. The run used the repository's disposable PostgreSQL and
S3-compatible services and exercised the real hosted provider executable.

## Reproduction

```sh
MDBASE_CONNECT_PROVIDER_E2E_BULK_COUNT=10000 \
MDBASE_CONNECT_PROVIDER_E2E_RUST_LOG='mdbase_connect::metrics=info,warn' \
fnm exec --using 24 pnpm e2e:provider
```

The same suite without `MDBASE_CONNECT_PROVIDER_E2E_BULK_COUNT` is the fast
100-record conformance tier. Deterministic 10,000, 100,000, and 1,000,000-record
fixtures can be generated as described in `docs/hosted-execution-testing.md`.
The legacy runtime is deliberately contained before the two largest tiers; those
tiers become required gates as the bounded record-source slices replace it.

## Result

The run completed successfully. It covered hosted setup and type resources,
point reads, queries, exact-document synchronization, semantic mutations,
authorization, browser and SDK compatibility, two-provider write races,
files/mirrors, authority transfer, pagination, restart, backup restore, token
rotation, revocation, and request-body limits.

| Measurement | Baseline |
| --- | ---: |
| Records | 10,003 |
| Mutation p95 | 54 ms |
| Snapshot construction | 1,392.98 ms |
| Change-page p95 | 31.94 ms |
| Warm point-read p95 | 55.62 ms |
| Warm query p95 | 175.40 ms |
| Provider RSS before measured warm operations | 77,320,192 bytes |
| Provider RSS after measured warm queries | 94,703,616 bytes |
| Cold point read | 1,132.65 ms |
| Cold point-read RSS increase | 35,532,800 bytes |
| Rows scanned/decrypted for one cold point read | 10,003 |
| Ciphertext read for one cold point read | 3,588,035 bytes |
| Cold query | 2,410.12 ms |
| Cold query RSS increase | 42,455,040 bytes |
| Rows scanned/decrypted for one cold query | 10,003 |
| Ciphertext read for one cold query | 3,588,035 bytes |
| Materialized plaintext estimate after warm operations | 2,305,677 bytes |

## Interpretation and gates

A cold point read performs the same collection-wide scan and decryption as a
cold query. The 10,003-record result therefore demonstrates the defect targeted
by the plan: point latency, IO, decryption work, and RSS scale with collection
cardinality even when only one record is requested.

The replacement gates are defined in
`config/hosted-execution-budgets.json`. In particular, a supported point read
must remain independent of unrelated collection cardinality and must not fetch
or decrypt an unrelated record. The 100 ms point-read p95 and 384 MiB steady RSS
targets are rollout gates, while semantic/security mismatches and ambiguous
mutation outcomes have zero tolerance.

The temporary `WorkingSet` cap, idle-age eviction, plaintext admission estimate,
and disabled query-result cache are deletion-bound containment only. They must be
removed with the legacy materialization path, not carried into the final design.
