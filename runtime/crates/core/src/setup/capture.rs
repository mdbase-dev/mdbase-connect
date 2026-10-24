//! Setup-only, fallible inventory contract over a frozen trusted Replica head.
//! No widening of ordinary StateView, ambient reads or empty-on-error fallback.
use crate::ids::{FileId, Hash};
use crate::state::{StateView, StoredFile};
use crate::validate::Issue;

/// Maximum metadata rows requested per page.
pub const FILE_PAGE_SIZE: usize = 128;
/// Maximum metadata rows visited during one setup assessment.
pub const MAX_INVENTORY_FILES: usize = 65_536;
/// Maximum eligible Ordinary holders per setup assessment.
pub const MAX_SETUP_FILES: usize = 256;
/// Aggregate observed UTF-8 source capacity, including parse-refused sources.
pub const MAX_SETUP_SOURCE_BYTES: usize = 8_388_608;

/// A verified source observation under the selected content profile. Descriptor
/// possession grants nothing: the trusted provider must authenticate/reconcile
/// the source, and recheck current holder/catalogue/authority across awaits.
#[derive(Debug, Clone, PartialEq)]
pub enum SetupSourceObservation {
    /// Exact complete UTF-8 source, within the requested source capacity.
    Utf8(String),
    /// Authenticated source failed UTF-8 admission. Retain as Ordinary file.
    InvalidUtf8,
}
/// Separate setup capability. Implementations must represent ONE frozen head:
/// a paged metadata inventory must be COMPLETE, not a grant-filtered candidate
/// list. Missing inventory/provider proof is an error, never an empty page.
/// Core values/assessment are evidence, not authority or an apply capability.
pub trait SetupStateView {
    /// The frozen state against which every descriptor is checked.
    fn state(&self) -> &dyn StateView;
    /// Trusted head revision (including head position), not an app-selected token.
    fn collection_revision(&self) -> Hash;
    /// Complete live-file metadata, strictly increasing by ID after `after`.
    /// At most `limit` rows; an empty page means the complete inventory ended.
    /// Core verifies order, descriptor equality and progress, and bounds visits.
    fn file_page(&self, after: Option<FileId>, limit: usize)
    -> Result<Vec<StoredFile>, Box<Issue>>;
    /// Bounded source observation for this exact captured descriptor. Any source
    /// verification/provider failure is fatal to setup, not a parse diagnostic.
    fn source(
        &self,
        file: &StoredFile,
        max_bytes: usize,
    ) -> Result<SetupSourceObservation, Box<Issue>>;
}
