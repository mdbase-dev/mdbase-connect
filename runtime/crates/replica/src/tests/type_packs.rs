//! Type pack plans over the real local view, submitted through the real writer:
//! review → adopt → one guarded mutation → current; stale and unauthorized
//! applies are refused.
use super::engine::{Node, node, settle};
use super::resources::granted;
use crate::api::{ClientApi, ErrorCode, TypePackPlan, TypePackRequest, TypePackWrite};
use crate::fake::FakeLogService;
use crate::mem::MemStore;
use crate::{Store, Tx};
use mdbn_core::ids::revision;
use mdbn_wire::client::{ReceiptState, SubmitParams};
use mdbn_wire::common::{Hash, Text, Value};
use mdbn_wire::intent::{Op, ResourceDelete, ResourcePut};

const TYPE: &str = "---\nkind: mdbase.type\nname: note\nversion: 1\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object}\n---\n";
const TARGET: &str = "_types/note.md";

fn text(s: &str) -> Value {
    Value::Text(s.into())
}
fn map(entries: Vec<(&str, Value)>) -> Value {
    Value::Map(entries.into_iter().map(|(k, v)| (k.into(), v)).collect())
}
fn provision() -> Value {
    let resource = map(vec![
        ("kind", text("type")),
        ("mode", text("managed")),
        ("source", text("note.md")),
        ("target", text(TARGET)),
        ("digest", text(&revision(TYPE).to_string())),
    ]);
    map(vec![
        (
            "manifest",
            map(vec![
                ("kind", text("mdbase.type-pack")),
                ("id", text("example.notes")),
                ("version", text("1.0.0")),
                ("resources", Value::List(vec![resource])),
            ]),
        ),
        (
            "resources",
            Value::List(vec![map(vec![
                ("source", text("note.md")),
                ("document", text(TYPE)),
            ])]),
        ),
    ])
}
fn request(adopt: Option<(&str, &str)>, expected: Option<Hash>) -> TypePackRequest {
    TypePackRequest {
        provision: provision(),
        installed_by: "dev.example.tests".into(),
        adopt: adopt.map(|(t, d)| map(vec![(t, text(d))])),
        preserve_seed_targets: vec![],
        target_overrides: None,
        allow_downgrade: false,
        expected,
    }
}
fn configured(existing: Option<&str>) -> (FakeLogService, Node) {
    let service = FakeLogService::new();
    let mut store = MemStore::new();
    let mut resources = vec![("mdbase.yaml".into(), "spec_version: '0.3.0'\n".into())];
    if let Some(doc) = existing {
        resources.push((TARGET.into(), doc.into()));
    }
    store
        .commit(Tx {
            resources_put: resources,
            ..Tx::default()
        })
        .unwrap();
    let mut a = node(&service, 1, store);
    a.r.planner = Box::new(crate::plan::CorePlanner);
    settle(&mut [&mut a]);
    (service, a)
}
fn get<'a>(v: &'a Value, key: &str) -> &'a Value {
    let Value::Map(m) = v else { panic!("{v:?}") };
    &m.iter()
        .find(|(k, _)| k == key)
        .unwrap_or_else(|| panic!("{key}"))
        .1
}
fn has(v: &Value, key: &str) -> bool {
    matches!(v, Value::Map(m) if m.iter().any(|(k, _)| k == key))
}
fn resource(plan: &TypePackPlan) -> &Value {
    let Value::List(rows) = get(&plan.assessment, "resources") else {
        panic!()
    };
    &rows[0]
}
fn digest(plan: &TypePackPlan) -> Hash {
    let Value::Text(d) = get(&plan.assessment, "assessment_digest") else {
        panic!()
    };
    crate::convert::whash(&mdbn_core::ids::Hash::parse(d).unwrap())
}
fn submit(a: &mut Node, writes: Vec<TypePackWrite>) -> mdbn_wire::client::Receipt {
    let ops = writes
        .into_iter()
        .map(|w| match w.doc {
            Some(doc) => Op::ResourcePut(ResourcePut {
                path: w.path,
                doc: Text::Inline(doc),
                base_revision: w.base_revision,
                must_not_exist: Some(w.must_not_exist),
            }),
            None => Op::ResourceDelete(ResourceDelete {
                path: w.path,
                base_revision: w.base_revision,
            }),
        })
        .collect();
    let s = a.s;
    a.r.submit(
        s,
        SubmitParams {
            ops,
            mutation_id: None,
            conflict_mode: None,
            timezone: None,
            allow_partial: None,
            mutation_ids: None,
            dry_run: None,
            include: None,
            wait: None,
        },
    )
    .unwrap()
    .remove(0)
}
/// The local (confirmed plus pending) resource source.
fn local(a: &Node, path: &str) -> Option<String> {
    use mdbn_core::state::StateView;
    let base = crate::plan::StoreView::new(&a.r.store, a.r.catalog.clone());
    let view = crate::layer::LayerView {
        base: &base,
        layer: &a.r.layer,
    };
    view.resource(path).map(|s| s.to_string())
}
fn put(a: &mut Node, doc: &str) {
    let base = local(a, TARGET).unwrap();
    let r = submit(
        a,
        vec![TypePackWrite {
            path: TARGET.into(),
            doc: Some(doc.into()),
            base_revision: Some(mdbn_wire::hash::sha256(base.as_bytes())),
            must_not_exist: false,
        }],
    );
    assert_eq!(r.state, ReceiptState::Pending, "{:?}", r.problem);
}
fn refused(e: crate::api::ApiError, code: ErrorCode, reason: &str) {
    assert_eq!(e.code(), Some(code), "{:?}", e.problem());
    assert_eq!(e.problem().reason.as_deref(), Some(reason));
}

