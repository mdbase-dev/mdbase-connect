//! Resource-only Core planning on the original native READ session. No caller
//! inventory, native file-absence witness, mutation header or publication API.
use super::*;
use mdbn_core::{
    contracts::jcs_digest,
    ids::Hash,
    intent::Op,
    packs::{Action, AssessOptions, Assessment, folder_target_overrides, load_pack},
    setup::envelope::{self, CollectionSetup, CollectionSetupTypePack},
    state::MemState,
    value::{Map, Value},
};
use mdbn_replica::api::{ClientApi, ListResources, SessionId};
use std::collections::BTreeSet;
const MAX: usize = 512 * 1024;
fn invalid() -> OpenFailure {
    OpenFailure("resource setup unavailable".into())
}
fn object(entries: Vec<(&str, Value)>) -> Value {
    let mut out = Map::new();
    for (key, value) in entries {
        out.insert(key, value);
    }
    Value::Map(out)
}
fn from_cbor(value: &Cbor, depth: u32, nodes: &mut usize) -> Result<Value, OpenFailure> {
    *nodes += 1;
    if depth > 32 || *nodes > 65_536 {
        return Err(invalid());
    }
    Ok(match value {
        Cbor::Null => Value::Null,
        Cbor::Bool(b) => Value::Bool(*b),
        Cbor::Text(s) => Value::string(s.clone()),
        Cbor::Uint(_) | Cbor::Nint(_) => Value::Int(value.as_i64().ok_or_else(invalid)?),
        Cbor::Float(f) => Value::float(*f).ok_or_else(invalid)?,
        Cbor::Array(a) => Value::List(
            a.iter()
                .map(|v| from_cbor(v, depth + 1, nodes))
                .collect::<Result<_, _>>()?,
        ),
        Cbor::Map(m) => {
            let mut out = Map::new();
            for (k, v) in m {
                let Cbor::Text(k) = k else {
                    return Err(invalid());
                };
                if out.insert(k, from_cbor(v, depth + 1, nodes)?).is_some() {
                    return Err(invalid());
                }
            }
            Value::Map(out)
        }
        Cbor::Bytes(_) => return Err(invalid()),
    })
}
fn to_cbor(value: &Value) -> Cbor {
    match value {
        Value::Null => Cbor::Null,
        Value::Bool(v) => Cbor::Bool(*v),
        Value::Int(v) => Cbor::int(*v),
        Value::Float(v) => Cbor::Float(*v),
        Value::Text(v) => Cbor::Text(v.clone()),
        Value::List(v) => Cbor::Array(v.iter().map(to_cbor).collect()),
        Value::Map(v) => Cbor::Map(
            v.iter()
                .map(|(k, v)| (Cbor::Text(k.into()), to_cbor(v)))
                .collect(),
        ),
    }
}
fn nested_pack(value: &Value) -> Result<CollectionSetupTypePack, Box<mdbn_core::validate::Issue>> {
    let bad = || {
        Box::new(mdbn_core::validate::Issue::new(
            "invalid_collection_setup",
            mdbn_core::validate::Severity::Error,
            mdbn_core::validate::Tier::Request,
            "invalid pack DATA",
        ))
    };
    let entry = value.as_map().ok_or_else(bad)?;
    let provision = entry
        .get("provision")
        .and_then(Value::as_map)
        .ok_or_else(bad)?;
    if provision
        .keys()
        .any(|k| !matches!(k, "manifest" | "resources" | "provides"))
    {
        return Err(bad());
    }
    let manifest = provision
        .get("manifest")
        .and_then(Value::as_map)
        .ok_or_else(bad)?;
    let resources = provision
        .get("resources")
        .and_then(Value::as_list)
        .ok_or_else(bad)?;
    let mut sources = BTreeMap::new();
    for row in resources {
        let row = row.as_map().ok_or_else(bad)?;
        if row.len() != 2 {
            return Err(bad());
        }
        let path = row.get("source").and_then(Value::as_str).ok_or_else(bad)?;
        let document = row
            .get("document")
            .and_then(Value::as_str)
            .ok_or_else(bad)?;
        if sources
            .insert(path.to_owned(), document.to_owned())
            .is_some()
        {
            return Err(bad());
        }
    }
    // Core's JSON rendering is also YAML flow syntax. Reuse its strict pack
    // loader and digest checks; there is no parallel manifest/parser/planner.
    let pack = load_pack(&Value::Map(manifest.clone()).to_json(), &|p| {
        sources.get(p).cloned()
    })
    .map_err(Box::new)?;
    if pack.resources.len() != sources.len() {
        return Err(bad());
    }
    let options = entry
        .get("options")
        .and_then(Value::as_map)
        .ok_or_else(bad)?;
    if options.len() != 1 {
        return Err(bad());
    }
    let installed_by = options
        .get("installed_by")
        .and_then(Value::as_str)
        .ok_or_else(bad)?;
    Ok(CollectionSetupTypePack {
        pack,
        options: AssessOptions {
            installed_by: installed_by.into(),
            ..Default::default()
        },
    })
}
fn setup(manifest: &Value) -> Result<CollectionSetup, OpenFailure> {
    let root = manifest.as_map().ok_or_else(invalid)?;
    let id = root.get("id").and_then(Value::as_str).ok_or_else(invalid)?;
    let empty = Map::new();
    let requirements = root
        .get("requirements")
        .and_then(Value::as_map)
        .ok_or_else(invalid)?;
    let provisions = match root.get("provisions") {
        Some(v) => v.as_map().ok_or_else(invalid)?,
        None => &empty,
    };
    let packs = match provisions.get("type_packs") {
        Some(v) => v.as_list().ok_or_else(invalid)?,
        None => &Vec::new(),
    };
    let entries = packs
        .iter()
        .map(|pack| {
            object(vec![
                ("provision", pack.clone()),
                ("options", object(vec![("installed_by", Value::string(id))])),
            ])
        })
        .collect();
    let envelope = object(vec![
        ("application_id", Value::string(id)),
        (
            "declaration_digest",
            Value::string(jcs_digest(manifest).to_string()),
        ),
        (
            "requirements",
            object(vec![(
                "configuration",
                requirements
                    .get("configuration")
                    .cloned()
                    .unwrap_or_else(|| Value::List(Vec::new())),
            )]),
        ),
        (
            "provisions",
            object(vec![
                (
                    "configuration",
                    provisions
                        .get("configuration")
                        .cloned()
                        .unwrap_or_else(|| Value::List(Vec::new())),
                ),
                ("type_packs", Value::List(entries)),
            ]),
        ),
    ]);
    CollectionSetup::from_value(&envelope, &nested_pack).map_err(|_| invalid())
}
fn plan(
    assessment: &envelope::CollectionResourceAssessment,
    ops: &[Op],
) -> Result<Value, OpenFailure> {
    let mut operations = Vec::new();
    let mut readback = Vec::new();
    for op in ops {
        let (path, doc, mut fields) = match op {
            Op::ResourcePut(r) => (
                &r.path,
                Value::string(r.doc.clone()),
                vec![
                    ("kind", Value::string("resource_put")),
                    ("doc", Value::string(r.doc.clone())),
                    ("mustNotExist", Value::Bool(r.must_not_exist)),
                ],
            ),
            Op::ResourceDelete(r) => (
                &r.path,
                Value::Null,
                vec![("kind", Value::string("resource_delete"))],
            ),
            _ => return Err(invalid()),
        };
        fields.push(("path", Value::string(path.clone())));
        let base = match op {
            Op::ResourcePut(r) => r.base_revision,
            Op::ResourceDelete(r) => r.base_revision,
            _ => None,
        };
        if let Some(base) = base {
            fields.push(("baseRevision", Value::string(base.to_string())));
        }
        operations.push(object(fields));
        readback.push(object(vec![
            ("path", Value::string(path.clone())),
            ("doc", doc),
        ]));
    }
    let packs = assessment
        .type_packs
        .iter()
        .map(|a| {
            object(vec![
                ("id", Value::string(a.pack.0.clone())),
                ("version", Value::string(a.pack.1.clone())),
                ("digest", Value::string(a.pack.2.to_string())),
            ])
        })
        .collect();
    let mut fields = vec![
        (
            "assessmentDigest",
            Value::string(assessment.assessment_digest.to_string()),
        ),
        (
            "provisionDigest",
            Value::string(assessment.provision_digest.to_string()),
        ),
        ("packs", Value::List(packs)),
        ("resourceOps", Value::List(operations)),
        ("resourceReadback", Value::List(readback)),
        ("sources", Value::List(Vec::new())),
    ];
    if assessment.type_packs.is_empty() {
        fields.push(("planKind", Value::string("configuration-only")));
    }
    Ok(object(fields))
}
/// Caller review decisions: adopted unmanaged targets → their exact digests.
#[derive(Debug, Default, Clone, PartialEq)]
struct Decisions {
    adopt: BTreeMap<String, Hash>,
}
fn decisions(value: &Value) -> Result<Decisions, OpenFailure> {
    let root = value.as_map().ok_or_else(invalid)?;
    if root.keys().any(|k| k != "adopt") {
        return Err(invalid());
    }
    let mut adopt = BTreeMap::new();
    if let Some(entries) = root.get("adopt") {
        let entries = entries.as_map().ok_or_else(invalid)?;
        if entries.len() > 256 {
            return Err(invalid());
        }
        for (target, digest) in entries.iter() {
            let digest = digest
                .as_str()
                .filter(|d| d.starts_with("sha256:"))
                .and_then(Hash::parse)
                .ok_or_else(invalid)?;
            adopt.insert(target.to_owned(), digest);
        }
    }
    Ok(Decisions { adopt })
}
/// Resolve pack targets over the confirmed resources: a pack that is not
/// installed yet goes into the collection's configured definition folders; an
/// installed pack keeps the targets its lock records, so a later folder change
/// never moves (or re-plans) installed definitions.
fn resolve(state: &MemState, setup: &mut CollectionSetup) -> Result<(), OpenFailure> {
    if setup.type_packs.is_empty() {
        return Ok(());
    }
    let initial = envelope::assess_collection_resources(state, setup).map_err(|_| invalid())?;
    for (entry, assessed) in setup.type_packs.iter_mut().zip(&initial.type_packs) {
        entry.options.target_overrides = match &assessed.current {
            None => folder_target_overrides(state, &entry.pack),
            Some(receipt) => entry
                .pack
                .resources
                .iter()
                .filter_map(|r| {
                    receipt
                        .resources
                        .iter()
                        .find(|e| e.source == r.source && e.kind == r.kind && e.target != r.target)
                        .map(|e| (r.target.clone(), e.target.clone()))
                })
                .collect(),
        };
    }
    Ok(())
}
/// The resolved targets the declared packs install.
fn targets(setup: &CollectionSetup) -> BTreeSet<String> {
    setup
        .type_packs
        .iter()
        .flat_map(|p| {
            p.pack.resources.iter().map(|r| {
                p.options
                    .target_overrides
                    .get(&r.target)
                    .unwrap_or(&r.target)
                    .clone()
            })
        })
        .collect()
}
fn row(r: &mdbn_core::packs::PlannedResource, installed: bool, adopted: Option<&Hash>) -> Value {
    let action = if adopted.is_some() {
        "adopt"
    } else {
        r.action.as_str()
    };
    let mut fields = vec![
        ("target", Value::string(r.target.clone())),
        ("kind", Value::string(r.kind.clone())),
        (
            "mode",
            Value::string(match r.mode {
                mdbn_core::packs::Mode::Managed => "managed",
                mdbn_core::packs::Mode::Seed => "seed",
            }),
        ),
        ("action", Value::string(action)),
        ("installed", Value::Bool(installed)),
    ];
    if let Some(live) = adopted.or(r.live.as_ref()) {
        fields.push(("currentDigest", Value::string(live.to_string())));
    }
    if let Some(reason) = &r.reason {
        fields.push(("reason", Value::string(reason.clone())));
    }
    object(fields)
}
fn pack_review(a: &Assessment, adopted: &BTreeMap<String, Hash>) -> Value {
    let installed = |target: &str| {
        a.current
            .as_ref()
            .is_some_and(|c| c.resources.iter().any(|e| e.target == target))
    };
    object(vec![
        ("id", Value::string(a.pack.0.clone())),
        ("version", Value::string(a.pack.1.clone())),
        ("status", Value::string(a.status.as_str())),
        (
            "installedVersion",
            a.current
                .as_ref()
                .map_or(Value::Null, |c| Value::string(c.version.clone())),
        ),
        (
            "resources",
            Value::List(
                a.resources
                    .iter()
                    .filter(|r| r.action != Action::Unchanged)
                    .map(|r| row(r, installed(&r.target), adopted.get(&r.target)))
                    .collect(),
            ),
        ),
    ])
}
/// The reviewable setup: per-pack changes, configuration changes and the
/// definition documents the setup would write (`staged`).
fn review(
    assessment: &envelope::CollectionResourceAssessment,
    ops: &[Op],
    adopted: &BTreeMap<String, Hash>,
) -> Value {
    let configuration = assessment
        .configuration
        .configuration
        .iter()
        .filter(|c| c.action != "current")
        .map(|c| {
            object(vec![
                ("requirement", Value::string(c.requirement.clone())),
                ("path", Value::string(c.path.clone())),
                ("action", Value::string(c.action)),
                ("value", c.value.clone()),
            ])
        })
        .collect();
    let staged = ops
        .iter()
        .filter_map(|op| match op {
            Op::ResourcePut(r)
                if !matches!(
                    r.path.as_str(),
                    "mdbase.yaml" | mdbn_core::types::LOCK_PATH | "mdbase.provisions.yaml"
                ) =>
            {
                Some(object(vec![
                    ("path", Value::string(r.path.clone())),
                    ("document", Value::string(r.doc.clone())),
                ]))
            }
            _ => None,
        })
        .collect();
    object(vec![
        (
            "packs",
            Value::List(
                assessment
                    .type_packs
                    .iter()
                    .map(|a| pack_review(a, adopted))
                    .collect(),
            ),
        ),
        ("configuration", Value::List(configuration)),
        ("staged", Value::List(staged)),
    ])
}
/// Assessment, its guarded writes, and the adoptions it applied.
type Assessed = (
    envelope::CollectionResourceAssessment,
    Vec<Op>,
    BTreeMap<String, Hash>,
);
/// Assess (and plan the guarded writes of) the declaration over confirmed
/// resources, after resolving folder targets and reviewed adoptions.
///
/// An adopted target (an unmanaged definition the user reviewed) is planned as
/// if absent, then written over exactly the reviewed revision: the write's
/// `baseRevision` is the reviewed digest, so any edit since review refuses the
/// whole mutation. Adoption stays out of the pack options, so it does not
/// change the provision identity later checks compare against.
fn assess(
    resources: &[(String, String)],
    manifest: &Value,
    decisions: &Decisions,
) -> Result<Assessed, OpenFailure> {
    let mut setup = setup(manifest)?;
    let mut full = MemState::new();
    for (path, source) in resources {
        full.insert_resource(path, source);
    }
    resolve(&full, &mut setup)?;
    let owned = targets(&setup);
    // Adoption is offered only for the subset the review advertises: a
    // managed-mode conflict over an existing definition no install recorded.
    // Every decision must still match exactly that row at its reviewed
    // revision; anything else (seed, installed, changed, deleted, undeclared)
    // is a stale or forged review and refuses rather than being ignored.
    let eligible: BTreeMap<String, Hash> = if decisions.adopt.is_empty() {
        BTreeMap::new()
    } else {
        let full_assessment =
            envelope::assess_collection_resources(&full, &setup).map_err(|_| invalid())?;
        full_assessment
            .type_packs
            .iter()
            .flat_map(|a| {
                a.resources.iter().filter_map(move |r| {
                    let installed = a
                        .current
                        .as_ref()
                        .is_some_and(|c| c.resources.iter().any(|e| e.target == r.target));
                    (r.action == Action::Conflict
                        && r.mode == mdbn_core::packs::Mode::Managed
                        && !installed)
                        .then_some(r.live.map(|live| (r.target.clone(), live)))
                        .flatten()
                })
            })
            .collect()
    };
    let mut adopted = BTreeMap::new();
    for (target, digest) in &decisions.adopt {
        let live = resources
            .iter()
            .find(|(path, _)| path == target)
            .map(|(_, source)| mdbn_core::ids::revision(source));
        if !owned.contains(target) || eligible.get(target) != Some(digest) || live != Some(*digest)
        {
            return Err(invalid());
        }
        adopted.insert(target.clone(), *digest);
    }
    let mut state = MemState::new();
    for (path, source) in resources {
        if !adopted.contains_key(path) {
            state.insert_resource(path, source);
        }
    }
    let assessment =
        envelope::assess_collection_resources(&state, &setup).map_err(|_| invalid())?;
    let mut operations = if assessment.applicable {
        envelope::apply_collection_resources(&state, &setup, assessment.assessment_digest)
            .map_err(|_| invalid())?
            .1
    } else {
        Vec::new()
    };
    for op in &mut operations {
        if let Op::ResourcePut(put) = op
            && let Some(digest) = adopted.get(&put.path)
        {
            if !put.must_not_exist {
                return Err(invalid());
            }
            put.must_not_exist = false;
            put.base_revision = Some(*digest);
        }
    }
    // An applicable adoption must become exactly one guarded overwrite each.
    if assessment.applicable
        && adopted.len()
            != operations
                .iter()
                .filter(|op| matches!(op, Op::ResourcePut(p) if adopted.contains_key(&p.path)))
                .count()
    {
        return Err(invalid());
    }
    let mut assessment = assessment;
    assessment.assessment_digest =
        review_digest(assessment.assessment_digest, &adopted, &operations);
    Ok((assessment, operations, adopted))
}
/// The digest a review binds. Without decisions it is Core's assessment
/// digest unchanged. With adoptions it also binds every adopted target's
/// reviewed revision and the exact guards of the converted writes, so the
/// masked inventory alone can never stand in for the reviewed adoption.
/// Provision identity is unaffected.
fn review_digest(assessed: Hash, adopted: &BTreeMap<String, Hash>, ops: &[Op]) -> Hash {
    if adopted.is_empty() {
        return assessed;
    }
    let guards = ops
        .iter()
        .filter_map(|op| {
            let (kind, path, must_not_exist, base) = match op {
                Op::ResourcePut(r) => ("put", &r.path, r.must_not_exist, r.base_revision),
                Op::ResourceDelete(r) => ("delete", &r.path, false, r.base_revision),
                _ => return None,
            };
            Some(object(vec![
                ("kind", Value::string(kind)),
                ("path", Value::string(path.clone())),
                ("mustNotExist", Value::Bool(must_not_exist)),
                (
                    "baseRevision",
                    base.map_or(Value::Null, |b| Value::string(b.to_string())),
                ),
            ]))
        })
        .collect();
    jcs_digest(&object(vec![
        ("domain", Value::string("mdbn-app-setup-review/1")),
        ("assessmentDigest", Value::string(assessed.to_string())),
        (
            "adopted",
            Value::List(
                adopted
                    .iter()
                    .map(|(t, d)| {
                        object(vec![
                            ("target", Value::string(t.clone())),
                            ("revision", Value::string(d.to_string())),
                        ])
                    })
                    .collect(),
            ),
        ),
        ("guards", Value::List(guards)),
    ]))
}
#[cfg(test)]
mod tests;

