//! Path-stored persisted values and atomic planning.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use mdbn_core::{
    doc::Document,
    ids::Uuid,
    intent::*,
    paths::fields::{PathPolicy, normalize},
    plan::{Effect, PlanOptions, Stage},
    state::{MemState, Overlay, StateView},
    value::{Map, Value},
};

const TASK: &str = "---\nkind: mdbase.type\nname: task\nmatch: {path_glob: 'tasks/*.md'}\nschema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    required: [title]\n    properties:\n      title: {type: string}\ncollection:\n  path:\n    pattern: 'tasks/{title}.md'\n    fields: [title]\n---\n";
fn id(n: u8) -> Uuid {
    Uuid([n; 16])
}
fn state() -> MemState {
    let mut s = MemState::new();
    s.insert_resource(
        "mdbase.yaml",
        "spec_version: '0.3.0'\nsettings: {validation: error}\n",
    );
    s.insert_resource("_types/task.md", TASK);
    s.insert_record(id(1), "tasks/Old.md", "---\nstatus: open\n---\n[[Old]]\n");
    s.insert_record(id(2), "ref.md", "See [[Old]].\n");
    s
}
fn mutation(op: Op) -> Mutation {
    Mutation {
        id: id(200),
        origin: id(201),
        base_seq: 0,
        clock: OpClock {
            instant_ms: 1_767_225_600_000,
            tz: "UTC".into(),
            local_date: "2026-01-01".into(),
        },
        seed: [7; 32],
        source: Source::Api,
        ops: vec![op],
        on_behalf: None,
        conflict_mode: ConflictMode::Record,
        validated_at: None,
        room: None,
    }
}
fn patch(key: &str, value: &str) -> Option<Map> {
    Some([(key.into(), Value::string(value))].into_iter().collect())
}
#[allow(clippy::result_large_err)]
fn plan(s: &MemState, op: Op) -> Result<mdbn_core::plan::Planned, mdbn_core::plan::Rejection> {
    mdbn_core::plan(
        &mutation(op),
        s,
        &PlanOptions {
            stage: Stage::Submit {
                level: Level::Error,
            },
        },
    )
}
fn create(title: &str) -> Op {
    Op::Create(Create {
        id: id(3),
        type_name: Some("task".into()),
        frontmatter: patch("title", title),
        ..Default::default()
    })
}

