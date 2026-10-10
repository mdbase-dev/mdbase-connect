use super::*;
use crate::doc::RecordFormat;
#[test]
fn independent_native_matrix_qualified_domain_is_exact() {
    check_native_matrix(include_str!(
        "../../../../../../conformance/oracle/obsidian-1.12.7/common-tags.observed.json"
    ));
}
#[test]
fn repeated_native_checkbox_and_unmodified_perf_corpus_tags_are_exact() {
    check_native_matrix(include_str!(
        "../../../../../../conformance/oracle/obsidian-1.12.7/checkbox-tags.observed.json"
    ));
}
#[test]
fn repeated_native_plain_fences_and_real_corpus_tags_are_exact() {
    check_native_matrix(include_str!(
        "../../../../../../conformance/oracle/obsidian-1.12.7/plain-fence-tags.observed.json"
    ));
}
#[test]
fn code_skip_is_complete_and_richer_or_tag_bearing_code_stays_unavailable() {
    let d = Document::parse("#alpha\n```\n[[bad\n```\n#after", RecordFormat::Markdown);
    assert_eq!(
        capture_source_tags(&d, &mut WorkBudget::new()).unwrap(),
        Some(vec!["#alpha".into(), "#after".into()])
    );
    for body in [
        "#alpha\n```ts\nlet x=1;\n```",
        "#alpha\n```\n#hidden\n```",
        "#alpha\n```\nunterminated",
    ] {
        let d = Document::parse(body, RecordFormat::Markdown);
        assert_eq!(
            capture_source_tags(&d, &mut WorkBudget::new()).unwrap(),
            None
        );
    }
}
fn check_native_matrix(source: &str) {
    let fixture = crate::yaml::parse_value(source).unwrap().unwrap();
    for case in fixture.get("cases").unwrap().as_list().unwrap() {
        let source = format!(
            "---\ntags: {}\n---\n{}",
            case.get("raw_tags").unwrap().to_json(),
            case.get("body").unwrap().as_str().unwrap()
        );
        let document = Document::parse(&source, RecordFormat::Markdown);
        let got = capture_source_tags(&document, &mut WorkBudget::new()).unwrap();
        let id = case.get("id").unwrap().as_str().unwrap();
        if case.get("qualified").unwrap().as_bool().unwrap() {
            let want: Vec<String> = case
                .get("tags")
                .unwrap()
                .as_list()
                .unwrap()
                .iter()
                .map(|tag| tag.as_str().unwrap().to_owned())
                .collect();
            assert_eq!(got, Some(want), "native case {id}");
        } else {
            assert_eq!(got, None, "unqualified native case {id}");
        }
    }
}
#[test]
fn marker_extension_does_not_qualify_links_references_or_arbitrary_brackets() {
    for body in [
        "[x](https://invalid/) #task",
        "[ ](#fake) #task",
        "[x][ref] #task",
        "[ x ] #task",
        "[[bad #task",
        "- [ ] `#fake` #task",
    ] {
        let document = Document::parse(body, RecordFormat::Markdown);
        assert_eq!(
            capture_source_tags(&document, &mut WorkBudget::new()).unwrap(),
            None,
            "{body}"
        );
    }
    assert_eq!(BASES_TAG_CAPTURE_VERSION, 3);
}
#[test]
fn body_tags_precede_raw_tags_without_rewriting_note_values() {
    let document = Document::parse(
        "---\ntags: [task, task, work/sub]\n---\nBody #other #task",
        RecordFormat::Markdown,
    );
    let raw = document.frontmatter().clone();
    assert_eq!(
        capture_source_tags(&document, &mut WorkBudget::new()).unwrap(),
        Some(vec!["#other".into(), "#task".into(), "#work/sub".into()])
    );
    assert_eq!(document.frontmatter(), &raw);
}
#[test]
fn heading_links_no_tags_known_empty_and_unknown_are_distinct() {
    for (source, want) in [
        ("[[note#heading]]", Some(vec![])),
        ("# Heading\nPlain body", Some(vec![])),
        ("Body #other", Some(vec!["#other".into()])),
        ("```\n#other\n```", None),
        ("[[bad #task", None),
        ("Body #café", None),
    ] {
        assert_eq!(
            capture_source_tags(
                &Document::parse(source, RecordFormat::Markdown),
                &mut WorkBudget::new()
            )
            .unwrap(),
            want
        );
    }
}
#[test]
fn exhausted_scan_copy_and_dedup_work_are_sticky() {
    let document = Document::parse("---\ntags: [task]\n---\n#other", RecordFormat::Markdown);
    for mut budget in [
        WorkBudget::constrained(1, 1 << 20),
        WorkBudget::constrained(2_000_000, 0),
    ] {
        let failure = capture_source_tags(&document, &mut budget).err().unwrap();
        assert_eq!(budget.failure(), Some(failure));
        assert_eq!(
            capture_source_tags(&document, &mut budget).err(),
            Some(failure)
        );
    }
}
