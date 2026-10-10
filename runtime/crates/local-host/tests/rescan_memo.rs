//! Warm open and rescan over the real native composition: attachments that a
//! local-only replica leaves unacknowledged are hashed once and remembered
//! (size, times, file ID -> revision) across reopens; edits made while the
//! folder was closed are still picked up, for notes and for attachments.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::path::{Path, PathBuf};

use mdbn_local_host::{
    Descriptor, HostKind, HostLock, Identity, LocalReplica, OsEntropy, ReplicaOptions,
    StoreOptions, SystemClock, open_store,
};
use mdbn_replica::store::Store;

fn test_dir(tag: &str) -> PathBuf {
    let p =
        PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(&p).unwrap();
    p
}

fn open(root: &Path) -> (HostLock, LocalReplica) {
    let opts = StoreOptions::default();
    let lock = HostLock::try_acquire(
        root,
        &opts.private_dir,
        Some(Descriptor::new(HostKind::Library, 1)),
    )
    .unwrap();
    let state = opts.state_dir(root);
    std::fs::create_dir_all(&state).unwrap();
    let identity =
        Identity::load_or_create(&state.join("identity.json"), 1, &mut OsEntropy).unwrap();
    let store = open_store(root, &opts, Box::new(SystemClock)).unwrap();
    let rep = LocalReplica::open(store, &identity, ReplicaOptions::default()).unwrap();
    (lock, rep)
}

fn doc(rep: &LocalReplica, path: &str) -> Option<String> {
    let store = rep.replica_ref().store();
    let id = store
        .record_at(&mdbn_core::paths::path_key(path))
        .unwrap()?;
    Some(store.record(&id).unwrap().unwrap().doc)
}

#[test]
fn warm_open_reuses_attachment_hashes_and_sees_edits_made_while_closed() {
    let root = test_dir("rescan-memo");
    std::fs::write(root.join("mdbase.yaml"), "spec_version: \"0.3.0\"\n").unwrap();
    std::fs::create_dir_all(root.join("media")).unwrap();
    std::fs::write(root.join("note.md"), "one\n").unwrap();
    std::fs::write(root.join("media/a.png"), vec![7u8; 300_000]).unwrap();
    std::fs::write(root.join("media/b.png"), vec![8u8; 300_000]).unwrap();

    let (lock, mut rep) = open(&root);
    rep.rescan().unwrap();
    assert_eq!(doc(&rep, "note.md").as_deref(), Some("one\n"));
    assert_eq!(rep.replica_ref().store().stats.files_streamed, 2);
    rep.rescan().unwrap();
    assert_eq!(
        rep.replica_ref().store().stats.files_streamed,
        2,
        "a rescan does not hash unchanged attachments again"
    );
    drop(rep.close());
    drop(lock);

    // Reopen: nothing changed, nothing hashed.
    let (lock, mut rep) = open(&root);
    rep.rescan().unwrap();
    let stats = rep.replica_ref().store().stats.clone();
    assert_eq!(stats.files_streamed, 0, "{stats:?}");
    assert_eq!(stats.hashes_reused, 2, "{stats:?}");
    drop(rep.close());
    drop(lock);

    // Edited while closed: a note (same size) and an attachment.
    std::thread::sleep(std::time::Duration::from_millis(20));
    std::fs::write(root.join("note.md"), "two\n").unwrap();
    std::fs::write(root.join("media/a.png"), vec![9u8; 300_000]).unwrap();
    let (_lock, mut rep) = open(&root);
    rep.rescan().unwrap();
    assert_eq!(doc(&rep, "note.md").as_deref(), Some("two\n"));
    let stats = rep.replica_ref().store().stats.clone();
    assert_eq!(
        stats.files_streamed, 1,
        "only the edited attachment: {stats:?}"
    );
    assert_eq!(stats.hashes_reused, 1, "{stats:?}");
    let _ = std::fs::remove_dir_all(&root);
}
