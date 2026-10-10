//! Resource-data assessment only. Atomic head planning owns namespace and
//! validity; this API cannot certify file absence, capture or source authority.
use super::*;
use std::collections::BTreeSet;

/// Maximum supplied resource inventory rows.
pub const MAX_RESOURCE_INVENTORY_ROWS: usize = 4096;
/// Maximum aggregate supplied UTF-8 resource source bytes.
pub const MAX_RESOURCE_INVENTORY_BYTES: usize = 8_388_608;
/// Maximum UTF-8 bytes in an inventory path.
pub const MAX_RESOURCE_PATH_BYTES: usize = 4096;
/// Maximum UTF-8 bytes in one supplied source.
pub const MAX_RESOURCE_SOURCE_BYTES: usize = 1_048_576;

/// Resource components, not a complete collection setup or file witness.
#[derive(Debug, Clone, PartialEq)]
pub struct CollectionResourceAssessment {
    /// Stable installer identity.
    pub application_id: String,
    /// Actual validated declaration and nested pack inputs.
    pub provision_digest: Hash,
    /// Digest of supplied resource DATA, not a trusted collection head.
    pub resource_inventory_digest: Hash,
    /// Existing configuration component evidence.
    pub configuration: ConfigurationPlan,
    /// Existing pack assessments over successive prospective resource overlays.
    pub type_packs: Vec<Assessment>,
    /// Whether the resource components are conflict-free.
    pub applicable: bool,
    /// Binds resource data, declaration, components and original guarded outputs.
    pub assessment_digest: Hash,
    operations: Vec<Op>,
}
impl CollectionResourceAssessment {
    /// Scope and component-summary DTO. Full component evidence remains in the
    /// public typed fields for existing component serializers; no file fields.
    pub fn to_value(&self) -> Value {
        obj(vec![
            ("scope", Value::string("resources")),
            ("application_id", Value::string(self.application_id.clone())),
            ("provision_digest", hash_value(self.provision_digest)),
            (
                "resource_inventory_digest",
                hash_value(self.resource_inventory_digest),
            ),
            (
                "configuration_digest",
                hash_value(self.configuration.assessment_digest),
            ),
            (
                "type_packs",
                Value::List(
                    self.type_packs
                        .iter()
                        .map(|a| {
                            obj(vec![
                                ("id", Value::string(a.pack.0.clone())),
                                ("version", Value::string(a.pack.1.clone())),
                                ("digest", hash_value(a.pack.2)),
                                ("assessment_digest", hash_value(a.assessment_digest)),
                                ("applicable", Value::Bool(a.applicable())),
                            ])
                        })
                        .collect(),
                ),
            ),
            ("applicable", Value::Bool(self.applicable)),
            ("assessment_digest", hash_value(self.assessment_digest)),
        ])
    }
}
fn inventory_digest(state: &dyn StateView) -> Result<Hash, Box<Issue>> {
    let mut paths = state.resource_paths();
    if paths.len() > MAX_RESOURCE_INVENTORY_ROWS {
        return Err(limit());
    }
    paths.sort();
    let mut seen = BTreeSet::new();
    let mut bytes = 0usize;
    let mut rows = Vec::new();
    for path in paths {
        if path.len() > MAX_RESOURCE_PATH_BYTES {
            return Err(limit());
        }
        crate::paths::check_path(&path).map_err(|_| invalid())?;
        if !seen.insert(path.clone()) {
            return Err(invalid());
        }
        let source = state.resource(&path).ok_or_else(|| {
            issue(
                "collection_resources_unavailable",
                "resource inventory row is unavailable",
            )
        })?;
        bytes = bytes.checked_add(source.len()).ok_or_else(limit)?;
        if source.len() > MAX_RESOURCE_SOURCE_BYTES || bytes > MAX_RESOURCE_INVENTORY_BYTES {
            return Err(limit());
        }
        rows.push(obj(vec![
            ("path", Value::string(path)),
            ("revision", hash_value(revision(&source))),
        ]));
    }
    Ok(jcs_digest(&Value::List(rows)))
}
// Earlier pack assessments still use their successive overlays. Only the
// published atomic output is compacted: final bytes with the FIRST base guard.
fn compact_pack_lock(operations: &mut Vec<Op>) {
    let first = operations
        .iter()
        .position(|op| matches!(op, Op::ResourcePut(r) if r.path == LOCK_PATH));
    let final_doc = operations.iter().rev().find_map(|op| match op {
        Op::ResourcePut(r) if r.path == LOCK_PATH => Some(r.doc.clone()),
        _ => None,
    });
    if let (Some(first), Some(doc)) = (first, final_doc) {
        if let Op::ResourcePut(r) = &mut operations[first] {
            r.doc = doc;
        }
        let mut kept = false;
        operations.retain(|op| {
            if matches!(op, Op::ResourcePut(r) if r.path == LOCK_PATH) {
                if kept {
                    return false;
                }
                kept = true;
            }
            true
        });
    }
}
/// Assess supplied resource DATA only; no file enumeration, promotion or
/// caller-labelled trusted revision. Operations still require atomic head checks.
pub fn assess_collection_resources(
    state: &dyn StateView,
    setup: &CollectionSetup,
) -> Result<CollectionResourceAssessment, Box<Issue>> {
    let resource_inventory_digest = inventory_digest(state)?;
    let StagedProvisions {
        configuration,
        type_packs,
        mut operations,
        applicable,
        ..
    } = stage_resource_provisions(state, setup)?;
    let provision_digest = setup.input_digest();
    let prior = state.resource(PROVISION_LOCK_PATH);
    let mut ledger = prior
        .as_deref()
        .map(ProvisionLock::parse)
        .transpose()?
        .unwrap_or_default();
    let mut changed = false;
    if applicable {
        for a in &configuration.configuration {
            changed |= ledger.contribute(
                &a.path,
                &a.value,
                Contributor {
                    application_id: setup.application_id.clone(),
                    declaration_digest: setup.declaration_digest,
                    provision_digest,
                    requirement: a.requirement.clone(),
                },
            )?;
        }
        if changed {
            let base_revision = prior.as_deref().map(revision);
            operations.push(Op::ResourcePut(ResourcePut {
                path: PROVISION_LOCK_PATH.into(),
                doc: ledger.render()?,
                base_revision,
                must_not_exist: base_revision.is_none(),
            }));
        }
        compact_pack_lock(&mut operations);
    } else {
        operations.clear();
    }
    let outputs = operations
        .iter()
        .map(|op| match op {
            Op::ResourcePut(r) => obj(vec![
                ("path", Value::string(r.path.clone())),
                ("revision", hash_value(revision(&r.doc))),
                ("base", optional_hash(r.base_revision)),
                ("create_only", Value::Bool(r.must_not_exist)),
                ("kind", Value::string("put")),
            ]),
            Op::ResourceDelete(r) => obj(vec![
                ("path", Value::string(r.path.clone())),
                ("base", optional_hash(r.base_revision)),
                ("kind", Value::string("delete")),
            ]),
            _ => unreachable!("resource components produce only resource operations"),
        })
        .collect();
    let assessment_digest = jcs_digest(&obj(vec![
        ("scope", Value::string("resources")),
        ("inventory", hash_value(resource_inventory_digest)),
        ("provision", hash_value(provision_digest)),
        ("configuration", hash_value(configuration.assessment_digest)),
        (
            "packs",
            Value::List(
                type_packs
                    .iter()
                    .map(|a| hash_value(a.assessment_digest))
                    .collect(),
            ),
        ),
        ("applicable", Value::Bool(applicable)),
        ("outputs", Value::List(outputs)),
    ]));
    if inventory_digest(state)? != resource_inventory_digest {
        return Err(stale());
    }
    Ok(CollectionResourceAssessment {
        application_id: setup.application_id.clone(),
        provision_digest,
        resource_inventory_digest,
        configuration,
        type_packs,
        applicable,
        assessment_digest,
        operations,
    })
}
/// Re-assess resource inputs and return one original guarded resource intent.
/// Callers append ordinary creates, then submit atomically; never install parts.
pub fn apply_collection_resources(
    state: &dyn StateView,
    setup: &CollectionSetup,
    expected_digest: Hash,
) -> Result<(CollectionResourceAssessment, Vec<Op>), Box<Issue>> {
    let assessment = assess_collection_resources(state, setup)?;
    if assessment.assessment_digest != expected_digest {
        return Err(stale());
    }
    if !assessment.applicable {
        return Err(issue(
            "collection_setup_conflict",
            "resource components conflict",
        ));
    }
    let operations = assessment.operations.clone();
    Ok((assessment, operations))
}
