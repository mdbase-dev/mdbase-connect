use super::*;
use crate::{value::Value, yaml};

fn fixture() -> Value {
    yaml::parse_value(include_str!(
        "../../../../tests/data/obsidian-bases-oracle.json"
    ))
    .unwrap()
    .unwrap()
}
fn expected<'a>(fixture: &'a Value, name: &str) -> &'a Value {
    fixture
        .get("cases")
        .unwrap()
        .as_list()
        .unwrap()
        .iter()
        .find(|v| v.get("name").and_then(Value::as_str) == Some(name))
        .unwrap()
        .get("expected")
        .unwrap()
}

#[test]
fn file_scalar_helpers_match_unchanged_oracle_and_bases_name_is_basename() {
    let fixture = fixture();
    let file = fixture.get("context").unwrap().get("file").unwrap();
    let mut budget = WorkBudget::new();
    let value = CapturedFile::new(
        file.get("path").unwrap().as_str().unwrap(),
        Some(1957),
        None,
        None,
        &mut budget,
    )
    .unwrap();
    for (name, actual) in [
        ("file name", value.basename()),
        ("file basename", value.basename()),
        ("file path", value.path()),
        ("file folder", value.folder()),
        ("file ext", value.extension()),
    ] {
        assert_eq!(&Value::string(actual), expected(&fixture, name), "{name}");
    }
    assert_eq!(value.filename(), "row.md");
    assert_eq!(
        &Value::Int(i64::try_from(value.size(&mut budget).unwrap()).unwrap()),
        expected(&fixture, "file size")
    );
    for (name, display) in [
        ("file as link", None),
        ("file as link display", Some("Shown")),
    ] {
        assert_eq!(
            &Value::string(
                value
                    .as_link(display, &mut budget)
                    .unwrap()
                    .render(&mut budget)
                    .unwrap()
            ),
            expected(&fixture, name)
        );
    }
    assert_eq!(
        &Value::Bool(
            value
                .in_folder("__codex_bases_expression_oracle/", &mut budget)
                .unwrap()
        ),
        expected(&fixture, "file in folder")
    );
    let tags = vec!["urgent".into(), "work".into(), "project/a".into()];
    for (name, needle) in [
        ("file has tag direct", "#work"),
        ("file has tag nested", "project"),
    ] {
        assert_eq!(
            &Value::Bool(CapturedFile::has_tag(&tags, &[needle.into()], &mut budget).unwrap()),
            expected(&fixture, name)
        );
    }
}

#[test]
fn captured_link_render_and_resolution_matrices_match_original_oracle() {
    let fixture = fixture();
    let file = fixture.get("context").unwrap().get("file").unwrap();
    for (field, rendered, resolved) in [
        (
            "links",
            "file links rendered matrix",
            Some("file links as files matrix"),
        ),
        (
            "embeds",
            "file embeds rendered matrix",
            Some("file embeds as files matrix"),
        ),
        ("backlinks", "file backlinks rendered matrix", None),
    ] {
        let mut budget = WorkBudget::new();
        let mut strings = Vec::new();
        let mut targets = Vec::new();
        for entry in file.get(field).unwrap().as_list().unwrap() {
            let path = entry.get("path").unwrap().as_str().unwrap();
            let resolution = match entry.get("resolvedPath") {
                Some(Value::Text(s)) => LinkResolution::Resolved(s),
                Some(Value::Null) => LinkResolution::Unresolved,
                _ => panic!("explicit fixture resolution"),
            };
            let link = CapturedLink::from_parts(
                path,
                entry.get("display").and_then(Value::as_str),
                resolution,
                &mut budget,
            )
            .unwrap();
            strings.push(Value::string(link.render(&mut budget).unwrap()));
            targets.push(
                link.resolved_path(&mut budget)
                    .unwrap()
                    .map(Value::string)
                    .unwrap_or(Value::Null),
            );
        }
        assert_eq!(
            &Value::List(strings),
            expected(&fixture, rendered),
            "{field}"
        );
        if let Some(name) = resolved {
            assert_eq!(&Value::List(targets), expected(&fixture, name), "{field}");
        }
    }
    let mut budget = WorkBudget::new();
    for (name, text, display) in [
        ("link stringify", "Some Note", None),
        ("link with display stringify", "Some Note", Some("Shown")),
    ] {
        let link =
            CapturedLink::parse(text, display, LinkResolution::Unresolved, &mut budget).unwrap();
        assert_eq!(
            &Value::string(link.render(&mut budget).unwrap()),
            expected(&fixture, name)
        );
    }
}

#[test]
fn captured_resolved_identity_and_broken_raw_matching_are_distinct() {
    let mut budget = WorkBudget::new();
    let a = CapturedLink::parse(
        "[[Other#Heading|Alias]]",
        None,
        LinkResolution::Resolved("Folder/Other.md"),
        &mut budget,
    )
    .unwrap();
    let b = CapturedLink::parse(
        "Other.md",
        Some("Other"),
        LinkResolution::Resolved("Folder/Other.md"),
        &mut budget,
    )
    .unwrap();
    assert!(a.equals(&b, &mut budget).unwrap());
    assert!(a.matches(&b, &mut budget).unwrap());
    let missing =
        CapturedLink::parse("Missing", None, LinkResolution::Unresolved, &mut budget).unwrap();
    assert!(missing.matches(&missing, &mut budget).unwrap());
    let other =
        CapturedLink::parse("Missing.md", None, LinkResolution::Unresolved, &mut budget).unwrap();
    assert!(!missing.matches(&other, &mut budget).unwrap());
    assert_eq!(missing.resolved_path(&mut budget).unwrap(), None);
    let mut budget = WorkBudget::new();
    let unknown =
        CapturedLink::parse("Other", None, LinkResolution::Unavailable, &mut budget).unwrap();
    assert_eq!(
        unknown.resolved_path(&mut budget),
        Err(EvaluationFailure::MetadataUnavailable("link_resolution"))
    );
    assert!(unknown.render(&mut budget).is_err());
}

