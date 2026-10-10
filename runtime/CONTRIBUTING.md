# Contributing

## Flow

1. Branch from `origin/main` in your own worktree:
   `git worktree add <worktree>/<task> -b <phase>/<topic> origin/main`.
2. Make the change, with tests. Keep PRs to one concern.
3. Run `cargo xtask ci` (or at least fmt, clippy, `xtask arch` and tests).
4. Push and open a PR to `main`. The description says what changed, why, and how it
   was verified. Include any WASM size delta and any change to
   `spec-expectations.txt` or the determinism goldens.
5. CI must be green before review. The designated reviewer merges.

## Branch names

`phase<N>/<topic>` for plan work (`phase0/skeleton`, `phase1/merge`),
`spike/<id>-<topic>` for spikes, `docs/<topic>` for doc-only changes.

## Commits

- Imperative subject, about 72 characters max. The body explains why.
- Generated files are committed with the change that regenerates them:
  `Cargo.lock`, `conformance/spec-expectations.txt`, `conformance/spec/**`,
  `tools/wasm/package-lock.json`, `conformance/determinism/*.expected.json`.

## Adding a dependency

- Workspace-level version in the root `Cargo.toml` `[workspace.dependencies]`.
- Portable crates: pure Rust, builds for `wasm32-unknown-unknown`, no
  `getrandom`/`libc`/`regex`. `cargo xtask arch` checks the resolved tree.
  Measure the size delta.
- Licence must be on the `deny.toml` allow-list. Changing the list needs a
  reason in the PR.

## Toolchain

`rust-toolchain.toml` pins the compiler. Bump it in its own PR, and run the WASM
size and determinism checks.

## Code style

- `rustfmt` (config in `rustfmt.toml`) and clippy with `-D warnings`.
- Every crate starts with crate-level docs covering its responsibility, its rules
  and its allowed dependencies. Keep them true.
- Prefer small pure functions in `mdbn-core` with fixture tests over logic in the
  service or stores.
