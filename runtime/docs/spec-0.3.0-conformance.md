# Stable mdbase 0.3.0 conformance audit

## Provenance and scope

The full v0.3 suite and its referenced artifacts are vendored from
`mdbase-dev/mdbase-spec` **merge commit
`0f10c9eed906adf8312a33e91baa6e51744f6a03`**, not a PR head. This includes
the six collection-timezone matching cases added before PR #69 merged.
`conformance/spec/SOURCE` records the revision and every vendored file hash.
The runtime declares spec 0.3.0 and planner semantics 1.3 in
`crates/core/src/semantics.rs`.

| Measurement | Pass | Total | Remaining |
| --- | ---: | ---: | --- |
| Previously committed selection | 357 | 359 | 2 expected failures |
| Original release report, rc behavior | 381 | 483 | 12 mismatches, 90 unknown operations |
| Original suite, stable expectations, before this change | 379 | 483 | 14 mismatches, 90 unknown operations |
| Original suite after this change | 407 | 483 | 76 explicit unsupported cases |
| Merged suite after this change | **413** | **489** | **76 explicit unsupported cases** |

The final run has zero mismatches, zero `UnknownOperation`s and zero skips.
The conformance ratchet passes; this is **not** a claim that all 489 cases or
all optional companion profiles are implemented. Every remaining case is
individually listed as `pending # out of scope: ...` in
`conformance/spec-expectations.txt`. Previously passing cases remain passing.

## Original mismatches: classification and evidence

| Case | Classification | Evidence and change |
| --- | --- | --- |
| `cel_match.nondeterministic_match_warning` | Engine fixed | Stable chapter 10 requires an error and exclusion, despite the historical fixture ID. Catalog loading now rejects the type. |
| `cel_match.match_deterministic_ok` | Engine fixed | The operation also reports the neighboring invalid type's load diagnostic. It now has error severity, while deterministic matching still works. |
| `paths.discovered_collision` | Engine fixed | `cross_record_issues` lacked the required discovery warning. All records sharing the path key are retained and warned, with sorted physical paths. A StateView path-key candidate lookup preserves bounded targeted validation instead of hydrating the whole collection. |
| `cel_query.context_links` | Engine fixed | Query activation lacked reserved `this`. Core and projected replica executors now resolve one immutable context candidate and retain its link origin. |
| `cel.date_timestamp_conversion` | Adapter fixed | The fixture's IANA invocation timezone was not passed to Core. The adapter now captures the real named zone rather than silently using UTC. |
| `cel_query.filter_error_excludes_record` | Adapter fixed | Core already excluded the record and emitted a diagnostic. The adapter now evaluates `diagnostics_contain` against actual diagnostics. |
| `cel.query_body_filter` | Adapter fixed | Core's body filter worked; the envelope omitted `body_returned`. It now derives the assertion from the actual returned records, including selected rows. |
| `collection.unique_collection_scope` | Adapter fixed; engine correct | Setup conflicts on collection-unique `code: K-1` with `notes/n.md` AND glob-unique `slug: alpha` with `tasks/active/b.md`. Both issues are correct. `issues_contain` is a subset assertion, not exact equality; no uniqueness semantics changed. |
| `runtime.standard-contract-registry` | Adapter fixed | The adapter flattened resource paths and did not expand fixture globs or load sibling schema resources. It now passes the actual relative resources to Core's contract registry. |
| `runtime.workflow-implementation` | Adapter fixed | Same artifact-loading defect; output also omitted the actual implementation contract/version. The existing engine validates this companion declaration; execution is a separate unsupported capability. |
| `v0.3/views/view-records.yaml@g0.t12` | Adapter fixed | Invalid query parse/compile failure is now exposed in both error and diagnostic envelopes, with its actual location. |
| `v0.3/views/view-records.yaml@g0.t13` | Adapter fixed | Same invalid-query envelope mapping, without manufacturing an expected diagnostic. |
| `v0.3/views/view-records.yaml@g0.t15` | Adapter fixed | Same invalid-query envelope mapping. |
| `v0.3/views/view-records.yaml@g0.t16` | Adapter fixed | Same invalid-query envelope mapping. |

No suspected spec defect remains among these cases. In particular, the extra
uniqueness issue and the stable nondeterminism error are required behavior,
not reasons to weaken Core or rewrite the suite.

## New collection-timezone cases: engine fixed

All six pass: `cel_match.configured_timezone_valid`,
`cel_match.configured_timezone_membership`,
`cel_match.invocation_timezone_utc_ignored`,
`cel_match.invocation_timezone_los_angeles_ignored`,
`cel_match.missing_timezone_error`, and
`cel_match.missing_timezone_excluded`.

