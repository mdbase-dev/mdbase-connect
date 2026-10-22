//! The hosted runtime budgets every streaming import step enforces
//! (hosted profile; H0–H10 contract "Hard runtime budgets").
//!
//! Each boundary checks **both** dimensions before it allocates or applies. Wire
//! chunk and blob sizes never authorise hydrating more than this in one step.

/// At most this many effects in one batch (one log append, one apply window).
pub const MAX_BATCH_EFFECTS: usize = 500;

/// At most this many decoded source bytes in one batch.
pub const MAX_BATCH_BYTES: usize = 512 << 10;

/// At most this many records hydrated by one request (one source page, one store page).
pub const MAX_HYDRATE_RECORDS: usize = 1_000;

/// At most this many decoded source bytes hydrated by one request.
pub const MAX_HYDRATE_BYTES: usize = 1 << 20;

/// At most this many rows in one hosted legacy source metadata page
/// (`Action::ReadPage`). Matches Connect's paged migration sources (64 rows).
pub const MAX_SOURCE_PAGE_ROWS: usize = 64;

/// At most this many bytes of one hosted legacy source metadata page as the
/// native ledger receives it (its whole canonical mirror; the page's path bytes
/// are a subset). Matches Connect's paged migration sources (48 KiB), so one
/// page plus its staged metadata fits the native atomic settlement.
pub const MAX_SOURCE_PAGE_BYTES: usize = 48 << 10;

/// At most this many staged SQL statements in one atomic native completion
/// (one action settlement's metadata).
pub const MAX_COMPLETION_STATEMENTS: usize = 512;

/// At most this many bytes of staged SQL text and parameters in one atomic
/// native completion. Sized so the largest source page the page bounds admit
/// (64 rows, 48 KiB, every row deferred: its original and staged path both
/// stored) stages in one completion with room to spare.
pub const MAX_COMPLETION_BYTES: usize = 128 << 10;

/// Whether a page of `rows` rows carrying `bytes` decoded bytes fits one request.
pub fn page_fits(rows: usize, bytes: usize) -> bool {
    rows <= MAX_HYDRATE_RECORDS && bytes <= MAX_HYDRATE_BYTES
}

/// Whether a batch of `effects` effects carrying `bytes` decoded bytes fits one batch.
pub fn batch_fits(effects: usize, bytes: usize) -> bool {
    effects <= MAX_BATCH_EFFECTS && bytes <= MAX_BATCH_BYTES
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_dimensions_bound() {
        assert!(page_fits(1_000, 1 << 20));
        assert!(!page_fits(1_001, 1));
        assert!(!page_fits(1, (1 << 20) + 1));
        assert!(batch_fits(500, 512 << 10));
        assert!(!batch_fits(501, 0));
        assert!(!batch_fits(0, (512 << 10) + 1));
    }
}