#[test]
fn shortest_match_anchoring_unicode_and_surgical_replacement() {
    let p = PathPolicy::new("{id} {title}.md", vec!["title".into()]).unwrap();
    let d = p.decode("α β γ.md").unwrap();
    assert_eq!(d.values.get("title"), Some(&Value::string("β γ")));
    assert!(p.decode("α/β γ.md").is_none());
    assert!(p.decode("α β γ.md.bak").is_none());
    let values = patch("title", "New").unwrap();
    assert_eq!(p.update_path("α β γ.md", &values).unwrap(), "α New.md");
    assert!(PathPolicy::new("{id}{title}.md", vec!["title".into()]).is_err());
}
#[test]
fn formatted_dates_combine_and_reject_inconsistency() {
    let p = PathPolicy::new(
        "Daily/{date:YYYY}/{date:MM}/{date:DD-MM-YYYY}.md",
        vec!["date".into()],
    )
    .unwrap();
    let v = patch("date", "2024-02-29").unwrap();
    assert_eq!(p.derive(&v).unwrap(), "Daily/2024/02/29-02-2024.md");
    assert_eq!(p.decode("Daily/2024/02/29-02-2024.md").unwrap().values, v);
    for path in ["Daily/2023/02/29-02-2023.md", "Daily/2024/03/29-02-2024.md"] {
        let d = p.decode(path).unwrap();
        assert!(d.values.is_empty());
        assert!(d.inconsistent.contains("date"));
    }
    // Partial dates and plain/formatted mixes cannot decode, so they are rejected at load.
    assert!(PathPolicy::new("{date:YYYY}.md", vec!["date".into()]).is_err());
    assert!(PathPolicy::new("{date:YYYY}/{date}.md", vec!["date".into()]).is_err());
    let p = PathPolicy::new("{date:YYYY-YYYY-MM-DD}.md", vec!["date".into()]).unwrap();
    assert!(
        p.decode("2024-2025-01-01.md")
            .unwrap()
            .inconsistent
            .contains("date")
    );
}
#[test]
fn fixed_normalization_no_fallback() {
    assert_eq!(
        normalize(" .. A\t B<>:\"/\\|?*#[]^\u{200b}... "),
        Some("A B".into())
    );
    for s in ["...", "?*"] {
        assert_eq!(normalize(s), None, "{s}");
    }
}
#[test]
fn create_strips_normalizes_validates_required_and_never_suffixes() {
    let s = state();
    let p = plan(&s, create(" New?  title. ")).unwrap();
    let Effect::PutRecord { path, doc, .. } = &p.effects[0] else {
        panic!()
    };
    assert_eq!(path, "tasks/New title.md");
    assert!(!doc.contains("title:"));
    assert!(mdbn_core::validate::validate_record(&s.catalog(), path, doc).is_empty());
    assert_eq!(
        plan(&s, create("OLD")).unwrap_err().reason.as_deref(),
        Some("path_conflict")
    );
}
#[test]
fn lifecycle_precedes_all_pattern_derivation_including_today() {
    let mut s = state();
    let daily = "---\nkind: mdbase.type\nname: daily\nschema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    properties:\n      date: {type: string, format: date}\ncollection:\n  path:\n    pattern: 'Daily/{date:YYYY}/{date:YYYY-MM-DD}.md'\n    fields: [date]\nlifecycle:\n  on_create:\n    set:\n      date: {today: true}\n---\n";
    s.insert_resource("_types/daily.md", daily);
    let op = Op::Create(Create {
        id: id(4),
        type_name: Some("daily".into()),
        ..Default::default()
    });
    let p = plan(&s, op.clone()).unwrap();
    assert!(
        matches!(&p.effects[0], Effect::PutRecord { path, doc, .. } if path == "Daily/2026/2026-01-01.md" && !doc.contains("date:"))
    );
    s.insert_resource(
        "_types/daily.md",
        &daily.replace("    fields: [date]\n", ""),
    );
    let p = plan(&s, op).unwrap();
    assert!(
        matches!(&p.effects[0], Effect::PutRecord { path, doc, .. } if path == "Daily/2026/2026-01-01.md" && doc.contains("date:"))
    );
}
#[test]
fn update_is_one_atomic_move_with_rewrites_and_preserves_new_body() {
    let s = state();
    let op = Op::Update(Update {
        id: id(1),
        patch: patch("title", "New"),
        body: Some("edited [[Old]]\n".into()),
        ..Default::default()
    });
    let p = plan(&s, op).unwrap();
    let own: Vec<_> = p
        .effects
        .iter()
        .filter(|e| matches!(e, Effect::PutRecord { id: rid, .. } if *rid == id(1)))
        .collect();
    assert_eq!(own.len(), 1);
    assert!(
        matches!(own[0], Effect::PutRecord { path, doc, .. } if path == "tasks/New.md" && doc.contains("edited [[New]]") && !doc.contains("title:"))
    );
    assert!(p.effects.iter().any(|e| matches!(e, Effect::PutRecord { id: rid, doc, .. } if *rid == id(2) && doc.contains("[[New]]"))));
    assert_eq!(p.link_rewrites.len(), 2);
    let mut ov = Overlay::new(&s);
    for e in &p.effects {
        ov.apply_effect(e);
    }
    assert!(ov.at_path_key("tasks/old.md").is_none());
    assert_eq!(ov.record(&id(1)).unwrap().path, "tasks/New.md");
}
#[test]
fn update_collision_unset_and_opt_out() {
    let mut s = state();
    s.insert_record(id(4), "tasks/Taken.md", "body");
    let op = Op::Update(Update {
        id: id(1),
        patch: patch("title", "Taken"),
        ..Default::default()
    });
    assert_eq!(
        plan(&s, op).unwrap_err().reason.as_deref(),
        Some("path_conflict")
    );
    let op = Op::Update(Update {
        id: id(1),
        unset: vec!["title".into()],
        ..Default::default()
    });
    assert_eq!(
        plan(&s, op).unwrap_err().reason.as_deref(),
        Some("path_value_missing")
    );
    let op = Op::Update(Update {
        id: id(1),
        patch: patch("title", "New"),
        update_refs: Some(false),
        ..Default::default()
    });
    let p = plan(&s, op).unwrap();
    assert_eq!(p.effects.len(), 1);
    assert!(p.link_rewrites.is_empty());
}
#[test]
fn document_value_moves_and_rename_requires_decodable_target() {
    let s = state();
    let op = Op::Document(DocumentOp {
        id: id(1),
        new: Some(DocVersion {
            path: "tasks/Old.md".into(),
            doc: "---\ntitle: New\n---\nnew body".into(),
        }),
        ..Default::default()
    });
    let p = plan(&s, op).unwrap();
    assert!(
        matches!(&p.effects[0], Effect::PutRecord { path, doc, .. } if path == "tasks/New.md" && !doc.contains("title:"))
    );
    let op = Op::Rename(Rename {
        id: id(1),
        from: "tasks/Old.md".into(),
        to: "other/New.md".into(),
        ..Default::default()
    });
    let p = plan(&s, op).unwrap();
    assert!(matches!(&p.effects[0], Effect::PutRecord { path, .. } if path == "other/New.md"));
}
#[test]
fn read_values_follow_external_move_win_duplicates_and_do_not_match_types() {
    let mut s = state();
    s.insert_record(id(1), "tasks/External.md", "---\ntitle: ignored\n---\nbody");
    let c = s.catalog();
    let rec = s.record(&id(1)).unwrap();
    let doc = Document::parse_at(&rec.path, &*rec.source);
    let types = c.membership(&rec.path, doc.frontmatter()).types;
    let (values, issues) = c.record_values_with_issues(&rec.path, &types, doc.frontmatter());
    assert_eq!(values.get("title"), Some(&Value::string("External")));
    assert_eq!(issues[0].code, "path_field_in_frontmatter");
    assert_eq!(issues[0].severity, mdbn_core::validate::Severity::Warning);
    s.insert_resource(
        "_types/other.md",
        &TASK.replace("name: task", "name: other").replace(
            "match: {path_glob: 'tasks/*.md'}",
            "match: {fields_present: [title]}",
        ),
    );
    assert_eq!(
        s.catalog()
            .membership("tasks/External.md", &Map::new())
            .types,
        vec!["task"]
    );
}
#[test]
fn path_values_are_persisted_for_queries_uniqueness_and_links() {
    let mut s = state();
    let query = mdbn_core::query::Query::from_value(&Value::Map(
        [(
            "where".into(),
            Value::string("raw.title == 'Old' && title == 'Old'"),
        )]
        .into_iter()
        .collect(),
    ))
    .unwrap();
    let q = mdbn_core::query::compile(&query, &s.catalog()).unwrap();
    let env = mdbn_core::query::QueryEnv {
        now_ms: 1_767_225_600_000,
        tz: "UTC".into(),
        today: "2026-01-01".into(),
    };
    assert_eq!(
        mdbn_core::query::execute(&q, &s, &env).unwrap().ids,
        vec![id(1)]
    );
    s.insert_resource(
        "mdbase.yaml",
        "spec_version: '0.3.0'\nsettings: {id_field: title}\n",
    );
    let keys = mdbn_core::links::target_keys(&s.catalog(), "tasks/Old.md", Some("body"));
    assert!(keys.len() >= 2, "{keys:?}");
    let unique_type = TASK
        .replace("tasks/{title}.md", "tasks/{prefix} {title}.md")
        .replace(
            "    fields: [title]",
            "    fields: [title]\n  unique:\n    - {field: title, enforce: write}",
        );
    s.insert_resource("_types/task.md", &unique_type);
    s.insert_record(id(1), "tasks/A Same.md", "body");
    let fm: Map = [
        ("prefix".into(), Value::string("B")),
        ("title".into(), Value::string("Same")),
    ]
    .into_iter()
    .collect();
    let op = Op::Create(Create {
        id: id(3),
        type_name: Some("task".into()),
        frontmatter: Some(fm),
        ..Default::default()
    });
    assert_eq!(
        plan(&s, op).unwrap_err().reason.as_deref(),
        Some("duplicate_value")
    );
}

