//! Separate configuration-tool warnings never exclude legacy bytes or alter policy.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, missing_docs)]

use mdbn_legacy::{
    hosted::{FileMeta, Record},
    revision_of,
};
use mdbn_migrate::preflight::{self, EntityKind};

fn record(i: usize, path: &str) -> Record {
    let document = format!("# private tool content {i}\n");
    Record {
        record_id: format!("0192f0c1-7e1a-7b3c-8d4e-{i:012x}"),
        path: path.into(),
        revision: revision_of(document.as_bytes()),
        document,
    }
}

#[test]
fn warnings_match_full_original_directory_components_not_file_names_or_prefixes() {
    let cases = [
        (".obsidian/workspace.md", true),
        ("notes/.GIT/config.md", true),
        ("nested/.vscode/settings.md", true),
        (".idea/workspace.md", true),
        (".hg/cache.md", true),
        (".svn/config.md", true),
        ("Node_Modules/dependency.md", true),
        ("notes\\.Obsidian\\workspace.md", true),
        (".git-backup/config.md", false),
        (".obsidian.md", false),
        ("notes/.git", false),
        ("node_modules", false),
        ("node_modules_/bad?.md", false),
        ("notes/other?.md", false),
    ];
    for (i, (path, expected)) in cases.into_iter().enumerate() {
        let records = [record(i, path)];
        let resolved = preflight::resolve(&[], &records, &[]).unwrap();
        assert_eq!(resolved.renames().len(), 1, "{path}");
        let rename = &resolved.renames()[0];
        assert_eq!(rename.tool_folder, expected, "{path}");
        assert_eq!(rename.entity.path, path);
        assert_eq!(
            resolved.tool_folder_renames().count(),
            usize::from(expected)
        );
        assert!(preflight::inspect_paths(&[], resolved.records(), &[]).is_clear());
        assert_eq!(resolved.records()[0].document, records[0].document);
        assert_eq!(resolved.records()[0].record_id, records[0].record_id);
        assert_eq!(resolved.records()[0].revision, records[0].revision);
    }
}

#[test]
fn tool_report_includes_all_namespaces_and_preserves_every_byte_and_identity() {
    let resources = vec![(".vscode/settings.json".into(), vec![0, 255, 17])];
    let records = vec![
        record(1, ".obsidian/workspace.md"),
        record(2, "notes/why?.md"),
    ];
    let files = vec![FileMeta {
        file_id: "0192f0c1-7e1a-7b3c-8d4e-000000000003".into(),
        path: "node_modules/private.png".into(),
        content_digest: revision_of(b"private binary"),
        size: 14,
        object_key: "private/original-object".into(),
        media_type: Some("image/png".into()),
        media_class: "image".into(),
    }];
    let resolved = preflight::resolve(&resources, &records, &files).unwrap();
    assert_eq!(resolved.renames().len(), 4);
    let warnings: Vec<_> = resolved.tool_folder_renames().collect();
    assert_eq!(warnings.len(), 3);
    assert_eq!(
        warnings.iter().map(|r| r.entity.kind).collect::<Vec<_>>(),
        [EntityKind::Resource, EntityKind::Record, EntityKind::File]
    );
    assert_eq!(
        warnings.iter().map(|r| r.reason).collect::<Vec<_>>(),
        [
            mdbn_core::paths::PathViolation::Hidden.reason(),
            mdbn_core::paths::PathViolation::Hidden.reason(),
            mdbn_core::paths::PathViolation::Dependency.reason(),
        ]
    );
    assert_eq!(resolved.resources()[0].1, resources[0].1);
    for (old, new) in records.iter().zip(resolved.records()) {
        assert_eq!(
            (&old.record_id, &old.document, &old.revision),
            (&new.record_id, &new.document, &new.revision)
        );
    }
    let mut expected_file = files[0].clone();
    expected_file.path = "node_modules_/private.png".into();
    assert_eq!(resolved.files(), &[expected_file]);
    assert!(
        preflight::inspect_paths(resolved.resources(), resolved.records(), resolved.files())
            .is_clear()
    );
    // Only explicit report fields expose names; routine diagnostics do not.
    let diagnostic = format!("{:?}", resolved.renames());
    for private in ["workspace", "settings", "private binary", "original-object"] {
        assert!(!diagnostic.contains(private), "{private}");
    }
}

#[test]
fn warnings_are_deterministic_and_do_not_mutate_inputs() {
    let records = vec![
        record(1, ".obsidian/z.md"),
        record(2, ".git/a.md"),
        record(3, "safe.md"),
    ];
    let original = records.clone();
    let first = preflight::resolve(&[], &records, &[]).unwrap();
    assert_eq!(records, original);
    let mut reordered = records.clone();
    reordered.reverse();
    let second = preflight::resolve(&[], &reordered, &[]).unwrap();
    assert_eq!(first.renames(), second.renames());
    assert_eq!(
        first.tool_folder_renames().collect::<Vec<_>>(),
        second.tool_folder_renames().collect::<Vec<_>>()
    );
    assert_eq!(first.records().len(), records.len());
    assert_eq!(second.records().len(), records.len());
}
