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
