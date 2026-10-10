//! # mdbn-daemon: the desktop daemon and the `mdbase` CLI
//!
//! **Responsibility.** The per-user native process that owns every device replica on
//! this computer (one replica per collection per device; apps are its
//! clients), and the `mdbase` command line that controls it.
//!
//! - It hosts one replica per registered collection over `mdbn-store-file` and
//!   `mdbn-platform-native`.
//! - Local-only collections have no log: the same replica service confirms a write
//!   once it is durably published to the file, and apps reach it only through the
//!   daemon, under grants cached from the control plane and a local access list
//!   ([`access`]). Synced collections append to the hosted log
//!   (`docs/collection-states-and-pricing.md`).
//! - It serves the replica client API over **local IPC** to apps and the CLI
//!   (`replica-client-api.md` §12.2), and keeps the relay connection for remote thin
//!   clients (control-plane client discovery).
//! - It owns the device identity, held in the OS keychain ([`secrets`]).
//!
//! **Process model** (single state owner with IPC clients): the
//! daemon is the only state owner; the CLI and the desktop app are peers that send
//! requests over a versioned, owner-only **control endpoint** ([`control`]). The
//! daemon reports a readiness contract ([`control::Readiness`]), runs as a single
//! instance per state directory ([`instance`]), starts durably (registry first,
//! then collections) and shuts down gracefully.
//!
//! **Rules.** Native only, never linked into WASM. This is a composition point: it
//! wires stores to replicas and may do real I/O, so it is exempt from the
//! portability lints. It must not decide semantics; anything replicas must agree on
//! belongs in `mdbn-core` or `mdbn-replica`.
//!
//! **Allowed dependencies.** Internal: `mdbn-core`, `mdbn-wire`, `mdbn-replica`,
//! `mdbn-store-file`, `mdbn-platform-native`, `mdbn-local-host` (the shared native
//! folder composition under the collection runtime), `mdbn-log-service`,
//! `mdbn-noise`, `mdbn-trust`, `mdbn-legacy` (reading the old connector's
//! state for the local takeover) and `mdbn-takeover` (the takeover steps T0–T6,
//! driven by [`takeover`]).
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

pub mod access;
pub mod approval_journal;
pub mod attest;
pub mod authority;
pub mod cli;
pub mod client;
pub mod cloud;
pub mod collections;
pub mod confirm;
pub mod control;
pub mod desktop;
pub mod direct;
pub mod fsutil;
pub mod instance;
pub mod ipc;
pub mod keyring_store;
pub mod link;
mod log_generation;
pub mod logwire;
pub mod noise;
pub mod paths;
pub mod pipes;
pub mod registry;
pub mod relay;
pub mod runtime;
pub mod secrets;
pub mod server;
pub mod service;
pub mod session;
pub mod sync;
pub mod takeover;
pub mod trust;
pub mod update;
pub mod watch;

/// This binary's version, reported by `--version` and in readiness.
///
/// Release builds stamp it with `MDBN_RELEASE_VERSION` at compile time (the
/// workspace version is `0.0.0`); other builds report `CARGO_PKG_VERSION`.
pub const BINARY_VERSION: &str = match option_env!("MDBN_RELEASE_VERSION") {
    Some(v) => v,
    None => env!("CARGO_PKG_VERSION"),
};

#[cfg(test)]
pub(crate) mod testutil;
