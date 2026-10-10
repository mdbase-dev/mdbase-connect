//! A local-only collection served by the real runtime: a host session creates a
//! record, the file appears, the receipt is confirmed with no `seq`; an outside
//! edit is ingested.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::path::PathBuf;
use std::time::Duration;

use mdbn_daemon::runtime::{Runtime, RuntimeConfig};
use mdbn_replica::DeviceSecrets;
use mdbn_replica::api::SessionAuth;
use mdbn_wire::Wire;
use mdbn_wire::client::{
    ClientFrame, ClientRequest, HelloParams, PublishState, Receipt, ReceiptState, SubmitParams,
    WaitFor,
};
use mdbn_wire::common::{B16, Text, Version};
use mdbn_wire::intent::{Create, Op};

fn scratch(tag: &str) -> PathBuf {
    let p = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("{tag}{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(&p).unwrap();
    p
}

/// No local grants, no owner: only the hosting app's own sessions are served.
struct NoAuthority;

impl mdbn_replica::policy::GrantSource for NoAuthority {
    fn grant(&self, _: &B16) -> Option<mdbn_replica::policy::EffectiveGrant> {
        None
    }
}

fn req(id: u64, method: &str, params: mdbn_wire::cbor::Cbor) -> Vec<u8> {
    ClientFrame::Request(ClientRequest {
        id,
        method: method.into(),
        params,
    })
    .to_bytes()
    .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_only_write_is_confirmed_once_published() {
    let root = scratch("rt");
    let folder = root.join("notes");
    std::fs::create_dir_all(&folder).unwrap();
    let cfg = RuntimeConfig {
        collection: [1; 16],
        replica_id: [2; 16],
        device_id: [3; 16],
        root: folder.clone(),
        private_dir: root.join("state"),
        sync: None,
    };
    let secrets = DeviceSecrets {
        sign_sk: [4; 32],
        kem_sk: [5; 32],
    };
    let rt = Runtime::open(
        cfg.clone(),
        secrets.clone(),
        Box::new(NoAuthority),
        Default::default(),
    )
    .unwrap();
    let hello = HelloParams {
        versions: vec![Version { major: 1, minor: 0 }],
        client_name: "test".into(),
        client_version: "0".into(),
        features: None,
        timezone: None,
    };
    let (session, resp, mut out) = rt
        .hello(SessionAuth::Host, req(0, "hello", hello.to_cbor()))
        .await
        .unwrap();
    let session =
        session.unwrap_or_else(|| panic!("hello refused: {:?}", ClientFrame::from_bytes(&resp)));

    let submit = SubmitParams {
        ops: vec![Op::Create(Create {
            id: B16([9; 16]),
            path: Some("hello.md".into()),
            type_name: None,
            frontmatter: None,
            body: None,
            document: Some(Text::Inline("---\ntitle: Hi\n---\nBody\n".into())),
        })],
        mutation_id: None,
        conflict_mode: None,
        timezone: None,
        allow_partial: None,
        mutation_ids: None,
        dry_run: None,
        include: None,
        wait: Some(WaitFor::Confirmed),
    };
    assert!(rt.frame(session, req(1, "submit", submit.to_cbor())));
    let receipt = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let bytes = out.recv().await.expect("session open");
            if let ClientFrame::Response(r) = ClientFrame::from_bytes(&bytes).unwrap()
                && r.id == 1
            {
                assert!(r.problem.is_none(), "{:?}", r.problem);
                let rs: Vec<Receipt> = Wire::from_cbor(&r.result.unwrap()).unwrap();
                break rs.into_iter().next().unwrap();
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(receipt.state, ReceiptState::Confirmed);
    assert_eq!(receipt.seq, None, "local-only: no log position");
    let text = std::fs::read_to_string(folder.join("hello.md")).unwrap();
    assert!(text.contains("title: Hi"), "{text}");

    // wait: published (SDK/Obsidian): answered once the file holds the write.
    let mut submit2 = submit.clone();
    submit2.wait = Some(WaitFor::Published);
    if let Op::Create(c) = &mut submit2.ops[0] {
        c.id = B16([10; 16]);
        c.path = Some("published.md".into());
        c.document = Some(Text::Inline("---\ntitle: Pub\n---\n".into()));
    }
    assert!(rt.frame(session, req(2, "submit", submit2.to_cbor())));
    let receipt = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let bytes = out.recv().await.expect("session open");
            if let ClientFrame::Response(r) = ClientFrame::from_bytes(&bytes).unwrap()
                && r.id == 2
            {
                assert!(r.problem.is_none(), "{:?}", r.problem);
                let rs: Vec<Receipt> = Wire::from_cbor(&r.result.unwrap()).unwrap();
                break rs.into_iter().next().unwrap();
            }
        }
    })
    .await
    .expect("wait: published answered");
    assert_eq!(receipt.published, Some(PublishState::Published));
    assert!(
        std::fs::read_to_string(folder.join("published.md"))
            .unwrap()
            .contains("title: Pub")
    );

    // A grants barrier is answered by the running runtime, after the submit above.
    tokio::time::timeout(Duration::from_secs(10), rt.grants_barrier())
        .await
        .expect("grants barrier answered");

    // Restart: the record survives in the durable index.
    rt.stop().await;
    // A stopped runtime has nothing in flight: the barrier returns at once.
    tokio::time::timeout(Duration::from_secs(1), rt.grants_barrier())
        .await
        .expect("barrier on a stopped runtime returns");
    let rt = Runtime::open(cfg, secrets, Box::new(NoAuthority), Default::default()).unwrap();
    let (session, _, _out) = rt
        .hello(SessionAuth::Host, req(0, "hello", hello.to_cbor()))
        .await
        .unwrap();
    assert!(session.is_some());
    rt.stop().await;
    let _ = std::fs::remove_dir_all(&root);
}

