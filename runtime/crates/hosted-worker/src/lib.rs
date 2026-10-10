//! # mdbn-hosted-worker: the hosted replica's engine for Cloudflare
//!
//! **Responsibility.** The Rust half of the hosted Worker (`services/hosted-worker`):
//! one Durable Object per cloud-copy collection runs one [`runtime::Engine`], the
//! replica in **hosted mode** (`Replica::open_hosted`): app writes are acknowledged
//! only after the log append, pending/retry state and keys stay in RAM, receipts are
//! log-derived, and nothing is served before the replica has rebuilt from the log.
//! Its store is the shared `SqlStore` over the DO's SQLite ([`do_index::DoIndex`]),
//! wrapped by `HostedCache`, so the SQLite database is a disposable cache of the log.
//!
//! **Not here.** Key custody (KMS unwrap into the open config), admission (verified
//! identity and grants) and the Noise transport are host-side seams owned by the
//! hosted workstream and the Noise-in-Wasm work; blobs and snapshots stream from R2
//! through the log service, never through this crate.
//!
//! **Rules.** Portable and deterministic like `mdbn-wasm`: host capabilities (SQL,
//! clock, entropy, time zones, the log transport) are imports.
//!
//! **Allowed dependencies.** Internal: `mdbn-core`, `mdbn-wire`, `mdbn-replica`,
//! `mdbn-store-file`, `mdbn-noise`, `mdbn-migrate-portable` (metadata-only import
//! preflight, not part of the SDK's runtime.wasm).

// The raw ABI is the only unsafe code: pointer handoff with the JS host.
#[cfg(target_arch = "wasm32")]
#[allow(unsafe_code)]
mod abi;
pub mod admission_wire;
mod attachment_region;
// Labels alone cannot mint a lease or confer current native authority.
pub use attachment_region::RegionOwner;
pub mod device_keys;
pub mod do_index;
mod effect_currentness;
mod file_reads;
pub mod host_trust;
pub mod log_http;
pub mod migration_source;
pub mod noise_sessions;
pub mod runtime;

#[cfg(test)]
mod tests;
