use super::*;
use mdbase_connect_protocol::{
    CollectionFileDescriptor, OpenFileDownloadRequest, OpenFileDownloadRequestKind,
    OpenFileUploadRequestKind,
};
use tempfile::tempdir;

fn owner() -> Uuid {
    Uuid::from_u128(42)
}

fn registered() -> (
    tempfile::TempDir,
    tempfile::TempDir,
    CollectionRegistry,
    Uuid,
) {
    let state = tempdir().unwrap();
    let root = tempdir().unwrap();
    fs::write(root.path().join("mdbase.yaml"), "spec_version: 0.3.0\n").unwrap();
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let id = registry.add(root.path()).unwrap().id;
    (state, root, registry, id)
}

fn request(path: &str, bytes: &[u8]) -> OpenFileUploadRequest {
    OpenFileUploadRequest {
        protocol_version: FILE_PROTOCOL_VERSION,
        message_type: OpenFileUploadRequestKind::OpenFileUpload,
        transfer_id: Uuid::now_v7(),
        path: path.to_string(),
        size: bytes.len() as u64,
        content_digest: sha256_digest(bytes),
        media_type: None,
        if_revision: None,
    }
}

fn download_request(file: &CollectionFileDescriptor) -> OpenFileDownloadRequest {
    OpenFileDownloadRequest {
        protocol_version: FILE_PROTOCOL_VERSION,
        message_type: OpenFileDownloadRequestKind::OpenFileDownload,
        transfer_id: Uuid::now_v7(),
        file_id: file.file_id,
        revision: Some(file.revision.clone()),
    }
}

fn upload_all(
    registry: &CollectionRegistry,
    collection_id: Uuid,
    session: &FileTransferSession,
    bytes: &[u8],
) {
    let FileTransferStrategy::FramedChunks { chunk_size } = session.strategy else {
        panic!("local upload should use framed chunks")
    };
    for (index, chunk) in bytes.chunks(chunk_size as usize).enumerate() {
        registry
            .put_file_upload_chunk(
                collection_id,
                owner(),
                session.transfer_id,
                index as u64,
                chunk,
            )
            .unwrap();
    }
}

#[test]
fn upload_resumes_out_of_order_across_restart_and_commits_atomically() {
    let (state, root, registry, id) = registered();
    let mut bytes = vec![0x41; DEFAULT_FILE_CHUNK_BYTES as usize];
    bytes.extend_from_slice(b"tail");
    let session = registry
        .open_file_upload(id, owner(), &request("Photos/image.bin", &bytes))
        .unwrap();

    registry
        .put_file_upload_chunk(id, owner(), session.transfer_id, 1, b"tail")
        .unwrap();
    assert!(!root.path().join("Photos/image.bin").exists());
    let reopened = CollectionRegistry::open(state.path()).unwrap();
    let first = &bytes[..DEFAULT_FILE_CHUNK_BYTES as usize];
    reopened
        .put_file_upload_chunk(id, owner(), session.transfer_id, 0, first)
        .unwrap();
    let duplicate = reopened
        .put_file_upload_chunk(id, owner(), session.transfer_id, 0, first)
        .unwrap();
    assert_eq!(duplicate.received, vec![0, 1]);
    assert_eq!(duplicate.received_bytes, bytes.len() as u64);

    let receipt = reopened
        .commit_file_upload(id, owner(), session.transfer_id)
        .unwrap();
    assert_eq!(
        fs::read(root.path().join("Photos/image.bin")).unwrap(),
        bytes
    );
    assert_eq!(receipt.file.file_id.get_version_num(), 7);
    assert_eq!(receipt.file.content_digest, sha256_digest(&bytes));
    assert_eq!(
        reopened
            .commit_file_upload(id, owner(), session.transfer_id)
            .unwrap(),
        receipt
    );
    assert_eq!(
        reopened
            .file_transfer_status(id, owner(), session.transfer_id)
            .unwrap()
            .state,
        FileTransferState::Committed
    );
}

#[test]
fn duplicate_chunk_with_different_bytes_is_rejected() {
    let (_state, _root, registry, id) = registered();
    let bytes = b"expected";
    let session = registry
        .open_file_upload(id, owner(), &request("file.bin", bytes))
        .unwrap();
    registry
        .put_file_upload_chunk(id, owner(), session.transfer_id, 0, bytes)
        .unwrap();
    let error = registry
        .put_file_upload_chunk(id, owner(), session.transfer_id, 0, b"different")
        .unwrap_err();
    assert_eq!(error.code(), "invalid_chunk_length");

    let error = registry
        .put_file_upload_chunk(id, owner(), session.transfer_id, 0, b"changed!")
        .unwrap_err();
    assert_eq!(error.code(), "chunk_conflict");
}

