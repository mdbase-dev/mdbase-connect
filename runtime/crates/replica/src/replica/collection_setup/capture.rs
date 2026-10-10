//! Frozen complete inventory and authenticated encrypted-object work. Core is
//! called synchronously over an actor-held StoreView, never across an await.
use super::{Replica, SetupCaptureFence, Store};
use crate::{
    api::{ApiResult, ErrorCode},
    convert,
    file_source::{FileSourceReader, SourceNeed},
    plan::StoreView,
    store::Page,
};
use mdbn_core::{
    ids::{FileId, Hash},
    intent::{FileKind, OpClock, RECORD_SOURCE_CAP_BYTES},
    setup::{
        capture::{
            FILE_PAGE_SIZE, MAX_INVENTORY_FILES, MAX_SETUP_FILES, MAX_SETUP_SOURCE_BYTES,
            SetupSourceObservation, SetupStateView,
        },
        envelope::{
            CollectionSetup, CollectionSetupAssessment, CollectionSetupSourceRequirements,
            assess_collection_setup, collection_setup_source_requirements,
        },
    },
    state::{PathHolder, StateView, StoredFile},
    validate::{Issue, Severity, Tier},
};
use mdbn_wire::common::Uuid;
use std::{cell::Cell, collections::BTreeMap, rc::Rc, sync::Arc};
use zeroize::Zeroizing;

