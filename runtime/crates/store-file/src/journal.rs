//! `Journal`: durable storage for the store's non-derived state.
//!
//! Non-derived state cannot be rebuilt from the files or the log: pending
//! mutations, receipts of local mutations, hold metadata, publish intents (with
//! the bytes needed to recover a torn in-place write), stash records, and the
//! store's name counter. It goes here, and an acknowledged entry must survive
//! process kill and, where the platform allows, power loss.
//!
//! The shape is a keyed, versioned append-only log: each entry sets or deletes
//! one `(space, key)`, and the live value of a key is the entry with the highest
//! `version`. That is what the webview needs: the same entries are written
//! to an IndexedDB `durability: "strict"` store **and** a CRC-framed append-only
//! vault file, acknowledged when both resolve, and recovered from the **union**
//! by highest version. Compaction rewrites the live set (A/B files on the vault,
//! never overwrite or rename).
//!
//! Async, because both webview stores are promise-based. Native implementations
//! (an fsynced SQLite table or file) complete immediately.

use std::future::Future;

/// Namespaces within the journal. The store owns the encoding of keys and
/// values inside each space.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct Space(pub u8);

/// One journal entry.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct JournalEntry {
    /// Namespace.
    pub space: Space,
    /// Key within the space (a mutation ID, a path, a publish op number...).
    pub key: Vec<u8>,
    /// Monotonic per store across all keys; assigned by the store. The highest
    /// version of a key wins at recovery.
    pub version: u64,
    /// The new value, or `None` to delete the key.
    pub value: Option<Vec<u8>>,
}

/// Errors from a journal.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum JournalError {
    /// Storage is full or over quota. The store stops accepting writes and
    /// surfaces it; it never drops entries.
    Full(String),
    /// Every copy is unreadable. With the dual journal this means both the
    /// browser store and the vault file are gone: pending writes are lost and
    /// must be surfaced to the user (explicit recovery outcome).
    Lost(String),
    /// Anything else.
    Other(String),
}

/// Durable, keyed, versioned append-only storage.
pub trait Journal {
    /// Append a batch. Resolves once the batch is durable. **Atomic:** after a
    /// crash at any point, recovery sees all of the batch or none of it (a torn
    /// tail drops the whole last frame).
    fn append(&self, batch: Vec<JournalEntry>) -> impl Future<Output = Result<(), JournalError>>;

    /// The live entries (highest version per key, deletes removed), in any
    /// order. Called once at open, before any append.
    fn load(&self) -> impl Future<Output = Result<Vec<JournalEntry>, JournalError>>;

    /// Replace the journal's content with exactly `live` (which the store
    /// computed from `load` plus later appends). Must be crash-safe: until it
    /// resolves, recovery yields either the old content or `live`.
    fn compact(&self, live: Vec<JournalEntry>) -> impl Future<Output = Result<(), JournalError>>;
}
