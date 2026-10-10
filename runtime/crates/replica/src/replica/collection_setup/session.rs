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
    setup::envelope::{CollectionSetup, CollectionSetupAssessment, apply_collection_setup},
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
}
/// Full reviewed assessment retaining the actual immutable inputs and sources.
pub struct PreparedCollectionSetupReview {
    setup: CollectionSetup,
    clock: OpClock,
    capture: SetupCapturedInventory,
    assessment: CollectionSetupAssessment,
}
impl PreparedCollectionSetupReview {
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
    /// Complete operation data for a later atomic mediated publisher; never
    /// install its configuration/packs/promotions/receipts separately.
    pub fn operations(&self) -> &[Op] {
        &self.operations
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
        let capture = self.capture_collection_setup_inventory(on_behalf)?;
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
        let needs = self.captured_collection_setup_source_requirements(&capture, &setup, &clock)?;
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
        })
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
            )
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
        let assessment = self.assess_captured_collection_setup(
            &session.capture,
            &session.setup,
            &session.clock,
        )?;
        Ok(PreparedCollectionSetupReview {
            setup: session.setup,
            clock: session.clock,
            capture: session.capture,
            assessment,
        })
    }
    /// Reassess the ORIGINAL actual inputs/clock against the reviewed digest and
    /// trusted revision. Returns complete pure data only, not a mutation receipt.
    pub fn prepare_reviewed_collection_setup(
        &self,
        review: PreparedCollectionSetupReview,
        expected_revision: Hash,
        expected_digest: Hash,
    ) -> ApiResult<PreparedCollectionSetupPlan> {
        if review.assessment.collection_revision != expected_revision
            || review.assessment.assessment_digest != expected_digest
        {
            return Err(changed());
        }
        let (assessment, operations) = self.with_setup_capture_view(&review.capture, |view| {
            apply_collection_setup(
                view,
                &review.setup,
                &review.clock,
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
        self.with_setup_capture_view(&plan.review.capture, |view| {
            apply_collection_setup(
                view,
                &plan.review.setup,
                &plan.review.clock,
                plan.review.assessment.collection_revision,
                plan.review.assessment.assessment_digest,
            )
            .map(|_| ())
        })
    }
}
