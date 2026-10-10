//! # mdbn-store-file: the file-backed store
//!
//! **Responsibility.** The `Store` implementation where Markdown files are the
//! truth: the never-clobber publish protocol and its recovery, stashes and holds,
//! ingest with a quiescence window, move detection across watcher batches, adopting
//! a folder in place, joining from existing files, and foreign-sync-tool detection
//! (file-layer contract).
//!
//! It runs over injected interfaces, all defined here and recorded in
//! the file platform and index storage contract:
//! - [`FilePlatform`]: the file system as one platform sees it (Linux, macOS,
//!   Windows in `mdbn-platform-native`; the Obsidian vault through the host
//!   queue, [`host`]; OS models in `mdbn-sim`). **Async.**
//! - [`IndexStorage`]: a SQLite database (native SQLite, sqlite-wasm on
//!   `opfs-sahpool` in webviews). **Sync.**
//! - [`Journal`]: durable non-derived state (pending, receipts, holds, publish
//!   intents). **Async.**
//! - [`EditorFence`]: publishing through an open editor's buffer. **Async.**
//!
//! Async here means "returns a future the store's own task loop polls"; there
//! is no async runtime. See [`platform`] for why each boundary sits where it does.
//!
//! **Rules.** Portable: pure Rust, builds for `wasm32-unknown-unknown`. No
//! `std::fs`, `libc` or C SQLite here (portable host boundary); those live behind the traits.
//! Deterministic like `mdbn-core`.
//!
//! **Allowed dependencies.** Internal: `mdbn-core`, `mdbn-wire`, `mdbn-replica`.
//! External: as for `mdbn-core`.

pub mod codec;
pub mod diskdb;
pub mod exec;
pub mod fence;
pub mod host;
pub mod index;
pub mod index_codec;
pub mod journal;
pub mod log_cache;
pub mod platform;
pub mod publish;
pub mod recover;
mod retention;
pub mod sql;
mod sql_bases;
pub mod sql_fields;
pub mod sql_query;
pub mod sql_select;
pub mod stash;
pub mod store;
pub mod tentative;
#[cfg(any(test, feature = "testing"))]
pub mod testing;

#[cfg(test)]
mod publish_tests;
#[cfg(test)]
mod store_tests;

pub use fence::{EditorFence, EditorState, FenceOutcome, NoFence};
pub use index::{IndexStorage, SqlValue};
pub use journal::{Journal, JournalEntry};
pub use log_cache::LogCache;
pub use platform::{Capabilities, FilePlatform, FsError, FsErrorKind, FsResult, RelPath};
pub use retention::{MAX_RETENTION_AGE_MS, ReleasePolicy};
pub use sql::{SqlStore, SqlStoreLimits};
pub use store::{Config, FileStore};
pub use tentative::TentativeStore;
