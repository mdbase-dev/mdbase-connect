//! Malformed frontmatter, BOM, CRLF and non-UTF-8 content through the native
//! generation-0 import on the real engine.
//!
//! Intended behaviour (migration decision 4A, `docs/contracts/intent.md`
//! `doc-version`: "the exact bytes of the document"): the import never parses,
//! repairs or normalises a document. Every record and resource is sealed as its
//! exact legacy bytes, bound to the S0 placement's SHA-256 and size, so
//! malformed YAML, duplicate keys, a BOM or CRLF line endings all migrate
//! byte-for-byte. An attachment is opaque bytes, so non-UTF-8 content migrates
//! exactly too. A record or resource can only be text: a legacy record is a JSON
//! string and `resource-row` holds text, so a non-UTF-8 window row, or one
//! "repaired" by stripping a BOM, normalising line endings or substituting
//! U+FFFD, is refused before sealing and nothing settles.
use super::*;

/// Records with every frontmatter hazard the legacy provider accepted: it stored
/// `document` verbatim and derived frontmatter only for display.
pub(super) fn hazard_records() -> Vec<(u8, &'static str, String)> {
    vec![
        (
            1,
            "hazard/unterminated.md",
            "---\ntitle: never closed\nbody without a closing fence\n".into(),
        ),
        (
            2,
            "hazard/duplicate-keys.md",
            "---\ntitle: one\ntitle: two\ntags: [a]\ntags: b\n---\nbody\n".into(),
        ),
        (
            3,
            "hazard/odd-values.md",
            concat!(
                "---\n",
                "? [complex, key]\n: value\n",
                "123: numeric key\n",
                "null: ~\n",
                "anchor: &a {x: 1}\n",
                "alias: *a\n",
                "bin: !!binary aGVsbG8=\n",
                "date: 2026-02-30\n",
                "nan: .nan\n",
                "tab:\tvalue\n",
                "multi: |\n  line one\n  line two\n",
                "---\nbody\n"
            )
            .into(),
        ),
        (
            4,
            "hazard/invalid-yaml.md",
            "---\nkey: [unclosed\n  : : :\n\t- mixed\n---\nbody\n".into(),
        ),
        (
            5,
            "hazard/sequence.md",
            "---\n- a\n- b\n---\nnot a mapping\n".into(),
        ),
        (
            6,
            "hazard/bom.md",
            "\u{feff}---\ntitle: bom\n---\nbody\n".into(),
        ),
        (
            7,
            "hazard/crlf.md",
            "---\r\ntitle: crlf\r\n---\r\nbody\r\n".into(),
        ),
        (
            8,
            "hazard/mixed-eol.md",
            "---\r\ntitle: mixed\n---\rbody\r\nlast\r".into(),
        ),
        (
            10,
            "hazard/control.md",
            "---\ntitle: \"a\\u0000b\"\n---\nnul\u{0}byte \u{1b}[0m\n".into(),
        ),
        (11, "hazard/fence-only.md", "---".into()),
        (12, "hazard/empty-frontmatter.md", "---\n---\n".into()),
        (13, "hazard/empty.md", String::new()),
    ]
}

/// Bytes that are not UTF-8 in any reading: a lone continuation byte, an
/// overlong encoding, a truncated sequence, a surrogate and 0xFF/0xFE.
pub(super) const NOT_UTF8: &[u8] = b"caf\xe9 \x80 \xc0\xaf \xe2\x82 \xed\xa0\x80 \xff\xfe\x00end";

fn hazard_legacy() -> Legacy {
    Legacy {
        resources: vec![
            (
                "mdbase.yaml",
                "\u{feff}name: hazards\r\nversion: 1\r\n".into(),
            ),
            (
                "_types/person.md",
                "---\nname: person\nname: duplicate\nfields: [unclosed\n---\n".into(),
            ),
        ],
        records: hazard_records(),
        files: vec![
            (20, "attachments/latin1.txt", NOT_UTF8.to_vec()),
            (21, "attachments/notes-latin1.md.bin", NOT_UTF8.repeat(3)),
            (22, "assets/pixel.gif", GIF.to_vec()),
        ],
    }
}

