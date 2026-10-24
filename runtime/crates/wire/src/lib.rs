//! # mdbn-wire: wire types and canonical encoding
//!
//! **Responsibility.** The types that cross a process or trust boundary, and their
//! one canonical byte encoding, exactly as specified in `docs/contracts/`:
//!
//! | Module | Contract |
//! |---|---|
//! | [`cbor`] | the `mdb-cbor/1` profile: strict deterministic CBOR (00-overview.md §3) |
//! | [`schema`] | typed mapping, unknown-field and unknown-variant rules (00-overview.md §6.2) |
//! | [`common`] | IDs, hashes, versions, `value`, data maps, `text` |
//! | [`hash`] | SHA-256 and domain-separated hashes (00-overview.md §4) |
//! | [`intent`] | the mutation and its operations (intent.md) |
//! | [`attachment`] | standalone critical attachment v1 codecs, not runtime activation (intent.md §3.9) |
//! | [`entry`] | the entry payload: results, conflicts, text table (log-entry.md) |
//! | [`envelope`] | the item envelope, AAD, signed digest, chain hash, key items (sealed-envelope.md) |
//! | [`snapshot`] | manifest, chunks, rows, `base` (snapshot.md) |
//! | [`policy`] | control-plane policy (policy.md) |
//! | [`ref_index`] | snapshot ref-index objects (sealed-envelope.md §4.3) |
//! | [`log_service`] | log service messages (log-service-api.md) |
//! | [`client`] | replica client API messages (replica-client-api.md) |
//! | [`render`] | diagnostic notation and the JSON debug view |
//! | [`fixtures`] | the values behind the golden fixtures in `conformance/wire/` |
//!
//! Sealing (compression, padding, AEAD) and signing need keys and belong to the
//! replica's crypto layer; this crate fixes the bytes those operations cover
//! ([`envelope::Item::aad`], [`envelope::Item::signed_digest`]).
//!
//! **Why not serde for the encoding.** The contracts need integer-keyed struct maps,
//! order-preserving data maps, a canonical-form check on every decode, and
//! "unknown variants are critical". serde's data model expresses none of these
//! directly, and a custom serializer that did would be larger than the declarative
//! macros in [`schema`].
//!
//! **Rules.** Portable and deterministic, like `mdbn-core`: the same value encodes
//! to the same bytes natively and in WASM, because entries are signed and digested.
//! No maps with unspecified order in encoded types.
//!
//! **Allowed dependencies.** Internal: `mdbn-core`, for shared types only (none
//! needed yet). External: `sha2` (pure Rust).

pub mod attachment;
pub mod attachment_runtime_v1;
pub mod cbor;
pub mod client;
pub mod common;
pub mod entry;
pub mod envelope;
pub mod fixtures;
pub mod hash;
pub mod intent;
pub mod log_service;
pub mod ordinary_file_promotion;
pub mod policy;
pub mod ref_index;
pub mod render;
pub mod schema;
pub mod snapshot;
pub mod unindexed_markdown;

pub use cbor::{Cbor, CborError};
pub use schema::{Ann, SchemaError, Wire};
