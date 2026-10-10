//! # mdbn-bench: benchmarks
//!
//! **Responsibility.** Benchmarks against the runtime performance budgets and the
//! performance targets (`tools/perf/README.md`): a deterministic synthetic
//! corpus generator ([`corpus`]), the native local journey through the
//! `mdbase` library ([`native`]), the replica engine syncing in memory with
//! production sealing ([`sync`]), TaskNotes views through the Bases executor
//! ([`bases`]), and the `mdbn-perf` runner with its CI regression gate.
//!
//! **Allowed dependencies.** Any library crate in the workspace.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

pub mod bases;
pub mod corpus;
pub mod measure;
pub mod native;
pub mod sync;
