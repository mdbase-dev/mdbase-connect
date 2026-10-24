//! Signed real FileStore/Durable SQLite conflict holds, not a seeded hold row.
use super::*;
use w::{
    attachment::FileContent,
    attachment_runtime_v1 as rt,
    client::{HoldReason, ReceiptState},
    entry::Status,
    snapshot::TextOrBlob,
};
const PATH: &str = "photo.bin";

fn disk(
    dir: &std::path::Path,
    label: &str,
    replica: u8,
) -> Replica<FileStore<NativePlatform, SqlStore<SqliteIndex>, SqlDiskDb<SqliteIndex>>> {
    let vault = dir.join(label);
    fs::create_dir_all(&vault).unwrap();
    let index = Rc::new(RefCell::new(
        SqliteIndex::open(dir.join(format!("{label}.db")), IndexDurability::Durable).unwrap(),
    ));
    let store = FileStore::open(
        Rc::new(platform(&vault)),
        SqlStore::open(index.clone()).unwrap(),
        SqlDiskDb::open(index).unwrap(),
        Box::new(mdbn_core::host::FixedClock(1700000000000)),
        Config::default(),
    )
    .unwrap();
    open_store(store, replica)
}

#[test]
fn signed_external_binary_conflict_preserves_user_bytes_in_real_files_after_cold_reopen() {
    let dir = scratch("signed-binary-conflict-hold");
    let svc = r::fake::FakeLogService::new();
    r::testkit::TestControlPlane::signed(COL).genesis_with_keys(
        &svc,
        CState::E2e,
        DEV,
        &[0x31; 32],
        &[0x32; 32],
    );
    let mut winner = disk(&dir, "winner", 1);
    let mut origin = disk(&dir, "origin", 2);
    settle(&mut winner, &svc);
    settle(&mut origin, &svc);
    fs::write(dir.join("winner").join(PATH), b"base").unwrap();
    winner.observe(None).unwrap();
    settle(&mut winner, &svc);
    origin.on_log_push(LogPush::Head {
        collection: COL,
        head: winner.head().seq,
        head_chain: winner.head().chain,
    });
    settle(&mut origin, &svc);
    let id = origin
        .store()
        .file_at(&mdbn_core::paths::path_key(PATH))
        .unwrap()
        .unwrap();
    assert_eq!(fs::read(dir.join("origin").join(PATH)).unwrap(), b"base");
    let lost = b"offline native binary\0\xff";
    fs::write(dir.join("origin").join(PATH), lost).unwrap();
    origin.observe(Some(&[PATH.to_string()])).unwrap();
    let mut log = svc.client(DEV);
    let mut pending = None;
    for _ in 0..100 {
        if let Some(row) = origin.store().pending(None, 256).unwrap().first() {
            pending = Some(row.clone());
            break;
        }
        for call in origin.take_log_calls() {
            assert!(
                !matches!(call.request, LogRequest::Append { .. }),
                "origin is still offline for ordering"
            );
            let reply = log.call(call.request);
            origin.on_log_reply(call.id, reply);
        }
    }
    let pending = pending.expect("streamed capture before rival result");
    let rt::Op::FileAttach(edit) = &pending.mutation.ops[0] else {
        panic!("attachment capture")
    };
    let mine = edit.content.clone();
    assert_eq!(
        edit.base,
        Some(w::hash::sha256(b"base")),
        "external observation must bind prior bytes"
    );
    fs::write(
        dir.join("winner").join(PATH),
        b"winning native bytes are different",
    )
    .unwrap();
    winner.observe(Some(&[PATH.to_string()])).unwrap();
    settle(&mut winner, &svc);
    let kept = winner.store().file(&id).unwrap().unwrap().content;
    assert_eq!(
        kept.plain_hash(),
        w::hash::sha256(b"winning native bytes are different"),
        "rival must genuinely capture before origin orders"
    );
    settle(&mut origin, &svc);
    let receipt = origin
        .store()
        .local_receipt(&pending.mutation.id)
        .unwrap()
        .unwrap();
    assert_eq!(receipt.state, ReceiptState::Confirmed);
    assert_eq!(receipt.status, Some(Status::Conflicted));
    let held = origin
        .store()
        .hold(&id)
        .unwrap()
        .expect("origin binary conflict hold");
    assert_eq!(held.reason, HoldReason::Conflict);
    assert_eq!(held.mine, TextOrBlob::Attachment(mine.clone()));
    let FileContent::AttachmentV1(kept_descriptor) = &kept else {
        panic!("typed winner")
    };
    assert_eq!(
        held.theirs,
        Some(TextOrBlob::Attachment(kept_descriptor.clone()))
    );
    assert_eq!(origin.store().file(&id).unwrap().unwrap().content, kept);
    assert_eq!(fs::read(dir.join("origin").join(PATH)).unwrap(), lost);
    assert!(
        origin
            .store()
            .conflicts(Some(&id))
            .unwrap()
            .iter()
            .any(|c| c.mutation == pending.mutation.id
                && c.conflict.lost == rt::ConflictValue::Attachment(mine.clone()))
    );
    drop(origin);
    let mut reopened = disk(&dir, "origin", 2);
    assert_eq!(
        reopened.store().hold(&id).unwrap(),
        Some(held.clone()),
        "persisted complete typed hold"
    );
    assert_eq!(
        fs::read(dir.join("origin").join(PATH)).unwrap(),
        lost,
        "open must not reconcile over hold"
    );
    settle(&mut reopened, &svc);
    assert_eq!(reopened.store().file(&id).unwrap().unwrap().content, kept);
    assert_eq!(
        fs::read(dir.join("origin").join(PATH)).unwrap(),
        lost,
        "late/repeated reads must not publish over hold"
    );
    assert_eq!(reopened.store().hold(&id).unwrap(), Some(held));
    assert!(winner.store().hold(&id).unwrap().is_none());
}