#[test]
fn lifecycle_update_moves_and_stale_stored_base_is_a_path_conflict() {
    let mut s = state();
    s.insert_resource(
        "_types/task.md",
        &TASK.replacen(
            "\n---\n",
            "\nlifecycle:\n  on_update:\n    set:\n      title: {literal: Lifecycle}\n---\n",
            1,
        ),
    );
    let p = plan(
        &s,
        Op::Update(Update {
            id: id(1),
            patch: patch("status", "done"),
            ..Default::default()
        }),
    )
    .unwrap();
    assert!(
        matches!(&p.effects[0], Effect::PutRecord { path, doc, .. } if path == "tasks/Lifecycle.md" && !doc.contains("title:"))
    );
    let p = plan(
        &s,
        Op::Document(DocumentOp {
            id: id(1),
            new: Some(DocVersion {
                path: "tasks/Old.md".into(),
                doc: "---\ntitle: null\n---\nbody".into(),
            }),
            ..Default::default()
        }),
    )
    .unwrap();
    assert!(
        matches!(&p.effects[0], Effect::PutRecord { path, doc, .. } if path == "tasks/Lifecycle.md" && !doc.contains("title:"))
    );
    s.insert_resource("_types/task.md", TASK);
    let op = Op::Update(Update {
        id: id(1),
        patch: patch("title", "New"),
        base: vec![BaseField {
            key: "title".into(),
            observed: Some(Value::string("Earlier")),
        }],
        ..Default::default()
    });
    assert_eq!(plan(&s, op).unwrap_err().reason.as_deref(), Some("renamed"));
}

