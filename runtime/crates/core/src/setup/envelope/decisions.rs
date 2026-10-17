//! Reviewed choices are CAS inputs, not a declaration or durable provision identity.
use super::*;
use std::collections::BTreeMap;

/// Validate only advertised unmanaged, managed-mode conflicts at exact live bytes.
/// Installed, seed, missing, changed and undeclared targets always refuse.
pub fn reviewed_resource_adoptions(
    state: &dyn StateView,
    setup: &CollectionSetup,
    requested: &BTreeMap<String, Hash>,
) -> Result<BTreeMap<String, Hash>, Box<Issue>> {
    if requested.is_empty() {
        return Ok(BTreeMap::new());
    }
    if requested.len() > 256 || requested.keys().any(|p| p.len() > 1024) {
        return Err(limit());
    }
    let assessment = assess_collection_resources(state, setup)?;
    let eligible: BTreeMap<_, _> = assessment
        .type_packs
        .iter()
        .flat_map(|a| {
            a.resources.iter().filter_map(move |r| {
                let installed = a
                    .current
                    .as_ref()
                    .is_some_and(|c| c.resources.iter().any(|e| e.target == r.target));
                (r.action == packs::Action::Conflict
                    && r.mode == packs::Mode::Managed
                    && !installed)
                    .then_some(r.live.map(|live| (r.target.clone(), live)))
                    .flatten()
            })
        })
        .collect();
    for (path, digest) in requested {
        if eligible.get(path) != Some(digest)
            || state.resource(path).as_deref().map(revision) != Some(*digest)
        {
            return Err(stale());
        }
    }
    Ok(requested.clone())
}
struct ReviewedView<'a> {
    raw: &'a dyn SetupStateView,
    state: Overlay<'a>,
}
impl SetupStateView for ReviewedView<'_> {
    fn state(&self) -> &dyn StateView {
        &self.state
    }
    fn collection_revision(&self) -> Hash {
        self.raw.collection_revision()
    }
    fn file_page(
        &self,
        after: Option<crate::ids::FileId>,
        limit: usize,
    ) -> Result<Vec<StoredFile>, Box<Issue>> {
        self.raw.file_page(after, limit)
    }
    fn source(&self, file: &StoredFile, max: usize) -> Result<SetupSourceObservation, Box<Issue>> {
        self.raw.source(file, max)
    }
}
fn reviewed<'a>(
    view: &'a dyn SetupStateView,
    setup: &CollectionSetup,
    adopt: &BTreeMap<String, Hash>,
) -> Result<ReviewedView<'a>, Box<Issue>> {
    reviewed_resource_adoptions(view.state(), setup, adopt)?;
    let mut state = Overlay::new(view.state());
    for path in adopt.keys() {
        state.apply_effect(&Effect::RemoveResource { path: path.clone() });
    }
    Ok(ReviewedView { raw: view, state })
}
/// Choose sources against the complete prospective state AFTER exact reviewed adoptions.
pub fn reviewed_collection_setup_source_requirements(
    view: &dyn SetupStateView,
    setup: &CollectionSetup,
    clock: &OpClock,
    adopt: &BTreeMap<String, Hash>,
) -> Result<CollectionSetupSourceRequirements, Box<Issue>> {
    collection_setup_source_requirements(&reviewed(view, setup, adopt)?, setup, clock)
}
/// Assess complete setup with reviewed overwrites, without altering provision identity.
pub fn assess_reviewed_collection_setup(
    view: &dyn SetupStateView,
    setup: &CollectionSetup,
    clock: &OpClock,
    adopt: &BTreeMap<String, Hash>,
    records: &[SetupStarterRecord],
) -> Result<CollectionSetupAssessment, Box<Issue>> {
    validate_setup_starter_records(records)?;
    let staged = reviewed(view, setup, adopt)?;
    let mut assessment = assess_collection_setup(&staged, setup, clock)?;
    if assessment.applicable {
        let mut applied = BTreeMap::new();
        for op in &mut assessment.operations {
            if let Op::ResourcePut(put) = op
                && let Some(digest) = adopt.get(&put.path)
            {
                if !put.must_not_exist
                    || put.base_revision.is_some()
                    || applied.insert(put.path.clone(), *digest).is_some()
                {
                    return Err(stale());
                }
                put.must_not_exist = false;
                put.base_revision = Some(*digest);
            }
        }
        if applied != *adopt {
            return Err(stale());
        }
        // Re-plan the COMPLETE guarded batch against ACTUAL state, not the mask.
        validate_setup_operations(view.state(), clock, &assessment.operations)?;
    }
    if !adopt.is_empty() {
        assessment.assessment_digest = jcs_digest(&obj(vec![
            ("assessment", hash_value(assessment.assessment_digest)),
            (
                "adopt",
                Value::Map(
                    adopt
                        .iter()
                        .map(|(p, h)| (p.clone(), hash_value(*h)))
                        .collect(),
                ),
            ),
        ]));
    }
    records::append_starters(view, clock, &mut assessment, records)?;
    assessment.adopted = adopt.clone();
    if view.collection_revision() != assessment.collection_revision {
        return Err(stale());
    }
    Ok(assessment)
}
/// Reassess the SAME choices and return only the full guarded atomic operation set.
pub fn apply_reviewed_collection_setup(
    view: &dyn SetupStateView,
    setup: &CollectionSetup,
    clock: &OpClock,
    adopt: &BTreeMap<String, Hash>,
    records: &[SetupStarterRecord],
    expected_revision: Hash,
    expected_digest: Hash,
) -> Result<(CollectionSetupAssessment, Vec<Op>), Box<Issue>> {
    let assessment = assess_reviewed_collection_setup(view, setup, clock, adopt, records)?;
    if assessment.collection_revision != expected_revision
        || assessment.assessment_digest != expected_digest
    {
        return Err(stale());
    }
    if !assessment.applicable {
        return Err(issue(
            "collection_setup_conflict",
            "setup components conflict",
        ));
    }
    let operations = assessment.operations.clone();
    Ok((assessment, operations))
}