/// Without a watcher, the periodic observe rescans the folder: a file written there
/// from outside becomes a confirmed record without any session write.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_only_external_edit_is_ingested() {
    let root = scratch("ext");
    let folder = root.join("notes");
    std::fs::create_dir_all(&folder).unwrap();
    let cfg = RuntimeConfig {
        collection: [6; 16],
        replica_id: [7; 16],
        device_id: [8; 16],
        root: folder.clone(),
        private_dir: root.join("state"),
        sync: None,
    };
    let secrets = DeviceSecrets {
        sign_sk: [4; 32],
        kem_sk: [5; 32],
    };
    let rt = Runtime::open(cfg, secrets, Box::new(NoAuthority), Default::default()).unwrap();
    let before = rt.confirmed_digest().await.unwrap();
    std::fs::write(folder.join("outside.md"), "written by another program\n").unwrap();
    let mut after = before;
    for _ in 0..50 {
        tokio::time::sleep(Duration::from_millis(200)).await;
        after = rt.confirmed_digest().await.unwrap();
        if after.0 == before.0 + 1 {
            break;
        }
    }
    assert_eq!(
        after.0,
        before.0 + 1,
        "the external file became a confirmed record"
    );
    rt.stop().await;
}

/// With the native watcher, an external edit is ingested well before the periodic
/// safety-net rescan (60 s when watched).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_watched_external_edit_is_ingested_promptly() {
    let root = scratch("watched");
    let folder = root.join("notes");
    std::fs::create_dir_all(&folder).unwrap();
    let cfg = RuntimeConfig {
        collection: [9; 16],
        replica_id: [10; 16],
        device_id: [11; 16],
        root: folder.clone(),
        private_dir: root.join("state"),
        sync: None,
    };
    let secrets = DeviceSecrets {
        sign_sk: [4; 32],
        kem_sk: [5; 32],
    };
    let rt = Runtime::open(cfg, secrets, Box::new(NoAuthority), Default::default()).unwrap();
    let before = rt.confirmed_digest().await.unwrap();
    let t = std::time::Instant::now();
    std::fs::write(folder.join("watched.md"), "seen by the watcher\n").unwrap();
    let mut after = before;
    while t.elapsed() < Duration::from_secs(10) {
        tokio::time::sleep(Duration::from_millis(25)).await;
        after = rt.confirmed_digest().await.unwrap();
        if after.0 == before.0 + 1 {
            break;
        }
    }
    assert_eq!(after.0, before.0 + 1);
    assert!(
        t.elapsed() < Duration::from_secs(5),
        "ingested in {:?}",
        t.elapsed()
    );
    rt.stop().await;
}
