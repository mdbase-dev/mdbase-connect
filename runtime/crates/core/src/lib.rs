//! # mdbn-core: the pure, deterministic core
//!
//! **Responsibility.** All mdbase semantics that must agree across replicas: parsing
//! and format-preserving YAML patching, the catalog and types, lifecycle, the CEL
//! profile (with the `regex-lite` flavour), links, three-way merge, intent planning,
//! the query IR and candidate/residual compilation (replicated semantics). Every other
//! layer calls into this crate, natively and as WASM.
//!
//! **Rules.**
//! - No I/O of any kind: no files, environment, clock, threads, network or OS
//!   entropy. Time and randomness enter only through [`host::Clock`] and
//!   [`host::Entropy`], passed in by the caller.
//! - Output is a pure function of input and is bit-identical natively and in
//!   WASM (deterministic replay). No hash-map iteration (use `BTreeMap`/`BTreeSet`), no
//!   `usize` in anything that is hashed or serialised (WASM is 32-bit), and no
//!   transcendental float functions.
//!
//! **Allowed dependencies.** No internal crates. External crates only if they are
//! pure Rust, build for `wasm32-unknown-unknown` without host imports, and do not
//! pull in `getrandom`, `libc` or `regex`. Enforced by `clippy.toml`, `deny.toml`
//! and `cargo xtask arch`.

//!
//! **Modules so far.** [`value`] (the frontmatter data model), [`yaml`] (the
//! YAML profile: span-tracking parser, composition, style-aware emitter),
//! [`doc`] (Markdown and YAML document records), [`writer`] (format-preserving
//! frontmatter writes, spec 12A), [`paths`] (path keys, collisions, path
//! patterns, globs), [`merge`] (the three-way record merge, body merge and
//! body edits), [`moves`] (move detection), [`regex`] (the regex profile),
//! [`cel`] (the CEL engine), [`unicode`] (pinned NFC and case
//! folding) and [`replay`]
//! (the native-vs-WASM determinism witness). Spec interpretations are listed in
//! `docs/spec-notes.md`.

pub mod cel;
pub mod doc;
pub mod host;
pub mod merge;
pub mod moves;
pub mod paths;
pub mod regex;
pub mod replay;
pub mod unicode;
pub mod value;
pub mod views;
pub mod writer;
pub mod yaml;

// core-B: catalog, validation, lifecycle, links, intent planning, query IR.
pub mod contracts;
pub mod ids;
pub mod intent;
pub mod jsonschema;
pub mod lifecycle;
pub mod links;
pub mod packs;
pub mod plan;
pub mod query;
pub mod semantics;
pub mod setup;
pub mod state;
pub mod types;
pub mod validate;

pub use plan::{PlanOptions, Planned, Rejection, Stage, plan};
pub use state::{MemState, Overlay, StateView};
