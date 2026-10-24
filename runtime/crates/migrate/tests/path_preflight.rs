//! Migration must report incompatible legacy names before sealing/import, not
//! silently drop a row or let the replica refuse the collection at the last step.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, missing_docs)]

use std::collections::BTreeMap;

use mdbn_core::paths::{PathViolation, path_key};
use mdbn_legacy::hosted::{FileMeta, Record};
use mdbn_legacy::revision_of;
use mdbn_migrate::preflight::{EntityKind, inspect_paths};
use mdbn_migrate::{Error, gen0};

const CID: &str = "4c18af2e-b04a-4b77-b83e-493c3695962e";
const R1: &str = "0192f0c1-7e1a-7b3c-8d4e-000000000001";
const R2: &str = "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f";
const F1: &str = "0192f0c1-7e1a-7b3c-8d4e-0000000000f1";
const F2: &str = "0192f0c1-7e1a-7b3c-8d4e-0000000000f2";

fn record(id: &str, path: &str) -> Record {
    let document = "---\ntitle: secret document content\n---\n".to_string();
    Record {
        record_id: id.into(),
        path: path.into(),
        revision: revision_of(document.as_bytes()),
        document,
    }
}

fn file(id: &str, path: &str) -> FileMeta {
    FileMeta {
        file_id: id.into(),
        path: path.into(),
        content_digest: revision_of(b""),
        size: 0,
        object_key: "legacy/private-object-key".into(),
        media_type: None,
        media_class: "other".into(),
    }
}

#[test]
fn every_invalid_legacy_name_is_reported_with_its_source_identity() {
    let records = vec![record(R1, "notes/why?.md"), record(R2, "notes/note:.md")];
    let files = vec![file(F1, "att/trailing."), file(F2, "att/trailing ")];
    let resources = vec![(
        ".obsidian/config.json".into(),
        b"secret resource bytes".to_vec(),
    )];
    let report = inspect_paths(&resources, &records, &files);
    assert_eq!(report.invalid.len(), 5);
    assert!(report.collisions.is_empty());
    assert!(!report.is_clear());
    assert_eq!(report.invalid[0].entity.kind, EntityKind::Resource);
    assert_eq!(report.invalid[0].entity.id, None);
    assert_eq!(report.invalid[0].violation, PathViolation::Hidden);
    assert_eq!(report.invalid[1].entity.id.as_deref(), Some(R1));
    assert_eq!(report.invalid[1].entity.path, "notes/why?.md");
    assert_eq!(
        report.invalid[1].violation,
        PathViolation::ForbiddenCharacter('?')
    );
    assert_eq!(
        report.invalid[2].violation,
        PathViolation::ForbiddenCharacter(':')
    );
    assert_eq!(
        report.invalid[3].violation,
        PathViolation::TrailingDotOrSpace
    );
    assert_eq!(
        report.invalid[4].violation,
        PathViolation::TrailingDotOrSpace
    );
}

#[test]
fn canonical_policy_is_used_for_every_namespace() {
    let cases = [
        ("../escape.md", PathViolation::DotSegment),
        ("/absolute.md", PathViolation::Absolute),
        ("notes\\a.md", PathViolation::Backslash),
        ("notes//a.md", PathViolation::EmptySegment),
        ("CON.md", PathViolation::ReservedName),
        ("GIT~1", PathViolation::ShortNameAlias),
        (".mdbase/state", PathViolation::Private),
        ("node_modules/x", PathViolation::Dependency),
        ("notes/a\u{200c}.md", PathViolation::IgnorableCharacter),
    ];
    for (path, violation) in cases {
        let report = inspect_paths(
            &[(path.into(), vec![])],
            &[record(R1, path)],
            &[file(F1, path)],
        );
        assert_eq!(report.invalid.len(), 3, "{path}");
        assert!(report.invalid.iter().all(|r| r.violation == violation));
        // Invalid rows remain in collision accounting; never silently filtered.
        assert_eq!(report.collisions.len(), 1);
        assert_eq!(report.collisions[0].entities.len(), 3);
    }
}