#[test]
fn inferred_create_cannot_lose_its_type_when_stored_keys_are_removed() {
    let mut s = state();
    s.insert_resource(
        "_types/task.md",
        &TASK.replace(
            "match: {path_glob: 'tasks/*.md'}",
            "match: {fields_present: [title]}",
        ),
    );
    let op = Op::Create(Create {
        id: id(3),
        frontmatter: patch("title", "New"),
        ..Default::default()
    });
    assert_eq!(
        plan(&s, op).unwrap_err().reason.as_deref(),
        Some("type_membership_changed")
    );
}

#[test]
fn patch_can_change_type_before_lifecycle_without_matching_on_synthetic_values() {
    let mut s = state();
    s.insert_record(id(1), "tasks/Old.md", "---\ntype: task\n---\nbody");
    s.insert_resource("_types/other.md", "---\nkind: mdbase.type\nname: other\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object}\n---\n");
    let p = plan(
        &s,
        Op::Update(Update {
            id: id(1),
            patch: patch("type", "other"),
            ..Default::default()
        }),
    )
    .unwrap();
    assert!(
        matches!(&p.effects[0], Effect::PutRecord { path, doc, .. } if path == "tasks/Old.md" && doc.contains("type: other") && doc.contains("title: Old"))
    );
}

#[test]
fn inbound_path_stored_link_is_rewritten_as_a_move_not_frontmatter() {
    let mut s = state();
    s.insert_resource("_types/ref.md", "---\nkind: mdbase.type\nname: ref\nmatch: {path_glob: 'tasks/link-*.md'}\nschema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    properties:\n      target: {type: string}\ncollection:\n  links:\n    target: {validate_exists: true}\n  path:\n    pattern: 'tasks/link-{target}.md'\n    fields: [target]\n---\n");
    s.insert_record(id(5), "tasks/link-Old.md", "---\ntype: ref\n---\nbody");
    let p = plan(
        &s,
        Op::Update(Update {
            id: id(1),
            patch: patch("title", "New"),
            ..Default::default()
        }),
    )
    .unwrap();
    assert!(p.effects.iter().any(|e| matches!(e, Effect::PutRecord { id: rid, path, doc } if *rid == id(5) && path == "tasks/link-New.md" && !doc.contains("target:"))), "{p:?}");
    s.insert_record(
        id(6),
        "tasks/link-New.md",
        "---\ntype: ref\n---\nalready occupied",
    );
    assert_eq!(
        plan(
            &s,
            Op::Update(Update {
                id: id(1),
                patch: patch("title", "New"),
                ..Default::default()
            })
        )
        .unwrap_err()
        .reason
        .as_deref(),
        Some("path_conflict")
    );
}

#[test]
fn concurrent_document_stored_assignments_use_path_merge_not_yaml_merge() {
    let mut s = state();
    let base = s.record(&id(1)).unwrap();
    s.insert_record(id(1), "tasks/First.md", &base.source);
    let op = Op::Document(DocumentOp {
        id: id(1),
        base: Some(DocVersion {
            path: base.path,
            doc: base.source.to_string(),
        }),
        new: Some(DocVersion {
            path: "tasks/Old.md".into(),
            doc: "---\ntitle: Second\nstatus: done\n---\n[[Old]]\n".into(),
        }),
        ..Default::default()
    });
    let p = plan(&s, op).unwrap();
    assert!(
        p.conflicts
            .iter()
            .any(|c| c.kind == mdbn_core::plan::ConflictKind::Path)
    );
    assert!(
        matches!(&p.effects[0], Effect::PutRecord { path, doc, .. } if path == "tasks/First.md" && doc.contains("status: done") && !doc.contains("title:"))
    );
}

