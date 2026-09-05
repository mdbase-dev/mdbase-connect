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

## Verification evidence

- The merged bridge at `22143340` passed complete local Rust/TypeScript suites and local E2E; bundled defaults at `f07c11ee` also passed complete local suites (611 Rust tests; 1,720 JS/TS tests).
- Import-cycle/readiness extraction: protocol and client tests/typechecks passed; parent reran client tests before `50011926`.
- Server extraction: 463 tests passed, typecheck passed; parent reran server tests before `8a9dcb16`.
- Rust extraction: 611 workspace tests passed, strict workspace/all-target Clippy passed, and per-file architecture checks passed before `7f60a24e`.
- Exact-candidate CI, signed predecessor qualification, and environment acceptance must still pass. Updating reviewed counts does not waive those gates.