impl AppRuntime {
    /// Whether `mutation` (16 UUID bytes) has a FINAL rejected receipt visible
    /// to this session's own grant. 1 only for exactly that mutation and
    /// state; pending, unknown, confirmed, missing or malformed answer 0.
    pub fn receipt_rejected_consuming(&mut self, session: u64, bytes: &mut [u8]) -> u32 {
        let rejected = (|| {
            if !self.healthy() {
                return None;
            }
            let id: [u8; 16] = (&*bytes).try_into().ok()?;
            if id == [0; 16] {
                return None;
            }
            let mutation = mdbn_wire::common::B16(id);
            let replica = self.runtime.as_mut()?.replica_mut();
            let receipt = replica.receipt(SessionId(session), mutation).ok()?;
            Some(
                receipt.mutation == mutation
                    && receipt.state == mdbn_wire::client::ReceiptState::Rejected,
            )
        })()
        .unwrap_or(false);
        wipe(bytes);
        u32::from(rejected)
    }
    /// Consumed bounded declaration DATA. Uses the actual facade's existing
    /// unrestricted READ session and canonical native resource paging. No IO
    /// await, inventory supplied by UI, write, or native readiness setter.
    pub fn resources_consuming(&mut self, session: u64, bytes: &mut [u8]) -> Vec<u8> {
        let result: Result<Cbor, OpenFailure> = (|| {
            if !self.healthy() || bytes.is_empty() || bytes.len() > MAX {
                return Err(invalid());
            }
            let Cbor::Array(request) = cbor::decode(bytes).map_err(|_| invalid())? else {
                return Err(invalid());
            };
            // A fifth member carries review decisions and asks for the review.
            if !(request.len() == 4 || request.len() == 5) {
                return Err(invalid());
            }
            let parsed = parse(&request, request.get(4))?;
            let replica = self.runtime.as_mut().ok_or_else(invalid)?.replica_mut();
            let mut cursor = None;
            let mut inventory = Inventory::default();
            loop {
                let page = replica
                    .list_resources(
                        SessionId(session),
                        ListResources {
                            folder: None,
                            text: Some(true),
                            cursor: cursor.clone(),
                            limit: Some(128),
                        },
                    )
                    .map_err(|_| invalid())?;
                for row in page.resources {
                    let source = row.text.ok_or_else(invalid)?;
                    if !row.confirmed || source.len() as u64 != row.size {
                        return Err(invalid());
                    }
                    inventory.push(row.path, source)?;
                }
                if page.complete {
                    if page.cursor.is_some() {
                        return Err(invalid());
                    }
                    break;
                }
                let next = page.cursor.ok_or_else(invalid)?;
                if next.is_empty() || cursor.as_ref() == Some(&next) {
                    return Err(invalid());
                }
                cursor = Some(next);
            }
            answer(&inventory.rows, &parsed)
        })();
        wipe(bytes);
        respond(result)
    }
}
/// The same assessment, review and plan as `resources_consuming`, over a
/// confirmed inventory the caller read through its own client session (a
/// Private collection over the relay). DATA only: the guarded writes are
/// enforced by the collection's own replica when the caller submits them.
/// Request: `[1, apply, manifest, expected, [[path, source], ...], decisions?]`.
pub fn setup_inventory_consuming(bytes: &mut [u8]) -> Vec<u8> {
    let result: Result<Cbor, OpenFailure> = (|| {
        if bytes.is_empty() || bytes.len() > INVENTORY_REQUEST_MAX {
            return Err(invalid());
        }
        let Cbor::Array(request) = cbor::decode(bytes).map_err(|_| invalid())? else {
            return Err(invalid());
        };
        if !(request.len() == 5 || request.len() == 6) {
            return Err(invalid());
        }
        let parsed = parse(&request, request.get(5))?;
        let Cbor::Array(rows) = &request[4] else {
            return Err(invalid());
        };
        let mut inventory = Inventory::default();
        for row in rows {
            let Cbor::Array(pair) = row else {
                return Err(invalid());
            };
            let [Cbor::Text(path), Cbor::Text(source)] = pair.as_slice() else {
                return Err(invalid());
            };
            inventory.push(path.clone(), source.clone())?;
        }
        answer(&inventory.rows, &parsed)
    })();
    wipe(bytes);
    respond(result)
}
/// A whole confirmed inventory may be up to its byte budget, plus framing.
const INVENTORY_REQUEST_MAX: usize =
    MAX + envelope::MAX_RESOURCE_INVENTORY_BYTES + 16 * envelope::MAX_RESOURCE_INVENTORY_ROWS;
