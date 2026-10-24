//! # mdbn-platform-native: native file platforms
//!
//! **Responsibility.** `FilePlatform` for real file systems, and the native
//! `IndexStorage` and `Journal` on SQLite (traits in `mdbn-store-file`):
//! - Linux: `renameat2(RENAME_EXCHANGE)` / `RENAME_NOREPLACE`, `syncfs`;
//! - macOS: `renamex_np(RENAME_SWAP)` / `RENAME_EXCL` after a
//!   `VOL_CAP_INT_RENAME_SWAP` check, metadata copy, `F_BARRIERFSYNC` /
//!   `F_FULLFSYNC`; volumes without swap are read-only;
//! - Windows: protocol D (lock with `FILE_SHARE_READ`, verify, overwrite in
//!   place, `SetEndOfFile`, `FlushFileBuffers`), creates by no-replace rename,
//!   deletes by lock and move-aside.
//!
//! The Obsidian vault platform is not here: it is TS behind the host queue in
//! the WASM runtime.
//!
//! Every [`mdbn_store_file::FilePlatform`] method does blocking I/O inside the
//! call and returns an already-completed future.
//!
//! **Rules.** Native only, never linked into WASM. This is where real I/O lives, so
//! it is exempt from the portability lints. It still must not decide semantics:
//! anything a replica must agree on belongs in `mdbn-core` or `mdbn-store-file`,
//! and the publish protocol itself is in `mdbn-store-file`; this crate only
//! provides the primitives.
//!
//! **Allowed dependencies.** Internal: `mdbn-store-file` (the traits it
//! implements) and `mdbn-core`.
//!
//! **Unsafe.** This is the only crate allowed `unsafe`, and only in the OS FFI
//! modules (`linux`, `macos`, `windows`), for calls no safe wrapper covers
//! (`F_SETLEASE`, `F_BARRIERFSYNC`, `copyfile`, `getattrlist`/`setattrlist`, Win32 handle
//! APIs); Linux and the Unix renames go through `rustix`. Every block carries a
//! `SAFETY:` comment, enforced by `clippy::undocumented_unsafe_blocks`.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]
#![deny(clippy::undocumented_unsafe_blocks)]

mod durability;
mod error;
#[cfg(target_os = "linux")]
#[allow(unsafe_code)]
mod linux;
#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
mod macos;
mod native;
#[cfg(feature = "sqlite")]
pub mod sqlite;
#[cfg(unix)]
mod unix;
#[cfg(windows)]
#[allow(unsafe_code)]
mod windows;

pub use native::{NativePlatform, OpenOptions, PlatformDiagnostics};
#[cfg(feature = "sqlite")]
pub use sqlite::{SqliteIndex, SqliteJournal};
