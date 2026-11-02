//! Reviewed choices are CAS inputs, not a declaration or durable provision identity.
use super::*;
use std::collections::BTreeMap;

/// Validate only advertised replacements at exact live bytes: an unmanaged
/// target's conflict, or a seed setup cannot upgrade (a conflict, or kept
/// with a reason). Installed managed, missing, changed and undeclared targets
/// always refuse.
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
    let assessment = assess_collection_resources(state, setup, &BTreeMap::new())?;
    let eligible: BTreeMap<_, _> = assessment
        .type_packs
        .iter()
        .flat_map(|a| {
            a.resources.iter().filter_map(move |r| {
                let installed = a
                    .current
                    .as_ref()
                    .is_some_and(|c| c.resources.iter().any(|e| e.target == r.target));
                let replaceable = match r.mode {
                    packs::Mode::Managed => r.action == packs::Action::Conflict && !installed,
                    packs::Mode::Seed => {
                        r.action == packs::Action::Conflict
                            || (r.action == packs::Action::Preserve && r.reason.is_some())
                    }
                };
                replaceable
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
/// Choose sources against the complete prospective state with exact reviewed adoptions.
pub fn reviewed_collection_setup_source_requirements(
    view: &dyn SetupStateView,
    setup: &CollectionSetup,
    clock: &OpClock,
    adopt: &BTreeMap<String, Hash>,
) -> Result<CollectionSetupSourceRequirements, Box<Issue>> {
    reviewed_resource_adoptions(view.state(), setup, adopt)?;
    source_requirements(view, setup, clock, adopt)
}
/// Assess complete setup with reviewed overwrites, without altering provision
/// identity. Each adoption is a pack option, so its write is guarded by the
/// reviewed revision and the assessment digest binds it.
pub fn assess_reviewed_collection_setup(
    view: &dyn SetupStateView,
    setup: &CollectionSetup,
    clock: &OpClock,
    adopt: &BTreeMap<String, Hash>,
    records: &[SetupStarterRecord],
) -> Result<CollectionSetupAssessment, Box<Issue>> {
    validate_setup_starter_records(records)?;
    reviewed_resource_adoptions(view.state(), setup, adopt)?;
    let mut assessment = assess_setup(view, setup, clock, adopt)?;
    records::append_starters(view, clock, &mut assessment, records)?;
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
