//! Writer format fidelity (spec 12A): one test per rule, plus the fallbacks.

use mdbn_core::doc::{Document, RecordFormat};
use mdbn_core::value::{Map, Value};
use mdbn_core::writer::{Change, WriteError, entry_copy, render_new, write};

fn md(s: &str) -> Document {
    Document::parse(s, RecordFormat::Markdown)
}

fn set(k: &str, v: Value) -> (String, Change) {
    (k.to_owned(), Change::Set(v))
}

fn list(items: &[&str]) -> Value {
    Value::List(items.iter().map(|s| Value::string(*s)).collect())
}

fn apply(src: &str, changes: &[(String, Change)]) -> String {
    let out = write(&md(src), changes, None).unwrap();
    // Every write reads back as intended.
    let d = md(&out);
    assert!(d.problem().is_none(), "{out}");
    out
}

const SRC: &str = "---\n# Task\ntitle: 'Fix login'   # quoted on purpose\nstatus: open\ntags: [a, b]\nblocked:\n  - x\n  - y\n\n# timestamps\ndateModified: 2026-10-01T00:00:00Z\n---\nBody line\n";

#[test]
fn unchanged_entries_stay_byte_identical() {
    let out = apply(SRC, &[set("status", Value::string("done"))]);
    assert_eq!(out, SRC.replace("status: open", "status: done"));
}

#[test]
fn noop_write_is_identity() {
    assert_eq!(apply(SRC, &[set("status", Value::string("open"))]), SRC);
    assert_eq!(apply(SRC, &[("missing".into(), Change::Remove)]), SRC);
    assert_eq!(write(&md(SRC), &[], None).unwrap(), SRC);
}

#[test]
fn quoting_and_trailing_comment_are_kept() {
    let out = apply(SRC, &[set("title", Value::string("It's fixed"))]);
    assert!(
        out.contains("title: 'It''s fixed'   # quoted on purpose\n"),
        "{out}"
    );
}

#[test]
fn flow_stays_flow_and_block_stays_block() {
    let out = apply(
        SRC,
        &[
            set("tags", list(&["a", "c, d"])),
            set("blocked", list(&["z"])),
        ],
    );
    assert!(out.contains("tags: [a, \"c, d\"]\n"), "{out}");
    assert!(out.contains("blocked:\n  - z\n\n# timestamps\n"), "{out}");
}

#[test]
fn compact_block_sequences_keep_their_indentation() {
    let out = apply(
        "---\ntags:\n- a\nx: 1\n---\n",
        &[set("tags", list(&["b", "c"]))],
    );
    assert_eq!(out, "---\ntags:\n- b\n- c\nx: 1\n---\n");
}

#[test]
fn removing_an_entry_removes_only_its_lines() {
    let out = apply(SRC, &[("blocked".into(), Change::Remove)]);
    assert_eq!(out, SRC.replace("blocked:\n  - x\n  - y\n", ""));
}

#[test]
fn new_keys_go_after_the_last_entry() {
    let src = "---\ntitle: Item   # name\nscore: 1\n# end of fields\n---\nBody.\n";
    let out = apply(
        src,
        &[set("owner", Value::string("bo")), set("n", Value::int(2))],
    );
    assert_eq!(
        out,
        "---\ntitle: Item   # name\nscore: 1\nowner: bo\nn: 2\n# end of fields\n---\nBody.\n"
    );
}

#[test]
fn bom_crlf_delimiters_and_body_are_kept() {
    let src = "\u{feff}---\r\na: 1\r\nb: x\r\n---\r\nbody\r\n";
    let out = apply(src, &[set("b", Value::string("y")), set("c", list(&["p"]))]);
    assert_eq!(
        out,
        "\u{feff}---\r\na: 1\r\nb: y\r\nc: [p]\r\n---\r\nbody\r\n"
    );
}

#[test]
fn body_replacement_keeps_frontmatter_bytes() {
    let d = md(SRC);
    let out = write(&d, &[], Some("New body\n")).unwrap();
    assert_eq!(out, SRC.replace("Body line\n", "New body\n"));
}

#[test]
fn a_document_without_frontmatter_gains_a_block() {
    let out = apply("just body\n", &[set("a", Value::int(1))]);
    assert_eq!(out, "---\na: 1\n---\njust body\n");
    let out = apply("\u{feff}just body\r\n", &[set("a", Value::int(1))]);
    assert_eq!(out, "\u{feff}---\r\na: 1\r\n---\r\njust body\r\n");
}

#[test]
fn invalid_frontmatter_rejects_structured_updates() {
    let d = md("---\n- a\n---\nx\n");
    assert_eq!(
        write(&d, &[set("a", Value::int(1))], None),
        Err(WriteError::InvalidFrontmatter("non_mapping_frontmatter"))
    );
    // A body-only write is still possible.
    assert_eq!(write(&d, &[], Some("y\n")).unwrap(), "---\n- a\n---\ny\n");
}