`date(timestamp)` and `startOfDay(string)` use only configured collection time
rules. With no collection timezone they invalidate the type at load, even if
an invocation supplies a timezone. `today()` remains invalid even with a
configured timezone because it also depends on the clock. Focused Core tests
cover indexed file dependencies, macro shadowing, timezone-independent
overloads, invocation-zone independence, collision removal, context origins
and context paths containing link punctuation.

## Previously unsupported cases: thin adapter mappings

The following 14 previously unknown cases now pass using existing Core APIs:

- `v0.3/migration/pickle-collection-migration.yaml@g0.t2`
- `v0.3/migration/pickle-collection-migration.yaml@g0.t3`
- `v0.3/migration/pickle-collection-migration.yaml@g0.t4`
- `v0.3/migration/tasknotes-type-migration.yaml@g0.t7`
- `v0.3/migration/tasknotes-type-migration.yaml@g0.t8`
- `runtime.standard-pack-resources`
- `runtime.standard-contract-artifacts`
- `v0.3/schema/schema-artifacts.yaml@g0.t2`
- `v0.3/schema/schema-artifacts.yaml@g0.t3`
- `v0.3/schema/schema-artifacts.yaml@g0.t9`
- `v0.3/schema/schema-artifacts.yaml@g0.t12`
- `v0.3/schema/schema-artifacts.yaml@g0.t16`
- `v0.3/schema/schema-artifacts.yaml@g1.t2`
- `v0.3/schema/schema-artifacts.yaml@g2.t2`

These are artifact parse, inspection, supported-profile schema-validation and
pack-resource operations, not migration or workflow engines. Missing files or
empty glob matches explicitly fail the mapping rather than passing vacuously.
Unsupported schema keywords and unavailable references are not misreported as
invalid instances: the adapter refuses to claim validation outside Core's
declared JSON Schema profile.

## Remaining cases: out of scope

| Count | Reason |
| ---: | --- |
| 17 | Event/action transport, provider registration and capability authorization are not Core engine features. |
| 16 | Artifacts use JSON Schema keywords outside Core's declared subset. |
| 8 | Full 2020-12 metaschema/embedded-schema validation is not Core's subset compiler. |
| 5 | Legacy type migration is not a Core collection operation. |
| 12 | Companion workflow admission, execution and journal transport are not runtime engine features. |
| 1 | Companion legacy-record admission is not a Core collection operation. |
| 2 | Artifact schema compilation requires references outside Core's supported schema profile. |
| 15 | Portable saved-view discovery/invocation is not implemented; Obsidian Bases is a distinct format, not a compatible substitute. |

All 76 IDs and their individual reasons are authoritative in
`conformance/spec-expectations.txt`. They execute and return explicit
`NotImplemented(reason)`, not `UnknownOperation`, skips or fabricated success.

## Collection impact

The repository, TaskNotes and Reader sources, structured collection artifacts,
fixtures, and vendored standard packs were searched for match expressions and
clock, external-record and timezone dependencies. The structured scan found
match rules in 17 repository files, 10 TaskNotes files, 278 Reader files and
10 standard-pack files, all using non-expression rules. A separate Rust/TS
source search covered embedded expression fixtures. No shipped product type
match expression was found that becomes invalid. Product uses of `today()`
and `now()` found in queries or Bases formulas are unaffected.

Three deliberate runtime fixtures used clock-dependent match expressions:
Core's nondeterminism test and the replica's membership test now assert invalid
type exclusion. The native raw-inventory test now uses a deterministic
`has(raw.due)` expression: it still deliberately disables the optional query
index, preserving its original raw-inventory independence assertion without
relying on a now-invalid type. The spec's intentionally invalid match fixtures
remain byte-for-byte upstream. This is a checked-source audit, not a scan of
private user collections or a claim about uninspected downstream installations.

## Reproduction

Rust commands run through `rcargo` on the build VM. To run the full ratchet
locally after pulling its binary:

```sh
cd runtime
rcargo --pull spec-conformance build --locked -p mdbn-conformance --bin spec-conformance
MDBN_REPO_ROOT="$PWD" target/debug/spec-conformance --verbose
```

Do not blindly bless again: preserve the reviewed per-case pending reasons.
The normal runtime workspace tests, clippy and architecture gate, repository
`pnpm ci:local`, request-path `pnpm e2e`, and changelog validation are recorded
with their actual results in the implementation PR.
