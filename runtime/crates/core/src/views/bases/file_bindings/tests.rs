use super::*;
use crate::{
    value::{Map, Value},
    views::bases::{BasesTimezone, Bindings, CapturedClock, CreationObservation, Profile, Program},
};
use std::collections::BTreeMap;
fn eval(
    source: &str,
    note: &Map,
    tags: Option<&[String]>,
    created: Option<CreationObservation>,
    modified: Option<i64>,
) -> Result<super::super::RuntimeValue, EvaluationFailure> {
    let mut budget = WorkBudget::new();
    let zone = BasesTimezone::capture("UTC", &mut budget).unwrap();
    let clock = CapturedClock::new(1781075828070, zone, &mut budget).unwrap();
    let file =
        CapturedFile::new("Tasks/My task.md", Some(42), created, modified, &mut budget).unwrap();
    let facts = CapturedFileBindings::capture(&file, tags, &mut budget)?;
    Program::compile_with_profile(source, &BTreeMap::new(), Profile::TaskSlice1)
        .unwrap()
        .evaluate(
            Bindings::raw(note).with_clock(clock).with_file(facts),
            &mut budget,
        )
}
#[test]
fn captured_identity_fields_use_bases_basename_not_core_filename() {
    let actual = eval(
        "[file.path,file.name,file.basename,file.folder,file.ext,file.size]",
        &Map::new(),
        Some(&[]),
        None,
        None,
    )
    .unwrap()
    .to_plain();
    assert_eq!(
        actual,
        Value::List(vec![
            Value::string("Tasks/My task.md"),
            Value::string("My task"),
            Value::string("My task"),
            Value::string("Tasks"),
            Value::string("md"),
            Value::Int(42)
        ])
    );
    assert_eq!(
        eval("file[\"name\"]", &Map::new(), Some(&[]), None, None)
            .unwrap()
            .to_plain(),
        Value::string("My task")
    );
}
#[test]
fn tags_are_explicit_known_empty_or_unavailable_and_do_not_come_from_defaults() {
    let tags = vec!["task/subtask".into(), "work".into()];
    let note = Map::from_iter([(
        "tags".into(),
        Value::List(vec![Value::string("not-file-tags")]),
    )]);
    assert_eq!(eval("[file.hasTag(\"task\"),file.hasTag(\"#work\"),file.hasTag(\"Task\"),file.hasTag(\"missing\",\"work\"),file.tags.length]",&note,Some(&tags),None,None).unwrap().to_plain(),Value::List(vec![Value::Bool(true),Value::Bool(true),Value::Bool(false),Value::Bool(true),Value::Int(2)]));
    assert_eq!(
        eval("file.hasTag(\"task\")", &note, Some(&[]), None, None)
            .unwrap()
            .to_plain(),
        Value::Bool(false)
    );
    assert_eq!(
        eval("file.hasTag(\"task\")", &note, None, None, None).unwrap_err(),
        EvaluationFailure::MetadataUnavailable("file_tags_not_captured")
    );
    assert_eq!(
        eval("file.hasTag()", &note, None, None, None)
            .unwrap()
            .to_plain(),
        Value::Bool(false)
    );
}
#[test]
fn property_predicate_uses_actual_raw_presence_and_folder_boundaries() {
    let note = Map::from_iter([
        ("false".into(), Value::Bool(false)),
        ("zero".into(), Value::Int(0)),
        ("empty".into(), Value::string("")),
        ("null".into(), Value::Null),
    ]);
    assert_eq!(eval("[file.hasProperty(\"false\"),file.hasProperty(\"zero\"),file.hasProperty(\"empty\"),file.hasProperty(\"null\"),file.hasProperty(\"missing\"),file.inFolder(\"Tasks/\"),file.inFolder(\"Task\"),file.inFolder(\"\")]",&note,Some(&[]),None,None).unwrap().to_plain(),Value::List(vec![Value::Bool(true),Value::Bool(true),Value::Bool(true),Value::Bool(true),Value::Bool(false),Value::Bool(true),Value::Bool(false),Value::Bool(false)]));
}
#[test]
fn typed_time_fields_use_captured_log_provenance_and_zone_not_fallback_epochs() {
    let created = Some(CreationObservation::FirstCreateLog(1781049600000));
    assert_eq!(
        eval(
            "[file.ctime.format(\"MMM D\"),file.mtime.isType(\"Date\")]",
            &Map::new(),
            Some(&[]),
            created,
            Some(1781049600000)
        )
        .unwrap()
        .to_plain(),
        Value::List(vec![Value::string("Jun 10"), Value::Bool(true)])
    );
    assert_eq!(
        eval("file.ctime", &Map::new(), Some(&[]), None, None).unwrap_err(),
        EvaluationFailure::MetadataUnavailable("file_ctime")
    );
    assert_eq!(
        eval("file.mtime", &Map::new(), Some(&[]), None, None).unwrap_err(),
        EvaluationFailure::MetadataUnavailable("file_mtime")
    );
}
#[test]
fn explicit_profile_preserves_old_profiles_and_refuses_graph_bare_or_dynamic_files() {
    for source in [
        "file.tasks",
        "file.links",
        "file.asLink()",
        "file.hasLink(\"Other\")",
        "file.properties.status",
        "file(note.title)",
        "file",
        "file[note.key]",
    ] {
        assert!(
            Program::compile_with_profile(source, &BTreeMap::new(), Profile::TaskSlice1).is_err(),
            "{source}"
        );
    }
    assert!(
        Program::compile_with_profile("file.hasTag(\"task\")", &BTreeMap::new(), Profile::Slice1)
            .is_err()
    );
    let p = Program::compile_with_profile(
        "false && file.hasTag(\"task\")",
        &BTreeMap::new(),
        Profile::TaskSlice1,
    )
    .unwrap();
    let mut budget = WorkBudget::new();
    assert_eq!(
        p.evaluate(Bindings::raw(&Map::new()), &mut budget)
            .unwrap_err(),
        EvaluationFailure::MetadataUnavailable("file_metadata_not_captured")
    );
}
#[test]
fn unqualified_casts_prefixes_and_capture_limits_stay_typed_refusals() {
    for source in [
        "file.hasTag(3)",
        "file.hasTag(\"##task\")",
        "file.hasProperty()",
        "file.inFolder(false)",
    ] {
        assert!(matches!(
            eval(source, &Map::new(), Some(&[]), None, None),
            Err(EvaluationFailure::UnsupportedConstruct(_))
        ));
    }
    let mut b = WorkBudget::new();
    let file = CapturedFile::new("x.md", None, None, None, &mut b).unwrap();
    let tags = vec!["x".into(); MAX_CAPTURE_ITEMS + 1];
    assert!(matches!(
        CapturedFileBindings::capture(&file, Some(&tags), &mut b),
        Err(EvaluationFailure::BudgetExceeded("file_tag_count"))
    ));
}
