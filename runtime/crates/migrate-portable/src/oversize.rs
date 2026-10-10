//! Documents too large to index are imported as byte-preserving files.
//!
//! Legacy hosted documents go up to the provider's 2 MiB quota, but a synced record
//! is capped at [`MAX_RECORD_DOCUMENT_BYTES`]. A larger document is imported as an
//! attachment-backed **file at the same path**, bytes preserved exactly, its legacy
//! record ID kept as the file ID, with core's typed "unindexed oversized markdown"
//! file kind, and listed in the per-account migration report as
//! [`IMPORTED_AS_FILE_REASON`]. Nothing is dropped or truncated.

use std::fmt;

use mdbn_wire::common::Uuid;

/// The largest document a synced record may carry: the replica refuses a log entry
/// over 1 MiB (`replica/append.rs`). Strictly larger documents are imported as files;
/// exactly this size still indexes as a record.
pub const MAX_RECORD_DOCUMENT_BYTES: u64 = 1 << 20;

/// The per-account migration report wording for a document imported as a file.
pub const IMPORTED_AS_FILE_REASON: &str = "imported as file: too large to index";

/// Whether a document of `bytes` UTF-8 bytes exceeds [`MAX_RECORD_DOCUMENT_BYTES`]
/// and so is imported as a file. The same rule applies to legacy changes read after
/// `S0`.
pub fn is_oversize(bytes: u64) -> bool {
    bytes > MAX_RECORD_DOCUMENT_BYTES
}

/// One legacy document imported as a file because it is too large to index. A report
/// entry: identity and size only.
#[derive(Clone, PartialEq, Eq)]
pub struct ImportedAsFile {
    /// The legacy record ID, now the file ID.
    pub id: Uuid,
    /// The path, unchanged.
    pub path: String,
    /// The document's exact size in bytes.
    pub bytes: u64,
}

impl ImportedAsFile {
    /// The report wording.
    pub fn reason(&self) -> &'static str {
        IMPORTED_AS_FILE_REASON
    }
}

impl fmt::Debug for ImportedAsFile {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ImportedAsFile")
            .field("id", &self.id)
            .field("path", &"[redacted]")
            .field("bytes", &self.bytes)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strictly_over_one_mib() {
        assert!(!is_oversize(MAX_RECORD_DOCUMENT_BYTES));
        assert!(is_oversize(MAX_RECORD_DOCUMENT_BYTES + 1));
        assert_eq!(MAX_RECORD_DOCUMENT_BYTES, 1_048_576);
    }
}