/// Opaque complete metadata + authenticated source collection, scoped to one
/// admitted replica lifetime. No mutation/installer/publication authority.
pub struct SetupCapturedInventory {
    fence: Arc<SetupCaptureFence>,
    files: Vec<StoredFile>,
    sources: BTreeMap<FileId, CachedSource>,
    source_bytes: usize,
    failed: Rc<Cell<bool>>,
    active: Rc<Cell<bool>>,
}
/// One opaque, bounded encrypted source read. Host fetches only `SourceNeed`
/// objects; it cannot supply cached/plain bytes or a forged descriptor proof.
pub struct SetupSourceRead {
    fence: Arc<SetupCaptureFence>,
    file: StoredFile,
    reader: Option<FileSourceReader>,
    failed: Rc<Cell<bool>>,
    active: Rc<Cell<bool>>,
}
impl Drop for SetupSourceRead {
    fn drop(&mut self) {
        if self.reader.is_some() {
            self.failed.set(true);
        }
        self.active.set(false);
    }
}
enum CachedSource {
    Utf8(Zeroizing<String>),
    InvalidUtf8,
}
fn unavailable() -> crate::api::ApiError {
    ErrorCode::Unavailable.err_with_reason(
        "collection_setup_metadata_unavailable",
        "complete setup inventory or authenticated source proof is unavailable",
    )
}
fn limit() -> crate::api::ApiError {
    ErrorCode::InvalidRequest.err_with_reason(
        "collection_setup_limit_exceeded",
        "setup capture capacity exceeded",
    )
}
fn issue() -> Box<Issue> {
    Box::new(Issue::new(
        "collection_setup_metadata_unavailable",
        Severity::Error,
        Tier::Request,
        "complete frozen setup source proof is unavailable",
    ))
}
impl SetupCapturedInventory {
    /// Complete live files, never grant-filtered or extension-guessed.
    pub fn files(&self) -> &[StoredFile] {
        &self.files
    }
    /// Trusted collection/head revision; not an app-declared token.
    pub fn collection_revision(&self) -> Hash {
        convert::hash(&self.fence.collection_revision())
    }
}
struct CapturedView<'a> {
    state: StoreView<'a>,
    capture: &'a SetupCapturedInventory,
}
impl SetupStateView for CapturedView<'_> {
    fn state(&self) -> &dyn StateView {
        &self.state
    }
    fn collection_revision(&self) -> Hash {
        self.capture.collection_revision()
    }
    fn file_page(
        &self,
        after: Option<FileId>,
        limit: usize,
    ) -> Result<Vec<StoredFile>, Box<Issue>> {
        if self.capture.failed.get() || limit == 0 || limit > FILE_PAGE_SIZE {
            return Err(issue());
        }
        Ok(self
            .capture
            .files
            .iter()
            .filter(|f| after.is_none_or(|id| f.id > id))
            .take(limit)
            .cloned()
            .collect())
    }
    fn source(&self, file: &StoredFile, max: usize) -> Result<SetupSourceObservation, Box<Issue>> {
        let idx = self
            .capture
            .files
            .binary_search_by_key(&file.id, |f| f.id)
            .map_err(|_| issue())?;
        if self.capture.failed.get()
            || &self.capture.files[idx] != file
            || file.content.size() > max as u64
        {
            return Err(issue());
        }
        match self.capture.sources.get(&file.id).ok_or_else(issue)? {
            CachedSource::Utf8(doc) if doc.len() <= max => {
                Ok(SetupSourceObservation::Utf8(doc.to_string()))
            }
            CachedSource::InvalidUtf8 => Ok(SetupSourceObservation::InvalidUtf8),
            _ => Err(issue()),
        }
    }
}
impl<S: Store> Replica<S> {
    fn setup_capture_file(&self, fence: &SetupCaptureFence, file: &StoredFile) -> ApiResult<()> {
        self.recheck_collection_setup_capture(fence)?;
        let view = StoreView::new(&self.store, self.catalog.clone());
        let same = view.file(&file.id).as_ref() == Some(file)
            && view.at_path_key(&mdbn_core::paths::path_key(&file.path))
                == Some(PathHolder::File(file.id))
            && view.record(&file.id).is_none();
        if view.error().is_some() {
            return Err(unavailable());
        }
        self.recheck_collection_setup_capture(fence)?;
        if !same {
            return Err(super::changed());
        }
        Ok(())
    }
    /// Capture COMPLETE live-file metadata to empty EOF at one trusted prefix.
    /// No await, source read, optimistic layer or unbounded record cloning.
    pub fn capture_collection_setup_inventory(
        &self,
        on_behalf: Option<Uuid>,
    ) -> ApiResult<SetupCapturedInventory> {
        let fence = Arc::new(self.collection_setup_capture_fence(on_behalf)?);
        let mut after = None;
        let mut files = Vec::new();
        loop {
            self.recheck_collection_setup_capture(&fence)?;
            let page = self
                .store
                .files(Page {
                    after,
                    limit: FILE_PAGE_SIZE as u32,
                })
                .map_err(|_| unavailable())?;
            if page.len() > FILE_PAGE_SIZE {
                return Err(unavailable());
            }
            if page.is_empty() {
                break;
            }
            for row in page {
                if after.is_some_and(|id| row.id <= id) {
                    return Err(unavailable());
                }
                after = Some(row.id);
                if files.len() >= MAX_INVENTORY_FILES {
                    return Err(limit());
                }
                let file = StoredFile {
                    id: convert::uuid(&row.id),
                    path: row.path,
                    content: convert::file_content(&row.content).map_err(|_| unavailable())?,
                    kind: convert::file_kind(row.kind),
                };
                self.setup_capture_file(&fence, &file)?;
                files.push(file);
            }
        }
        self.recheck_collection_setup_capture(&fence)?;
        Ok(SetupCapturedInventory {
            fence,
            files,
            sources: BTreeMap::new(),
            source_bytes: 0,
            failed: Rc::new(Cell::new(false)),
            active: Rc::new(Cell::new(false)),
        })
    }
    pub(super) fn check_setup_inventory(&self, capture: &SetupCapturedInventory) -> ApiResult<()> {
        if capture.failed.get() {
            return Err(unavailable());
        }
        if let Err(e) = self.recheck_collection_setup_capture(&capture.fence) {
            capture.failed.set(true);
            return Err(e);
        }
        Ok(())
    }
    /// Begin an authenticated <=1MiB Ordinary source read from captured metadata.
    /// Future driver selects IDs via prospective source requirements, not guesses.
    pub fn begin_collection_setup_source(
        &self,
        capture: &SetupCapturedInventory,
        id: FileId,
    ) -> ApiResult<SetupSourceRead> {
        let result = (|| {
            self.check_setup_inventory(capture)?;
            if capture.active.get() {
                return Err(unavailable());
            }
            let i = capture
                .files
                .binary_search_by_key(&id, |f| f.id)
                .map_err(|_| unavailable())?;
            let file = &capture.files[i];
            if file.kind != FileKind::Ordinary
                || file.content.size() > RECORD_SOURCE_CAP_BYTES
                || capture.sources.contains_key(&id)
            {
                return Err(unavailable());
            }
            if capture.sources.len() >= MAX_SETUP_FILES {
                return Err(limit());
            }
            self.setup_capture_file(&capture.fence, file)?;
            let reader = FileSourceReader::new(
                &*self.sealer,
                convert::wfile_content(&file.content),
                RECORD_SOURCE_CAP_BYTES,
            )
            .map_err(|_| unavailable())?;
            capture.active.set(true);
            Ok(SetupSourceRead {
                fence: capture.fence.clone(),
                file: file.clone(),
                reader: Some(reader),
                failed: capture.failed.clone(),
                active: capture.active.clone(),
            })
        })();
        if result.is_err() {
            capture.failed.set(true);
        }
        result
    }
    fn check_setup_source(&self, work: &SetupSourceRead) -> ApiResult<()> {
        if work.failed.get() || work.reader.is_none() {
            return Err(unavailable());
        }
        self.setup_capture_file(&work.fence, &work.file)
    }
    /// Before the host awaits transport, recheck full holder/catalog/authority.
    /// Enforce returned max/exact object lengths WHILE fetching, before buffering.
    pub fn collection_setup_source_need(
        &self,
        work: &mut SetupSourceRead,
    ) -> ApiResult<Option<SourceNeed>> {
        let result = (|| {
            self.check_setup_source(work)?;
            work.reader
                .as_ref()
                .ok_or_else(unavailable)?
                .need()
                .map_err(|_| unavailable())
        })();
        if result.is_err() {
            work.failed.set(true);
            work.reader = None;
        }
        result
    }
    /// After transport await: authenticate exactly the requested encrypted object,
    /// with complete before+after fences. Any failure invalidates the whole capture.
    pub fn supply_collection_setup_source(
        &self,
        work: &mut SetupSourceRead,
        need: SourceNeed,
        encrypted: &[u8],
    ) -> ApiResult<()> {
        let result = (|| {
            self.check_setup_source(work)?;
            work.reader
                .as_mut()
                .ok_or_else(unavailable)?
                .supply(&*self.sealer, need, encrypted)
                .map_err(|_| unavailable())?;
            self.setup_capture_file(&work.fence, &work.file)
        })();
        if result.is_err() {
            work.failed.set(true);
            work.reader = None;
        }
        result
    }
    /// Finish whole authentication before retaining any source observation.
    /// Invalid UTF8 is a proven retention diagnostic, not failed authentication.
    pub fn finish_collection_setup_source(
        &self,
        capture: &mut SetupCapturedInventory,
        mut work: SetupSourceRead,
    ) -> ApiResult<()> {
        let result = (|| {
            self.check_setup_inventory(capture)?;
            self.check_setup_source(&work)?;
            if capture.sources.len() >= MAX_SETUP_FILES {
                return Err(limit());
            }
            if !Arc::ptr_eq(&capture.fence, &work.fence)
                || !Rc::ptr_eq(&capture.failed, &work.failed)
                || capture.sources.contains_key(&work.file.id)
            {
                return Err(unavailable());
            }
            let source = work
                .reader
                .take()
                .ok_or_else(unavailable)?
                .finish()
                .map_err(|_| unavailable())?;
            if source.descriptor() != &convert::wfile_content(&work.file.content) {
                return Err(unavailable());
            }
            let observed = match std::str::from_utf8(source.bytes()) {
                Ok(s) => {
                    let bytes = capture
                        .source_bytes
                        .checked_add(s.len())
                        .ok_or_else(limit)?;
                    if bytes > MAX_SETUP_SOURCE_BYTES {
                        return Err(limit());
                    }
                    capture.source_bytes = bytes;
                    CachedSource::Utf8(Zeroizing::new(s.to_owned()))
                }
                Err(_) => CachedSource::InvalidUtf8,
            };
            self.setup_capture_file(&capture.fence, &work.file)?;
            capture.sources.insert(work.file.id, observed);
            Ok(())
        })();
        if result.is_err() {
            capture.failed.set(true);
            work.failed.set(true);
            capture.sources.clear();
        }
        result
    }
    /// Synchronous Core assessment over the borrowed StoreView plus owned frozen
    /// complete inventory/authenticated sources. No await and no partial result.
    pub fn assess_captured_collection_setup(
        &self,
        capture: &SetupCapturedInventory,
        setup: &CollectionSetup,
        clock: &OpClock,
    ) -> ApiResult<CollectionSetupAssessment> {
        self.with_setup_capture_view(capture, |view| assess_collection_setup(view, setup, clock))
    }
    /// Select exact prospective source candidates synchronously, before any
    /// source IO; missing complete inventory or StoreView errors remain fatal.
    pub fn captured_collection_setup_source_requirements(
        &self,
        capture: &SetupCapturedInventory,
        setup: &CollectionSetup,
        clock: &OpClock,
    ) -> ApiResult<CollectionSetupSourceRequirements> {
        self.with_setup_capture_view(capture, |view| {
            collection_setup_source_requirements(view, setup, clock)
        })
    }
    pub(super) fn with_setup_capture_view<T>(
        &self,
        capture: &SetupCapturedInventory,
        call: impl FnOnce(&dyn SetupStateView) -> Result<T, Box<Issue>>,
    ) -> ApiResult<T> {
        let result = (|| {
            self.check_setup_inventory(capture)?;
            if capture.active.get() {
                return Err(unavailable());
            }
            let view = CapturedView {
                state: StoreView::new(&self.store, self.catalog.clone()),
                capture,
            };
            let assessed = call(&view);
            if view.state.error().is_some() {
                return Err(unavailable());
            }
            self.recheck_collection_setup_capture(&capture.fence)?;
            assessed.map_err(|i| match i.code.as_str() {
                "collection_setup_metadata_unavailable" => unavailable(),
                "concurrent_modification" => super::changed(),
                _ => ErrorCode::InvalidRequest.err_with_reason(&i.code, i.message),
            })
        })();
        if result.is_err() {
            capture.failed.set(true);
        }
        result
    }
}
