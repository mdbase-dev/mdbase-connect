//! Input/clock-bound sans-IO setup workflow. Reviewed pure operations remain
//! data: no runtime conversion, publication or SDK activation occurs here.
use super::{Replica, SetupCapturedInventory, SetupSourceRead, Store};
use crate::{
    api::{ApiResult, ErrorCode},
    file_source::SourceNeed,
};
use mdbn_core::{
    ids::{FileId, Hash},
    intent::{Op, OpClock},
    setup::envelope::{
        CollectionSetup, CollectionSetupAssessment, apply_reviewed_collection_setup,
        assess_reviewed_collection_setup, reviewed_collection_setup_source_requirements,
    },
};
use mdbn_wire::common::Uuid;

/// One owned input identity and captured trusted clock across source awaits.
/// No clone, host-provided source observations or publication capability.
pub struct CollectionSetupSession {
    setup: CollectionSetup,
    clock: OpClock,
    capture: SetupCapturedInventory,
    files: Vec<FileId>,
    next: usize,
    work: Option<SetupSourceRead>,
    failed: bool,
    adopt: std::collections::BTreeMap<String, Hash>,
    records: Vec<mdbn_core::setup::envelope::SetupStarterRecord>,
    source_refs: std::collections::BTreeSet<mdbn_wire::common::Hash>,
}
/// Full reviewed assessment retaining the actual immutable inputs and sources.
pub struct PreparedCollectionSetupReview {
    setup: CollectionSetup,
    clock: OpClock,
    capture: SetupCapturedInventory,
    assessment: CollectionSetupAssessment,
    adopt: std::collections::BTreeMap<String, Hash>,
    records: Vec<mdbn_core::setup::envelope::SetupStarterRecord>,
    source_refs: Vec<mdbn_wire::common::Hash>,
}
impl PreparedCollectionSetupReview {
    pub(crate) fn declaration_digest(&self) -> Hash {
        self.setup.declaration_digest
    }
    /// Review projection; may contain user data, so do not log it.
    pub fn assessment(&self) -> &CollectionSetupAssessment {
        &self.assessment
    }
    /// Exact trusted clock captured before source IO, not recaptured on apply.
    pub fn clock(&self) -> &OpClock {
        &self.clock
    }
}
/// Review-bound complete pure operation set. Not a sealed mutation, trusted
/// header or publication capability; runtime Op17/Effect11 remain guarded.
pub struct PreparedCollectionSetupPlan {
    review: PreparedCollectionSetupReview,
    operations: Vec<Op>,
}
impl PreparedCollectionSetupPlan {
    /// Initiating app grant, independently fenced from the keyed device writer.
    pub fn initiating_grant(&self) -> Option<Uuid> {
        self.review.capture.initiating_grant()
    }
    /// Authenticated API session which owns this review, when opened by a client.
    pub fn initiating_client(&self) -> Option<crate::api::SessionId> {
        self.review.capture.initiating_client()
    }
    /// Complete operation data for a later atomic mediated publisher; never
    /// install its configuration/packs/promotions/receipts separately.
    pub fn operations(&self) -> &[Op] {
        &self.operations
    }
    pub(crate) fn source_refs(&self) -> &[mdbn_wire::common::Hash] {
        &self.review.source_refs
    }
    /// Review which admitted this complete operation set.
    pub fn assessment(&self) -> &CollectionSetupAssessment {
        self.review.assessment()
    }
    /// Frozen original trusted clock.
    pub fn clock(&self) -> &OpClock {
        self.review.clock()
    }
}
fn unavailable() -> crate::api::ApiError {
    ErrorCode::Unavailable.err_with_reason(
        "collection_setup_metadata_unavailable",
        "complete setup session source proof is unavailable",
    )
}
fn changed() -> crate::api::ApiError {
    super::changed()
}
impl<S: Store> Replica<S> {
    /// Freeze actual validated declarations, prospective candidates, complete
    /// inventory and the replica's monotonic host clock before source IO.
    pub fn begin_collection_setup_session(
        &mut self,
        setup: CollectionSetup,
        timezone: Option<&str>,
        on_behalf: Option<Uuid>,
    ) -> ApiResult<CollectionSetupSession> {
        self.begin_setup_session(
            setup,
            timezone,
            on_behalf,
            None,
            Default::default(),
            Vec::new(),
        )
    }
    /// Begin from the authenticated original client session and the CURRENT
    /// trusted declaration. The request never supplies a grant, key or manifest.
    pub fn begin_app_collection_setup_session(
        &mut self,
        session: crate::api::SessionId,
        timezone: Option<&str>,
    ) -> ApiResult<CollectionSetupSession> {
        self.begin_app_setup_with_adoptions(session, timezone, Default::default(), Vec::new())
    }
    pub(crate) fn begin_app_setup_with_adoptions(
        &mut self,
        session: crate::api::SessionId,
        timezone: Option<&str>,
        adopt: std::collections::BTreeMap<String, Hash>,
        records: Vec<mdbn_core::setup::envelope::SetupStarterRecord>,
    ) -> ApiResult<CollectionSetupSession> {
        let auth = self.session(session)?.auth.clone();
        let crate::api::SessionAuth::Grant { grant, client_pk } = auth else {
            return Err(ErrorCode::Forbidden.err("declared setup requires an app grant"));
        };
        self.grant_for_client(&grant, &client_pk).ok_or_else(|| {
            ErrorCode::Unauthenticated.err("the original client grant is no longer active")
        })?;
        let setup = self.setup_delegation(grant)?.authorization.setup;
        self.begin_setup_session(
            setup,
            timezone,
            Some(grant),
            Some((session, client_pk)),
            adopt,
            records,
        )
    }
    fn begin_setup_session(
        &mut self,
        mut setup: CollectionSetup,
        timezone: Option<&str>,
        on_behalf: Option<Uuid>,
        client: Option<(crate::api::SessionId, [u8; 32])>,
        adopt: std::collections::BTreeMap<String, Hash>,
        records: Vec<mdbn_core::setup::envelope::SetupStarterRecord>,
    ) -> ApiResult<CollectionSetupSession> {
        mdbn_core::setup::envelope::validate_setup_starter_records(&records)
            .map_err(|i| ErrorCode::InvalidRequest.err_with_reason(&i.code, i.message))?;
        let capture = match on_behalf {
            Some(grant) => self.capture_declared_setup_inventory(&setup, grant, client)?,
            None => self.capture_collection_setup_inventory(None)?,
        };
        if on_behalf.is_some() {
            self.with_setup_capture_view(&capture, |view| {
                setup.resolve_installer_targets(view.state())
            })?;
        }
        let zone = timezone
            .map(str::to_owned)
            .unwrap_or_else(|| self.host.zones.default_zone());
        if zone.len() > 128 {
            return Err(ErrorCode::InvalidRequest
                .err_with_reason("invalid_timezone", "invalid setup timezone"));
        }
        let instant_ms = self.capture_instant();
        let local_date = self
            .host
            .zones
            .local_date(instant_ms, &zone)
            .ok_or_else(|| {
                ErrorCode::InvalidRequest
                    .err_with_reason("invalid_timezone", "unknown setup timezone")
            })?;
        let clock = OpClock {
            instant_ms,
            tz: zone,
            local_date,
        };
        let needs = self.with_setup_capture_view(&capture, |view| {
            reviewed_collection_setup_source_requirements(view, &setup, &clock, &adopt)
        })?;
        let files = needs
            .files
            .into_iter()
            .filter(|f| f.content.size() <= mdbn_core::intent::RECORD_SOURCE_CAP_BYTES)
            .map(|f| f.id)
            .collect();
        Ok(CollectionSetupSession {
            setup,
            clock,
            capture,
            files,
            next: 0,
            work: None,
            failed: false,
            adopt,
            records,
            source_refs: Default::default(),
        })
    }
    pub(crate) fn check_collection_setup_review(
        &self,
        review: &PreparedCollectionSetupReview,
    ) -> ApiResult<()> {
        self.check_setup_inventory(&review.capture)?;
        if review
            .assessment
            .records
            .iter()
            .any(|r| r.action == "create")
        {
            self.require(
                review.capture.initiating_client().ok_or_else(unavailable)?,
                "records.create",
            )?;
        }
        Ok(())
    }
    pub(crate) fn check_collection_setup_session(
        &self,
        session: &CollectionSetupSession,
    ) -> ApiResult<()> {
        self.check_setup_inventory(&session.capture)
    }
    /// Exact next bounded encrypted object. Finished readers are authenticated
    /// and retained before advancing. None means IO complete, not setup success.
    pub fn collection_setup_session_need(
        &self,
        session: &mut CollectionSetupSession,
    ) -> ApiResult<Option<SourceNeed>> {
        let result = (|| {
            if session.failed {
                return Err(unavailable());
            }
            self.check_setup_inventory(&session.capture)?;
            loop {
                if let Some(work) = session.work.as_mut() {
                    if let Some(need) = self.collection_setup_source_need(work)? {
                        return Ok(Some(need));
                    }
                    let work = session.work.take().ok_or_else(unavailable)?;
                    self.finish_collection_setup_source(&mut session.capture, work)?;
                    session.next += 1;
                }
                let Some(id) = session.files.get(session.next) else {
                    return Ok(None);
                };
                session.work = Some(self.begin_collection_setup_source(&session.capture, *id)?);
            }
        })();
        if result.is_err() {
            session.failed = true;
            session.work = None;
        }
        result
    }
    /// Authenticate a requested object after host transport. The host must
    /// enforce the need's byte bound while fetching, before buffering.
    pub fn supply_collection_setup_session(
        &self,
        session: &mut CollectionSetupSession,
        need: SourceNeed,
        encrypted: &[u8],
    ) -> ApiResult<()> {
        let result = (|| {
            if session.failed {
                return Err(unavailable());
            }
            self.check_setup_inventory(&session.capture)?;
            self.supply_collection_setup_source(
                session.work.as_mut().ok_or_else(unavailable)?,
                need,
                encrypted,
            )?;
            let address = match need {
                SourceNeed::BlobPart { address, .. }
                | SourceNeed::Manifest { address, .. }
                | SourceNeed::Chunk { address, .. } => address,
            };
            session.source_refs.insert(address);
            Ok(())
        })();
        if result.is_err() {
            session.failed = true;
            session.work = None;
        }
        result
    }
    /// Complete full Core assessment under actor-held state. Conflicting
    /// assessments are reviewable but cannot produce a prepared applicable plan.
    pub fn finish_collection_setup_session(
        &self,
        mut session: CollectionSetupSession,
    ) -> ApiResult<PreparedCollectionSetupReview> {
        if self.collection_setup_session_need(&mut session)?.is_some() {
            return Err(unavailable());
        }
        let assessment = self.with_setup_capture_view(&session.capture, |view| {
            assess_reviewed_collection_setup(
                view,
                &session.setup,
                &session.clock,
                &session.adopt,
                &session.records,
            )
        })?;
        let review = PreparedCollectionSetupReview {
            setup: session.setup,
            clock: session.clock,
            capture: session.capture,
            assessment,
            adopt: session.adopt,
            records: session.records,
            source_refs: session.source_refs.into_iter().collect(),
        };
        self.check_collection_setup_review(&review)?;
        Ok(review)
    }
    /// Reassess the ORIGINAL actual inputs/clock against the reviewed digest and
    /// trusted revision. Returns complete pure data only, not a mutation receipt.
    pub fn prepare_reviewed_collection_setup(
        &self,
        review: PreparedCollectionSetupReview,
        expected_revision: Hash,
        expected_digest: Hash,
    ) -> ApiResult<PreparedCollectionSetupPlan> {
        self.check_collection_setup_review(&review)?;
        if review.assessment.collection_revision != expected_revision
            || review.assessment.assessment_digest != expected_digest
        {
            return Err(changed());
        }
        let (assessment, operations) = self.with_setup_capture_view(&review.capture, |view| {
            apply_reviewed_collection_setup(
                view,
                &review.setup,
                &review.clock,
                &review.adopt,
                &review.records,
                expected_revision,
                expected_digest,
            )
        })?;
        Ok(PreparedCollectionSetupPlan {
            review: PreparedCollectionSetupReview {
                assessment,
                ..review
            },
            operations,
        })
    }
    /// A later publisher must recheck immediately before building real trusted
    /// headers; this method still emits no mutation and cannot enable Op17.
    pub fn recheck_prepared_collection_setup(
        &self,
        plan: &PreparedCollectionSetupPlan,
    ) -> ApiResult<()> {
        self.check_collection_setup_review(&plan.review)?;
        self.with_setup_capture_view(&plan.review.capture, |view| {
            apply_reviewed_collection_setup(
                view,
                &plan.review.setup,
                &plan.review.clock,
                &plan.review.adopt,
                &plan.review.records,
                plan.review.assessment.collection_revision,
                plan.review.assessment.assessment_digest,
            )
            .map(|_| ())
        })
    }
}
