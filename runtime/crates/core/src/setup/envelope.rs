//! Complete pure setup staging. Provider-mediated capture/atomic publication
//! remains a separate gate: these values and operations confer no authority.
use super::capture::{
    FILE_PAGE_SIZE, MAX_INVENTORY_FILES, MAX_SETUP_FILES, MAX_SETUP_SOURCE_BYTES,
    SetupSourceObservation, SetupStateView,
};
use super::configuration::{ConfigurationDeclaration, ConfigurationPlan, plan_configuration};
use super::receipts::{Contributor, PROVISION_LOCK_PATH, ProvisionLock};
use crate::contracts::jcs_digest;
use crate::ids::{Hash, Uuid, revision};
use crate::intent::{
    ConflictMode, FileKind, Mutation, Op, OpClock, OrdinaryFileToRecord, RECORD_SOURCE_CAP_BYTES,
    ResourcePut, Source,
};
use crate::packs::{self, AssessOptions, Assessment, Pack};
use crate::plan::{Effect, PlanOptions, Stage};
use crate::state::{Overlay, StateView, StoredFile};
use crate::types::{CONFIG_PATH, LOCK_PATH};
use crate::validate::{Issue, Severity, Tier};
use crate::value::Value;

mod decode;
mod resources;
pub use resources::{
    CollectionResourceAssessment, MAX_RESOURCE_INVENTORY_BYTES, MAX_RESOURCE_INVENTORY_ROWS,
    MAX_RESOURCE_PATH_BYTES, MAX_RESOURCE_SOURCE_BYTES, apply_collection_resources,
    assess_collection_resources,
};