struct Parsed {
    apply: bool,
    expected: Option<Hash>,
    manifest: Value,
    reviewing: bool,
    choices: Decisions,
}
fn parse(request: &[Cbor], decided: Option<&Cbor>) -> Result<Parsed, OpenFailure> {
    if request.len() < 4 || request[0] != Cbor::Uint(1) {
        return Err(invalid());
    }
    let choices = match decided {
        Some(value) => decisions(&from_cbor(value, 0, &mut 0)?)?,
        None => Decisions::default(),
    };
    let apply = match request[1] {
        Cbor::Uint(0) => false,
        Cbor::Uint(1) => true,
        _ => return Err(invalid()),
    };
    let expected = match &request[3] {
        Cbor::Null if !apply => None,
        Cbor::Text(s) if apply => Some(Hash::parse(s).ok_or_else(invalid)?),
        _ => return Err(invalid()),
    };
    Ok(Parsed {
        apply,
        expected,
        manifest: from_cbor(&request[2], 0, &mut 0)?,
        reviewing: decided.is_some(),
        choices,
    })
}
/// Strictly path-ordered, bounded rows: the shape canonical paging yields.
#[derive(Default)]
struct Inventory {
    rows: Vec<(String, String)>,
    size: usize,
}
impl Inventory {
    fn push(&mut self, path: String, source: String) -> Result<(), OpenFailure> {
        self.size = self.size.checked_add(source.len()).ok_or_else(invalid)?;
        if self.rows.last().is_some_and(|(p, _)| path <= *p)
            || self.rows.len() >= envelope::MAX_RESOURCE_INVENTORY_ROWS
            || self.size > envelope::MAX_RESOURCE_INVENTORY_BYTES
            || source.len() > envelope::MAX_RESOURCE_SOURCE_BYTES
        {
            return Err(invalid());
        }
        self.rows.push((path, source));
        Ok(())
    }
}
fn answer(inventory: &[(String, String)], r: &Parsed) -> Result<Cbor, OpenFailure> {
    let (assessment, operations, adopted) = assess(inventory, &r.manifest, &r.choices)?;
    let status = if !assessment.applicable {
        "conflict"
    } else if operations.is_empty() {
        "current"
    } else {
        "provision"
    };
    let dto = if r.apply {
        if !assessment.applicable
            || r.expected != Some(assessment.assessment_digest)
            || operations.is_empty()
        {
            return Err(invalid());
        }
        plan(&assessment, &operations)?
    } else {
        let mut fields = vec![
            ("status", Value::string(status)),
            (
                "assessmentDigest",
                Value::string(assessment.assessment_digest.to_string()),
            ),
        ];
        if r.reviewing {
            fields.push(("review", review(&assessment, &operations, &adopted)));
        }
        object(fields)
    };
    Ok(Cbor::Array(vec![
        Cbor::Uint(1),
        Cbor::Bool(true),
        to_cbor(&dto),
    ]))
}
fn respond(result: Result<Cbor, OpenFailure>) -> Vec<u8> {
    result
        .and_then(|v| cbor::encode(&v).map_err(|_| invalid()))
        .ok()
        .filter(|v| v.len() <= MAX)
        .unwrap_or_else(|| {
            cbor::encode(&Cbor::Array(vec![
                Cbor::Uint(1),
                Cbor::Bool(false),
                Cbor::Null,
            ]))
            .expect("fixed refusal")
        })
}
