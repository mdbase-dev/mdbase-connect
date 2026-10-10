//! # mdbn-takeover: the new daemon takes over old local Connect collections
//!
//! **Responsibility.** The library half of the local takeover
//! (local migration, steps T0–T6) and of its local rollback:
//! - [`takeover`]: stop the old connector, settle its in-flight engine transactions
//!   through the new daemon's guarded publish, copy the old state as evidence, hand
//!   the daemon the import, and fence the folder with the v2 marker;
//! - [`rollback`]: undo that for one folder, keeping the fence until restoration is ready;
//! - [`mirror_join`]: pure three-way revision classification proposals only;
//!   durable proof and guarded effects remain the host's responsibility.
//!
//! The side effects on the new daemon and the old service manager go through traits
//! ([`takeover::Daemon`], [`OldService`], [`rollback::NewDaemon`], …) that the daemon
//! implements, so the daemon depends on this crate and never on the migrator
//! composition crate (`mdbn-migrate`, which re-exports both modules).
//!
//! **Rules.**
//! - Old state is read only through `mdbn-legacy`. The only writes are the evidence
//!   copy (under the daemon's state), the v2 marker, and the moved-aside marker on
//!   rollback. Markdown is written only through the daemon's guarded publish.
//! - Native only, never linked into WASM.
//!
//! **Allowed dependencies.** Internal: `mdbn-legacy`. External: `serde_json`.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

pub mod mirror_join;
pub mod rollback;
pub mod takeover;

pub use mdbn_legacy::OldService;

use std::fmt;

/// Takeover and local rollback errors. Messages carry IDs and paths, never content.
#[derive(Debug)]
pub enum Error {
    /// Old state is unreadable or inconsistent.
    Legacy(String),
    /// The input contradicts the takeover's rules, or a step failed.
    Invalid(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Legacy(d) => write!(f, "legacy: {d}"),
            Self::Invalid(d) => write!(f, "invalid: {d}"),
        }
    }
}

impl std::error::Error for Error {}

/// Result alias.
pub type Result<T> = std::result::Result<T, Error>;
