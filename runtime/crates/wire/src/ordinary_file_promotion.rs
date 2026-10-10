//! Closed data shapes for ordinary-file → record promotion (intent.md §3.12).
//!
//! The codec carries exact source and the full expected descriptor. It does not
//! verify plaintext, current holder/authority, source admission or setup atomicity;
//! those belong to Core and the Replica's verified mediation.

use crate::attachment::FileContent;
use crate::common::{Text, Uuid};
use crate::wire_struct;

wire_struct! {
    /// Critical Op17 body: same ID/path/exact source under full Ordinary-content CAS.
    pub struct OrdinaryFileToRecord {
        /// Existing File/Record ID, unchanged.
        1 req id: Uuid,
        /// Exact current path, unchanged.
        2 req path: String,
        /// Complete exact UTF8 source (inline or entry text-table index).
        3 req doc: Text,
        /// Complete expected Ordinary file content, never a hash-only comparison.
        4 req prior: FileContent,
    }
}

wire_struct! {
    /// Critical Effect11 body: atomic Ordinary-holder removal and Record installation.
    pub struct ReindexOrdinaryFile {
        /// Existing File/Record ID, unchanged.
        1 req id: Uuid,
        /// Exact current path, unchanged.
        2 req path: String,
        /// Complete resolved source (inline or entry text-table index).
        3 req doc: Text,
    }
}