#[test]
fn incomplete_and_digest_mismatched_uploads_never_become_visible() {
    let (_state, root, registry, id) = registered();
    let bytes = b"complete bytes";
    let session = registry
        .open_file_upload(id, owner(), &request("file.bin", bytes))
        .unwrap();
    let incomplete = registry
        .commit_file_upload(id, owner(), session.transfer_id)
        .unwrap_err();
    assert_eq!(incomplete.code(), "transfer_incomplete");
    assert!(!root.path().join("file.bin").exists());

    let mut incorrect = request("bad.bin", bytes);
    incorrect.content_digest = sha256_digest(b"different bytes");
    let session = registry.open_file_upload(id, owner(), &incorrect).unwrap();
    upload_all(&registry, id, &session, bytes);
    let mismatch = registry
        .commit_file_upload(id, owner(), session.transfer_id)
        .unwrap_err();
    assert_eq!(mismatch.code(), "content_digest_mismatch");
    assert!(!root.path().join("bad.bin").exists());
}

#[test]
fn replacement_requires_and_rechecks_the_current_revision() {
    let (_state, root, registry, id) = registered();
    fs::write(root.path().join("photo.png"), b"old").unwrap();
    let current = registry.reconcile_files(id).unwrap().remove(0);
    let bytes = b"replacement";
    let missing_base = registry
        .open_file_upload(id, owner(), &request("photo.png", bytes))
        .unwrap_err();
    assert_eq!(missing_base.code(), "stale_file_revision");

    let mut replace = request("photo.png", bytes);
    replace.if_revision = Some(current.revision);
    let session = registry.open_file_upload(id, owner(), &replace).unwrap();
    upload_all(&registry, id, &session, bytes);
    fs::write(root.path().join("photo.png"), b"concurrent edit").unwrap();
    let stale = registry
        .commit_file_upload(id, owner(), session.transfer_id)
        .unwrap_err();
    assert_eq!(stale.code(), "stale_file_revision");
    assert_eq!(
        fs::read(root.path().join("photo.png")).unwrap(),
        b"concurrent edit"
    );
}

#[test]
fn committing_transfer_recovers_after_destination_rename() {
    let (state, root, registry, id) = registered();
    let bytes = b"recover me";
    let session = registry
        .open_file_upload(id, owner(), &request("recover.bin", bytes))
        .unwrap();
    upload_all(&registry, id, &session, bytes);
    let transfer = required_upload(
        &registry.connection().unwrap(),
        id,
        Some(owner()),
        session.transfer_id,
    )
    .unwrap();
    registry
        .connection()
        .unwrap()
        .execute(
            "UPDATE collection_file_transfers SET state = 'committing' WHERE transfer_id = ?1",
            [session.transfer_id.to_string()],
        )
        .unwrap();
    fs::rename(
        transfer_staging_path(root.path(), &transfer).unwrap(),
        root.path().join("recover.bin"),
    )
    .unwrap();

    let reopened = CollectionRegistry::open(state.path()).unwrap();
    let receipt = reopened
        .commit_file_upload(id, owner(), session.transfer_id)
        .unwrap();
    assert_eq!(receipt.file.file_id, transfer.file_id);
    assert_eq!(fs::read(root.path().join("recover.bin")).unwrap(), bytes);
}

#[test]
fn hidden_structural_record_and_symlink_targets_are_refused() {
    let (_state, root, registry, id) = registered();
    fs::write(root.path().join("record.md"), "---\ntitle: Record\n---\n").unwrap();
    for path in [".hidden/file.bin", "_types/file.bin", "record.md"] {
        let error = registry
            .open_file_upload(id, owner(), &request(path, b"bytes"))
            .unwrap_err();
        assert!(matches!(error.code(), "unsafe_file_path" | "path_occupied"));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let outside = tempdir().unwrap();
        symlink(outside.path(), root.path().join("linked")).unwrap();
        let error = registry
            .open_file_upload(id, owner(), &request("linked/file.bin", b"bytes"))
            .unwrap_err();
        assert_eq!(error.code(), "unsafe_file_path");
    }
}

#[test]
fn zero_byte_upload_commits_without_chunks_and_abort_is_durable() {
    let (_state, root, registry, id) = registered();
    let empty = registry
        .open_file_upload(id, owner(), &request("empty.bin", b""))
        .unwrap();
    registry
        .commit_file_upload(id, owner(), empty.transfer_id)
        .unwrap();
    assert_eq!(fs::read(root.path().join("empty.bin")).unwrap(), b"");

    let aborted = registry
        .open_file_upload(id, owner(), &request("aborted.bin", b"no"))
        .unwrap();
    assert_eq!(
        registry
            .abort_file_transfer(id, owner(), aborted.transfer_id)
            .unwrap()
            .state,
        FileTransferState::Aborted
    );
    assert_eq!(
        registry
            .abort_file_transfer(id, owner(), aborted.transfer_id)
            .unwrap()
            .state,
        FileTransferState::Aborted
    );
    assert!(!root.path().join("aborted.bin").exists());
}

