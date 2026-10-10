//! # mdbn-migrate-portable: the pure conversion rules of a legacy import
//!
//! **Responsibility.** The parts of the hosted migration procedure (hosted adoption,
//! H2/H2b) that every importer must apply identically, whether it runs natively
//! (`mdbn-migrate`) or inside the hosted Worker (the TypeScript import over the
//! legacy source, through a Worker WASM export over [`abi`]; not part of `runtime.wasm`):
//! - [`budget`]: the hosted runtime budgets every streaming step enforces;
//! - [`namespace`]: the same whole-namespace resolve as [`preflight::resolve`], page
//!   by page in bounded memory over a hashed spill, for the hosted Worker;
//! - [`hosted_import`]: the sans-IO hosted import driver (H0–H10): checkpoints,
//!   barriers, fence/drain, cutover and the budgeted state-diff replay;
//! - [`live_digest`]: the order-independent, windowed live-state digest both sides
//!   of a hosted import compute for the shadow compare;
//! - [`preflight`]: the portable path policy and NFC/case-fold collision check over
//!   one consistent legacy read, and the decided remediation (rename, report every
//!   rename, never drop);
//! - [`ids`]: legacy IDs and revisions in wire form;
//! - [`oversize`]: documents over the synced-record cap are imported as files at the
//!   same path and reported;
//! - [`json`]: the same preflight over a JSON description of the read, for the WASM
//!   ABI;
//! - [`prehistory`]: the pinned format of the sealed pre-history archive (legacy
//!   version history imported at `S0`, referenced from the `base` item).
//!
//! It works on **metadata only**: paths, IDs, sizes. No document, object key or
//! attachment bytes enter this crate, so nothing here is bounded by content size.
//!
//! **Rules.** Portable and deterministic, like `mdbn-core`: no I/O, no clocks, no
//! entropy, no hash-map iteration order. Reports carry names for deliberate review;
//! their `Debug` and error `Display` expose counts only.
//!
//! **Allowed dependencies.** Internal: `mdbn-core`, `mdbn-wire`, `mdbn-store-file`
//! (its portable SQL index ABI only, for the hosted import's spill, behind the
//! `sql-spill` feature that only the hosted Worker composition enables).

use std::fmt;

pub mod abi;
pub mod budget;
pub mod hosted_import;
pub mod ids;
pub mod live_digest;
pub mod namespace;
pub mod oversize;
pub mod preflight;
pub mod prehistory;
pub mod rows;

/// Conversion errors. Messages carry IDs and counts, never content.
#[derive(Debug)]
pub enum Error {
    /// The input contradicts the migration's rules (for example, a malformed ID).
    Invalid(String),
    /// Legacy names need explicit remediation; the complete report is attached.
    Paths(preflight::PathReport),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(d) => write!(f, "invalid: {d}"),
            Self::Paths(r) => write!(
                f,
                "legacy paths need review: {} invalid, {} collision groups",
                r.invalid.len(),
                r.collisions.len()
            ),
        }
    }
}

impl std::error::Error for Error {}

/// Result alias.
pub type Result<T> = std::result::Result<T, Error>;