#[test]
fn nfc_and_full_case_fold_collisions_include_all_kinds() {
    let resources = vec![("Notes/é.md".into(), vec![])];
    let records = vec![
        record(R1, "notes/e\u{301}.md"),
        record(R2, "notes/straße.md"),
    ];
    let files = vec![file(F1, "NOTES/É.md"), file(F2, "NOTES/STRASSE.MD")];
    let report = inspect_paths(&resources, &records, &files);
    assert!(report.invalid.is_empty());
    assert_eq!(report.collisions.len(), 2);
    let accent = report
        .collisions
        .iter()
        .find(|c| c.path_key == path_key("notes/é.md"))
        .unwrap();
    assert_eq!(accent.entities.len(), 3);
    assert_eq!(accent.entities[0].kind, EntityKind::Resource);
    assert_eq!(accent.entities[1].id.as_deref(), Some(R1));
    assert_eq!(accent.entities[2].id.as_deref(), Some(F1));
    assert_eq!(accent.entities[1].path, "notes/e\u{301}.md");
    let folded = report
        .collisions
        .iter()
        .find(|c| c.path_key == path_key("notes/straße.md"))
        .unwrap();
    assert_eq!(folded.entities.len(), 2);
}

#[test]
fn exact_duplicate_resources_are_not_overwritten_or_ignored() {
    let resources = vec![
        ("mdbase.yaml".into(), b"first".to_vec()),
        ("mdbase.yaml".into(), b"second".to_vec()),
    ];
    let report = inspect_paths(&resources, &[], &[]);
    assert_eq!(report.collisions.len(), 1);
    assert_eq!(report.collisions[0].entities.len(), 2);
    assert!(matches!(
        gen0::build(CID, 0, &resources, &[], &[], &BTreeMap::new()),
        Err(Error::Paths(_))
    ));
}

#[test]
fn report_is_deterministic_under_reordered_input_and_does_not_mutate_rows() {
    let mut records = vec![
        record(R1, "notes/Secret?.md"),
        record(R2, "notes/SECRET?.MD"),
    ];
    let mut resources = vec![
        (".obsidian/z".into(), vec![1]),
        (".obsidian/a".into(), vec![2]),
    ];
    let mut files = vec![file(F1, "att/é"), file(F2, "att/e\u{301}")];
    let original_records = records.clone();
    let original_resources = resources.clone();
    let original_files = files.clone();
    let first = inspect_paths(&resources, &records, &files);
    assert_eq!(records, original_records);
    assert_eq!(resources, original_resources);
    assert_eq!(files, original_files);
    records.reverse();
    resources.reverse();
    files.reverse();
    assert_eq!(first, inspect_paths(&resources, &records, &files));
}

#[test]
fn display_and_debug_do_not_leak_names_documents_or_object_keys() {
    let records = vec![record(R1, "notes/Private?.md")];
    let files = vec![file(F1, "NOTES/PRIVATE?.MD")];
    let report = inspect_paths(&[], &records, &files);
    let debug = format!("{report:?} {:?} {:?}", report.invalid, report.collisions);
    let error = report
        .clone()
        .ensure_clear()
        .map_err(Error::from)
        .unwrap_err();
    let diagnostics = format!("{error} {error:?} {debug}");
    for name in [
        "Private",
        "PRIVATE",
        "secret document",
        "private-object-key",
    ] {
        assert!(!diagnostics.contains(name), "leaked {name}");
    }
    let Error::Paths(details) = error else {
        panic!("lost structured report")
    };
    assert_eq!(details, report);
    assert_eq!(details.invalid[0].entity.path, records[0].path);
}

#[test]
fn gen0_checks_all_paths_before_blob_or_document_validation() {
    let mut bad_record = record(R1, "notes/ok.md");
    bad_record.document = "tampered".into();
    let files = vec![file(F1, "NOTES/OK.MD"), file(F2, "att/invalid?.png")];
    let err = gen0::build(CID, 1, &[], &[bad_record], &files, &BTreeMap::new()).unwrap_err();
    let Error::Paths(report) = err else {
        panic!("expected full path report first")
    };
    assert_eq!(report.invalid.len(), 1);
    assert_eq!(report.collisions.len(), 1);
    assert_eq!(report.collisions[0].entities.len(), 2);
}

#[test]
fn clear_input_preserves_legacy_ids_and_exact_documents() {
    let records = vec![record(R2, "notes/é.md")];
    let resources = vec![("mdbase.yaml".into(), b"spec_version: 0.3.0\n".to_vec())];
    inspect_paths(&resources, &records, &[])
        .ensure_clear()
        .unwrap();
    let g = gen0::build(CID, 7, &resources, &records, &[], &BTreeMap::new()).unwrap();
    assert_eq!(g.records[0].id.to_uuid_string(), R2);
    assert_eq!(g.records[0].path, records[0].path);
    assert_eq!(g.records[0].doc, records[0].document);
    assert_eq!(g.resources[0].1.as_bytes(), resources[0].1);
}

#[test]
fn empty_collection_is_allowed() {
    assert!(inspect_paths(&[], &[], &[]).is_clear());
    assert!(gen0::build(CID, 0, &[], &[], &[], &BTreeMap::new()).is_ok());
}

