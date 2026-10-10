//! Device-only, complete, bounded Bases discovery over confirmed raw records.
//! Reuses the existing strict keyed-editor fence; no grants, writes or facade.
use super::collection_setup::SetupCaptureFence;
use super::{Replica, Store};
use crate::{
    api::{ApiResult, ErrorCode},
    store::{Page, RecordRow},
    store_query::QueryBudget,
};
use mdbn_core::{
    doc::{Document, RecordFormat},
    intent::OpClock,
    views::bases::{BASES_CONTRACT, EvaluationFailure, WorkBudget, discover_base_record},
};
use mdbn_wire::common::{B32, Hash, Uuid};
use sha2::{Digest, Sha256};
pub(in crate::replica) mod discovery;
mod execution;
pub use discovery::{BasesDiscoveryHandle, BasesDiscoveryPage, BasesViewSource};
pub use execution::{
    BasesExecutionGroup, BasesExecutionPolicies, BasesExecutionResult, BasesExecutionRow,
    BasesExecutionWindow, BasesGroupPlacement, BasesReadRequest, BasesViewSelection,
    BasesWindowInfo, CapturedBasesExecutionInputs,
};
/// Resolved implementation identity. Passive metadata grants no execution.
#[derive(Clone)]
pub struct BasesImplementationDescriptor {
    /// Exact implementing type.
    pub type_name: String,
    /// Exact resolved version.
    pub version: String,
    /// Validated contract digest.
    pub contract_digest: Hash,
    /// Validated implementation digest.
    pub implementation_digest: Hash,
}
/// Source-ordinal descriptor for a view stored on an actual record.
#[derive(Clone)]
pub struct BasesViewDescriptor {
    /// Actual record identity, never a synthetic resource kind.
    pub record: Uuid,
    /// Exact path, not inferred from its extension.
    pub path: String,
    /// Actual SHA256 of captured raw document bytes.
    pub revision: Hash,
    /// Validated implementations projecting the same source.
    pub implementations: Vec<BasesImplementationDescriptor>,
    /// Original declaration ordinal; names can repeat.
    pub index: u32,
    /// Exact optional user name.
    pub name: Option<String>,
    /// Exact rendering type; not proof of renderer support.
    pub view_type: String,
}
/// Opaque complete inventory observation. Source/capture fields cannot be
/// supplied by app/MCP callers. No debug/source/publication escape.
pub struct CapturedBasesDiscovery {
    fence: SetupCaptureFence,
    clock: OpClock,
    records: Vec<RecordRow>,
    views: Vec<BasesViewDescriptor>,
}
impl CapturedBasesDiscovery {
    /// Complete descriptors from this captured inventory.
    pub fn views(&self) -> &[BasesViewDescriptor] {
        &self.views
    }
    /// Frozen host clock used for type matching.
    pub fn clock(&self) -> &OpClock {
        &self.clock
    }
    /// Trusted head revision, not a caller declaration.
    pub fn collection_revision(&self) -> Hash {
        self.fence.collection_revision()
    }
    /// Number of verified live records, including non-Bases records.
    pub fn record_count(&self) -> usize {
        self.records.len()
    }
}
fn unavailable() -> crate::api::ApiError {
    ErrorCode::Unavailable.err_with_reason(
        "view_metadata_unavailable",
        "complete bounded raw record inventory is unavailable",
    )
}
fn invalid() -> crate::api::ApiError {
    ErrorCode::Conflict.err_with_reason(
        "concurrent_modification",
        "captured Bases record inventory changed or is inconsistent",
    )
}
fn failure(e: EvaluationFailure) -> crate::api::ApiError {
    ErrorCode::InvalidRequest.err_with_reason(e.code(), e.detail())
}
impl<S: Store> Replica<S> {
    /// Synchronous actor-held capture, initially healthy keyed editor devices only.
    /// An empty size page is the ONLY completion proof. Unsupported storage,
    /// overlays, incomplete hydration or any source/catalogue failure suppresses
    /// the entire result. Source sizes are admitted BEFORE copying/decoding docs.
    pub fn capture_bases_discovery(
        &mut self,
        timezone: Option<&str>,
    ) -> ApiResult<CapturedBasesDiscovery> {
        let mut work = WorkBudget::new();
        self.capture_bases_discovery_metered(timezone, &mut work)
    }
    pub(super) fn capture_bases_discovery_metered(
        &mut self,
        timezone: Option<&str>,
        work: &mut WorkBudget,
    ) -> ApiResult<CapturedBasesDiscovery> {
        let fence = self.collection_setup_capture_fence(None)?;
        if !self.catalog.is_valid()
            || !self
                .catalog
                .contracts()
                .iter()
                .any(|c| c.id == BASES_CONTRACT)
        {
            return Err(ErrorCode::Unavailable.err_with_reason(
                "view_metadata_unavailable",
                "Bases record contract/catalogue is not installed and valid",
            ));
        }
        let zone = timezone
            .map(str::to_owned)
            .unwrap_or_else(|| self.host.zones.default_zone());
        if zone.len() > 128 {
            return Err(ErrorCode::InvalidRequest
                .err_with_reason("invalid_timezone", "invalid Bases capture timezone"));
        }
        let instant_ms = self.capture_instant();
        let local_date = self
            .host
            .zones
            .local_date(instant_ms, &zone)
            .ok_or_else(|| {
                ErrorCode::InvalidRequest
                    .err_with_reason("invalid_timezone", "unknown Bases capture timezone")
            })?;
        let clock = OpClock {
            instant_ms,
            tz: zone,
            local_date,
        };
        let head = self.head;
        let mut after = None;
        let mut source = QueryBudget::HOSTED;
        let mut records = Vec::new();
        let mut views = Vec::new();
        loop {
            self.recheck_collection_setup_capture(&fence)?;
            let page = self
                .store
                .query_record_sizes_at(Page { after, limit: 128 }, head)
                .map_err(|_| unavailable())?;
            if page.len() > 128 {
                return Err(invalid());
            }
            if page.is_empty() {
                break;
            }
            let mut previous = after;
            let mut bytes = 0u64;
            for row in &page {
                if previous.is_some_and(|id| row.id <= id) {
                    return Err(invalid());
                }
                previous = Some(row.id);
                bytes = bytes
                    .checked_add(row.encoded_bytes)
                    .ok_or_else(unavailable)?;
            }
            if page.len() > source.records_left() as usize || bytes > source.bytes_left() {
                return Err(failure(EvaluationFailure::BudgetExceeded(
                    "bases_source_inventory",
                )));
            }
            let ids: Vec<_> = page.iter().map(|r| r.id).collect();
            let rows = self
                .store
                .hydrate_query_at(&ids, head, &mut source)
                .map_err(|_| unavailable())?;
            if rows.len() != page.len() {
                return Err(invalid());
            }
            for (row, expected) in rows.into_iter().zip(&page) {
                if row.id != expected.id
                    || row.doc.len() > 1 << 20
                    || row.doc.len() as u64 > expected.encoded_bytes
                    || row.path.len() > 1024
                    || row.path_key != mdbn_core::paths::path_key(&row.path)
                    || B32(Sha256::digest(row.doc.as_bytes()).into()) != row.revision
                    || self
                        .store
                        .record_at(&row.path_key)
                        .map_err(|_| unavailable())?
                        != Some(row.id)
                    || self
                        .store
                        .file_at(&row.path_key)
                        .map_err(|_| unavailable())?
                        .is_some()
                {
                    return Err(invalid());
                }
                // Parsing needs one owned source copy; no defaults/effective projection.
                if !work.charge(row.doc.len() as u64, row.doc.len() as u64) {
                    return Err(failure(work.failure().expect("source allocation failure")));
                }
                let document = Document::parse(row.doc.clone(), RecordFormat::for_path(&row.path));
                if let Some(base) =
                    discover_base_record(&self.catalog, &row.path, &document, &clock, work)
                        .map_err(failure)?
                {
                    if views.len() + base.views.len() > 256 {
                        return Err(failure(EvaluationFailure::BudgetExceeded(
                            "bases_discovery_views",
                        )));
                    }
                    for view in base.views {
                        let bytes = row.path.len()
                            + view.view_type.len()
                            + view.name.map_or(0, str::len)
                            + base
                                .implementations
                                .iter()
                                .map(|i| i.type_name.len() + 128)
                                .sum::<usize>();
                        if !work.charge(1, (bytes as u64) + 256) {
                            return Err(failure(
                                work.failure().expect("descriptor allocation failure"),
                            ));
                        }
                        views.push(BasesViewDescriptor {
                            record: row.id,
                            path: row.path.clone(),
                            revision: row.revision,
                            index: view.index,
                            name: view.name.map(str::to_owned),
                            view_type: view.view_type.to_owned(),
                            implementations: base
                                .implementations
                                .iter()
                                .map(|i| BasesImplementationDescriptor {
                                    type_name: i.type_name.clone(),
                                    version: i.version.to_string(),
                                    contract_digest: B32(i.contract_digest.0),
                                    implementation_digest: B32(i.digest.0),
                                })
                                .collect(),
                        });
                    }
                }
                records.push(row);
            }
            after = previous;
        }
        self.recheck_collection_setup_capture(&fence)?;
        Ok(CapturedBasesDiscovery {
            fence,
            clock,
            records,
            views,
        })
    }
    /// Re-admit current keyed-device authority/head before consuming this result.
    /// No external await is part of the capture API; future workers must recheck
    /// around every await and before evaluating or returning any observation.
    pub fn recheck_bases_discovery(&self, capture: &CapturedBasesDiscovery) -> ApiResult<()> {
        self.recheck_collection_setup_capture(&capture.fence)?;
        let mut source = QueryBudget::HOSTED;
        let mut after = None;
        let mut offset = 0usize;
        loop {
            let page = self
                .store
                .query_record_sizes_at(Page { after, limit: 128 }, self.head)
                .map_err(|_| unavailable())?;
            if page.len() > 128 {
                return Err(invalid());
            }
            if page.is_empty() {
                break;
            }
            let mut previous = after;
            let mut bytes = 0u64;
            for row in &page {
                if previous.is_some_and(|id| row.id <= id) {
                    return Err(invalid());
                }
                previous = Some(row.id);
                bytes = bytes
                    .checked_add(row.encoded_bytes)
                    .ok_or_else(unavailable)?;
            }
            if page.len() > source.records_left() as usize || bytes > source.bytes_left() {
                return Err(failure(EvaluationFailure::BudgetExceeded(
                    "bases_source_inventory",
                )));
            }
            let end = offset.checked_add(page.len()).ok_or_else(invalid)?;
            let expected = capture.records.get(offset..end).ok_or_else(invalid)?;
            if expected
                .iter()
                .zip(&page)
                .any(|(record, meta)| record.id != meta.id)
            {
                return Err(invalid());
            }
            let ids: Vec<_> = page.iter().map(|r| r.id).collect();
            let rows = self
                .store
                .hydrate_query_at(&ids, self.head, &mut source)
                .map_err(|_| unavailable())?;
            for row in &rows {
                if self
                    .store
                    .record_at(&row.path_key)
                    .map_err(|_| unavailable())?
                    != Some(row.id)
                    || self
                        .store
                        .file_at(&row.path_key)
                        .map_err(|_| unavailable())?
                        .is_some()
                {
                    return Err(invalid());
                }
            }
            if rows.len() != expected.len()
                || rows.iter().zip(expected).any(|(actual, expected)| {
                    actual.id != expected.id
                        || actual.path != expected.path
                        || actual.path_key != expected.path_key
                        || actual.revision != expected.revision
                        || actual.doc != expected.doc
                })
            {
                return Err(invalid());
            }
            offset = end;
            after = previous;
        }
        if offset != capture.records.len() {
            return Err(invalid());
        }
        self.recheck_collection_setup_capture(&capture.fence)
    }
}