#[test]
fn external_document_move_changes_values_without_sanitizing_bytes() {
    let s = state();
    let mut m = mutation(Op::Document(DocumentOp {
        id: id(1),
        base: Some(DocVersion {
            path: "tasks/Old.md".into(),
            doc: s.record(&id(1)).unwrap().source.to_string(),
        }),
        new: Some(DocVersion {
            path: "tasks/External.md".into(),
            doc: "---\ntitle: untouched duplicate\n---\nbody".into(),
        }),
        ..Default::default()
    }));
    m.source = Source::External;
    let p = mdbn_core::plan(&m, &s, &PlanOptions { stage: Stage::Head }).unwrap();
    let mut ov = Overlay::new(&s);
    for e in &p.effects {
        ov.apply_effect(e);
    }
    let r = ov.record(&id(1)).unwrap();
    assert_eq!(r.path, "tasks/External.md");
    assert!(r.source.contains("title: untouched duplicate"));
    let doc = Document::parse_at(&r.path, &*r.source);
    let c = ov.catalog();
    let types = c.membership(&r.path, doc.frontmatter()).types;
    assert_eq!(
        c.record_values(&r.path, &types, doc.frontmatter())
            .get("title"),
        Some(&Value::string("External"))
    );
}

#[test]
fn type_constraints_and_unknown_keys_are_warnings() {
    let mut s = state();
    s.insert_resource(
        "_types/task.md",
        &TASK.replace(
            "    fields: [title]",
            "    fields: [title]\n    runtime: tasknotes\n    x-test: true",
        ),
    );
    let c = s.catalog();
    assert_eq!(c.types().len(), 1);
    assert_eq!(c.issues().len(), 1);
    assert_eq!(c.issues()[0].code, "unknown_path_key");
    assert_eq!(
        c.issues()[0].severity,
        mdbn_core::validate::Severity::Warning
    );
    for t in [
        TASK.replace("title: {type: string}", "title: {type: number}"),
        TASK.replace("    pattern: 'tasks/{title}.md'\n", ""),
        TASK.replace("tasks/{title}.md", "tasks/{id}.md"),
        TASK.replace("tasks/{title}.md", "tasks/{title:YYYY}.md"),
    ] {
        s.insert_resource("_types/task.md", &t);
        let c = s.catalog();
        assert!(c.types().is_empty());
        assert!(c.issues().iter().any(|i| i.code == "invalid_type"));
    }
}

const DAILY: &str = "---\nkind: mdbase.type\nname: daily\nmatch: {path_glob: 'Daily/**/*.md'}\nschema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    properties:\n      date: {type: string, format: date}\n      mood: {type: string}\ncollection:\n  path:\n    pattern: 'Daily/{date:YYYY}/{date:YYYY-MM-DD}.md'\n    fields: [date]\n---\n";

#[test]
fn unrelated_writes_preserve_unnormalized_and_nondecoding_paths() {
    let mut s = state();
    s.insert_resource("_types/daily.md", DAILY);
    for path in [
        "tasks/[x] Plan.md",
        "Daily/not-a-date.md",
        "Daily/2025/2026-10-28.md",
    ] {
        s.insert_record(id(9), path, "---\nstatus: open\n---\nbody\n");
        for op in [
            Op::Update(Update {
                id: id(9),
                patch: patch("status", "done"),
                ..Default::default()
            }),
            Op::Update(Update {
                id: id(9),
                body: Some("new body\n".into()),
                ..Default::default()
            }),
            Op::Document(DocumentOp {
                id: id(9),
                new: Some(DocVersion {
                    path: path.into(),
                    doc: "---\nstatus: done\n---\nnew body\n".into(),
                }),
                ..Default::default()
            }),
        ] {
            let p = plan(&s, op).unwrap();
            assert!(
                matches!(&p.effects[0], Effect::PutRecord { path: target, .. } if target == path),
                "{p:?}"
            );
            assert!(p.aliases.is_empty());
        }
    }
}

#[test]
fn explicit_create_decodes_without_normalizing_unsupplied_values() {
    let s = state();
    let p = plan(
        &s,
        Op::Create(Create {
            id: id(3),
            type_name: Some("task".into()),
            path: Some("tasks/[y] Plan.md".into()),
            ..Default::default()
        }),
    )
    .unwrap();
    assert!(
        matches!(&p.effects[0], Effect::PutRecord { path, doc, .. } if path == "tasks/[y] Plan.md" && !doc.contains("title:"))
    );
    // An actual assignment is normalized, even if equal to the decoded text before normalization.
    let p = plan(
        &s,
        Op::Update(Update {
            id: id(1),
            patch: patch("title", " Old? "),
            ..Default::default()
        }),
    )
    .unwrap();
    assert!(p.effects.is_empty());
}

