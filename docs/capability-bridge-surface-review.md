# Capability bridge implementation-surface review

PR #397 introduces capability v2 while retaining explicitly versioned predecessor semantics. This records the evidence-backed surface-budget changes allowed by `docs/code-quality.md`; it is not release qualification.

## Structural corrections before updating counts

- Removed both newly introduced relative import cycles. The legacy manifest types now live alongside their base protocol types; the SDK operation defaults have one acyclic owner.
- Deleted the redundant `legacy-manifest.ts` production module.
- Moved readiness verification into its existing SDK readiness module and declaration option resolution into existing runtime utilities.
- Moved contract-choice validation into existing grant policy and relay compatibility/locking helpers into the existing relay-compatibility module.
- Extracted existing authority-store tests into a test-only child module. No production logic is classified as test code.
- Moved grant security helpers into existing scope validation and setup-choice validation alongside replica evidence verification.
- Extracted HTTP replica handlers as a cohesive enrollment/policy/rotation/revocation module.

All production files satisfy their existing line limits after these changes. The 1,000-line rule, existing legacy line exceptions, cycle detection, external guards, and dead-code inventory are unchanged.

## Reviewed production additions

The net increase from the checked-in baseline is nine files:

| Package | Addition | Responsibility |
| --- | --- | --- |
| Desktop | `src/renderer/application-capabilities.ts` | Typed permission presentation and unavailable-declaration handling |
| Editor | `scripts/validate-manifest.mjs` | Explicit versioned validation for the bridge's predecessor declaration |
| Portal | `src/authorization-capabilities.ts` | Exact v1 versus atomic v2 consent and file selections |
| Hosted provider | `src/http/replicas.rs` | Versioned replica policy HTTP boundary extracted from the composition root |
| Rust protocol | `src/application_capabilities_generated.rs` | Generated immutable v1/v2 operation mapping |
| Rust protocol | `src/application_declaration.rs` | Node-compatible commitment verification and exact setup projection |
| SDK | `src/application-contract.ts` | Explicit v1/v2 declaration compilation and API selection rules |
| SDK | `src/structured-readiness.ts` | Independent files/contracts/setup/notification readiness |
| Server | `src/application-requirements.ts` | Server-local versioned requirements and exact legacy file/operation compilation |

The Editor bridge validator and version-specific compatibility branches have deletion gates in ADR 0013. The generated catalogs and authenticated setup verifier are permanent enforcement boundaries, not temporary compatibility aliases.

## Count changes

| Reviewed metric | Previous bound | Reviewed bound |
| --- | ---: | ---: |
| Production files | 666 | 675 |
| Relative imports | 1,389 | 1,430 |
| Rust public visibility references | 3,112 | 3,155 |
| TypeScript export references | 2,318 | 2,386 |

Visibility/export counts conservatively include generated catalog identifiers, legacy SDK APIs/types retained for source compatibility, structured readiness types, declaration verification, and named internal helpers extracted to preserve module ownership and line limits. They do not imply that all helpers are public network APIs. Per-package file bounds increase only for the additions listed above. No spare headroom is added.

## Compatibility-prelude additions

The approved prelude introduces a separate artifact-bound fresh-issuance policy,
without modifying either immutable reader catalog. Its generated constant and
predicate add two public declarations in each language. Rust also adds one shared
persisted-semantics decoder, one local issuance guard, and two hosted policy guards
(four restricted-visibility declarations). TypeScript adds the server issuance
assertion and three exports in existing authorization test support. One relative
import connects that assertion to the existing structured HTTP error type.

The resulting reviewed totals are 3,161 Rust public declarations, 2,392 TypeScript
export declarations, and 1,431 relative imports. Production-file count remains
675: a redundant legacy test-helper file was consolidated into existing test
support before review. No per-file limit, package file allowance, cycle rule, or
external guard changes. Corrective migration 0041 and its tests preserve 0039/0040
bytes; these counts do not qualify any new rollback endpoint.

## Verification evidence

- The merged bridge at `22143340` passed complete local Rust/TypeScript suites and local E2E; bundled defaults at `f07c11ee` also passed complete local suites (611 Rust tests; 1,720 JS/TS tests).
- Import-cycle/readiness extraction: protocol and client tests/typechecks passed; parent reran client tests before `50011926`.
- Server extraction: 463 tests passed, typecheck passed; parent reran server tests before `8a9dcb16`.
- Rust extraction: 611 workspace tests passed, strict workspace/all-target Clippy passed, and per-file architecture checks passed before `7f60a24e`.
- Exact-candidate CI, signed predecessor qualification, and environment acceptance must still pass. Updating reviewed counts does not waive those gates.

## Browser SDK size review — compatibility prelude

Measured with Node 24.19.0 and each checkout's frozen dependency lock, using the
unchanged `packages/client/scripts/build-browser.mjs` configuration:

| Source | Raw bytes | Gzip bytes |
| --- | ---: | ---: |
| Published beta.94 source `8d1b5fb1647edcadd716d4ee671f0ba04d34fa5e` | 230,850 | 58,770 |
| Prelude `01f74ecd7106ddcb63bdc0ef0d63f951416f9161` | 240,726 | 61,440 |
| Source-to-source increase | 9,876 | 2,670 |

The prelude has 4,096 gzip bytes and 21,418 raw bytes remaining under the hard
ceilings. Its 7,785-byte increase over the checked-in gzip baseline is **not**
entirely new in this change: beta.94 already exceeds that baseline by 5,115 bytes.
The actual 2,670-byte increase still warrants review against the 2,048-byte
per-change allowance. Both builds exceed the 57,344-byte review threshold.

An in-memory esbuild build with the same options and `metafile: true` reproduces
the exact sizes. Its largest raw output contributions to the increase are:

| Input | Raw output delta |
| --- | ---: |
| `src/structured-readiness.ts` | +4,053 |
| `src/application-contract.ts` | +1,835 |
| Protocol `capabilities.js` | +1,173 |
| `src/application-session.ts` | +985 |
| `src/session.ts` | +974 |
| `src/connection.ts` | +843 |

These are raw minified input contributions, not independent gzip costs; gzip
compression and minifier naming cross module boundaries. The new readiness and
application-contract code owns exact contract checks, version-aware selection,
and independent readiness reporting. The dual capability catalog preserves
immutable legacy semantics while reading v2; deleting it to meet the old size
baseline would violate the compatibility boundary. The client package dependency
manifest, browser build configuration, and bundle budget are unchanged from
beta.94. This review retains those behaviors and does not raise any threshold or
claim a browser latency benchmark.

Reproduce each ordinary build with `pnpm install --frozen-lockfile`, then
`pnpm --filter @mdbase-dev/connect-protocol build` and
`pnpm --filter @mdbase-dev/connect build`, under Node 24.19.0 in separate source
checkouts. Local evidence: `/tmp/prelude-sdk-baseline-build.log`,
`/tmp/prelude-sdk-baseline-analysis.json`, and
`/tmp/prelude-sdk-bundle-analysis.json`. These are source-build size measurements,
not signed SDK artifact or downstream consumer qualification.
