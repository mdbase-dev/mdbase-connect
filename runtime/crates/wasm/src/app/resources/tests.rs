//! Real Core producer/codec tests, not an app-runtime/native write witness.
use super::*;
fn manifest() -> Value {
    mdbn_core::yaml::parse_value(
        r#"
id: org.example.resources
requirements:
  configuration:
    - {id: base-format, path: /settings/record_extensions, predicate: contains, value: base}
provisions:
  configuration:
    - {requirement: base-format, path: /settings/record_extensions, operation: set_add, value: base}
  type_packs: []
"#,
    )
    .unwrap()
    .unwrap()
}
#[test]
fn canonical_config_only_plan_has_original_guards_and_no_synthetic_pack() {
    let setup = setup(&manifest()).unwrap();
    let mut state = MemState::new();
    let assessment = envelope::assess_collection_resources(&state, &setup).unwrap();
    assert!(assessment.applicable);
    let (_, ops) =
        envelope::apply_collection_resources(&state, &setup, assessment.assessment_digest).unwrap();
    assert!(!ops.is_empty());
    let dto = plan(&assessment, &ops).unwrap();
    assert_eq!(
        dto.get("planKind").unwrap().as_str(),
        Some("configuration-only")
    );
    assert!(dto.get("packs").unwrap().as_list().unwrap().is_empty());
    assert!(dto.get("sources").unwrap().as_list().unwrap().is_empty());
    for op in &ops {
        let Op::ResourcePut(r) = op else {
            panic!("only guarded config resource puts");
        };
        assert!(["mdbase.yaml", "mdbase.provisions.yaml"].contains(&r.path.as_str()));
        assert!(r.must_not_exist);
        assert!(r.base_revision.is_none());
        state.insert_resource(&r.path, &r.doc);
    }
    let ready = envelope::assess_collection_resources(&state, &setup).unwrap();
    assert!(ready.applicable);
    assert!(
        envelope::apply_collection_resources(&state, &setup, ready.assessment_digest)
            .unwrap()
            .1
            .is_empty()
    );
    assert!(
        envelope::apply_collection_resources(&state, &setup, assessment.assessment_digest).is_err()
    );
}
#[test]
fn config_conflict_and_changed_original_input_refuse_core_apply() {
    let setup = setup(&manifest()).unwrap();
    let mut state = MemState::new();
    state.insert_resource("mdbase.yaml", "settings: false\n");
    let assessed = envelope::assess_collection_resources(&state, &setup).unwrap();
    assert!(!assessed.applicable);
    assert!(
        envelope::apply_collection_resources(&state, &setup, assessed.assessment_digest).is_err()
    );
}
#[test]
fn declaration_codec_rejects_bytes_duplicate_keys_and_deep_inputs() {
    let original = manifest();
    assert_eq!(from_cbor(&to_cbor(&original), 0, &mut 0).unwrap(), original);
    assert!(from_cbor(&Cbor::Bytes(vec![1]), 0, &mut 0).is_err());
    let key = Cbor::Text("same".into());
    assert!(
        from_cbor(
            &Cbor::Map(vec![(key.clone(), Cbor::Null), (key, Cbor::Null)]),
            0,
            &mut 0
        )
        .is_err()
    );
    let mut deep = Cbor::Null;
    for _ in 0..34 {
        deep = Cbor::Array(vec![deep]);
    }
    assert!(from_cbor(&deep, 0, &mut 0).is_err());
}
#[test]
fn pack_loader_is_the_canonical_core_loader_not_a_reconstructed_identity() {
    let source = "---\nkind: type\nname: task\nversion: 1\nfields: {}\n---\n";
    let digest = mdbn_core::ids::revision(source).to_string();
    let pack_manifest = mdbn_core::yaml::parse_value(&format!("kind: mdbase.type-pack\nid: org.example.task\nversion: 1.0.0\nresources:\n  - {{kind: type, mode: managed, source: task.md, target: _types/task.md, digest: {digest}}}\n")).unwrap().unwrap();
    let mut declaration = manifest();
    {
        let Value::Map(root) = &mut declaration else {
            panic!("map");
        };
        let Value::Map(provisions) = root.get_mut("provisions").unwrap() else {
            panic!("map");
        };
        provisions.insert(
            "type_packs",
            Value::List(vec![object(vec![
                ("manifest", pack_manifest.clone()),
                (
                    "resources",
                    Value::List(vec![object(vec![
                        ("source", Value::string("task.md")),
                        ("document", Value::string(source)),
                    ])]),
                ),
                ("provides", Value::List(Vec::new())),
            ])]),
        );
    }
    let loaded = setup(&declaration).unwrap();
    let direct = load_pack(&pack_manifest.to_json(), &|path| {
        (path == "task.md").then(|| source.to_owned())
    })
    .unwrap();
    assert_eq!(loaded.type_packs[0].pack, direct);
    // The embedded source bytes remain part of the actual strict digest check.
    let Value::Map(root) = &mut declaration else {
        panic!("map");
    };
    let Value::Map(provisions) = root.get_mut("provisions").unwrap() else {
        panic!("map");
    };
    let Value::List(entries) = provisions.get_mut("type_packs").unwrap() else {
        panic!("list");
    };
    let Value::Map(entry) = &mut entries[0] else {
        panic!("map");
    };
    entry.insert(
        "resources",
        Value::List(vec![object(vec![
            ("source", Value::string("task.md")),
            ("document", Value::string("changed")),
        ])]),
    );
    assert!(setup(&declaration).is_err());
}
fn pack_declaration(source: &str) -> Value {
    pack_declaration_mode(source, "managed")
}
fn pack_declaration_mode(source: &str, mode: &str) -> Value {
    let digest = mdbn_core::ids::revision(source).to_string();
    let pack_manifest = mdbn_core::yaml::parse_value(&format!("kind: mdbase.type-pack\nid: org.example.task\nversion: 1.0.0\nresources:\n  - {{kind: type, mode: {mode}, source: task.md, target: _types/task.md, digest: {digest}}}\n")).unwrap().unwrap();
    let mut declaration = manifest();
    let Value::Map(root) = &mut declaration else {
        panic!("map");
    };
    let Value::Map(provisions) = root.get_mut("provisions").unwrap() else {
        panic!("map");
    };
    provisions.insert(
        "type_packs",
        Value::List(vec![object(vec![
            ("manifest", pack_manifest),
            (
                "resources",
                Value::List(vec![object(vec![
                    ("source", Value::string("task.md")),
                    ("document", Value::string(source)),
                ])]),
            ),
            ("provides", Value::List(Vec::new())),
        ])]),
    );
    declaration
}
const TASK: &str = "---
kind: mdbase.type
name: task
version: 1
schema:
  dialect: json-schema-2020-12
  value: {type: object}