#[test]
fn surgical_updates_ignore_missing_and_untouched_stored_values() {
    let p = PathPolicy::new(
        "{title}/{date:YYYY}/{date:YYYY-MM-DD}.md",
        vec!["title".into(), "date".into()],
    )
    .unwrap();
    assert_eq!(
        p.update_path(
            "[x] Plan/2025/2026-10-28.md",
            &patch("title", "New").unwrap()
        )
        .unwrap(),
        "New/2025/2026-10-28.md"
    );
    assert_eq!(
        p.update_path(
            "[x] Plan/2025/2026-10-28.md",
            &patch("date", "2027-01-01").unwrap()
        )
        .unwrap(),
        "[x] Plan/2027/2027-01-01.md"
    );
    assert_eq!(
        p.update_path("does-not-match.md", &Map::new()).unwrap(),
        "does-not-match.md"
    );
    let v: Map = [
        ("title".into(), Value::string("New")),
        ("date".into(), Value::string("2027-01-01")),
    ]
    .into_iter()
    .collect();
    assert_eq!(
        p.update_path("does-not-match.md", &v).unwrap(),
        "New/2027/2027-01-01.md"
    );
}

#[test]
fn update_and_document_moves_preserve_type_membership() {
    let mut s = state();
    s.insert_resource("_types/work.md", "---\nkind: mdbase.type\nname: work\nmatch: {path_glob: 'work/*.md'}\nschema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    properties:\n      area: {type: string}\ncollection:\n  path:\n    pattern: '{area}/{x}.md'\n    fields: [area]\n---\n");
    s.insert_record(id(9), "work/a.md", "---\nk: 1\n---\nbody");
    for op in [
        Op::Update(Update {
            id: id(9),
            patch: patch("area", "home"),
            ..Default::default()
        }),
        Op::Document(DocumentOp {
            id: id(9),
            new: Some(DocVersion {
                path: "work/a.md".into(),
                doc: "---\narea: home\nk: 1\n---\nbody".into(),
            }),
            ..Default::default()
        }),
    ] {
        assert_eq!(
            plan(&s, op).unwrap_err().reason.as_deref(),
            Some("type_membership_changed")
        );
    }
}

#[test]
fn resurrect_collisions_allocate_without_dropping_acknowledged_writes() {
    let mut s = state();
    s.insert_record(id(4), "tasks/Taken.md", "body");
    let ops = [
        (create("Old"), id(3), "tasks/Old (2).md"),
        (
            Op::Create(Create {
                id: id(3),
                type_name: Some("task".into()),
                path: Some("tasks/Old.md".into()),
                ..Default::default()
            }),
            id(3),
            "tasks/Old (2).md",
        ),
        (
            Op::Create(Create {
                id: id(3),
                type_name: Some("task".into()),
                path: Some("tasks/Old.md".into()),
                frontmatter: patch("title", "Old"),
                ..Default::default()
            }),
            id(3),
            "tasks/Old (2).md",
        ),
        (
            Op::Update(Update {
                id: id(1),
                patch: patch("title", "Taken"),
                ..Default::default()
            }),
            id(1),
            "tasks/Taken (2).md",
        ),
        (
            Op::Document(DocumentOp {
                id: id(1),
                new: Some(DocVersion {
                    path: "tasks/Old.md".into(),
                    doc: "---\ntitle: Taken\n---\nnew body".into(),
                }),
                ..Default::default()
            }),
            id(1),
            "tasks/Taken (2).md",
        ),
    ];
    for (op, rid, target) in ops {
        let p = mdbn_core::plan(
            &mutation(op),
            &s,
            &PlanOptions {
                stage: Stage::Resurrect,
            },
        )
        .unwrap();
        assert!(
            !p.issues.iter().any(|i| i.issue.code == "resurrect_skipped"),
            "{p:?}"
        );
        assert!(
            p.issues.iter().any(|i| i.issue.code == "record_renamed"),
            "{p:?}"
        );
        let mut ov = Overlay::new(&s);
        for e in &p.effects {
            ov.apply_effect(e);
        }
        let r = ov.record(&rid).unwrap();
        assert_eq!(r.path, target);
        assert!(!r.source.contains("title:"));
        let c = ov.catalog();
        let doc = Document::parse_at(&r.path, &*r.source);
        let types = c.membership(&r.path, doc.frontmatter()).types;
        assert_eq!(
            c.record_values(&r.path, &types, doc.frontmatter())
                .get("title"),
            Some(&Value::string(
                target
                    .strip_prefix("tasks/")
                    .unwrap()
                    .strip_suffix(".md")
                    .unwrap()
            ))
        );
    }
}

