//! Synthetic file-I/O workloads and thread-local work accounting, test builds only.
use super::*;
use mdbase_connect_protocol::{
    FileTransferStrategy, OpenFileDownloadRequest, OpenFileDownloadRequestKind,
    OpenFileUploadRequest, OpenFileUploadRequestKind, FILE_PROTOCOL_VERSION,
};
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::time::Instant;

thread_local! {
    static WORK: RefCell<BTreeMap<&'static str, u64>> = RefCell::new(BTreeMap::new());
}
pub(in crate::registry) fn record(name: &'static str, count: u64) {
    WORK.with(|work| *work.borrow_mut().entry(name).or_default() += count);
}
fn measure<T>(name: &str, parameters: Value, operation: impl FnOnce() -> T) -> T {
    WORK.with(|work| work.borrow_mut().clear());
    let started = Instant::now();
    let result = operation();
    let elapsed = started.elapsed().as_secs_f64() * 1000.0;
    WORK.with(|work| println!("FILE_IO_BENCH {}", json!({
        "name": name, "parameters": parameters, "elapsed_ms": elapsed, "work": *work.borrow(),
    })));
    result
}
fn fixture(records: usize, files: usize) -> (tempfile::TempDir, CollectionRegistry, Uuid) {
    let dir = tempdir().unwrap();
    let root = dir.path().join("collection");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("mdbase.yaml"), "spec_version: 0.3.0\n").unwrap();
    for index in 0..records {
        std::fs::write(
            root.join(format!("record-{index}.md")),
            format!("---\ntitle: Record {index}\n---\n{}", "x".repeat(4096)),
        )
        .unwrap();
    }
    for index in 0..files {
        std::fs::write(
            root.join(format!("file-{index}.bin")),
            vec![index as u8; 1024 * 1024],
        )
        .unwrap();
    }
    let registry = CollectionRegistry::open(dir.path().join("state")).unwrap();
    let id = registry.add(root).unwrap().id;
    registry.reconcile_files(id).unwrap();
    (dir, registry, id)
}
fn upload_request(bytes: &[u8]) -> OpenFileUploadRequest {
    OpenFileUploadRequest {
        protocol_version: FILE_PROTOCOL_VERSION,
        message_type: OpenFileUploadRequestKind::OpenFileUpload,
        transfer_id: Uuid::now_v7(),
        path: "uploaded.bin".into(),
        size: bytes.len() as u64,
        content_digest: format!("sha256:{:x}", Sha256::digest(bytes)),
        media_type: None,
        if_revision: None,
    }
}
#[test]
fn single_file_work_is_independent_of_unrelated_contents() {
    let (dir, registry, id) = fixture(32, 8);
    // A binary operation must not load/parse unrelated Markdown at all.
    std::fs::write(dir.path().join("collection/record-0.md"), [0xff, 0xfe]).unwrap();
    let owner = Uuid::now_v7();
    let bytes = vec![42; 4096];
    let receipt = measure("bounded_upload_regression", json!({}), || {
        let session = registry
            .open_file_upload(id, owner, &upload_request(&bytes))
            .unwrap();
        registry
            .put_file_upload_chunk(id, owner, session.transfer_id, 0, &bytes)
            .unwrap();
        registry
            .commit_file_upload(id, owner, session.transfer_id)
            .unwrap()
    });
    WORK.with(|work| {
        let work = work.borrow();
        assert_eq!(work.get("snapshot_captures").copied().unwrap_or(0), 0);
        assert_eq!(work.get("inventory_hash_bytes"), Some(&4096));
        assert_eq!(work.get("index_rows_inserted"), Some(&1));
        assert!(work.get("index_rows_loaded").copied().unwrap_or(0) <= 4);
    });
    measure("bounded_download_regression", json!({}), || {
        registry
            .open_file_download(
                id,
                owner,
                &OpenFileDownloadRequest {
                    protocol_version: FILE_PROTOCOL_VERSION,
                    message_type: OpenFileDownloadRequestKind::OpenFileDownload,
                    transfer_id: Uuid::now_v7(),
                    file_id: receipt.file.file_id,
                    revision: Some(receipt.file.revision),
                },
                |_| Ok(()),
            )
            .unwrap();
    });
    WORK.with(|work| {
        let work = work.borrow();
        assert_eq!(work.get("index_rows_loaded"), Some(&2));
        assert_eq!(work.get("transfer_hash_bytes").copied().unwrap_or(0), 0);
    });
}

