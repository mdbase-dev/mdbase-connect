# Maintainability handbook

This handbook turns the architectural direction in
[Code quality](./code-quality.md) into the day-to-day practices used to keep
mdbase connect understandable as it grows.

## Make ownership obvious

A reader should be able to answer four questions from the module layout:

1. Which feature owns this behavior?
2. Which function or state machine makes the policy decision?
3. Which adapter performs the side effect?
4. Which test proves the invariant?

Keep entry points and package indexes as composition roots or compatibility
facades. Put behavior in feature modules named for the domain concept. Avoid
new generic `utils`, `common`, or `services` modules; shared code should
represent a stable concept with a narrow contract.

Production modules are capped at 1,000 lines by `pnpm check:architecture` and
should usually be 100–600 lines. Crossing the normal range is a design prompt,
not an invitation to move unrelated functions into another large file.

## Preserve dependency direction

Transport adapters validate and translate. Application use cases coordinate.
Domain policy decides. Repositories and network clients perform side effects.
Dependencies point toward policy, never from policy back to a web framework,
database row, browser API, Electron process, or filesystem.

Cross-feature calls use a named public seam. Do not import another feature's
repository internals. Rust crate and workspace package cycles are prohibited,
as are cycles between relative source modules.

## Refactor safely

Prefer a sequence that keeps every commit reviewable:

1. Characterize existing behavior with a focused test.
2. Extract a cohesive module without changing the contract.
3. Move policy behind a narrow typed seam.
4. Add denial, malformed-input, retry, and recovery coverage as relevant.
5. Remove the obsolete path and update the architecture documentation.

Separate behavior changes, migrations, and mechanical movement when doing so
makes review or rollback safer. Never split an authorization decision from the
transaction or authority that must enforce it.

## Review checklist

Reviewers check:

- authorization and privacy at the final authority, including retry paths;
- one owner for each lifecycle and transaction;
- exhaustive tagged states instead of interacting booleans;
- stable structured errors at process and package boundaries;
- cancellation, cleanup, idempotency, and timeout behavior;
- logs that omit secrets, record payloads, and local paths;
- protocol compatibility in both Rust and TypeScript;
- focused regression coverage and the relevant end-to-end journey; and
- documentation for changed user, operator, security, or architectural
  behavior.

Security-sensitive paths are listed in `.github/CODEOWNERS`. The current
single-maintainer mapping is deliberately explicit and can be replaced with
team aliases without changing protected paths.

## Required local checks

Use the narrowest checks while iterating. Before handoff, run:

```bash
pnpm install --frozen-lockfile
pnpm version:check
pnpm check:release-readiness
pnpm audit:dependencies
pnpm check:architecture
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm build
pnpm typecheck
pnpm test
pnpm package:audit
```

`pnpm test:fast`, `pnpm test:integration`, and `pnpm test:system` are the
canonical test tiers. `pnpm test:all` is the exhaustive local entry point;
select individual system suites while iterating rather than repeatedly paying
for unrelated environments.

Run the browser persistence and accessibility suites for browser, portal, or
desktop changes. Run the local, relay, sync, provider, and containerized
journeys for changes that touch their boundary. See
[Testing](./testing-environment.md) for environment details.

## Release discipline

Dependency updates are reviewed weekly and high-severity audit findings fail
CI. Beta releases may carry the explicitly documented external risks in
`config/release-readiness.json`; a stable release runs the same checker with
`--stable` and cannot pass until every gate is complete and contains an
evidence reference.

Update design records and the release-readiness manifest in the same pull
request as the decision they record. An empty checkbox is not evidence:
reviews, drills, signing verification, and operational controls need durable,
dated artifacts.
