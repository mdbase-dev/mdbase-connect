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
