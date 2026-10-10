//! # mdbn-legacy: read-only readers for the old mdbase Connect formats
//!
//! **Responsibility.** Parse the state that today's mdbase Connect and mdbase-rs leave
//! on disk and in the hosted provider, so that migration (`mdbn-migrate`,
//! the migration procedure) can settle, import and verify it:
//! - [`connector`]: the local connector's state directory: `connector.sqlite`
//!   (schema 2 and 3), `authority.sqlite` (1–5), the durable mutation journal
//!   (ADR 0005), and the record IDs in `local_sync_records`;
//! - [`receipts`]: the content-addressed receipt store (ADR 0007) and inline
//!   receipts;
//! - [`engine`]: mdbase-rs engine transaction journals (v1 shadow and runtime v2–v4)
//!   in a collection's `.mdbase/transactions/`, and how each one settles;
//! - [`marker`]: `.mdbase/connect-role.json` v1 (mirror) and v2 (claimed by
//!   mdbase-next, takeover marker contract);
//! - [`mirror`]: old hosted-mirror state (three engine formats) and the local edits a
//!   mirror had not uploaded, for the rehearsal oracle;
//! - [`lock`]: the old daemon's `daemon.lock` and the engine's `write.lock`;
//! - [`hosted`]: the hosted provider's sealed Postgres columns, collection key
//!   unwrapping (legacy and KMS), and with feature `pg` a read-only consistent
//!   snapshot and change reader.
//!
//! [`OldService`] is a caller-implemented takeover hook. This crate declares its
//! signature only; it does not invoke service managers or stop processes.
//!
//! **Rules.**
//! - **Read-only by construction.** SQLite is opened with `SQLITE_OPEN_READ_ONLY`.
//!   Nothing here writes, renames or deletes a file. The one exception is that
//!   [`lock`] may create an empty lock file, which is what the old daemon itself does.
//! - **No new-system semantics.** This crate reports what old state *says*. It never
//!   normalises paths, documents or IDs. Mapping into mdbase-next types is the
//!   migrator's job.
//! - **Never prints content.** `Debug` output of rows can include paths, so callers
//!   must not log rows. Summaries go through counts.
//! - Native only, never linked into WASM, so it is exempt from the portability lints.
//!
//! **Allowed dependencies.** Internal: none. External: `rusqlite` (bundled SQLite),
//! `postgres` (feature `pg`), `aes-gcm`, `base64`, `serde`, `serde_json`, `sha2`.
//!
//! Source references (`MC/…`, `RS/…`) are to `reference/mdbase-connect@7d91bd3f` and
//! `reference/mdbase-rs@056db73`.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

pub mod connector;
pub mod engine;
pub mod hosted;
pub mod lock;
pub mod marker;
pub mod mirror;
pub mod receipts;
mod sqlite;

use std::fmt;
use std::path::PathBuf;

/// The old connector daemon's service manager (systemd, launchd, Task Scheduler, or
/// `connect daemon stop`). Implemented by the native shell, used by the migrator.
pub trait OldService {
    /// Stop the old daemon and disable its autostart. It must be safe to call when
    /// it isn't running.
    fn stop_and_disable(&mut self) -> std::result::Result<(), String>;
}

/// Errors from reading old state. Messages name files, never their contents.
#[derive(Debug)]
pub enum Error {
    /// An I/O error on a file.
    Io {
        /// The file or directory.
        path: PathBuf,
        /// The underlying error.
        source: std::io::Error,
    },
    /// A SQLite error.
    Sqlite {
        /// The database.
        path: PathBuf,
        /// The underlying error.
        source: rusqlite::Error,
    },
    /// State that doesn't match any known old format.
    Format {
        /// The file or directory.
        path: PathBuf,
        /// What is wrong.
        detail: String,
    },
}

impl Error {
    pub(crate) fn io(path: impl Into<PathBuf>, source: std::io::Error) -> Self {
        Self::Io {
            path: path.into(),
            source,
        }
    }

    pub(crate) fn format(path: impl Into<PathBuf>, detail: impl Into<String>) -> Self {
        Self::Format {
            path: path.into(),
            detail: detail.into(),
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io { path, source } => write!(f, "{}: {source}", path.display()),
            Self::Sqlite { path, source } => write!(f, "{}: sqlite: {source}", path.display()),
            Self::Format { path, detail } => {
                write!(f, "{}: unrecognised old format: {detail}", path.display())
            }
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            Self::Sqlite { source, .. } => Some(source),
            Self::Format { .. } => None,
        }
    }
}

/// Result alias.
pub type Result<T> = std::result::Result<T, Error>;

/// `"sha256:<lowercase hex>"` of `bytes`: the revision format shared by mdbase-rs
/// (`RS/src/v03/mod.rs:50-52`), the connector and the hosted provider.
pub fn revision_of(bytes: &[u8]) -> String {
    format!("sha256:{}", hex(&sha256(bytes)))
}

pub(crate) fn sha256(bytes: &[u8]) -> [u8; 32] {
    use sha2::Digest;
    sha2::Sha256::digest(bytes).into()
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[usize::from(b >> 4)] as char);
        out.push(DIGITS[usize::from(b & 0xf)] as char);
    }
    out
}

/// True for a canonical lowercase hyphenated UUID (`8-4-4-4-12`), the form every
/// old store writes.
pub fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_digit() || (b'a'..=b'f').contains(c),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revision_matches_mdbase_rs() {
        assert_eq!(
            revision_of(b""),
            "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn uuid_shape() {
        assert!(is_uuid("0192f0c1-7e1a-7b3c-8d4e-5f6a7b8c9d0e"));
        assert!(!is_uuid("0192F0C1-7E1A-7B3C-8D4E-5F6A7B8C9D0E"));
        assert!(!is_uuid("0192f0c17e1a7b3c8d4e5f6a7b8c9d0e"));
    }
}