#[test]
fn copies_are_verbatim_and_convert_line_endings() {
    let other = md("---\r\nstatus: \"in-progress\" # mine\r\n---\r\n");
    let copy = entry_copy(&other, "status").unwrap();
    assert_eq!(copy.text(), "status: \"in-progress\" # mine\r\n");
    let out = apply(SRC, &[("status".into(), Change::Copy(copy))]);
    assert!(
        out.contains("\nstatus: \"in-progress\" # mine\ntags"),
        "{out}"
    );
}

#[test]
fn aliases_tied_to_a_changed_anchor_are_reemitted() {
    let src = "---\na: &x [1, 2]\nb: *x\nc: keep # me\n---\n";
    let out = apply(src, &[set("a", Value::List(vec![Value::int(3)]))]);
    let d = md(&out);
    assert_eq!(
        d.frontmatter().get("b"),
        Some(&Value::List(vec![Value::int(1), Value::int(2)]))
    );
    assert!(out.contains("c: keep # me\n"), "{out}");
    let out = apply(src, &[("a".into(), Change::Remove)]);
    let d = md(&out);
    assert!(d.frontmatter().get("a").is_none());
    assert_eq!(
        d.frontmatter().get("b"),
        Some(&Value::List(vec![Value::int(1), Value::int(2)]))
    );
}

#[test]
fn integer_and_float_are_distinct_for_writes() {
    let out = apply("---\nn: 1\n---\n", &[set("n", Value::Float(1.0))]);
    assert_eq!(out, "---\nn: 1.0\n---\n");
}

#[test]
fn strings_that_look_like_other_types_are_quoted() {
    let out = apply(
        "---\na: x\n---\n",
        &[
            set("b", Value::string("true")),
            set("c", Value::string("2026-10-01")),
            set("d", Value::string("")),
            set("e", Value::string("yes")),
            set("f", Value::Null),
        ],
    );
    assert_eq!(
        out,
        "---\na: x\nb: \"true\"\nc: \"2026-10-01\"\nd: \"\"\ne: \"yes\"\nf: null\n---\n"
    );
    // A plain previous style is kept when the new text is plain-safe.
    let out = apply(
        "---\ndue: 2026-10-01\n---\n",
        &[set("due", Value::string("2026-10-05"))],
    );
    assert_eq!(out, "---\ndue: 2026-10-05\n---\n");
}

#[test]
fn multiline_strings_and_nested_values() {
    let mut m = Map::new();
    m.insert("k", Value::string("v"));
    m.insert("list", list(&["a"]));
    let out = apply(
        "---\na: 1\n---\n",
        &[
            set("text", Value::string("line 1\nline 2\n")),
            set("nested", Value::Map(m)),
            set(
                "items",
                Value::List(vec![Value::Map(
                    [("x".to_owned(), Value::int(1))].into_iter().collect(),
                )]),
            ),
        ],
    );
    assert_eq!(
        out,
        "---\na: 1\ntext: |\n  line 1\n  line 2\nnested:\n  k: v\n  list:\n    - a\nitems:\n  - x: 1\n---\n"
    );
}

#[test]
fn literal_block_scalars_are_replaced_in_place() {
    let src = "---\nnote: |\n  old\n  text\n\nnext: 1\n---\n";
    let out = apply(src, &[set("note", Value::string("new\n"))]);
    assert_eq!(out, "---\nnote: |\n  new\n\nnext: 1\n---\n");
}

#[test]
fn indented_comment_lines_belong_to_the_entry() {
    let src = "---\ntags:\n  - a\n  # about a\nnext: 1\n---\n";
    let out = apply(src, &[("tags".into(), Change::Remove)]);
    assert_eq!(out, "---\nnext: 1\n---\n");
}

#[test]
fn top_level_flow_mapping_is_reemitted() {
    let out = apply("---\n{a: 1, b: 2}\n---\nx\n", &[set("b", Value::int(3))]);
    assert_eq!(out, "---\na: 1\nb: 3\n---\nx\n");
}

#[test]
fn yaml_document_records() {
    let d = Document::parse("views:\n  - type: table", RecordFormat::YamlDocument);
    let out = write(&d, &[set("filters", Value::Null)], None).unwrap();
    assert_eq!(out, "views:\n  - type: table\nfilters: null\n");
    assert_eq!(
        write(&d, &[], Some("text")),
        Err(WriteError::BodyOnYamlDocument)
    );
}

#[test]
fn render_new_documents() {
    let m: Map = [
        ("title".to_owned(), Value::string("T")),
        ("tags".to_owned(), list(&["a"])),
    ]
    .into_iter()
    .collect();
    let out = render_new(
        &m,
        "Body\n",
        RecordFormat::Markdown,
        mdbn_core::doc::LineEnding::Lf,
    )
    .unwrap();
    assert_eq!(out, "---\ntitle: T\ntags: [a]\n---\nBody\n");
}