---
";
fn adopting(target: &str, digest: &str) -> Decisions {
    decisions(&object(vec![(
        "adopt",
        object(vec![(target, Value::string(digest))]),
    )]))
    .unwrap()
}
fn put(inventory: &mut Vec<(String, String)>, path: &str, source: &str) {
    inventory.retain(|(p, _)| p != path);
    inventory.push((path.to_owned(), source.to_owned()));
    inventory.sort();
}
#[test]
fn setup_installs_into_configured_folders_and_reviews_an_existing_type_for_adoption() {
    let declaration = pack_declaration(TASK);
    let mut inventory = Vec::new();
    let settings = |folder: &str| {
        format!(
            "spec_version: '0.3.0'\nsettings:\n  types_folder: {folder}\n  record_extensions: [md, base]\n"
        )
    };
    put(&mut inventory, "mdbase.yaml", &settings("Types"));
    // A hand-written type already sits where the pack would install.
    let theirs = "---\nkind: mdbase.type\nname: task\nversion: 1\ndescription: Mine\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object}\n---\n";
    put(&mut inventory, "Types/task.md", theirs);
    let (assessment, ops, adopted) =
        assess(&inventory, &declaration, &Decisions::default()).unwrap();
    assert!(!assessment.applicable && ops.is_empty());
    let reviewed = review(&assessment, &ops, &adopted);
    let row = &reviewed.get("packs").unwrap().as_list().unwrap()[0]
        .get("resources")
        .unwrap()
        .as_list()
        .unwrap()[0];
    assert_eq!(row.get("target").unwrap().as_str(), Some("Types/task.md"));
    assert_eq!(row.get("action").unwrap().as_str(), Some("conflict"));
    assert_eq!(row.get("installed"), Some(&Value::Bool(false)));
    let live = row
        .get("currentDigest")
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(live, mdbn_core::ids::revision(theirs).to_string());

    // Reviewed adoption: one write over exactly the reviewed revision.
    let decision = adopting("Types/task.md", &live);
    let (adopting_plan, ops, adopted) = assess(&inventory, &declaration, &decision).unwrap();
    assert!(adopting_plan.applicable);
    let write = ops
        .iter()
        .find_map(|op| match op {
            Op::ResourcePut(r) if r.path == "Types/task.md" => Some(r),
            _ => None,
        })
        .unwrap();
    assert_eq!(
        (
            write.doc.as_str(),
            write.must_not_exist,
            write.base_revision.map(|h| h.to_string())
        ),
        (TASK, false, Some(live.clone()))
    );
    let shown = review(&adopting_plan, &ops, &adopted);
    let staged = shown.get("staged").unwrap().as_list().unwrap();
    assert_eq!(
        staged[0].get("path").unwrap().as_str(),
        Some("Types/task.md")
    );
    assert_eq!(staged[0].get("document").unwrap().as_str(), Some(TASK));
    // Applying recomputes the same reviewed assessment.
    assert_eq!(
        assess(&inventory, &declaration, &decision)
            .unwrap()
            .0
            .assessment_digest,
        adopting_plan.assessment_digest
    );
    // A decision no declared pack installs is a stale review.
    assert!(assess(&inventory, &declaration, &adopting("Other/task.md", &live)).is_err());

    // After install, checks without the decision are current, and a later
    // folder change never moves the pack's types.
    for op in ops {
        if let Op::ResourcePut(r) = op {
            put(&mut inventory, &r.path, &r.doc);
        }
    }
    assert!(
        assess(&inventory, &declaration, &Decisions::default())
            .unwrap()
            .1
            .is_empty()
    );
    put(&mut inventory, "mdbase.yaml", &settings("Moved"));
    let (current, ops, _) = assess(&inventory, &declaration, &Decisions::default()).unwrap();
    assert!(current.applicable && ops.is_empty());
}

