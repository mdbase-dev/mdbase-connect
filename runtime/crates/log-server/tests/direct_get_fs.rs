//! Bounded TEST-ONLY backing-file size checks; no live OOM or allocator claim.
use mdbn_log_server::fs::FsObjects;
use mdbn_log_service::backend::ObjectStore;
use mdbn_log_service::{Code, limits::MAX_OBJECT_BYTES};

#[tokio::test]
async fn sparse_backing_file_over_cap_is_refused_even_for_a_one_byte_range() {
    let root = std::path::PathBuf::from("target").join(format!(
        "mdbn-direct-fs-{}-{}",
        std::process::id(),
        mdbn_log_service::testkit::id16("direct-get/sparse").to_hex()
    ));
    tokio::fs::create_dir_all(root.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::create_dir(&root)
        .await
        .expect("unique fixture directory");
    let store = FsObjects::new(root.clone());
    let path = root.join("object");
    let file = tokio::fs::File::create(&path).await.unwrap();
    file.set_len(MAX_OBJECT_BYTES + 1).await.unwrap();
    assert_eq!(file.metadata().await.unwrap().len(), MAX_OBJECT_BYTES + 1);
    // Metadata is actual file length: a legal requested slice cannot hide an
    // oversized backing object. Fixtures are only 9 MiB + 1 logical byte.
    for range in [None, Some((0, 1)), Some((MAX_OBJECT_BYTES, 1))] {
        let e = store
            .get("object", range)
            .await
            .expect_err("oversized backing object must be refused before read/allocation");
        assert_eq!(e.code, Code::Unavailable);
        assert_eq!(e.message.as_deref(), Some("object size"));
    }
    file.set_len(MAX_OBJECT_BYTES).await.unwrap();
    assert_eq!(
        store
            .get("object", Some((MAX_OBJECT_BYTES - 1, 1)))
            .await
            .unwrap(),
        Some(vec![0])
    );
    let all = store.get("object", None).await.unwrap().unwrap();
    assert_eq!(all.len() as u64, MAX_OBJECT_BYTES);
    assert!(all.iter().all(|b| *b == 0));
    assert!(
        store
            .get("object", Some((MAX_OBJECT_BYTES, 1)))
            .await
            .is_err()
    );
    assert_eq!(store.get("missing", None).await.unwrap(), None);
    drop(file);
    tokio::fs::remove_dir_all(root).await.unwrap();
}
