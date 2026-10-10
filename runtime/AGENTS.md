# Agent rules for mdbase-next

Read `README.md` (crate map, checks) first. These rules apply to every change.

## Workspace and disk

- **Never build under `/tmp`.** A full `/tmp` broke the shell before. `target/` stays
  in your worktree; don't set `CARGO_TARGET_DIR` to anywhere outside it.
- Disk is shared and limited. Run `du -sh target` now and then; `cargo clean` when it
  passes ~10 GB.
- Work in your own worktree on your own branch. Don't touch other worktrees, and
  don't edit `main` in the primary checkout.
- The rc.5 spec draft is local only. Read it in place and **never push it**.
  Vendor its fixtures with `scripts/sync-spec-fixtures.sh`.

## Before you push

Run the same checks as CI:

```sh
cargo xtask ci          # everything (needs cargo-deny and `npm ci --prefix tools/wasm`)
```

Or the fast subset:

```sh
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings
cargo xtask arch
cargo test --workspace
```

CI must be green. Don't merge your own PR; the designated reviewer reviews and merges.

## Crate boundaries

- The allowed internal dependencies are in `RULES` in `xtask/src/arch.rs` and the
  README crate map. If you need an edge that isn't there, stop and ask. Don't
  widen the table to make your change compile.
- `mdbn-core` depends on no internal crate.
- Nothing depends on a store crate. Stores implement the replica's `Store` trait,
  and composition points wire them together.
- `mdbn-log-service` depends only on `mdbn-wire`. It must never be able to read
  plaintext.
- A new crate needs a `RULES` row, `[lints] workspace = true`, crate-level docs
  stating its responsibility and allowed dependencies, and a README row.
- `mdbn-wire` is filled from `docs/contracts/`. Don't invent wire
  types ahead of the contracts.

## Determinism (portable crates: core, wire, replica, store-file, wasm)

- No I/O: no `std::fs`, `std::env`, `std::net`, `std::process` or `std::thread`.
  Files go through `FilePlatform`, and the index through `IndexStorage`.
- No clock, no OS entropy. Use `mdbn_core::host::Clock` and `Entropy`, passed in by
  the caller. Nonces come from a CSPRNG seeded from `Entropy`, never from a
  configured seed.
- No `HashMap`/`HashSet`. Use `BTreeMap`/`BTreeSet`, or an insertion-ordered map
  where order is semantic.
- Never hash or serialise a `usize`, because WASM is 32-bit. Widen to `u64`
  explicitly.
- No transcendental float functions (`powf`, `exp`, `ln`, `sin`, ...).
- Regex is `regex-lite` everywhere. Never the `regex` crate, and never
  the host's regex engine.
- Never `#![allow(clippy::disallowed_*)]` in a portable crate. `cargo xtask arch`
  rejects it.
- If you change replay semantics on purpose, update
  `conformance/determinism/*.expected.json` in the same commit and say why.

## Conformance

- Fixture ids in `conformance/spec-expectations.txt` only move from `pending` to
  `pass` (`spec-conformance --bless`). Turning a `pass` back to `pending` needs
  `--accept-regressions` and a reason in the PR.
- Don't edit `conformance/spec/` by hand. Change the spec, then re-sync.

## Size

- Standalone apps, including TaskNotes, have no bundle/WASM size limit. `cargo xtask wasm-size`
  and `wasm-app` report raw/gzip/brotli sizes;
  size is never a PR/CI gate. Do not size-qualify app changes or run size experiments.
- Historical targets/ceilings in `tools/wasm/budget.json` are informational only.
  The small-bundle concern is limited to the post-production Obsidian plugin.
  Runtime request/response, work, memory and architecture bounds remain unchanged.