/// Maximum nested packs in one reviewed envelope.
pub const MAX_TYPE_PACKS: usize = 16;
/// Maximum resource/baseline bytes across all nested packs.
pub const MAX_PACK_BYTES: usize = 8_388_608;
/// A validated type pack with explicit, reviewed installer choices.
#[derive(Debug, Clone, PartialEq)]
pub struct CollectionSetupTypePack {
    /// Strictly loaded pack; mutable fields revalidated by pack assessment.
    pub pack: Pack,
    /// Explicit installer decisions, bound to the actual provision digest.
    pub options: AssessOptions,
}
/// Typed envelope assembled by the installer, never by merging application YAML.
#[derive(Debug, Clone, PartialEq)]
pub struct CollectionSetup {
    /// Stable installer identity, also used by nested pack receipts.
    pub application_id: String,
    /// Publisher identity only; actual declarations are independently hashed.
    pub declaration_digest: Hash,
    /// Lifted requirements/provisions from the catalog carrier.
    pub configuration: ConfigurationDeclaration,
    /// Ordered nested type packs. Strict load_pack remains unchanged.
    pub type_packs: Vec<CollectionSetupTypePack>,
}
/// File-specific assessment/receipt outcome. Prior metadata binds capture/CAS.
#[derive(Debug, Clone, PartialEq)]
pub struct SetupFileAssessment {
    /// Exact current Ordinary holder.
    pub file: StoredFile,
    /// promote or retain.
    pub action: &'static str,
    /// Typed source admission diagnostic, never observed source/parser text.
    pub diagnostic: Option<String>,
    /// Actual observed UTF-8 bytes when available.
    pub source_digest: Option<Hash>,
}
/// Whole-envelope assessment. Not a publication or provider capability.
#[derive(Debug, Clone, PartialEq)]
pub struct CollectionSetupAssessment {
    /// Reviewed identity and actual-input digest.
    pub application_id: String,
    /// Exact frozen trusted head revision.
    pub collection_revision: Hash,
    /// Actual declaration, nested pack bytes/options and identity.
    pub provision_digest: Hash,
    /// Configuration component assessment.
    pub configuration: ConfigurationPlan,
    /// Nested pack assessments at the successive prospective overlay.
    pub type_packs: Vec<Assessment>,
    /// Complete affected Ordinary-holder list, including refused sources.
    pub files: Vec<SetupFileAssessment>,
    /// Whether all non-source components may apply.
    pub applicable: bool,
    /// Binds actual inputs, head, components, files and both receipt documents.
    pub assessment_digest: Hash,
    operations: Vec<Op>,
}
fn issue(code: &str, message: impl Into<String>) -> Box<Issue> {
    Box::new(Issue::new(code, Severity::Error, Tier::Request, message))
}
fn invalid() -> Box<Issue> {
    issue("invalid_collection_setup", "invalid setup envelope")
}
fn limit() -> Box<Issue> {
    issue(
        "collection_setup_limit_exceeded",
        "setup envelope capacity exceeded",
    )
}
fn unavailable() -> Box<Issue> {
    issue(
        "collection_setup_metadata_unavailable",
        "complete frozen setup inventory or source proof is unavailable",
    )
}
fn stale() -> Box<Issue> {
    issue(
        "concurrent_modification",
        "setup capture or reviewed inputs changed",
    )
}
fn obj(pairs: Vec<(&str, Value)>) -> Value {
    Value::Map(pairs.into_iter().map(|(k, v)| (k.into(), v)).collect())
}
fn hash_value(h: Hash) -> Value {
    Value::string(h.to_string())
}
fn optional_hash(h: Option<Hash>) -> Value {
    h.map_or(Value::Null, hash_value)
}
fn pack_input(p: &CollectionSetupTypePack) -> Value {
    let resources = p
        .pack
        .resources
        .iter()
        .map(|r| {
            obj(vec![
                ("kind", Value::string(r.kind.clone())),
                (
                    "mode",
                    Value::string(match r.mode {
                        packs::Mode::Managed => "managed",
                        packs::Mode::Seed => "seed",
                    }),
                ),
                ("source", Value::string(r.source.clone())),
                ("target", Value::string(r.target.clone())),
                ("declared", hash_value(r.digest)),
                ("actual", hash_value(revision(&r.document))),
                (
                    "baselines",
                    Value::List(
                        r.baselines
                            .iter()
                            .map(|b| {
                                obj(vec![
                                    ("declared", hash_value(b.digest)),
                                    ("actual", hash_value(revision(&b.document))),
                                    ("version", b.version.map_or(Value::Null, Value::Int)),
                                ])
                            })
                            .collect(),
                    ),
                ),
            ])
        })
        .collect();
    obj(vec![
        ("id", Value::string(p.pack.id.clone())),
        ("version", Value::string(p.pack.version.to_string())),
        ("digest", hash_value(p.pack.digest)),
        ("resources", Value::List(resources)),
        (
            "installed_by",
            Value::string(p.options.installed_by.clone()),
        ),
        ("downgrade", Value::Bool(p.options.allow_downgrade)),
        (
            "overrides",
            Value::Map(
                p.options
                    .target_overrides
                    .iter()
                    .map(|(k, v)| (k.clone(), Value::string(v.clone())))
                    .collect(),
            ),
        ),
        (
            "adopt",
            Value::Map(
                p.options
                    .adopt
                    .iter()
                    .map(|(k, v)| (k.clone(), hash_value(*v)))
                    .collect(),
            ),
        ),
        (
            "preserve",
            Value::List(
                p.options
                    .preserve_seed_targets
                    .iter()
                    .map(|v| Value::string(v.clone()))
                    .collect(),
            ),
        ),
    ])
}
impl CollectionSetup {
    /// Revalidate mutable envelope and bound data before staging/cloning it.
    pub fn validate(&self) -> Result<(), Box<Issue>> {
        self.configuration.validate()?;
        if self.application_id.len() > 150 || self.type_packs.len() > MAX_TYPE_PACKS {
            return Err(limit());
        }
        // Reuse the ledger's identity and declaration confinement checks.
        let mut test = ProvisionLock::default();
        test.contribute(
            "/x-setup/identity",
            &Value::Null,
            Contributor {
                application_id: self.application_id.clone(),
                declaration_digest: self.declaration_digest,
                provision_digest: self.declaration_digest,
                requirement: "identity".into(),
            },
        )?;
        let mut bytes = 0usize;
        let mut resources = 0usize;
        let mut packs = std::collections::BTreeSet::new();
        for p in &self.type_packs {
            if p.options.installed_by != self.application_id || !packs.insert(&p.pack.id) {
                return Err(invalid());
            }
            if p.pack.version.pre.len() > 128
                || p.pack
                    .version
                    .pre
                    .iter()
                    .try_fold(0usize, |n, s| n.checked_add(s.len()))
                    .is_none_or(|n| n > 128)
            {
                return Err(limit());
            }
            resources = resources
                .checked_add(p.pack.resources.len())
                .ok_or_else(limit)?;
            if resources > 256
                || p.options.target_overrides.len() > 256
                || p.options.adopt.len() > 256
                || p.options.preserve_seed_targets.len() > 256
            {
                return Err(limit());
            }
            for r in &p.pack.resources {
                for s in [&r.source, &r.target, &r.kind, &r.document] {
                    bytes = bytes.checked_add(s.len()).ok_or_else(limit)?;
                }
                if r.baselines.len() > 128 {
                    return Err(limit());
                }
                for b in &r.baselines {
                    bytes = bytes.checked_add(b.document.len()).ok_or_else(limit)?;
                }
                if bytes > MAX_PACK_BYTES {
                    return Err(limit());
                }
            }
            for (a, b) in &p.options.target_overrides {
                bytes = bytes
                    .checked_add(a.len())
                    .and_then(|n| n.checked_add(b.len()))
                    .ok_or_else(limit)?;
            }
            for s in p
                .options
                .adopt
                .keys()
                .chain(p.options.preserve_seed_targets.iter())
            {
                bytes = bytes.checked_add(s.len()).ok_or_else(limit)?;
            }
            bytes = bytes.checked_add(p.pack.id.len()).ok_or_else(limit)?;
            if bytes > MAX_PACK_BYTES {
                return Err(limit());
            }
        }
        Ok(())
    }
    fn input_digest(&self) -> Hash {
        jcs_digest(&obj(vec![
            ("application_id", Value::string(self.application_id.clone())),
            ("declaration_digest", hash_value(self.declaration_digest)),
            ("configuration", self.configuration.to_value()),
            (
                "packs",
                Value::List(self.type_packs.iter().map(pack_input).collect()),
            ),
        ]))
    }
}
fn stage_resources(overlay: &mut Overlay<'_>, operations: &[Op]) -> Result<(), Box<Issue>> {
    for op in operations {
        let path = match op {
            Op::ResourcePut(r) => &r.path,
            Op::ResourceDelete(r) => &r.path,
            _ => return Err(invalid()),
        };
        if overlay.at_path_key(&crate::paths::path_key(path)).is_some() {
            return Err(issue(
                "collection_setup_namespace_conflict",
                format!(
                    "Rename {path} before setup: this resource path is held by a file or record"
                ),
            ));
        }
        match op {
            Op::ResourcePut(r) => overlay.apply_effect(&Effect::PutResource {
                path: r.path.clone(),
                doc: r.doc.clone(),
            }),
            Op::ResourceDelete(r) => overlay.apply_effect(&Effect::RemoveResource {
                path: r.path.clone(),
            }),
            _ => return Err(invalid()),
        }
    }
    Ok(())
}
fn descriptor_value(file: &StoredFile) -> Value {
    use crate::intent::FileContent;
    let content = match file.content {
        FileContent::Blob(b) => obj(vec![
            ("kind", Value::string("blob")),
            ("plain", hash_value(b.plain_hash)),
            ("size", Value::string(b.size.to_string())),
            ("id", hash_value(Hash(b.blob_id))),
            ("epoch", Value::string(b.id_epoch.to_string())),
            ("part", Value::string(b.part_size.to_string())),
        ]),
        FileContent::AttachmentV1(a) => obj(vec![
            ("kind", Value::string("attachment_v1")),
            ("plain", hash_value(a.whole_plain_hash)),
            ("size", Value::string(a.total_plain_bytes.to_string())),
            (
                "collection",
                Value::string(a.reference.collection.to_string()),
            ),
            ("epoch", Value::string(a.reference.key_epoch.to_string())),
            ("id", hash_value(Hash(a.reference.attachment_id))),
            ("manifest", hash_value(a.reference.manifest_cipher_hash)),
        ]),
    };
    obj(vec![
        ("id", Value::string(file.id.to_string())),
        ("path", Value::string(file.path.clone())),
        ("content", content),
    ])
}
fn file_value(f: &SetupFileAssessment) -> Value {
    obj(vec![
        ("prior", descriptor_value(&f.file)),
        ("action", Value::string(f.action)),
        (
            "diagnostic",
            f.diagnostic
                .as_ref()
                .map_or(Value::Null, |s| Value::string(s.clone())),
        ),
        ("source", optional_hash(f.source_digest)),
    ])
}
fn mutation(op: Op, clock: &OpClock) -> Mutation {
    Mutation {
        id: Uuid([1; 16]),
        origin: Uuid([2; 16]),
        base_seq: 0,
        clock: clock.clone(),
        seed: [0; 32],
        source: Source::Api,
        ops: vec![op],
        on_behalf: None,
        conflict_mode: ConflictMode::Record,
        validated_at: None,
        room: None,
    }
}
fn promotion_candidates(
    view: &dyn SetupStateView,
    overlay: &Overlay<'_>,
) -> Result<Vec<StoredFile>, Box<Issue>> {
    let mut after = None;
    let mut visited = 0usize;
    let mut files = Vec::new();
    loop {
        let page = view
            .file_page(after, FILE_PAGE_SIZE)
            .map_err(|_| unavailable())?;
        if page.len() > FILE_PAGE_SIZE {
            return Err(unavailable());
        }
        if page.is_empty() {
            break;
        }
        for file in page {
            if after.is_some_and(|id| file.id <= id) {
                return Err(unavailable());
            }
            after = Some(file.id);
            visited = visited.checked_add(1).ok_or_else(limit)?;
            if visited > MAX_INVENTORY_FILES {
                return Err(limit());
            }
            if view.state().file(&file.id).as_ref() != Some(&file) {
                return Err(stale());
            }
            if file.kind != FileKind::Ordinary || !overlay.catalog().is_record_path(&file.path) {
                continue;
            }
            if files.len() >= MAX_SETUP_FILES {
                return Err(limit());
            }
            files.push(file);
        }
    }
    Ok(files)
}
fn promotions(
    view: &dyn SetupStateView,
    overlay: &mut Overlay<'_>,
    clock: &OpClock,
) -> Result<(Vec<SetupFileAssessment>, Vec<Op>), Box<Issue>> {
    let mut source_bytes = 0usize;
    let mut files = Vec::new();
    let mut operations = Vec::new();
    for file in promotion_candidates(view, overlay)? {
        let mut assessment = SetupFileAssessment {
            file,
            action: "retain",
            diagnostic: None,
            source_digest: None,
        };
        if assessment.file.content.size() > RECORD_SOURCE_CAP_BYTES {
            assessment.diagnostic = Some("record_too_large".into());
            files.push(assessment);
            continue;
        }
        let observed = view
            .source(&assessment.file, RECORD_SOURCE_CAP_BYTES as usize)
            .map_err(|_| unavailable())?;
        match observed {
            SetupSourceObservation::InvalidUtf8 => {
                assessment.diagnostic = Some("invalid_utf8".into())
            }
            SetupSourceObservation::Utf8(doc) => {
                if doc.len() > RECORD_SOURCE_CAP_BYTES as usize {
                    return Err(unavailable());
                }
                source_bytes = source_bytes.checked_add(doc.len()).ok_or_else(limit)?;
                if source_bytes > MAX_SETUP_SOURCE_BYTES {
                    return Err(limit());
                }
                if doc.len() as u64 != assessment.file.content.size()
                    || revision(&doc) != assessment.file.content.plain_hash()
                {
                    return Err(unavailable());
                }
                assessment.source_digest = Some(revision(&doc));
                let op = Op::OrdinaryFileToRecord(OrdinaryFileToRecord {
                    id: assessment.file.id,
                    path: assessment.file.path.clone(),
                    doc,
                    prior: assessment.file.content,
                });
                match crate::plan(
                    &mutation(op.clone(), clock),
                    overlay,
                    &PlanOptions { stage: Stage::Head },
                ) {
                    Ok(plan) => {
                        overlay.apply(&plan);
                        operations.push(op);
                        assessment.action = "promote";
                    }
                    Err(r)
                        if r.reason.as_deref() == Some("invalid_frontmatter")
                            || r.code == crate::plan::RejectCode::TooLarge =>
                    {
                        assessment.diagnostic =
                            Some(r.reason.unwrap_or_else(|| "source_admission_failed".into()))
                    }
                    Err(_) => {
                        return Err(issue(
                            "collection_setup_conflict",
                            "a captured file cannot be promoted against the prospective state",
                        ));
                    }
                }
            }
        }
        if view.state().file(&assessment.file.id).as_ref() != Some(&assessment.file) {
            return Err(stale());
        }
        files.push(assessment);
    }
    Ok((files, operations))
}
struct StagedProvisions<'a> {
    overlay: Overlay<'a>,
    configuration: ConfigurationPlan,
    type_packs: Vec<Assessment>,
    operations: Vec<Op>,
    applicable: bool,
}
fn stage_provisions<'a>(
    state: &'a dyn StateView,
    setup: &CollectionSetup,
    clock: &OpClock,
) -> Result<StagedProvisions<'a>, Box<Issue>> {
    setup.validate()?;
    if clock.tz.len() > 128 || clock.local_date.len() > 32 {
        return Err(limit());
    }
    stage_resource_provisions(state, setup)
}
fn stage_resource_provisions<'a>(
    state: &'a dyn StateView,
    setup: &CollectionSetup,
) -> Result<StagedProvisions<'a>, Box<Issue>> {
    setup.validate()?;
    if state
        .at_path_key(&crate::paths::path_key(PROVISION_LOCK_PATH))
        .is_some()
    {
        return Err(issue(
            "collection_setup_namespace_conflict",
            "Rename mdbase.provisions.yaml before setup: this reserved receipt path is held by a file or record",
        ));
    }
    let source = state.resource(CONFIG_PATH);
    let configuration = plan_configuration(source.as_deref(), &setup.configuration)?;
    let mut overlay = Overlay::new(state);
    let mut operations = Vec::new();
    let mut type_packs = Vec::new();
    if configuration.applicable() {
        if let Some(doc) = &configuration.document {
            let r = ResourcePut {
                path: CONFIG_PATH.into(),
                doc: doc.clone(),
                base_revision: configuration.source_digest,
                must_not_exist: configuration.source_digest.is_none(),
            };
            operations.push(Op::ResourcePut(r));
            stage_resources(&mut overlay, &operations)?;
        }
        for pack in &setup.type_packs {
            let a =
                packs::assess_type_pack(&overlay, &pack.pack, &pack.options).map_err(Box::new)?;
            if !a.applicable() {
                type_packs.push(a);
                continue;
            }
            let (_, ops) =
                packs::apply_type_pack(&overlay, &pack.pack, &pack.options, &a.assessment_digest)
                    .map_err(Box::new)?;
            stage_resources(&mut overlay, &ops)?;
            operations.extend(ops);
            type_packs.push(a);
        }
    }
    let applicable = configuration.applicable()
        && type_packs.len() == setup.type_packs.len()
        && type_packs.iter().all(Assessment::applicable);
    Ok(StagedProvisions {
        overlay,
        configuration,
        type_packs,
        operations,
        applicable,
    })
}

