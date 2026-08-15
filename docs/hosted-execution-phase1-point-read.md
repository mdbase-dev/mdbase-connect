# Hosted execution Phase 1: direct point reads

Date: 2026-08-15 (Australia/Melbourne)

## Delivered boundary

Canonical v0.3 point reads now use an immutable mdbase-rs `CompiledCatalog`
constructed from the authority's exact configuration plus resolved type and
record-contract resources. The same evaluator consumes either filesystem file
facts or one provider-supplied exact Markdown record. A differential test compares
the complete filesystem and provider read envelopes.

The hosted provider performs a `REPEATABLE READ READ ONLY` transaction from
resource-catalog load through the input record read. It supports both:

- HMAC path-token lookup for public path-addressed reads; and
- stable record-ID lookup for create, update, and rename response hydration.

Each lookup selects at most one `hosted_provider_records` row, authenticates the
encrypted payload with the collection/record/sequence AAD, verifies the decrypted
identity and requested path, and supplies only that record to mdbase-rs. Contract
projection now uses the provider-neutral resolved-contract projector and does not
require a `WorkingSet` or temporary collection directory.

## Semantic and security evidence

- mdbase-rs library suite: 123 passed.
- Connect runtime suite: 10 passed.
- hosted-provider library suite: 73 passed, 3 environment-gated tests ignored.
- full disposable PostgreSQL/object-store/browser/SDK provider suite: passed.
- contract projection, type scopes, optional exact documents, invalid/missing
  inputs, optimistic conflicts, multi-instance races, restart, backup restore,
  token rotation, and revocation remained compatible.
- stable-ID reads are exercised by mutation-result hydration; HMAC token reads are
  exercised by ordinary application and SDK reads.
- metrics expose only counts, bytes, lookup kind, time, pool occupancy, and process
  memory; no path, record, query, or plaintext content is logged.

## 10,003-record acceptance measurement

Command:

```sh
MDBASE_CONNECT_PROVIDER_E2E_BULK_COUNT=10000 \
MDBASE_CONNECT_PROVIDER_E2E_RUST_LOG='mdbase_connect::metrics=info,warn' \
fnm exec --using 24 node scripts/hosted-provider-e2e.mjs
```

| Measurement | Phase 0 legacy | Phase 1 direct |
| --- | ---: | ---: |
| Cold point read | 1,132.65 ms | 41.52 ms |
| Record rows fetched/decrypted | 10,003 | 1 |
| Record ciphertext read | 3,588,035 bytes | 356 bytes |
| Cold-read RSS increase | 35,532,800 bytes | 17,674,240 bytes |
| Legacy WorkingSet materialized | yes | no |
| Warm point-read p95 | 55.62 ms | 31.39 ms |

The cold point read is below the published 100 ms p95 point target in this local
acceptance environment and is independent of unrelated record cardinality. The
same run deliberately left queries on the legacy path: its cold query still
scanned all 10,003 rows and read 3,588,035 ciphertext bytes, which is the Phase 3
target rather than hidden follow-up work in this slice.

## Remaining deletion work

The catalog is compiled per point request in this slice. A globally byte- and
age-bounded resource-revision cache may be added after profiling, but correctness
does not depend on it. Legacy `WorkingSet` paths remain for queries, semantic
mutation preparation, resources, and lifecycle operations until their scheduled
vertical slices.
