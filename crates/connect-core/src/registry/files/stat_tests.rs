use super::tests::registered;
use super::*;
use mdbase_connect_protocol::{StatFileRequest, StatFileRequestKind};

fn request(path: Option<&str>, file_id: Option<Uuid>) -> StatFileRequest {
    StatFileRequest {
        protocol_version: 1,
        message_type: StatFileRequestKind::StatFile,
        path: path.map(str::to_owned),
        file_id,
    }
}

#[test]
fn stat_reconciles_only_target_and_does_not_establish_inventory_completeness() {
    let (_state, root, registry, id) = registered();
    fs::create_dir(root.path().join("Assets")).unwrap();
    fs::create_dir(root.path().join("Unrelated")).unwrap();
    fs::write(root.path().join("Assets/photo.PNG"), b"pixels").unwrap();
    fs::write(root.path().join("Unrelated/large.bin"), b"unrelated bytes").unwrap();
    let first = registry
        .stat_file(id, &request(Some("assets/PHOTO.png"), None), |_| true)
        .unwrap()
        .unwrap();
    assert_eq!(first.path, "Assets/photo.PNG");
    assert_eq!(first.size, 6);
    assert_eq!(registry.indexed_files(id).unwrap(), vec![first.clone()]);
    assert_eq!(registry.file_index_revision(id).unwrap(), 0);
    let by_id = registry
        .stat_file(id, &request(None, Some(first.file_id)), |_| true)
        .unwrap()
        .unwrap();
    assert_eq!(first, by_id);
    fs::write(root.path().join(&first.path), b"new bytes").unwrap();
    let pinned = mdbase_connect_protocol::OpenFileDownloadRequest {
        protocol_version: 1,
        message_type: mdbase_connect_protocol::OpenFileDownloadRequestKind::OpenFileDownload,
        transfer_id: Uuid::now_v7(),
        file_id: first.file_id,
        revision: Some(first.revision.clone()),
    };
    assert_eq!(
        registry
            .open_file_download(id, Uuid::now_v7(), &pinned, |_| Ok(()))
            .unwrap_err()
            .code(),
        "file_changed_during_read"
    );
    let edited = registry
        .stat_file(id, &request(None, Some(first.file_id)), |_| true)
        .unwrap()
        .unwrap();
    assert_eq!(edited.file_id, first.file_id);
    assert_ne!(edited.revision, first.revision);
    assert_ne!(edited.content_digest, first.content_digest);
    assert_eq!(edited.size, 9);
    assert_eq!(
        registry
            .open_file_download(id, Uuid::now_v7(), &pinned, |_| Ok(()))
            .unwrap_err()
            .code(),
        "file_revision_not_found"
    );
    fs::remove_file(root.path().join(&edited.path)).unwrap();
    assert!(registry
        .stat_file(id, &request(None, Some(edited.file_id)), |_| true)
        .unwrap()
        .is_none());
    assert!(registry
        .stat_file(id, &request(Some(&edited.path), None), |_| true)
        .unwrap()
        .is_none());
    assert!(registry.indexed_files(id).unwrap().is_empty());
}

#[cfg(unix)]
#[test]
fn stat_id_relocates_only_proven_identity_and_rechecks_scope() {
    let (_state, root, registry, id) = registered();
    fs::create_dir(root.path().join("Allowed")).unwrap();
    fs::create_dir(root.path().join("Outside")).unwrap();
    fs::write(root.path().join("Allowed/first.bin"), b"safe").unwrap();
    let first = registry
        .stat_file(id, &request(Some("Allowed/first.bin"), None), |_| true)
        .unwrap()
        .unwrap();
    fs::rename(
        root.path().join(&first.path),
        root.path().join("Allowed/renamed.bin"),
    )
    .unwrap();
    let renamed = registry
        .stat_file(id, &request(None, Some(first.file_id)), |_| true)
        .unwrap()
        .unwrap();
    assert_eq!(renamed.file_id, first.file_id);
    assert_eq!(renamed.path, "Allowed/renamed.bin");
    assert_ne!(renamed.revision, first.revision);
    fs::rename(
        root.path().join(&renamed.path),
        root.path().join("Outside/renamed.bin"),
    )
    .unwrap();
    let visible = |path: &str| path.starts_with("Allowed/");
    assert!(registry
        .stat_file(id, &request(None, Some(first.file_id)), visible)
        .unwrap()
        .is_none());
    assert!(registry
        .stat_file(id, &request(None, Some(Uuid::now_v7())), visible)
        .unwrap()
        .is_none());
}

#[test]
fn stat_excludes_engine_namespaces_and_other_collection_ids() {
    let (_state, root, registry, id) = registered();
    fs::write(root.path().join("record.md"), b"record").unwrap();
    for path in [
        "record.md",
        "mdbase.yaml",
        ".hidden.bin",
        "_types/example.bin",
        "node_modules/x.bin",
    ] {
        assert!(
            registry
                .stat_file(id, &request(Some(path), None), |_| true)
                .unwrap()
                .is_none(),
            "{path}"
        );
    }
    let (_other_state, other_root, other_registry, other_id) = registered();
    fs::write(other_root.path().join("file.bin"), b"other").unwrap();
    let other = other_registry
        .stat_file(other_id, &request(Some("file.bin"), None), |_| true)
        .unwrap()
        .unwrap();
    assert!(registry
        .stat_file(id, &request(None, Some(other.file_id)), |_| true)
        .unwrap()
        .is_none());
    for target in [
        request(None, None),
        request(Some("x.bin"), Some(Uuid::now_v7())),
        request(Some("../escape.bin"), None),
    ] {
        assert!(registry.stat_file(id, &target, |_| true).is_err());
    }
}

#[cfg(unix)]
#[test]
fn stat_rejects_symlinks_and_ambiguous_portable_aliases() {
    use std::os::unix::fs::symlink;
    let (_state, root, registry, id) = registered();
    fs::write(root.path().join("file.bin"), b"safe").unwrap();
    symlink(root.path().join("file.bin"), root.path().join("link.bin")).unwrap();
    assert!(registry
        .stat_file(id, &request(Some("link.bin"), None), |_| true)
        .is_err());
    fs::write(root.path().join("FILE.bin"), b"alias").unwrap();
    // Case-insensitive filesystems overwrite file.bin rather than creating an
    // ambiguous alias. Probe the contents, not the fixture's directory count.
    if fs::read(root.path().join("file.bin")).unwrap() == b"safe" {
        assert_eq!(
            registry
                .stat_file(id, &request(Some("file.bin"), None), |_| true)
                .unwrap_err()
                .code(),
            "path_alias"
        );
    }
}