/// Every hazard migrates: windows seal, the base settles, and the state digest
/// the base commits to (placements only) equals the digest fed from the exact
/// legacy bytes. A normalised byte anywhere would change it.
#[test]
fn malformed_frontmatter_bom_crlf_and_binary_attachments_migrate_byte_exact() {
    let mut r = run_legacy(hazard_legacy());
    let mut store = Objects::default();
    r.windows(&mut store, 90);
    let out = r.d.gen0_finish(&r.p, &mut r.h.e, &r.target).unwrap();
    store.put(&out);
    let flags = store.result(r.c(), &out.verify);
    let result =
        r.d.settle_gen0(&r.p, &mut r.h.e, &r.target, &flags)
            .unwrap();
    r.d.assert_settled(&r.p, result).unwrap();
    let cp = r.d.test_checkpoint();
    assert_eq!(cp.step, Step::BaseIntent);
    assert_eq!(cp.state_digest, Some(expected_digest(&r.l)));
}

/// "Repairs" are refused before sealing, never silently applied: a stripped
/// BOM, LF-normalised line endings, a trimmed trailing newline or a U+FFFD
/// substitution each differ from the S0 placement's hash or size.
#[test]
fn normalised_or_lossy_text_is_refused_before_sealing() {
    let mut r = run_legacy(hazard_legacy());
    let c = r.c();
    let step = r.d.test_checkpoint().step;
    let settled = r.d.test_settled();
    // Resource window: the BOM stripped, then CRLF normalised to LF.
    for repaired in [
        "name: hazards\r\nversion: 1\r\n",
        "\u{feff}name: hazards\nversion: 1\n",
    ] {
        let mut rows = resource_rows(&r.l);
        let at = rows
            .iter()
            .position(|(k, _)| *k == t("mdbase.yaml"))
            .unwrap();
        rows[at].1 = repaired.into();
        assert_eq!(
            r.d.gen0_window(&r.p, &mut r.h.e, &r.target, &window_input(c, rows))
                .err(),
            Some(LedgerError::Conflict),
            "{repaired:?}"
        );
    }
    r.unmoved(settled, step);
    let mut store = Objects::default();
    r.window(&mut store, 90);
    let step = r.d.test_checkpoint().step;
    let settled = r.d.test_settled();
    let Action::ImportGen0 { bits, bucket, .. } = r.d.prepared_action(&r.p).unwrap().clone() else {
        panic!("a record bucket is pending")
    };
    let bucket = bucket.unwrap_or(0);
    let rows = record_rows(&r.l, bits, bucket);
    assert!(!rows.is_empty(), "the pending bucket holds hazard records");
    for (i, (_, doc)) in rows.iter().enumerate() {
        let mut variants = vec![
            doc.trim_start_matches('\u{feff}').to_owned(),
            doc.replace("\r\n", "\n"),
            doc.trim_end_matches('\n').to_owned(),
            doc.replace('\u{0}', "\u{fffd}"),
        ];
        variants.retain(|v| v != doc);
        for v in variants {
            let mut bad = rows.clone();
            bad[i].1 = v;
            assert_eq!(
                r.d.gen0_window(&r.p, &mut r.h.e, &r.target, &window_input(c, bad))
                    .err(),
                Some(LedgerError::Conflict)
            );
        }
    }
    r.unmoved(settled, step);
}

/// A window row whose text is not UTF-8 is malformed input (CBOR text must be
/// UTF-8, and `resource-row`/record documents are text): refused, nothing
/// sealed or settled, the Driver unmoved.
#[test]
fn a_non_utf8_window_row_is_refused_without_settling() {
    let mut r = run_legacy(hazard_legacy());
    let c = r.c();
    let step = r.d.test_checkpoint().step;
    let settled = r.d.test_settled();
    let mut rows = resource_rows(&r.l);
    let at = rows
        .iter()
        .position(|(k, _)| *k == t("mdbase.yaml"))
        .unwrap();
    let marker = "#".repeat(NOT_UTF8.len());
    rows[at].1 = marker.clone();
    let mut input = window_input(c, rows);
    let pos = input
        .windows(marker.len())
        .position(|w| w == marker.as_bytes())
        .unwrap();
    input[pos..pos + NOT_UTF8.len()].copy_from_slice(NOT_UTF8);
    assert!(
        r.d.gen0_window(&r.p, &mut r.h.e, &r.target, &input)
            .is_err()
    );
    r.unmoved(settled, step);
}