/// Metadata-only prospective source selection. This is NOT an assessment,
/// source/authority proof, review digest or publication capability. It never
/// calls SetupStateView::source; a blocked component is explicitly inapplicable.
#[derive(Debug, Clone, PartialEq)]
pub struct CollectionSetupSourceRequirements {
    /// Trusted revision under which the metadata was enumerated.
    pub collection_revision: Hash,
    /// Actual validated declaration/pack/options identity, not a publisher claim.
    pub provision_digest: Hash,
    /// Configuration and nested packs may proceed; final full-plan admission is later.
    pub applicable: bool,
    /// Complete prospective Ordinary candidates, INCLUDING above-cap retained
    /// files. Only <=1 MiB descriptors require authenticated source observations.
    pub files: Vec<StoredFile>,
}
/// Select against the same staged configuration/packs and complete bounded EOF
/// inventory as assessment. No source fetching, ordinary mutation or receipt
/// emission. Every <=1 MiB candidate still needs full authenticated source proof
/// before the real assessment; a missing provider can never become empty success.
pub fn collection_setup_source_requirements(
    view: &dyn SetupStateView,
    setup: &CollectionSetup,
    clock: &OpClock,
) -> Result<CollectionSetupSourceRequirements, Box<Issue>> {
    let head = view.collection_revision();
    let staged = stage_provisions(view.state(), setup, clock)?;
    // Fail malformed contribution metadata before asking the host to read source.
    if let Some(lock) = view.state().resource(PROVISION_LOCK_PATH) {
        ProvisionLock::parse(&lock)?;
    }
    let files = if staged.applicable {
        promotion_candidates(view, &staged.overlay)?
    } else {
        Vec::new()
    };
    if view.collection_revision() != head {
        return Err(stale());
    }
    Ok(CollectionSetupSourceRequirements {
        collection_revision: head,
        provision_digest: setup.input_digest(),
        applicable: staged.applicable,
        files,
    })
}