const THEIRS: &str = "---\nkind: mdbase.type\nname: task\nversion: 1\ndescription: Mine\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object}\n---\n";
fn rev(source: &str) -> String {
    mdbn_core::ids::revision(source).to_string()
}
fn overwrites(ops: &[Op], path: &str) -> bool {
    ops.iter()
        .any(|op| matches!(op, Op::ResourcePut(r) if r.path == path && !r.must_not_exist))
}
#[test]
fn adoption_is_limited_to_the_advertised_unmanaged_managed_conflicts() {
    // A seed target the user already has is preserved, never adoptable.
    let seed = pack_declaration_mode(TASK, "seed");
    let mut inventory = Vec::new();
    put(&mut inventory, "_types/task.md", THEIRS);
    let (kept, ops, _) = assess(&inventory, &seed, &Decisions::default()).unwrap();
    assert!(kept.applicable && !overwrites(&ops, "_types/task.md"));
    assert!(assess(&inventory, &seed, &adopting("_types/task.md", &rev(THEIRS))).is_err());

    // An installed managed definition edited afterwards stays a conflict.
    let managed = pack_declaration(TASK);
    let mut inventory = Vec::new();
    let (_, ops, _) = assess(&inventory, &managed, &Decisions::default()).unwrap();
    for op in ops {
        if let Op::ResourcePut(r) = op {
            put(&mut inventory, &r.path, &r.doc);
        }
    }
    put(&mut inventory, "_types/task.md", THEIRS);
    let (edited, _, _) = assess(&inventory, &managed, &Decisions::default()).unwrap();
    assert!(!edited.applicable);
    assert!(
        assess(
            &inventory,
            &managed,
            &adopting("_types/task.md", &rev(THEIRS))
        )
        .is_err()
    );
}
#[test]
fn reviewed_adoption_binds_target_existence_revision_and_guard() {
    let declaration = pack_declaration(TASK);
    let mut inventory = Vec::new();
    put(&mut inventory, "_types/task.md", THEIRS);
    let decision = adopting("_types/task.md", &rev(THEIRS));
    let (reviewed, ops, _) = assess(&inventory, &declaration, &decision).unwrap();
    assert!(reviewed.applicable && overwrites(&ops, "_types/task.md"));

    // Deleted between review and apply: refuses instead of a create-only put,
    // and the masked inventory alone never reproduces the reviewed digest.
    let deleted: Vec<(String, String)> = Vec::new();
    assert!(assess(&deleted, &declaration, &decision).is_err());
    let (masked, _, _) = assess(&deleted, &declaration, &Decisions::default()).unwrap();
    assert_ne!(masked.assessment_digest, reviewed.assessment_digest);

    // Changed between review and apply: the stale decision refuses.
    let mut changed = inventory.clone();
    put(
        &mut changed,
        "_types/task.md",
        &THEIRS.replace("Mine", "Edited"),
    );
    assert!(assess(&changed, &declaration, &decision).is_err());
}
fn stateless(apply: bool, expected: Option<&str>, rows: &[(&str, &str)], review: bool) -> Cbor {
    let mut request = vec![
        Cbor::Uint(1),
        Cbor::Uint(u64::from(apply)),
        to_cbor(&manifest()),
        expected.map_or(Cbor::Null, |e| Cbor::Text(e.into())),
        Cbor::Array(
            rows.iter()
                .map(|(p, s)| Cbor::Array(vec![Cbor::Text((*p).into()), Cbor::Text((*s).into())]))
                .collect(),
        ),
    ];
    if review {
        request.push(Cbor::Map(vec![]));
    }
    let mut bytes = cbor::encode(&Cbor::Array(request)).unwrap();
    cbor::decode(&setup_inventory_consuming(&mut bytes)).unwrap()
}
fn answered(reply: &Cbor) -> Option<Value> {
    let Cbor::Array(parts) = reply else {
        return None;
    };
    (parts.get(1) == Some(&Cbor::Bool(true))).then(|| from_cbor(&parts[2], 0, &mut 0).unwrap())
}
#[test]
fn caller_inventory_gets_the_replica_paths_assessment_review_and_plan() {
    let assessed = answered(&stateless(false, None, &[], true)).unwrap();
    let (core, ops, _) = assess(&[], &manifest(), &Decisions::default()).unwrap();
    let digest = core.assessment_digest.to_string();
    assert_eq!(assessed.get("status").unwrap().as_str(), Some("provision"));
    assert_eq!(
        assessed.get("assessmentDigest").unwrap().as_str(),
        Some(digest.as_str())
    );
    assert!(assessed.get("review").is_some());
    let planned = answered(&stateless(true, Some(&digest), &[], false)).unwrap();
    assert_eq!(planned, plan(&core, &ops).unwrap());
    // A stale digest, an unordered or duplicate inventory all refuse.
    let other = mdbn_core::ids::revision("x").to_string();
    assert!(answered(&stateless(true, Some(&other), &[], false)).is_none());
    assert!(
        answered(&stateless(
            false,
            None,
            &[("b.md", "x"), ("a.md", "y")],
            false
        ))
        .is_none()
    );
    assert!(
        answered(&stateless(
            false,
            None,
            &[("a.md", "x"), ("a.md", "x")],
            false
        ))
        .is_none()
    );
}
