//! Pure setup deterministic witness over owned in-memory fixtures. Never a
//! provider, grant, installation or publication endpoint.
use super::capture::{SetupSourceObservation, SetupStateView};
use super::configuration::{
    ConfigurationDeclaration, ConfigurationOperation, ConfigurationPredicate,
    ConfigurationProvision, ConfigurationRequirement,
};
use super::envelope::{
    CollectionSetup, CollectionSetupTypePack, apply_collection_setup, assess_collection_setup,
};
use super::receipts::{PROVISION_LOCK_PATH, ProvisionLock};
use crate::ids::{Hash, Uuid, revision};
use crate::intent::{
    AttachmentContentV1, AttachmentRefV1, BlobRef, ConflictMode, FileContent, Mutation, Op,
    OpClock, Source,
};
use crate::plan::{Effect, PlanOptions, Stage};
use crate::state::{MemState, StateView, StoredFile};
use crate::validate::{Issue, Severity, Tier};
use crate::value::{Map, Value};
use std::collections::BTreeMap;
struct Fixture {
    state: MemState,
    files: Vec<StoredFile>,
    sources: BTreeMap<Uuid, (String, String)>,
    available: bool,
    head: Hash,
}
fn bad() -> Box<Issue> {
    Box::new(Issue::new(
        "fixture_unavailable",
        Severity::Error,
        Tier::Request,
        "owned fixture unavailable",
    ))
}
impl SetupStateView for Fixture {
    fn state(&self) -> &dyn StateView {
        &self.state
    }
    fn collection_revision(&self) -> Hash {
        self.head
    }
    fn file_page(&self, after: Option<Uuid>, limit: usize) -> Result<Vec<StoredFile>, Box<Issue>> {
        if !self.available {
            return Err(bad());
        }
        Ok(self
            .files
            .iter()
            .filter(|f| after.is_none_or(|id| f.id > id))
            .take(limit)
            .cloned()
            .collect())
    }
    fn source(&self, file: &StoredFile, _: usize) -> Result<SetupSourceObservation, Box<Issue>> {
        let (doc, status) = self.sources.get(&file.id).ok_or_else(bad)?;
        match status.as_str() {
            "invalid_utf8" => Ok(SetupSourceObservation::InvalidUtf8),
            "unavailable" => Err(bad()),
            _ => Ok(SetupSourceObservation::Utf8(doc.clone())),
        }
    }
}
fn obj(pairs: Vec<(&str, Value)>) -> Value {
    Value::Map(pairs.into_iter().map(|(k, v)| (k.into(), v)).collect())
}
fn error(code: &str) -> Value {
    obj(vec![("error", Value::string(code))])
}
fn text<'a>(m: &'a Map, k: &str, default: &'a str) -> &'a str {
    m.get(k).and_then(Value::as_str).unwrap_or(default)
}
fn flag(m: &Map, k: &str) -> bool {
    matches!(m.get(k), Some(Value::Bool(true)))
}
fn run(args: &Map) -> Result<Value, Box<Issue>> {
    let mut f = Fixture {
        state: MemState::new(),
        files: Vec::new(),
        sources: BTreeMap::new(),
        available: !flag(args, "inventory_unavailable"),
        head: Hash::of(b"owned head"),
    };
    if !flag(args, "config_absent") {
        f.state.insert_resource(
            "mdbase.yaml",
            text(args, "config", "spec_version: '0.3.0'\n"),
        );
    }
    if let Some(receipt) = args.get("receipt").and_then(Value::as_str) {
        f.state.insert_resource(PROVISION_LOCK_PATH, receipt);
    }
    let entries = args.get("files").and_then(Value::as_list).unwrap_or(&[]);
    if entries.len() > 256 {
        return Err(bad());
    }
    for (i, entry) in entries.iter().enumerate() {
        let e = entry.as_map().ok_or_else(bad)?;
        let mut id = [0; 16];
        id[0] = 2;
        id[14..].copy_from_slice(&u16::try_from(i + 1).map_err(|_| bad())?.to_be_bytes());
        let id = Uuid(id);
        let path = text(e, "path", "views/default.base");
        let doc = text(e, "doc", "views: []\n");
        let declared = text(e, "declared_doc", doc);
        let status = text(e, "source_status", "utf8");
        let hash = if status == "invalid_utf8" {
            Hash::of(&[255])
        } else {
            revision(declared)
        };
        let size = if status == "invalid_utf8" {
            1
        } else {
            declared.len() as u64
        };
        let size = e
            .get("size")
            .and_then(|v| {
                if let Value::Int(n) = v {
                    u64::try_from(*n).ok()
                } else {
                    None
                }
            })
            .unwrap_or(size);
        let content = if text(e, "profile", "blob") == "attachment" {
            FileContent::AttachmentV1(AttachmentContentV1 {
                reference: AttachmentRefV1 {
                    collection: Uuid([9; 16]),
                    key_epoch: 1,
                    attachment_id: [7; 32],
                    manifest_cipher_hash: Hash::of(b"manifest"),
                },
                whole_plain_hash: hash,
                total_plain_bytes: size,
            })
        } else {
            FileContent::Blob(BlobRef {
                plain_hash: hash,
                size,
                blob_id: [7; 32],
                id_epoch: 1,
                part_size: 8_388_608,
            })
        };
        if flag(e, "unindexed") {
            f.state.apply_effect(&Effect::PutUnindexedMarkdown {
                id,
                path: path.into(),
                content,
            });
        } else {
            match content {
                FileContent::Blob(blob) => f.state.apply_effect(&Effect::PutFile {
                    id,
                    path: path.into(),
                    blob,
                }),
                FileContent::AttachmentV1(content) => {
                    f.state.apply_effect(&Effect::PutAttachmentFile {
                        id,
                        path: path.into(),
                        content,
                    })
                }
            }
        }
        f.files.push(f.state.file(&id).ok_or_else(bad)?);
        f.sources.insert(id, (doc.into(), status.into()));
    }
    match text(args, "occupied_receipt", "") {
        "file" => f.state.apply_effect(&Effect::PutFile {
            id: Uuid([6; 16]),
            path: PROVISION_LOCK_PATH.into(),
            blob: BlobRef {
                plain_hash: revision("x: 1\n"),
                size: 5,
                blob_id: [1; 32],
                id_epoch: 1,
                part_size: 1,
            },
        }),
        "record" => f
            .state
            .insert_record(Uuid([6; 16]), PROVISION_LOCK_PATH, "x: 1\n"),
        _ => {}
    }
    let configuration = if let Some(v) = args.get("configuration") {
        ConfigurationDeclaration::from_value(v)?
    } else {
        ConfigurationDeclaration {
            requirements: vec![ConfigurationRequirement {
                id: "base-extension".into(),
                path: "/settings/record_extensions".into(),
                predicate: ConfigurationPredicate::Contains,
                value: Value::string("base"),
            }],
            provisions: vec![ConfigurationProvision {
                requirement: "base-extension".into(),
                path: "/settings/record_extensions".into(),
                operation: ConfigurationOperation::SetAdd,
                value: Value::string("base"),
            }],
        }
    };
    let mut setup = CollectionSetup {
        application_id: text(args, "application_id", "app.reader").into(),
        declaration_digest: Hash::of(b"declaration"),
        configuration,
        type_packs: Vec::new(),
    };
    if flag(args, "note_pack") {
        let doc = "---\nkind: mdbase.type\nname: note\nversion: 1\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object}\n---\n";
        let manifest = format!(
            "kind: mdbase.type-pack\nid: example.notes\nversion: 1.0.0\nresources:\n  - kind: type\n    mode: managed\n    source: note.md\n    target: _types/note.md\n    digest: {}\n",
            revision(doc)
        );
        let pack = crate::packs::load_pack(&manifest, &|_| Some(doc.into())).map_err(Box::new)?;
        setup.type_packs.push(CollectionSetupTypePack {
            pack,
            options: crate::packs::AssessOptions {
                installed_by: setup.application_id.clone(),
                ..Default::default()
            },
        });
    }
    let clock = OpClock {
        instant_ms: 0,
        tz: "UTC".into(),
        local_date: "1970-01-01".into(),
    };
    let a = assess_collection_setup(&f, &setup, &clock)?;
    if !a.applicable {
        return Ok(obj(vec![
            ("applicable", Value::Bool(false)),
            ("operations", Value::List(Vec::new())),
        ]));
    }
    let (_, ops) = apply_collection_setup(
        &f,
        &setup,
        &clock,
        if flag(args, "stale_revision") {
            Hash::of(b"wrong head")
        } else {
            a.collection_revision
        },
        a.assessment_digest,
    )?;
    let operation_names = ops
        .iter()
        .map(|o| {
            Value::string(match o {
                Op::ResourcePut(_) => "resource_put",
                Op::ResourceDelete(_) => "resource_delete",
                Op::OrdinaryFileToRecord(_) => "ordinary_file_to_record",
                _ => "unexpected_operation",
            })
        })
        .collect();
    let request = Mutation {
        id: Uuid([1; 16]),
        origin: Uuid([2; 16]),
        base_seq: 0,
        clock,
        seed: [0; 32],
        source: Source::Api,
        ops,
        on_behalf: None,
        conflict_mode: ConflictMode::Record,
        validated_at: None,
        room: None,
    };
    if !request.ops.is_empty() {
        let planned = crate::plan(&request, &f.state, &PlanOptions { stage: Stage::Head })
            .map_err(|_| bad())?;
        f.state.apply(&planned);
    }
    let rows = a
        .files
        .iter()
        .map(|r| {
            obj(vec![
                ("path", Value::string(r.file.path.clone())),
                ("action", Value::string(r.action)),
                (
                    "diagnostic",
                    r.diagnostic
                        .as_ref()
                        .map_or(Value::Null, |s| Value::string(s.clone())),
                ),
                (
                    "source",
                    r.source_digest
                        .map_or(Value::Null, |h| Value::string(h.to_string())),
                ),
            ])
        })
        .collect();
    let count = f
        .state
        .resource(PROVISION_LOCK_PATH)
        .as_deref()
        .map(ProvisionLock::parse)
        .transpose()?
        .map_or(0usize, |l| {
            l.contributions.iter().map(|c| c.contributors.len()).sum()
        });
    Ok(obj(vec![
        ("applicable", Value::Bool(true)),
        ("files", Value::List(rows)),
        ("operations", Value::List(operation_names)),
        (
            "extensions",
            Value::List(
                f.state
                    .catalog()
                    .settings()
                    .record_extensions
                    .iter()
                    .map(|s| Value::string(s.clone()))
                    .collect(),
            ),
        ),
        ("contributors", Value::Int(count as i64)),
        (
            "pack_receipt",
            Value::Bool(f.state.resource("mdbase.lock.yaml").is_some()),
        ),
    ]))
}
/// Fixture-only deterministic entry point; no durable installation endpoint.
pub fn replay(args: &Map) -> Value {
    run(args).unwrap_or_else(|e| error(&e.code))
}