#[test]
fn expired_upload_rejects_chunks_and_removes_staging() {
    let (_state, root, registry, id) = registered();
    let session = registry
        .open_file_upload(id, owner(), &request("expired.bin", b"no"))
        .unwrap();
    registry
        .connection()
        .unwrap()
        .execute(
            "UPDATE collection_file_transfers SET expires_at = '2000-01-01T00:00:00Z'
             WHERE transfer_id = ?1",
            [session.transfer_id.to_string()],
        )
        .unwrap();
    let error = registry
        .put_file_upload_chunk(id, owner(), session.transfer_id, 0, b"no")
        .unwrap_err();
    assert_eq!(error.code(), "transfer_expired");
    assert_eq!(
        registry
            .file_transfer_status(id, owner(), session.transfer_id)
            .unwrap()
            .state,
        FileTransferState::Expired
    );
    assert!(fs::read_dir(root.path().join(STAGING_DIRECTORY))
        .unwrap()
        .next()
        .is_none());
}

#[cfg(unix)]
#[test]
fn staging_symlink_replacement_is_refused_without_touching_its_target() {
    use std::os::unix::fs::symlink;

    let (_state, root, registry, id) = registered();
    let session = registry
        .open_file_upload(id, owner(), &request("safe.bin", b"bytes"))
        .unwrap();
    let transfer = required_upload(
        &registry.connection().unwrap(),
        id,
        Some(owner()),
        session.transfer_id,
    )
    .unwrap();
    let staging = transfer_staging_path(root.path(), &transfer).unwrap();
    fs::remove_file(&staging).unwrap();
    let outside = root.path().join("outside.txt");
    fs::write(&outside, b"untouched").unwrap();
    symlink(&outside, &staging).unwrap();

    let error = registry
        .put_file_upload_chunk(id, owner(), session.transfer_id, 0, b"bytes")
        .unwrap_err();
    assert_eq!(error.code(), "unsafe_file_path");
    assert_eq!(fs::read(outside).unwrap(), b"untouched");
}

#[test]
fn malformed_control_values_are_rejected_before_staging() {
    let (_state, root, registry, id) = registered();
    let mut invalid = request("file.bin", b"bytes");
    invalid.protocol_version = 99;
    assert_eq!(
        registry
            .open_file_upload(id, owner(), &invalid)
            .unwrap_err()
            .code(),
        "unsupported_file_protocol"
    );
    invalid.protocol_version = FILE_PROTOCOL_VERSION;
    invalid.content_digest = "sha256:ABC".to_string();
    assert_eq!(
        registry
            .open_file_upload(id, owner(), &invalid)
            .unwrap_err()
            .code(),
        "invalid_content_digest"
    );
    assert!(!root.path().join(STAGING_DIRECTORY).exists());
}

#[test]
fn upload_open_is_idempotent_and_transfer_ownership_is_exact() {
    let (_state, _root, registry, id) = registered();
    let bytes = b"owned upload";
    let request = request("owned.bin", bytes);
    let first = registry.open_file_upload(id, owner(), &request).unwrap();
    registry
        .put_file_upload_chunk(id, owner(), first.transfer_id, 0, bytes)
        .unwrap();
    let resumed = registry.open_file_upload(id, owner(), &request).unwrap();
    assert_eq!(resumed.transfer_id, first.transfer_id);
    assert_eq!(resumed.received, vec![0]);

    let other = Uuid::from_u128(43);
    assert_eq!(
        registry
            .file_transfer_status(id, other, first.transfer_id)
            .unwrap_err()
            .code(),
        "transfer_not_found"
    );
    assert_eq!(
        registry
            .open_file_upload(id, other, &request)
            .unwrap_err()
            .code(),
        "transfer_not_found"
    );
    let mut conflicting = request.clone();
    conflicting.path = "different.bin".to_string();
    assert_eq!(
        registry
            .open_file_upload(id, owner(), &conflicting)
            .unwrap_err()
            .code(),
        "transfer_conflict"
    );
}