#[test]
fn resurrect_stale_stored_base_merges_and_preserves_other_edits() {
    let s = state();
    let mut fields = patch("title", "New").unwrap();
    fields.insert("status", Value::string("done"));
    let op = Op::Update(Update {
        id: id(1),
        patch: Some(fields),
        base: vec![BaseField {
            key: "title".into(),
            observed: Some(Value::string("Earlier")),
        }],
        ..Default::default()
    });
    let p = mdbn_core::plan(
        &mutation(op),
        &s,
        &PlanOptions {
            stage: Stage::Resurrect,
        },
    )
    .unwrap();
    assert!(
        !p.issues.iter().any(|i| i.issue.code == "resurrect_skipped"),
        "{p:?}"
    );
    assert!(!p.conflicts.is_empty(), "{p:?}");
    assert!(
        p.effects
            .iter()
            .any(|e| matches!(e, Effect::PutRecord { doc, .. } if doc.contains("status: done"))),
        "{p:?}"
    );
}

#[test]
fn nonstored_provisional_membership_runs_path_only_create_lifecycle() {
    let mut s = MemState::new();
    s.insert_resource(
        "mdbase.yaml",
        "spec_version: '0.3.0'\nsettings: {validation: error, explicit_type_keys: []}\n",
    );
    s.insert_resource("_types/note.md", "---\nkind: mdbase.type\nname: note\nmatch: {path_glob: 'notes/*.md'}\nschema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    properties:\n      title: {type: string}\ncollection:\n  path:\n    pattern: 'notes/{title}.md'\n---\n");
    s.insert_resource("_types/stamped.md", "---\nkind: mdbase.type\nname: stamped\nmatch: {path_glob: 'notes/**'}\nschema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    required: [created]\n    properties:\n      created: {type: string}\nlifecycle:\n  on_create:\n    set:\n      created: {now: true}\n---\n");
    let p = plan(
        &s,
        Op::Create(Create {
            id: id(3),
            type_name: Some("note".into()),
            frontmatter: patch("title", "X"),
            ..Default::default()
        }),
    )
    .unwrap();
    assert!(
        matches!(&p.effects[0], Effect::PutRecord { path, doc, .. } if path == "notes/X.md" && doc.contains("created:"))
    );
}

#[test]
fn rename_checks_target_types_not_source_types() {
    let mut s = state();
    let op = Op::Rename(Rename {
        id: id(1),
        from: "tasks/Old.md".into(),
        to: "archive/Old.md".into(),
        ..Default::default()
    });
    assert!(plan(&s, op).is_ok());
    s.insert_resource(
        "_types/task.md",
        &TASK.replace("tasks/{title}.md", "tasks/prefix-{title}.md"),
    );
    let op = Op::Rename(Rename {
        id: id(2),
        from: "ref.md".into(),
        to: "tasks/Bad.md".into(),
        ..Default::default()
    });
    let err = plan(&s, op).unwrap_err();
    assert_eq!(err.reason.as_deref(), Some("path_value_missing"));
    assert_eq!(
        err.details.unwrap().get("field"),
        Some(&Value::string("title"))
    );
}

#[test]
fn ambiguous_written_values_are_rejected_on_all_assignment_paths() {
    let mut s = state();
    s.insert_resource(
        "_types/task.md",
        &TASK.replace("tasks/{title}.md", "tasks/{title} {id}.md"),
    );
    s.insert_record(id(1), "tasks/a b.md", "---\nstatus: open\n---\nbody");
    let mut fields = patch("title", "x y").unwrap();
    fields.insert("id", Value::string("b"));
    for op in [
        Op::Create(Create {
            id: id(3),
            type_name: Some("task".into()),
            frontmatter: Some(fields),
            ..Default::default()
        }),
        Op::Update(Update {
            id: id(1),
            patch: patch("title", "x y"),
            ..Default::default()
        }),
        Op::Document(DocumentOp {
            id: id(1),
            new: Some(DocVersion {
                path: "tasks/a b.md".into(),
                doc: "---\ntitle: x y\n---\nbody".into(),
            }),
            ..Default::default()
        }),
    ] {
        let err = plan(&s, op).unwrap_err();
        assert_eq!(err.reason.as_deref(), Some("path_value_invalid"));
        assert_eq!(
            err.details.unwrap().get("field"),
            Some(&Value::string("title"))
        );
    }
    let p = PathPolicy::new("{title} {id}.md", vec!["title".into()]).unwrap();
    assert_eq!(
        p.update_path("a b.md", &patch("title", "x y").unwrap())
            .unwrap_err()
            .code(),
        "path_value_invalid"
    );
}

#[test]
fn formats_require_tokens_even_for_nonstored_fields() {
    assert!(PathPolicy::new("{d:x}.md", vec![]).is_err());
    let mut s = state();
    s.insert_resource(
        "_types/task.md",
        &TASK
            .replace("tasks/{title}.md", "tasks/{title:x}.md")
            .replace("    fields: [title]\n", ""),
    );
    assert!(
        s.catalog()
            .issues()
            .iter()
            .any(|i| i.code == "invalid_type")
    );
}