#[test]
fn unchanged_integrity_scan_does_not_rewrite_index_rows() {
    let (_dir, registry, id) = fixture(2, 4);
    measure("unchanged_index_regression", json!({}), || {
        registry.reconcile_files(id).unwrap()
    });
    WORK.with(|work| {
        let work = work.borrow();
        assert_eq!(work.get("index_rows_inserted").copied().unwrap_or(0), 0);
        assert_eq!(work.get("index_rows_deleted").copied().unwrap_or(0), 0);
    });
}

#[test]
fn chunk_acknowledgements_do_not_enumerate_resume_state() {
    let (_dir, registry, id) = fixture(0, 0);
    let owner = Uuid::now_v7();
    let bytes = vec![42; 8 * mdbase_connect_protocol::DEFAULT_FILE_CHUNK_BYTES as usize];
    let session = registry
        .open_file_upload(id, owner, &upload_request(&bytes))
        .unwrap();
    measure("bounded_chunk_ack_regression", json!({}), || {
        for (index, bytes) in bytes
            .chunks(mdbase_connect_protocol::DEFAULT_FILE_CHUNK_BYTES as usize)
            .enumerate()
            .rev()
        {
            registry
                .file_transfer_session(id, owner, session.transfer_id)
                .unwrap();
            registry
                .put_file_upload_chunk(id, owner, session.transfer_id, index as u64, bytes)
                .unwrap();
            registry
                .put_file_upload_chunk(id, owner, session.transfer_id, index as u64, bytes)
                .unwrap();
        }
    });
    WORK.with(|work| {
        assert_eq!(
            work.borrow().get("chunk_status_rows").copied().unwrap_or(0),
            0
        )
    });
    let status = registry
        .file_transfer_status(id, owner, session.transfer_id)
        .unwrap();
    assert_eq!(status.received, (0..8).collect::<Vec<_>>());
    assert_eq!(status.received_bytes, bytes.len() as u64);
}

#[test]
fn targeted_upload_rejects_structural_and_portable_alias_targets() {
    let (dir, registry, id) = fixture(0, 0);
    let root = dir.path().join("collection");
    std::fs::create_dir(root.join("Photos")).unwrap();
    std::fs::write(root.join("Photos/Existing.bin"), b"keep").unwrap();
    for path in [
        "schemas/custom.json",
        "mdbase.lock.yaml",
        "mdbase.provisions.yaml",
        "MDBASE.yaml",
        "photos/new.bin",
        "Photos/existing.bin",
    ] {
        let mut request = upload_request(b"replace");
        request.path = path.into();
        assert!(
            registry
                .open_file_upload(id, Uuid::now_v7(), &request)
                .is_err(),
            "accepted {path}"
        );
    }
    assert_eq!(
        std::fs::read(root.join("Photos/Existing.bin")).unwrap(),
        b"keep"
    );
}

#[test]
fn same_size_same_mtime_edit_still_fails_the_upload_revision_check() {
    let (dir, registry, id) = fixture(0, 1);
    let path = dir.path().join("collection/file-0.bin");
    let current = registry.indexed_files(id).unwrap().pop().unwrap();
    let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
    let mut request = upload_request(b"replacement");
    request.path = current.path;
    request.if_revision = Some(current.revision);
    let owner = Uuid::now_v7();
    let session = registry.open_file_upload(id, owner, &request).unwrap();
    registry
        .put_file_upload_chunk(id, owner, session.transfer_id, 0, b"replacement")
        .unwrap();
    std::fs::write(&path, vec![99; 1024 * 1024]).unwrap();
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(modified))
        .unwrap();
    let error = registry
        .commit_file_upload(id, owner, session.transfer_id)
        .unwrap_err();
    assert_eq!(error.code(), "stale_file_revision");
    assert_eq!(std::fs::read(&path).unwrap()[0], 99);
}

