//! # mdbn-log-conformance: the log service contract, tested over the wire
//!
//! **Responsibility.** The conformance suite of `log-service-api.md` §13, written
//! once and run against any implementation through its public protocol
//! (WebSocket + HTTPS): the in-memory reference, the Postgres gateway, and the
//! Durable Object Worker. Also the benchmark driver for log backend comparisons
//! (`logsvc-bench`).
//!
//! **Allowed dependencies.** Internal: `mdbn-wire`, `mdbn-log-service` (testkit and
//! error codes), and `mdbn-log-server` for in-process targets in tests.
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    clippy::too_many_arguments
)]

pub mod bench;
pub mod client;
pub mod fixture;
pub mod suite;

pub use fixture::Target;