#[test]
fn portable_names_are_checked_on_resulting_segments_not_bare_values() {
    let mut s = state();
    s.insert_resource(
        "_types/task.md",
        &TASK.replace("tasks/{title}.md", "tasks/{id} {title}.md"),
    );
    let mut fields = patch("title", "nul").unwrap();
    fields.insert("id", Value::string("A1"));
    let p = plan(
        &s,
        Op::Create(Create {
            id: id(3),
            type_name: Some("task".into()),
            frontmatter: Some(fields),
            ..Default::default()
        }),
    )
    .unwrap();
    assert!(matches!(&p.effects[0], Effect::PutRecord { path, .. } if path == "tasks/A1 nul.md"));
    s.insert_resource("_types/task.md", TASK);
    for title in ["CON", "nul.txt", "LPT¹", &"a".repeat(256)] {
        let err = plan(&s, create(title)).unwrap_err();
        assert_eq!(err.reason.as_deref(), Some("path_value_invalid"));
        assert_eq!(
            err.details.unwrap().get("field"),
            Some(&Value::string("title"))
        );
    }
}

#[test]
fn duplicate_frontmatter_warning_is_reported_once_per_stored_field() {
    let mut s = state();
    s.insert_resource(
        "_types/other.md",
        &TASK.replace("name: task", "name: other"),
    );
    let c = s.catalog();
    let raw = patch("title", "ignored").unwrap();
    let types = c.membership("tasks/Old.md", &raw).types;
    assert_eq!(types.len(), 2);
    let (_, issues) = c.record_values_with_issues("tasks/Old.md", &types, &raw);
    assert_eq!(
        issues
            .iter()
            .filter(|i| i.code == "path_field_in_frontmatter")
            .count(),
        1
    );
}

#[test]
fn updating_one_stored_field_preserves_another_inconsistent_field() {
    let mut s = state();
    s.insert_resource(
        "_types/task.md",
        &TASK
            .replace("tasks/{title}.md", "tasks/{title}-{tag}-{tag}.md")
            .replace(
                "title: {type: string}",
                "title: {type: string}\n      tag: {type: string}",
            )
            .replace("fields: [title]", "fields: [title, tag]"),
    );
    s.insert_record(id(1), "tasks/[x]-a-b.md", "---\nstatus: open\n---\nbody");
    for op in [
        Op::Update(Update {
            id: id(1),
            patch: patch("title", "New"),
            ..Default::default()
        }),
        Op::Document(DocumentOp {
            id: id(1),
            new: Some(DocVersion {
                path: "tasks/[x]-a-b.md".into(),
                doc: "---\ntitle: New\nstatus: open\n---\nbody".into(),
            }),
            ..Default::default()
        }),
    ] {
        let p = plan(&s, op).unwrap();
        assert!(
            matches!(&p.effects[0], Effect::PutRecord { path, doc, .. }
            if path == "tasks/New-a-b.md" && !doc.contains("title:") && !doc.contains("tag:")),
            "{p:?}"
        );
    }
}

#[test]
fn resurrect_rename_suffix_is_an_observation_not_an_assignment() {
    let mut s = state();
    s.insert_resource("_types/daily.md", DAILY);
    s.insert_record(id(9), "Daily/2026/2026-01-01.md", "body");
    s.insert_record(id(10), "Daily/2026/2026-01-02.md", "taken");
    let op = Op::Rename(Rename {
        id: id(9),
        from: "Daily/2026/2026-01-01.md".into(),
        to: "Daily/2026/2026-01-02.md".into(),
        ..Default::default()
    });
    let p = mdbn_core::plan(
        &mutation(op),
        &s,
        &PlanOptions {
            stage: Stage::Resurrect,
        },
    )
    .unwrap();
    assert!(
        matches!(&p.effects[0], Effect::PutRecord { path, .. } if path == "Daily/2026/2026-01-02 (2).md"),
        "{p:?}"
    );
    assert!(!p.issues.iter().any(|i| i.issue.code == "resurrect_skipped"));
}

#[test]
fn invalid_segment_reports_the_field_in_that_segment() {
    let p = PathPolicy::new("{area}/{title}.md", vec!["area".into(), "title".into()]).unwrap();
    let values: Map = [
        ("area".into(), Value::string("tasks")),
        ("title".into(), Value::string("CON")),
    ]
    .into_iter()
    .collect();
    let e = p.derive(&values).unwrap_err();
    assert_eq!(e.code(), "path_value_invalid");
    assert_eq!(e.field(), Some("title"));
}