#[test]
fn file_facts_never_fall_back_to_stat_ctime_zero_or_epoch() {
    let mut budget = WorkBudget::new();
    let zone = BasesTimezone::capture("UTC", &mut budget).unwrap();
    let observed = CapturedFile::new(
        "folder/a.md",
        Some(0),
        Some(CreationObservation::FirstCreateLog(0)),
        Some(1_781_075_828_070),
        &mut budget,
    )
    .unwrap();
    assert_eq!(observed.created(zone, &mut budget).unwrap().millis(), 0); // real observation, not a default
    assert_eq!(
        observed.modified(zone, &mut budget).unwrap().millis(),
        1_781_075_828_070
    );
    let imported = CapturedFile::new(
        "a.md",
        None,
        Some(CreationObservation::ImportedBirth(12345)),
        None,
        &mut budget,
    )
    .unwrap();
    assert_eq!(imported.created(zone, &mut budget).unwrap().millis(), 12345);
    for action in ["size", "ctime", "mtime"] {
        let mut budget = WorkBudget::new();
        let absent = CapturedFile::new("a.md", None, None, None, &mut budget).unwrap();
        let err = match action {
            "size" => absent.size(&mut budget).unwrap_err(),
            "ctime" => absent.created(zone, &mut budget).unwrap_err(),
            _ => absent.modified(zone, &mut budget).unwrap_err(),
        };
        assert_eq!(err.code(), "view_metadata_unavailable");
        assert_eq!(Some(err), budget.failure());
    }
}

#[test]
fn paths_and_folder_tag_boundaries_preserve_exact_names() {
    let mut budget = WorkBudget::new();
    let file = CapturedFile::new("Unicode/Über.v2.md", None, None, None, &mut budget).unwrap();
    assert_eq!(file.basename(), "Über.v2");
    assert!(!file.in_folder("Uni", &mut budget).unwrap());
    assert!(file.in_folder("Unicode/", &mut budget).unwrap());
    assert!(
        !CapturedFile::has_tag(&["projectile/a".into()], &["project".into()], &mut budget).unwrap()
    );
    for path in ["/a.md", "../a.md", "a/../b.md", "a//b.md", "a\\b.md", ""] {
        assert!(CapturedFile::new(path, None, None, None, &mut WorkBudget::new()).is_err());
    }
    assert!(
        CapturedFile::new(
            "a.md",
            Some(9_007_199_254_740_992),
            None,
            None,
            &mut WorkBudget::new()
        )
        .is_err()
    );
}

#[test]
fn source_bounds_and_prior_resource_failures_are_sticky_across_calls() {
    let mut budget = WorkBudget::constrained(1, 100);
    assert!(CapturedLink::parse("abc", None, LinkResolution::Unavailable, &mut budget).is_err());
    assert!(CapturedFile::has_tag(&[], &[], &mut budget).is_err());
    assert!(CapturedFile::new("x.md", None, None, None, &mut budget).is_err());
    let mut budget = WorkBudget::new();
    let oversized = "x".repeat(MAX_CAPTURE_TEXT_BYTES + 1);
    assert_eq!(
        CapturedLink::parse(&oversized, None, LinkResolution::Unavailable, &mut budget)
            .unwrap_err(),
        EvaluationFailure::BudgetExceeded("capture_text_bytes")
    );
    assert!(CapturedLink::parse("x", None, LinkResolution::Resolved("x.md"), &mut budget).is_err());
    let mut budget = WorkBudget::constrained(10, 1000);
    budget.fail(EvaluationFailure::Cancelled);
    assert_eq!(
        CapturedFile::new("x.md", None, None, None, &mut budget).unwrap_err(),
        EvaluationFailure::Cancelled
    );
}

#[test]
fn link_wrappers_alias_override_and_external_render_remain_separate() {
    let mut budget = WorkBudget::new();
    let a = CapturedLink::parse(
        " ![[Folder/Note#H|old]] ",
        Some("new"),
        LinkResolution::Resolved("Folder/Note.md"),
        &mut budget,
    )
    .unwrap();
    assert_eq!(a.path(), "Folder/Note#H");
    assert_eq!(a.render(&mut budget).unwrap(), "[[Folder/Note#H|new]]");
    let external = CapturedLink::parse(
        "https://example.com/path",
        Some("Label"),
        LinkResolution::Unresolved,
        &mut budget,
    )
    .unwrap();
    assert!(external.is_external());
    assert_eq!(
        external.render(&mut budget).unwrap(),
        "https://example.com/path"
    );
    assert!(
        !CapturedLink::parse(
            "1scheme:path",
            None,
            LinkResolution::Unresolved,
            &mut budget
        )
        .unwrap()
        .is_external()
    );
    assert!(
        CapturedLink::parse(
            "\u{85}Note",
            None,
            LinkResolution::Unavailable,
            &mut WorkBudget::new()
        )
        .is_err()
    );
}