/// Assess all configuration, packs, Ordinary candidates and contribution receipts
/// against one complete frozen capture. Missing inventory never means no files.
pub fn assess_collection_setup(
    view: &dyn SetupStateView,
    setup: &CollectionSetup,
    clock: &OpClock,
) -> Result<CollectionSetupAssessment, Box<Issue>> {
    let state = view.state();
    let head = view.collection_revision();
    let StagedProvisions {
        mut overlay,
        configuration,
        type_packs,
        mut operations,
        applicable,
    } = stage_provisions(state, setup, clock)?;
    let provision_digest = setup.input_digest();
    let (files, file_ops) = if applicable {
        promotions(view, &mut overlay, clock)?
    } else {
        (Vec::new(), Vec::new())
    };
    if applicable {
        operations.extend(file_ops);
    }
    let prior_lock = state.resource(PROVISION_LOCK_PATH);
    let mut ledger = prior_lock
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
            let base_revision = prior_lock.as_deref().map(revision);
            operations.push(Op::ResourcePut(ResourcePut {
                path: PROVISION_LOCK_PATH.into(),
                doc: ledger.render()?,
                base_revision,
                must_not_exist: base_revision.is_none(),
            }));
        }
    }
    if applicable && !operations.is_empty() {
        let mut request = mutation(operations[0].clone(), clock);
        request.ops = operations.clone();
        let planned =
            crate::plan(&request, state, &PlanOptions { stage: Stage::Head }).map_err(|_| {
                issue(
                    "collection_setup_conflict",
                    "the complete atomic setup plan cannot be admitted",
                )
            })?;
        crate::plan::admission::RecordWriteAdmission::Synced
            .check_planned(&planned)
            .map_err(|_| limit())?;
        crate::plan::frontmatter_admission::check_planned(&planned).map_err(|_| limit())?;
    }
    if view.collection_revision() != head {
        return Err(stale());
    }
    let final_receipt = operations
        .iter()
        .rev()
        .find_map(|op| {
            if let Op::ResourcePut(r) = op {
                (r.path == PROVISION_LOCK_PATH).then(|| revision(&r.doc))
            } else {
                None
            }
        })
        .or_else(|| prior_lock.as_deref().map(revision));
    let assessment_digest = jcs_digest(&obj(vec![
        ("provision", hash_value(provision_digest)),
        ("head", hash_value(head)),
        (
            "clock",
            obj(vec![
                ("instant", Value::string(clock.instant_ms.to_string())),
                ("zone", Value::string(clock.tz.clone())),
                ("date", Value::string(clock.local_date.clone())),
            ]),
        ),
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
        ("files", Value::List(files.iter().map(file_value).collect())),
        (
            "prior_receipt",
            optional_hash(prior_lock.as_deref().map(revision)),
        ),
        ("receipt", optional_hash(final_receipt)),
        (
            "pack_receipt",
            optional_hash(overlay.resource(LOCK_PATH).as_deref().map(revision)),
        ),
        ("applicable", Value::Bool(applicable)),
    ]));
    if !applicable {
        operations.clear();
    }
    Ok(CollectionSetupAssessment {
        application_id: setup.application_id.clone(),
        collection_revision: head,
        provision_digest,
        configuration,
        type_packs,
        files,
        applicable,
        assessment_digest,
        operations,
    })
}
/// Re-assess actual inputs/head; return ONLY the reviewed, applicable operations
/// for one atomic mediated mutation. Applications must not install its parts.
pub fn apply_collection_setup(
    view: &dyn SetupStateView,
    setup: &CollectionSetup,
    clock: &OpClock,
    expected_revision: Hash,
    expected_digest: Hash,
) -> Result<(CollectionSetupAssessment, Vec<Op>), Box<Issue>> {
    let assessment = assess_collection_setup(view, setup, clock)?;
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