#[cfg(unix)]
#[test]
fn unchanged_descriptor_still_updates_replaced_physical_identity() {
    let (dir, registry, id) = fixture(0, 1);
    let path = dir.path().join("collection/file-0.bin");
    let old = registry.indexed_files(id).unwrap().pop().unwrap();
    let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
    let replacement = dir.path().join("replacement");
    std::fs::write(&replacement, std::fs::read(&path).unwrap()).unwrap();
    std::fs::File::options()
        .write(true)
        .open(&replacement)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(modified))
        .unwrap();
    std::fs::rename(&replacement, &path).unwrap();
    measure("physical_identity_regression", json!({}), || {
        registry.reconcile_files(id).unwrap()
    });
    assert_eq!(registry.indexed_files(id).unwrap().pop().unwrap(), old);
    WORK.with(|work| {
        assert_eq!(work.borrow().get("index_rows_inserted"), Some(&1));
        assert_eq!(work.borrow().get("index_rows_deleted"), Some(&1));
    });
    registry
        .open_file_download(
            id,
            Uuid::now_v7(),
            &OpenFileDownloadRequest {
                protocol_version: FILE_PROTOCOL_VERSION,
                message_type: OpenFileDownloadRequestKind::OpenFileDownload,
                transfer_id: Uuid::now_v7(),
                file_id: old.file_id,
                revision: Some(old.revision),
            },
            |_| Ok(()),
        )
        .unwrap();
}

#[test]
fn point_reconciliation_preserves_pending_full_inventory_invalidation() {
    let (_dir, registry, id) = fixture(0, 2);
    registry.mark_file_inventory_dirty(id).unwrap();
    let owner = Uuid::now_v7();
    let bytes = b"small";
    let session = registry
        .open_file_upload(id, owner, &upload_request(bytes))
        .unwrap();
    registry
        .put_file_upload_chunk(id, owner, session.transfer_id, 0, bytes)
        .unwrap();
    registry
        .commit_file_upload(id, owner, session.transfer_id)
        .unwrap();
    let (observed, reconciled): (u64, u64) = registry.connection().unwrap().query_row(
        "SELECT observed_generation, reconciled_generation FROM collection_file_inventory_state WHERE collection_id = ?1",
        [id.to_string()], |row| Ok((row.get(0)?, row.get(1)?)),
    ).unwrap();
    assert!(observed > reconciled);
    assert_eq!(registry.indexed_files(id).unwrap().len(), 3);
}

#[test]
#[ignore = "optimized synthetic file-I/O observation"]
fn benchmark_file_io() {
    for (records, files) in [(0, 0), (1000, 32)] {
        let (_dir, registry, id) = fixture(records, files);
        let parameters =
            json!({"markdown_records":records,"unrelated_files":files,"file_bytes":1048576});
        measure("noop_reconcile", parameters.clone(), || {
            registry.reconcile_files(id).unwrap()
        });
        let owner = Uuid::now_v7();
        let bytes = vec![0x42; 4096];
        let receipt = measure("small_upload", parameters.clone(), || {
            let session = registry
                .open_file_upload(id, owner, &upload_request(&bytes))
                .unwrap();
            registry
                .put_file_upload_chunk(id, owner, session.transfer_id, 0, &bytes)
                .unwrap();
            registry
                .commit_file_upload(id, owner, session.transfer_id)
                .unwrap()
        });
        assert_eq!(receipt.file.size, 4096);
        measure("point_download", parameters, || {
            let session = registry
                .open_file_download(
                    id,
                    owner,
                    &OpenFileDownloadRequest {
                        protocol_version: FILE_PROTOCOL_VERSION,
                        message_type: OpenFileDownloadRequestKind::OpenFileDownload,
                        transfer_id: Uuid::now_v7(),
                        file_id: receipt.file.file_id,
                        revision: Some(receipt.file.revision.clone()),
                    },
                    |_| Ok(()),
                )
                .unwrap();
            assert_eq!(
                registry
                    .read_file_download_chunk(id, owner, session.transfer_id, 0)
                    .unwrap(),
                bytes
            );
        });
    }
    for count in [16, 128] {
        let (_dir, registry, id) = fixture(0, 0);
        let owner = Uuid::now_v7();
        let bytes = vec![0x42; count * mdbase_connect_protocol::DEFAULT_FILE_CHUNK_BYTES as usize];
        let session = registry
            .open_file_upload(id, owner, &upload_request(&bytes))
            .unwrap();
        let FileTransferStrategy::FramedChunks { chunk_size } = session.strategy else {
            panic!()
        };
        measure(
            "upload_chunks",
            json!({"chunks":count,"chunk_bytes":chunk_size}),
            || {
                for (index, bytes) in bytes.chunks(chunk_size as usize).enumerate() {
                    registry
                        .put_file_upload_chunk(id, owner, session.transfer_id, index as u64, bytes)
                        .unwrap();
                }
            },
        );
        assert_eq!(
            registry
                .file_transfer_status(id, owner, session.transfer_id)
                .unwrap()
                .received
                .len(),
            count
        );
    }
}