#[test]
fn type_pack_review_adopt_apply_once_then_current() {
    let edited = format!("{TYPE}\nlocal edit\n");
    let (_, mut a) = configured(Some(&edited));
    let s = a.s;
    // An unmanaged, different target is a conflict naming its live digest.
    let first = a.r.plan_type_pack(s, request(None, None)).unwrap();
    assert_eq!(get(&first.assessment, "applicable"), &Value::Bool(false));
    assert_eq!(get(resource(&first), "action"), &text("conflict"));
    let live = revision(&edited).to_string();
    assert_eq!(get(resource(&first), "current_digest"), &text(&live));
    assert!(first.writes.is_none(), "an assessment plans no writes");
    refused(
        a.r.plan_type_pack(s, request(None, Some(digest(&first))))
            .unwrap_err(),
        ErrorCode::Conflict,
        "type_pack_conflict",
    );

    // The reviewed adoption makes it applicable; apply is one guarded mutation.
    let adopted =
        a.r.plan_type_pack(s, request(Some((TARGET, &live)), None))
            .unwrap();
    assert_eq!(get(&adopted.assessment, "applicable"), &Value::Bool(true));
    assert_eq!(get(resource(&adopted), "adopted_from_digest"), &text(&live));
    let plan =
        a.r.plan_type_pack(s, request(Some((TARGET, &live)), Some(digest(&adopted))))
            .unwrap();
    let writes = plan.writes.unwrap();
    assert_eq!(writes.len(), 2, "the type and the lock");
    assert!(
        writes
            .iter()
            .all(|w| w.base_revision.is_some() || w.must_not_exist)
    );
    let r = submit(&mut a, writes);
    assert_eq!(r.state, ReceiptState::Pending, "{:?}", r.problem);

    // Re-plan: current, and a re-apply writes nothing.
    let again = a.r.plan_type_pack(s, request(None, None)).unwrap();
    assert_eq!(get(&again.assessment, "status"), &text("current"));
    assert!(has(&again.assessment, "current"));
    let re =
        a.r.plan_type_pack(s, request(None, Some(digest(&again))))
            .unwrap();
    assert_eq!(re.writes, Some(vec![]));

    // A change after review is a concurrent modification.
    put(&mut a, &format!("{TYPE}\nanother edit\n"));
    refused(
        a.r.plan_type_pack(s, request(None, Some(digest(&again))))
            .unwrap_err(),
        ErrorCode::Conflict,
        "concurrent_modification",
    );
}

#[test]
fn type_pack_adopted_unchanged_target_is_guarded_until_submit() {
    let (_, mut a) = configured(Some(TYPE));
    let s = a.s;
    let plan = a.r.plan_type_pack(s, request(None, None)).unwrap();
    assert_eq!(get(resource(&plan), "action"), &text("adopt"));
    let writes =
        a.r.plan_type_pack(s, request(None, Some(digest(&plan))))
            .unwrap()
            .writes
            .unwrap();
    let guard = writes.iter().find(|w| w.path == TARGET).unwrap();
    assert_eq!(
        guard.base_revision,
        Some(mdbn_wire::hash::sha256(TYPE.as_bytes()))
    );
    // The adopted target changes between review and submit: nothing lands.
    put(&mut a, &format!("{TYPE}\nraced\n"));
    let r = submit(&mut a, writes);
    assert_ne!(r.state, ReceiptState::Pending);
    assert!(
        local(&a, mdbn_core::types::LOCK_PATH).is_none(),
        "no lock without the guard"
    );
}

#[test]
fn type_pack_plan_reports_and_apply_refuses_missing_manage_and_folder_scope() {
    let (service, mut a) = configured(None);
    let reader = granted(&service, &mut a, "collection.read", None);
    let plan = a.r.plan_type_pack(reader, request(None, None)).unwrap();
    assert_eq!(
        get(&plan.assessment, "definitions_manage"),
        &Value::Bool(false)
    );
    assert_eq!(
        a.r.plan_type_pack(reader, request(None, Some(digest(&plan))))
            .unwrap_err()
            .code(),
        Some(ErrorCode::Forbidden)
    );
    let (service, mut a) = configured(None);
    let folder = granted(
        &service,
        &mut a,
        "collection.read",
        Some(vec!["notes".into()]),
    );
    assert_eq!(
        a.r.plan_type_pack(folder, request(None, None))
            .unwrap_err()
            .code(),
        Some(ErrorCode::Forbidden)
    );
}
