# Fuzz targets for mdbn-core

`cargo-fuzz` targets, kept out of the workspace and out of CI. Run them in short
local sessions (nightly toolchain, `cargo install cargo-fuzz`):

```sh
cd fuzz
cargo +nightly fuzz run yaml_parse -- -max_total_time=300
cargo +nightly fuzz run yaml_write -- -max_total_time=300
cargo +nightly fuzz run body_merge -- -max_total_time=300
```

| Target | Property |
|---|---|
| `yaml_parse` | parsing never panics; an unchanged write is the identity; a parsed mapping re-emits and reads back exactly; adding a key keeps every other value |
| `yaml_write` | document + `\0` + a YAML mapping of changes: the write reads back as exactly the intended mapping and untouched entries keep their bytes |
| `body_merge` | base `\0` first `\0` second: the body merge never panics, is deterministic, satisfies the identity laws and commutes outside append-append; `body_edits` never panics |
| `regex_profile` | pattern `\0` text: validation never panics, and matching is deterministic |
| `cel` | any expression: compiling and evaluating never panics and is deterministic |

Crashes land in `fuzz/artifacts/`; add a regression test for each before fixing.
The deterministic property tests in `crates/core/tests/` cover the same
properties in CI with fixed seeds.
