//! Resource-only Core planning on the original native READ session. No caller
//! inventory, native file-absence witness, mutation header or publication API.
use super::*;
use mdbn_core::{
    contracts::jcs_digest,
    ids::Hash,
    intent::Op,
    packs::{AssessOptions, load_pack},
    setup::envelope::{self, CollectionSetup, CollectionSetupTypePack},
    state::MemState,
    value::{Map, Value},
};
use mdbn_replica::api::{ClientApi, ListResources, SessionId};
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
#[cfg(test)]
mod tests;

impl AppRuntime {
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
            if request.len() != 4 || request[0] != Cbor::Uint(1) {
                return Err(invalid());
            }
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
            let setup = setup(&from_cbor(&request[2], 0, &mut 0)?)?;
            let replica = self.runtime.as_mut().ok_or_else(invalid)?.replica_mut();
            let mut cursor = None;
            let mut state = MemState::new();
            let mut rows = 0usize;
            let mut size = 0usize;
            let mut previous: Option<String> = None;
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
                    rows += 1;
                    size = size.checked_add(source.len()).ok_or_else(invalid)?;
                    if !row.confirmed
                        || source.len() as u64 != row.size
                        || previous.as_ref().is_some_and(|p| row.path <= *p)
                        || rows > envelope::MAX_RESOURCE_INVENTORY_ROWS
                        || size > envelope::MAX_RESOURCE_INVENTORY_BYTES
                        || source.len() > envelope::MAX_RESOURCE_SOURCE_BYTES
                    {
                        return Err(invalid());
                    }
                    previous = Some(row.path.clone());
                    state.insert_resource(&row.path, &source);
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
            let assessment =
                envelope::assess_collection_resources(&state, &setup).map_err(|_| invalid())?;
            let operations = if assessment.applicable {
                envelope::apply_collection_resources(&state, &setup, assessment.assessment_digest)
                    .map_err(|_| invalid())?
                    .1
            } else {
                Vec::new()
            };
            let status = if !assessment.applicable {
                "conflict"
            } else if operations.is_empty() {
                "current"
            } else {
                "provision"
            };
            let dto = if apply {
                if !assessment.applicable
                    || expected != Some(assessment.assessment_digest)
                    || operations.is_empty()
                {
                    return Err(invalid());
                }
                plan(&assessment, &operations)?
            } else {
                object(vec![
                    ("status", Value::string(status)),
                    (
                        "assessmentDigest",
                        Value::string(assessment.assessment_digest.to_string()),
                    ),
                ])
            };
            Ok(Cbor::Array(vec![
                Cbor::Uint(1),
                Cbor::Bool(true),
                to_cbor(&dto),
            ]))
        })();
        wipe(bytes);
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
}
