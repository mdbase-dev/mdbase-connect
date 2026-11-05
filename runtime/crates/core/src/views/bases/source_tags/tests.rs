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
fn code_skip_is_complete_including_info_strings_and_tag_bearing_code() {
    let d = Document::parse("#alpha\n```\n[[bad\n```\n#after", RecordFormat::Markdown);
    assert_eq!(
        capture_source_tags(&d, &mut WorkBudget::new()).unwrap(),
        Some(exact(&["#alpha", "#after"]))
    );
    for body in [
        "#alpha\n```ts\nlet x=1;\n```",
        "#alpha\n```\n#hidden\n```",
        "#alpha\n```\nunterminated",
    ] {
        let d = Document::parse(body, RecordFormat::Markdown);
        assert_eq!(
            capture_source_tags(&d, &mut WorkBudget::new()).unwrap(),
            Some(exact(&["#alpha"]))
        );
    }
}
#[test]
fn every_native_body_observation_is_bounded_and_exact_results_are_equal() {
    let fixture = crate::yaml::parse_value(include_str!(
        "../../../../../../conformance/oracle/obsidian-1.12.7/body-tags.observed.json"
    ))
    .unwrap()
    .unwrap();
    let mut exact = 0;
    let cases = fixture.get("cases").unwrap().as_list().unwrap();
    for case in cases {
        let source = case.get("source").unwrap().as_str().unwrap();
        let want: Vec<&str> = case
            .get("tags")
            .unwrap()
            .as_list()
            .unwrap()
            .iter()
            .map(|tag| tag.as_str().unwrap())
            .collect();
        exact += usize::from(check_native(source, &want));
    }
    // Most of the matrix is a deliberate sweep of delimiter positions. This
    // floor stops the scan quietly declining what it qualifies today.
    assert!(exact >= 150, "{exact}/{}", cases.len());
}
// A bound holds every native tag, including one wrapped in emphasis. An exact
// result must equal the native set. Returns whether the result was exact.
fn check_native(source: &str, want: &[&str]) -> bool {
    let document = Document::parse(source, RecordFormat::Markdown);
    let got = capture_source_tags(&document, &mut WorkBudget::new())
        .unwrap()
        .unwrap();
    for tag in want {
        assert!(
            got.spellings().iter().any(|spelled| spelled == tag),
            "{source:?} must bound {tag}: {got:?}"
        );
    }
    if let Some(known) = got.known() {
        assert_eq!(known, want, "exact result for {source:?}");
    }
    got.is_exact()
}
fn check_native_matrix(source: &str) {
    let fixture = crate::yaml::parse_value(source).unwrap().unwrap();
    for case in fixture.get("cases").unwrap().as_list().unwrap() {
        let source = format!(
            "---\ntags: {}\n---\n{}",
            case.get("raw_tags").unwrap().to_json(),
            case.get("body").unwrap().as_str().unwrap()
        );
        let id = case.get("id").unwrap().as_str().unwrap();
        let want: Vec<&str> = case
            .get("tags")
            .unwrap()
            .as_list()
            .unwrap()
            .iter()
            .map(|tag| tag.as_str().unwrap())
            .collect();
        // Historical qualification is a floor; later versions may exceed it.
        let exact = check_native(&source, &want);
        assert!(
            exact || !case.get("qualified").unwrap().as_bool().unwrap(),
            "native case {id}"
        );
    }
}
fn capture(source: &str) -> SourceTags {
    let document = Document::parse(source, RecordFormat::Markdown);
    capture_source_tags(&document, &mut WorkBudget::new())
        .unwrap()
        .unwrap()
}
fn exact(tags: &[&str]) -> SourceTags {
    SourceTags::exact(tags.iter().map(|tag| (*tag).into()).collect())
}
fn bounded(tags: &[&str]) -> SourceTags {
    SourceTags::bounded(tags.iter().map(|tag| (*tag).into()).collect())
}
#[test]
fn reported_references_are_native_tags_and_fragments_are_not() {
    assert_eq!(
        capture("verified healthy in #16/#18; `code` [x](target)"),
        exact(&["#16/"])
    );
    assert_eq!(
        capture("Linked #400, #1115, #914/#926, #1403, and the #226\u{2192}#264 rollback. *Done*"),
        exact(&["#914/", "#226\u{2192}"])
    );
    assert_eq!(
        capture("[a](https://x.invalid/#overview) https://x.invalid/a#issuecomment-1 **b** #real"),
        exact(&["#real"])
    );
}
#[test]
fn links_and_emphasis_do_not_hide_a_tag_after_whitespace() {
    for body in [
        "[x](https://invalid/) #task",
        "[x][ref] #task",
        "[ ](#fake) #task",
        "[ x ] #task",
        "**bold #task**",
        "> quote #task",
        "~~gone~~ #task",
    ] {
        assert_eq!(capture(body), exact(&["#task"]), "{body}");
    }
}
#[test]
fn unmodelled_positions_bound_their_spellings_without_claiming_them() {
    for (body, want) in [
        ("[[bad #task", bounded(&["#task"])),
        ("**#task**", bounded(&["#task"])),
        ("*#task", bounded(&["#task"])),
        ("<div>\n#task\n</div>", bounded(&["#task"])),
        ("<!-- #task -->", bounded(&["#task"])),
        ("$x #task$", bounded(&["#task"])),
        ("    #task", bounded(&["#task"])),
        ("[a]:\n#task", bounded(&["#task"])),
        ("> ```\n> #task\n> ```", bounded(&["#task"])),
        ("_x #task_ y", bounded(&["#task", "#task_"])),
    ] {
        assert_eq!(capture(body), want, "{body}");
    }
    assert_eq!(BASES_TAG_CAPTURE_VERSION, 5);
}
#[test]
fn unqualified_frontmatter_bounds_its_values_and_source_problems_stay_unavailable() {
    for (source, want) in [
        ("---\ntags: [task, 5]\n---\n", bounded(&["#task"])),
        ("---\ntags: 5\n---\n", bounded(&[])),
        ("---\ntags: 'task work'\n---\n", bounded(&["#task work"])),
        ("---\ntags: [caf\u{e9}]\n---\n", bounded(&["#caf\u{e9}"])),
        ("---\nTags: task\n---\n", bounded(&["#task"])),
        ("---\ntags: ['##task']\n---\n", bounded(&["#task"])),
    ] {
        assert_eq!(capture(source), want, "{source}");
    }
    let broken = Document::parse("---\nbad: [\n---\n", RecordFormat::Markdown);
    assert!(broken.problem().is_some());
    assert_eq!(
        capture_source_tags(&broken, &mut WorkBudget::new()).unwrap(),
        None
    );
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
        Some(exact(&["#other", "#task", "#work/sub"]))
    );
    assert_eq!(document.frontmatter(), &raw);
}
#[test]
fn heading_links_no_tags_known_empty_and_unknown_are_distinct() {
    for (source, want) in [
        ("[[note#heading]]", exact(&[])),
        ("# Heading\nPlain body", exact(&[])),
        ("Body #other", exact(&["#other"])),
        ("Body #caf\u{e9}", exact(&["#caf\u{e9}"])),
        ("```\n#other\n```", exact(&[])),
        ("[[bad #task", bounded(&["#task"])),
    ] {
        assert_eq!(capture(source), want, "{source}");
    }
}
#[test]
fn code_and_numeric_references_do_not_hide_real_tags() {
    for body in [
        "Private `#cppLive` PR #123 #task",
        "Private ``a ` #cppLive`` PR #123 #task",
        "- [ ] `#fake` #task",
        "#task\n  ~~~~rust\n#hidden\n  ~~~~~\n",
        "#task\n```rust\n#hidden\n```\n",
        "#task\n```\n#hidden",
    ] {
        assert_eq!(capture(body), exact(&["#task"]), "{body}");
    }
    for body in [
        "PR #123 *reference*",
        "`#cppLive` #123",
        "```rust\n#task\n```",
    ] {
        assert_eq!(capture(body), exact(&[]), "{body}");
    }
    assert_eq!(capture("`\n\n#task\n`"), exact(&["#task"]));
    assert_eq!(capture("\\`#task`"), bounded(&["#task"]));
    assert_eq!(capture("``#task`"), bounded(&["#task"]));
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