/// A path that can't be made portable stops the collection in `resolve`. With no
/// `preflight::Resolved`, `reseal_files` (which requires one) can't run, so nothing is
/// read or uploaded. The upload side is tested in the crate's `reseal` unit tests.
#[test]
fn unresolvable_paths_stop_the_collection() {
    let too_long = format!("{}x.png", "a/".repeat(600));
    let files = vec![file(F1, "att/valid.png"), file(F2, &too_long)];
    let err = mdbn_migrate::preflight::resolve(&[], &[], &files).unwrap_err();
    assert!(matches!(err, Error::Paths(_)));
    let files = vec![file(F1, "att/valid.png"), file(F2, "att/invalid?.png")];
    let resolved = mdbn_migrate::preflight::resolve(&[], &[], &files).unwrap();
    assert_eq!(resolved.renames().len(), 1);
}

mod resolve {
    use mdbn_legacy::hosted::{FileMeta, Record};
    use mdbn_legacy::revision_of;
    use mdbn_migrate::preflight::{self, EntityKind};

    fn rec(id: &str, path: &str) -> Record {
        Record {
            record_id: id.into(),
            path: path.into(),
            document: format!("# {id}\n"),
            revision: revision_of(format!("# {id}\n").as_bytes()),
        }
    }

    fn file(id: &str, path: &str) -> FileMeta {
        FileMeta {
            file_id: id.into(),
            path: path.into(),
            content_digest: revision_of(b"x"),
            size: 1,
            object_key: format!("v1/blobs/{id}"),
            media_type: None,
            media_class: "other".into(),
        }
    }

    const A: &str = "0192f0c1-7e1a-7b3c-8d4e-00000000000a";
    const B: &str = "0192f0c1-7e1a-7b3c-8d4e-00000000000b";
    const C: &str = "0192f0c1-7e1a-7b3c-8d4e-00000000000c";
    const D: &str = "0192f0c1-7e1a-7b3c-8d4e-00000000000d";
    const E: &str = "0192f0c1-7e1a-7b3c-8d4e-00000000000e";
    const F: &str = "0192f0c1-7e1a-7b3c-8d4e-00000000000f";

    #[test]
    fn renames_every_non_portable_or_colliding_path_and_reports_it() {
        let records = vec![
            rec(A, "notes/What? Why: now.md"),
            rec(B, "notes/draft. /b.md"),
            rec(C, ".obsidian/workspace.md"),
            rec(D, "Notes/Plain.md"),
            rec(E, "notes/plain.md"), // collides with D under case folding
        ];
        let files = vec![file(F, "node_modules/x/CON.png")];
        let r = preflight::resolve(&[], &records, &files).unwrap();

        // Nothing dropped; IDs, content and object keys unchanged.
        assert_eq!(r.records().len(), 5);
        assert_eq!(r.files()[0].object_key, files[0].object_key);
        for (a, b) in records.iter().zip(r.records()) {
            assert_eq!((&a.record_id, &a.document), (&b.record_id, &b.document));
        }
        // Every new path is portable and unique.
        assert!(preflight::inspect_paths(&[], r.records(), r.files()).is_clear());

        let to = |id: &str| {
            r.renames()
                .iter()
                .find(|x| x.entity.id.as_deref() == Some(id))
                .map(|x| (x.to.as_str(), x.reason))
        };
        assert_eq!(to(A).unwrap().0, "notes/What_ Why_ now.md");
        assert_eq!(to(C).unwrap().0, "_obsidian/workspace.md");
        assert_eq!(to(F).unwrap().0, "node_modules_/x/CON_.png");
        assert_eq!(to(B).unwrap().0, "notes/draft._/b.md");
        // Of the two colliding portable paths, the first keeps its name.
        assert_eq!(to(D), None);
        assert_eq!(to(E), Some(("notes/plain (2).md", "collision")));
        assert_eq!(r.renames().len(), 5);
        assert!(
            r.renames()
                .iter()
                .all(|x| x.entity.kind != EntityKind::Resource)
        );
        // The renamed read builds generation 0 (the gate gen0 enforces).
        assert!(
            mdbn_migrate::gen0::build(
                "4c18af2e-b04a-4b77-b83e-493c3695962e",
                1,
                &[],
                r.records(),
                &[],
                &Default::default()
            )
            .is_ok()
        );
    }

    #[test]
    fn clean_collections_are_untouched() {
        let records = vec![rec(A, "notes/a.md"), rec(B, "notes/b.md")];
        let r = preflight::resolve(&[], &records, &[]).unwrap();
        assert!(r.renames().is_empty());
        assert_eq!(r.records(), &records[..]);
    }
}
