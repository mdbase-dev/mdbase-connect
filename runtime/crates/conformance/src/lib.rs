//! # mdbn-conformance: conformance harnesses
//!
//! **Responsibility.** Native harnesses that run shared fixtures against the core:
//! - [`spec`]: the spec conformance runner over the vendored rc.5 fixtures in
//!   `conformance/spec/`, with a pending/pass ratchet in
//!   `conformance/spec-expectations.txt`;
//! - the `replay` binary: the native side of the native-vs-WASM determinism check
//!   (`cargo xtask determinism`), calling the same [`mdbn_wasm::replay`] that the
//!   WASM module exports.
//!
//! Later Phase 0 conformance suites (store, file platform, log service) belong here
//! too, as library functions each implementation's tests call.
//!
//! **Rules.** Native only; reads fixture files, so it is exempt from the
//! portability lints. It must not contain semantics: an operation adapter in
//! [`ops`] only translates fixture input into a core call and the result back.
//!
//! **Allowed dependencies.** Internal: `mdbn-core`, `mdbn-wasm`.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::path::PathBuf;

pub mod collection;
pub mod ops;
pub mod ops_b;
pub mod parser_performance;
pub mod query_differential;
pub mod spec;
pub mod yaml;

/// The repository root: `$MDBN_REPO_ROOT` when set (a binary built on a
/// remote builder and run locally), else two levels above this crate.
pub fn repo_root() -> PathBuf {
    match std::env::var_os("MDBN_REPO_ROOT") {
        Some(root) => PathBuf::from(root),
        None => PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
    }
}