#[test]
fn download_is_revision_pinned_resumable_and_snapshot_backed() {
    let (state, root, registry, id) = registered();
    let mut bytes = vec![0x52; DEFAULT_FILE_CHUNK_BYTES as usize];
    bytes.extend_from_slice(b"download tail");
    fs::write(root.path().join("asset.bin"), &bytes).unwrap();
    let descriptor = registry.reconcile_files(id).unwrap().remove(0);
    let request = download_request(&descriptor);
    let session = registry
        .open_file_download(id, owner(), &request, |_| Ok(()))
        .unwrap();
    assert_eq!(session.direction, FileTransferDirection::Download);
    assert_eq!(session.protection, FileTransferProtection::GrantAeadV1);
    assert_eq!(session.total_size, bytes.len() as u64);

    fs::write(root.path().join("asset.bin"), b"changed after open").unwrap();
    let first = registry
        .read_file_download_chunk(id, owner(), session.transfer_id, 0)
        .unwrap();
    assert_eq!(first, bytes[..DEFAULT_FILE_CHUNK_BYTES as usize]);
    let reopened = CollectionRegistry::open(state.path()).unwrap();
    let second = reopened
        .read_file_download_chunk(id, owner(), session.transfer_id, 1)
        .unwrap();
    assert_eq!(second, b"download tail");
    assert_eq!(
        reopened
            .open_file_download(id, owner(), &request, |_| Ok(()))
            .unwrap()
            .transfer_id,
        session.transfer_id
    );
    assert_eq!(
        reopened
            .abort_file_transfer(id, owner(), session.transfer_id)
            .unwrap()
            .state,
        FileTransferState::Aborted
    );
}

#[cfg(unix)]
#[test]
fn download_reuses_unchanged_inventory_digests_before_verifying_selected_bytes() {
    use std::os::unix::fs::PermissionsExt;

    let (_state, root, registry, id) = registered();
    fs::write(root.path().join("selected.bin"), b"selected bytes").unwrap();
    fs::write(root.path().join("unrelated.bin"), b"unrelated bytes").unwrap();
    let files = registry.reconcile_files(id).unwrap();
    let selected = files
        .into_iter()
        .find(|file| file.path == "selected.bin")
        .unwrap();
    fs::set_permissions(
        root.path().join("unrelated.bin"),
        fs::Permissions::from_mode(0o000),
    )
    .unwrap();

    let session = registry
        .open_file_download(id, owner(), &download_request(&selected), |_| Ok(()))
        .unwrap();

    assert_eq!(session.total_size, b"selected bytes".len() as u64);
}

#[test]
fn download_open_does_not_wait_for_an_unrelated_inventory_reconcile() {
    let (_state, root, registry, id) = registered();
    fs::write(root.path().join("selected.bin"), b"selected bytes").unwrap();
    fs::write(root.path().join("unrelated.bin"), b"unrelated bytes").unwrap();
    let selected = registry
        .reconcile_files(id)
        .unwrap()
        .into_iter()
        .find(|file| file.path == "selected.bin")
        .unwrap();

    let reconcile_lock = registry.file_reconcile_lock(id).unwrap();
    let reconcile_guard = reconcile_lock.lock().unwrap();
    let request = download_request(&selected);
    let worker_registry = registry.clone();
    let (sender, receiver) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        sender
            .send(worker_registry.open_file_download(id, owner(), &request, |_| Ok(())))
            .unwrap();
    });

    let session = receiver
        .recv_timeout(std::time::Duration::from_secs(2))
        .expect("one-file download preparation must not wait for inventory reconciliation")
        .unwrap();
    assert_eq!(session.total_size, b"selected bytes".len() as u64);
    drop(reconcile_guard);
    worker.join().unwrap();
}

#[test]
fn download_rejects_stale_revisions_other_owners_and_expired_snapshots() {
    let (_state, root, registry, id) = registered();
    fs::write(root.path().join("asset.bin"), b"download").unwrap();
    let descriptor = registry.reconcile_files(id).unwrap().remove(0);
    let mut stale = download_request(&descriptor);
    stale.revision = Some("file:stale".to_string());
    assert_eq!(
        registry
            .open_file_download(id, owner(), &stale, |_| Ok(()))
            .unwrap_err()
            .code(),
        "file_revision_not_found"
    );

    let request = download_request(&descriptor);
    let session = registry
        .open_file_download(id, owner(), &request, |_| Ok(()))
        .unwrap();
    assert_eq!(
        registry
            .read_file_download_chunk(id, Uuid::from_u128(43), session.transfer_id, 0)
            .unwrap_err()
            .code(),
        "transfer_not_found"
    );
    registry
        .connection()
        .unwrap()
        .execute(
            "UPDATE collection_file_transfers SET expires_at = '2000-01-01T00:00:00Z'
             WHERE transfer_id = ?1",
            [session.transfer_id.to_string()],
        )
        .unwrap();
    assert_eq!(
        registry
            .read_file_download_chunk(id, owner(), session.transfer_id, 0)
            .unwrap_err()
            .code(),
        "transfer_expired"
    );
    assert_eq!(
        registry
            .file_transfer_status(id, owner(), session.transfer_id)
            .unwrap()
            .state,
        FileTransferState::Expired
    );
    assert!(!root
        .path()
        .join(STAGING_DIRECTORY)
        .join(format!("{}.download", session.transfer_id))
        .exists());
}
