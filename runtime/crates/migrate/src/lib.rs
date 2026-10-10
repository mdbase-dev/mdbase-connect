//! # mdbn-migrate: moving collections off mdbase Connect
//!
//! **Responsibility.** The migration procedure in the migration design:
//! - **hosted adoption**: build generation 0 from the old provider's rows
//!   ([`gen0`]), seal and upload attachments ([`reseal`]), and verify the new replica
//!   against the old rows ([`shadow`]);
//! - the re-seal cost and time **estimate** ([`estimate`]);
//! - **rollback** ([`rollback`]), local and hosted, before and after cutover;
//! - the **local takeover** ([`takeover`]): no conversion; the daemon-facing
//!   part is a trait;
//! - the **pre-history archive** ([`prehistory`]): legacy version rows become
//!   sealed archive segments referenced from `base`;
//! - the **rehearsal harness** ([`rehearsal`]): synthetic real-shaped data, the
//!   write ledger and test oracle, plus the `mdbn-rehearse` command.
//!
//! The pure conversion rules (path preflight and renames, IDs, the oversized-document
//! rule) live in `mdbn-migrate-portable`, shared with the hosted Worker import through
//! `mdbn-wasm`; this crate adapts them to `mdbn-legacy`'s row types.
//!
//! It reads old state only through `mdbn-legacy`, which is read-only by construction.
//! New-system state is written only through the replica's interfaces (`Store`,
//! `LogClient`, `crypto`).
//!
//! **Not yet wired:** appending the `base` item and installing generation 0 into the
//! hosted replica. The replica answers a `base` with "not supported by this build"
//! (`replica/apply.rs`). The interface request is in
//! the migration request protocol. [`gen0::Gen0`] is the
//! data that call takes.
//!
//! **Rules.** Never prints or logs content. Reports carry IDs, counts and digests
//! only. Native only.
//!
//! **Allowed dependencies.** Internal: `mdbn-migrate-portable`, `mdbn-legacy`, `mdbn-core`, `mdbn-wire`,
//! `mdbn-replica`, `mdbn-store-file`, `mdbn-platform-native`, `mdbn-store-pg` (a
//! composition point; nothing depends on it).
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

pub mod estimate;
pub mod gen0;
pub mod ids;
pub mod preflight;
pub mod prehistory;
pub mod rehearsal;
#[cfg(any(test, feature = "hosted-service"))]
pub mod reseal;
pub mod rollback;
pub mod shadow;
pub mod takeover {
    //! The local takeover, implemented in `mdbn-takeover` (re-exported).
    pub use mdbn_takeover::takeover::*;
}

use std::fmt;

/// Migration errors. Messages carry IDs and paths, never content.
#[derive(Debug)]
pub enum Error {
    /// Old state is unreadable or inconsistent.
    Legacy(String),
    /// The new log service refused or failed a request.
    Log(String),
    /// Sealing failed.
    Crypto(String),
    /// Legacy names need explicit remediation; detailed paths are not logged.
    Paths(preflight::PathReport),
    /// The input contradicts the migration's rules (e.g. a non-UTF-8 resource).
    Invalid(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Legacy(d) => write!(f, "legacy: {d}"),
            Self::Log(d) => write!(f, "log service: {d}"),
            Self::Crypto(d) => write!(f, "crypto: {d}"),
            Self::Paths(r) => write!(
                f,
                "legacy paths need review: {} invalid, {} collision groups",
                r.invalid.len(),
                r.collisions.len()
            ),
            Self::Invalid(d) => write!(f, "invalid: {d}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<mdbn_takeover::Error> for Error {
    fn from(e: mdbn_takeover::Error) -> Self {
        match e {
            mdbn_takeover::Error::Legacy(d) => Self::Legacy(d),
            mdbn_takeover::Error::Invalid(d) => Self::Invalid(d),
        }
    }
}

impl From<mdbn_migrate_portable::Error> for Error {
    fn from(e: mdbn_migrate_portable::Error) -> Self {
        match e {
            mdbn_migrate_portable::Error::Invalid(d) => Self::Invalid(d),
            mdbn_migrate_portable::Error::Paths(r) => Self::Paths(r),
        }
    }
}

/// Result alias.
pub type Result<T> = std::result::Result<T, Error>;
