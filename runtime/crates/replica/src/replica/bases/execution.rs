//! Immutable selected-view execution inputs over the actual fenced inventory.
//! On-device data-only seam: no facade, publication headers or caller sources.
use super::*;
use mdbn_core::views::bases::{
    CapturedFile, CapturedPropertyTypes, MAX_PROPERTY_TYPE_HINT_BYTES, MAX_PROPERTY_TYPE_HINTS,
};
use std::collections::BTreeMap;
mod indexed;
mod run;
mod tags;
pub use run::{
    BasesExecutionGroup, BasesExecutionPolicies, BasesExecutionResult, BasesExecutionRow,
};
mod window;
pub use window::{BasesExecutionWindow, BasesGroupPlacement, BasesReadRequest, BasesWindowInfo};
/// Identity/source CAS and source declaration ordinal. Names are not identities.
#[derive(Clone, Copy)]
pub struct BasesViewSelection {
    /// Actual record UUID from discovery.
    pub record: Uuid,
    /// SHA256 of exact raw source observed by the client.
    pub revision: Hash,
    /// Original view ordinal, preserving duplicate/missing names.
    pub index: u32,
}
/// Opaque immutable execution inputs. Source/authority come from Replica, not
/// an app-provided source document. Property hints are explicitly captured host
/// data, not effective/defaulted catalogue properties or publication authority.
pub struct CapturedBasesExecutionInputs {
    pub(super) capture: CapturedBasesDiscovery,
    pub(super) selected: usize,
    pub(super) property_types: BTreeMap<String, String>,
    pub(super) files: Vec<CapturedFile>,
    pub(super) documents: Vec<Document>,
    pub(super) tags: Vec<Option<Vec<String>>>,
    pub(super) work: WorkBudget,
}
impl CapturedBasesExecutionInputs {
    #[cfg(test)]
    pub(crate) fn exhaust_for_test(&mut self) {
        self.work.charge(u64::MAX, u64::MAX);
    }
    /// Exact resolved selected declaration identity.
    pub fn view(&self) -> &BasesViewDescriptor {
        &self.capture.views[self.selected]
    }
    /// Frozen host clock shared by discovery, admission and all rows.
    pub fn clock(&self) -> &OpClock {
        &self.capture.clock
    }
    /// Verified complete confirmed record count, not a partial candidate page.
    pub fn record_count(&self) -> usize {
        self.capture.records.len()
    }
    /// Head/custody/catalogue observation binding, not a caller revision assertion.
    pub fn collection_revision(&self) -> Hash {
        self.capture.collection_revision()
    }
    /// Explicit known-empty or captured property type registry size.
    pub fn property_type_count(&self) -> usize {
        self.property_types.len()
    }
    /// Number of captured file identity/size observations. Missing time facts stay
    /// unavailable; no creation=mtime or epoch defaults are introduced.
    pub fn file_observation_count(&self) -> usize {
        self.files.len()
    }
    /// Verified raw documents retained for residual execution; no source escape.
    pub fn raw_document_count(&self) -> usize {
        self.documents.len()
    }
    /// Tag sets known within the narrow raw-frontmatter domain. Unqualified body
    /// extraction or tag shapes stay unavailable, never empty false matches.
    pub fn known_tag_observation_count(&self) -> usize {
        self.tags.iter().filter(|v| v.is_some()).count()
    }
}
impl<S: Store> Replica<S> {
    /// Current authenticated READ and unrestricted collection scope for the
    /// app-runtime Bases producer. Unknown/revoked sessions fail before scope
    /// inspection. Call before capture, before encode and before publication;
    /// this is not a substitute for the executor's independent actor fences.
    pub fn authorize_bases_read(&self, session: crate::api::SessionId) -> ApiResult<()> {
        self.require(session, crate::policy::capability::READ)?;
        if self.file_scope(session).is_some() {
            return Err(ErrorCode::Forbidden.err_with_reason(
                "view_full_collection_required",
                "Bases execution requires an unrestricted collection READ session",
            ));
        }
        Ok(())
    }
    /// Capture an actual resolved view source and complete raw inventory while the
    /// actor holds its strict healthy keyed-editor fence. `None` registry is not
    /// known-empty. Never resolve a view by extension/name or caller YAML.
    pub fn capture_bases_execution_inputs(
        &mut self,
        selection: BasesViewSelection,
        property_types: Option<&BTreeMap<String, String>>,
        timezone: Option<&str>,
    ) -> ApiResult<CapturedBasesExecutionInputs> {
        // Authorize before accepting any host metadata, then bind its immutable copy
        // to the same actual inventory/fence/clock used by source discovery.
        let initial = self.collection_setup_capture_fence(None)?;
        let Some(hints) = property_types else {
            return Err(failure(EvaluationFailure::MetadataUnavailable(
                "property_types_not_captured",
            )));
        };
        if hints.len() > MAX_PROPERTY_TYPE_HINTS {
            return Err(failure(EvaluationFailure::BudgetExceeded(
                "property_type_count",
            )));
        }
        let bytes = hints
            .iter()
            .try_fold(0usize, |n, (k, v)| {
                n.checked_add(k.len()).and_then(|n| n.checked_add(v.len()))
            })
            .ok_or_else(|| failure(EvaluationFailure::BudgetExceeded("property_type_bytes")))?;
        if bytes > MAX_PROPERTY_TYPE_HINT_BYTES {
            return Err(failure(EvaluationFailure::BudgetExceeded(
                "property_type_bytes",
            )));
        }
        let mut work = WorkBudget::new();
        CapturedPropertyTypes::capture(hints, &mut work).map_err(failure)?;
        if !work.charge(hints.len() as u64, (bytes + hints.len() * 128) as u64) {
            return Err(failure(work.failure().expect("registry copy budget")));
        }
        let property_types = hints.clone();
        self.recheck_collection_setup_capture(&initial)?;
        let capture = self.capture_bases_discovery_metered(timezone, &mut work)?;
        self.recheck_collection_setup_capture(&initial)?;
        let selected = capture
            .views
            .iter()
            .position(|view| view.record == selection.record && view.index == selection.index)
            .ok_or_else(|| {
                ErrorCode::InvalidRequest.err_with_reason(
                    "base_view_not_found",
                    "the requested resolved Bases source declaration is unavailable",
                )
            })?;
        let view = &capture.views[selected];
        if view.revision != selection.revision {
            return Err(invalid());
        }
        if !matches!(
            view.view_type.as_str(),
            "table" | "tasknotesTaskList" | "tasknotesKanban"
        ) {
            return Err(failure(EvaluationFailure::UnsupportedConstruct(
                "bases_view_renderer",
            )));
        }
        if !work.charge(
            capture.records.len() as u64,
            (capture.records.len() * std::mem::size_of::<CapturedFile>()) as u64,
        ) {
            return Err(failure(work.failure().expect("file observation budget")));
        }
        let mut files = Vec::with_capacity(capture.records.len());
        if !work.charge(
            capture.records.len() as u64,
            (capture.records.len()
                * (std::mem::size_of::<Document>() + std::mem::size_of::<Option<Vec<String>>>()))
                as u64,
        ) {
            return Err(failure(work.failure().expect("raw row storage budget")));
        }
        let mut documents = Vec::with_capacity(capture.records.len());
        let mut tags = Vec::with_capacity(capture.records.len());
        for record in &capture.records {
            if !work.charge(record.doc.len() as u64, record.doc.len() as u64) {
                return Err(failure(
                    work.failure().expect("raw execution document budget"),
                ));
            }
            let document =
                Document::parse(record.doc.clone(), RecordFormat::for_path(&record.path));
            tags.push(tags::capture(&document, &mut work).map_err(failure)?);
            documents.push(document);
            // Path/source byte count are proven by the inventory. RecordRow carries no
            // authenticated birth/mtime timestamp; keep both unavailable, never guess
            // from host stat, modified sequence, status history or snapshot time.
            files.push(
                CapturedFile::new(
                    &record.path,
                    Some(record.doc.len() as u64),
                    None,
                    None,
                    &mut work,
                )
                .map_err(failure)?,
            );
        }
        self.recheck_collection_setup_capture(&capture.fence)?;
        Ok(CapturedBasesExecutionInputs {
            capture,
            selected,
            property_types,
            files,
            documents,
            tags,
            work,
        })
    }
    /// Re-admit authority and actual complete inventory before executing or
    /// returning observations, including unchanged-head source/holder drift.
    pub fn recheck_bases_execution_inputs(
        &self,
        inputs: &CapturedBasesExecutionInputs,
    ) -> ApiResult<()> {
        self.recheck_bases_discovery(&inputs.capture)
    }
}
