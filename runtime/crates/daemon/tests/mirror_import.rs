//! An old hosted mirror's unsent edits survive the move: the takeover captures
//! them (instead of waiting for a queue that can never drain) and they are
//! imported into the collection through the real replica, across a crash.
//!
//! The device has a local collection (taken over) and a hosted mirror whose queue
//! holds a create, a change, a rename, a delete, a non-UTF-8 edit and a change
//! that conflicts with the server. The collection runs on the real runtime.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::path::{Path, PathBuf};
use std::time::Duration;

use mdbn_daemon::runtime::{Runtime, RuntimeConfig};
use mdbn_daemon::takeover::held::{self, Outcome};
use mdbn_daemon::takeover::mirror_import::{self, Current, Target};
use mdbn_daemon::takeover::record::{CollectionState, Record, State};
use mdbn_daemon::takeover::{self, IsolatedOldService, Options, Paths};
use mdbn_replica::DeviceSecrets;
use mdbn_replica::api::SessionAuth;
use mdbn_wire::Wire;
use mdbn_wire::cbor::Cbor;
use mdbn_wire::client::{
    ClientFrame, ClientRequest, HelloParams, Include, Receipt, ReceiptState, RecordView,
    SubmitParams, WaitFor,
};
use mdbn_wire::common::{B16, Text, Version};
use mdbn_wire::intent::{Create, Op};

#[path = "fixtures/old_agent.rs"]
mod old_agent;

#[path = "fixtures/hosted_mirror.rs"]
mod hosted_mirror;
use hosted_mirror::{BINARY, HOSTED, RA, RB, RC, RD, RE, RU};

fn scratch(tag: &str) -> PathBuf {
    let p = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("{tag}{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(&p).unwrap();
    p
}

struct NoAuthority;

impl mdbn_replica::policy::GrantSource for NoAuthority {
    fn grant(&self, _: &B16) -> Option<mdbn_replica::policy::EffectiveGrant> {
        None
    }
}

fn uuid(s: &str) -> [u8; 16] {
    let hex = s.replace('-', "");
    let mut b = [0u8; 16];
    for (i, out) in b.iter_mut().enumerate() {
        *out = u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap();
    }
    b
}

/// A UUIDv7-shaped ID, distinct per call.
fn v7(seq: &mut u16) -> [u8; 16] {
    *seq += 1;
    let mut b = [0u8; 16];
    b[..6].copy_from_slice(&[0x01, 0x92, 0xf0, 0xc1, 0x7e, 0x1a]);
    b[6] = 0x70;
    b[8] = 0x80;
    b[14..].copy_from_slice(&seq.to_be_bytes());
    b
}

/// The joined hosted collection's replica, as the hosting app sees it.
struct Collection {
    rt: Runtime,
    session: mdbn_replica::api::SessionId,
    out: tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
    next: u64,
    /// Simulate a crash: after this many more submits, the reply is lost.
    lose_reply_after: Option<usize>,
}

fn cfg(root: &Path) -> RuntimeConfig {
    RuntimeConfig {
        collection: uuid(HOSTED),
        replica_id: [2; 16],
        device_id: [3; 16],
        root: root.join("Hosted (joined)"),
        private_dir: root.join("state/collections").join(HOSTED),
        adopt: None,
        id_hints: vec![],
        computer_name: None,
        sync: None,
    }
}

impl Collection {
    async fn open(root: &Path) -> Collection {
        let c = cfg(root);
        std::fs::create_dir_all(&c.root).unwrap();
        let rt = Runtime::open(
            c,
            DeviceSecrets {
                sign_sk: [4; 32],
                kem_sk: [5; 32],
            },
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
        let (session, resp, out) = rt
            .hello(SessionAuth::Host, frame(0, "hello", hello.to_cbor()))
            .await
            .unwrap();
        let session = session
            .unwrap_or_else(|| panic!("hello refused: {:?}", ClientFrame::from_bytes(&resp)));
        Collection {
            rt,
            session,
            out,
            next: 1,
            lose_reply_after: None,
        }
    }

    async fn call(&mut self, method: &str, params: Cbor) -> Result<Cbor, String> {
        let id = self.next;
        self.next += 1;
        assert!(self.rt.frame(self.session, frame(id, method, params)));
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                let bytes = self.out.recv().await.expect("session open");
                if let ClientFrame::Response(r) = ClientFrame::from_bytes(&bytes).unwrap()
                    && r.id == id
                {
                    return match r.problem {
                        Some(p) => Err(p.code),
                        None => Ok(r.result.unwrap_or(Cbor::Null)),
                    };
                }
            }
        })
        .await
        .unwrap()
    }

    async fn view(&mut self, key: &str) -> Option<RecordView> {
        let reference = if key.len() == 36 && key.as_bytes()[8] == b'-' {
            B16(uuid(key)).to_cbor()
        } else {
            Cbor::Text(key.into())
        };
        let include = Include {
            effective: None,
            body: None,
            document: Some(true),
            diagnostics: None,
        };
        match self
            .call(
                "get",
                Cbor::Map(vec![
                    (Cbor::Uint(0), reference),
                    (Cbor::Uint(1), include.to_cbor()),
                ]),
            )
            .await
        {
            Ok(v) => Some(RecordView::from_cbor(&v).unwrap()),
            Err(code) if code == "not_found" => None,
            Err(code) => panic!("get {key}: {code}"),
        }
    }

    async fn doc(&mut self, key: &str) -> Option<(String, String)> {
        self.view(key).await.map(|v| (v.path, v.document.unwrap()))
    }

    async fn stop(self) {
        self.rt.stop().await;
    }
}

fn frame(id: u64, method: &str, params: Cbor) -> Vec<u8> {
    ClientFrame::Request(ClientRequest {
        id,
        method: method.into(),
        params,
    })
    .to_bytes()
    .unwrap()
}

fn outcome(state: ReceiptState) -> Outcome {
    match state {
        ReceiptState::Pending => Outcome::Pending,
        ReceiptState::Confirmed => Outcome::Confirmed,
        ReceiptState::Unknown => Outcome::Unknown,
        ReceiptState::Rejected => Outcome::Rejected,
    }
}

impl Target for Collection {
    async fn get(&mut self, key: &str) -> std::io::Result<Option<Current>> {
        Ok(self.view(key).await.map(|v| Current {
            id: v.id.0,
            path: v.path,
            revision: v.revision.0,
            document: v.document.unwrap(),
        }))
    }

    async fn submit(&mut self, ops: Vec<Op>, mutation: [u8; 16]) -> std::io::Result<Outcome> {
        let submit = SubmitParams {
            ops,
            mutation_id: Some(B16(mutation)),
            conflict_mode: None,
            timezone: None,
            allow_partial: None,
            mutation_ids: None,
            dry_run: None,
            include: None,
            wait: Some(WaitFor::Confirmed),
        };
        let result = self
            .call("submit", submit.to_cbor())
            .await
            .map_err(std::io::Error::other)?;
        let receipts: Vec<Receipt> = Wire::from_cbor(&result).unwrap();
        let state = receipts[0].state;
        if let Some(n) = self.lose_reply_after.as_mut() {
            if *n == 0 {
                return Err(std::io::Error::other(
                    "crashed before the reply was recorded",
                ));
            }
            *n -= 1;
        }
        Ok(outcome(state))
    }

    async fn receipt(&mut self, mutation: [u8; 16]) -> std::io::Result<Option<Outcome>> {
        match self
            .call(
                "receipt",
                Cbor::Map(vec![(Cbor::Uint(0), B16(mutation).to_cbor())]),
            )
            .await
        {
            Ok(v) => Ok(Some(outcome(Receipt::from_cbor(&v).unwrap().state))),
            Err(code) if code == "not_found" => Ok(None),
            Err(code) => Err(std::io::Error::other(code)),
        }
    }
}

/// Seed the collection as the server had it at cutover (legacy record IDs kept).
async fn seed(c: &mut Collection, seq: &mut u16) {
    for (rid, path, doc) in hosted_mirror::server_records() {
        let ops = vec![Op::Create(Create {
            id: B16(uuid(rid)),
            path: Some(path.into()),
            type_name: None,
            frontmatter: None,
            body: None,
            document: Some(Text::Inline(doc.into())),
        })];
        assert_eq!(c.submit(ops, v7(seq)).await.unwrap(), Outcome::Confirmed);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unsent_mirror_edits_are_captured_at_takeover_and_imported_across_a_crash() {
    let root = scratch("mimp");
    let old = root.join("connect");
    let notes = root.join("notes");
    old_agent::build(&old, &notes);
    let mirror_folder = root.join("Hosted notes");
    hosted_mirror::build(&old, &mirror_folder);
    let state = root.join("state");
    std::fs::create_dir_all(&state).unwrap();
    let paths = Paths::new(&state, state.join("store-ids.json"));
    let snapshot = |p: &Path| -> Vec<(PathBuf, Vec<u8>)> {
        let mut out = Vec::new();
        let mut stack = vec![p.to_path_buf()];
        while let Some(d) = stack.pop() {
            for e in std::fs::read_dir(&d).unwrap().flatten() {
                if e.file_type().unwrap().is_dir() {
                    stack.push(e.path());
                } else {
                    out.push((e.path(), std::fs::read(e.path()).unwrap()));
                }
            }
        }
        out.sort();
        out
    };
    let old_mirror_state = snapshot(&old.join("mirrors"));
    let old_mirror_folder = snapshot(&mirror_folder);

    // The account has moved: the takeover no longer waits for the mirror queue.
    let ran = takeover::run(
        &paths,
        &old,
        &mut IsolatedOldService,
        &Options {
            stop_mirrors: false,
            account_moved: true,
            drain: Duration::ZERO,
            now: "2026-10-18T09:00:00Z".into(),
        },
    )
    .unwrap();
    let record = ran.record.unwrap();
    assert_eq!(record.state, State::Complete, "{record:?}");
    assert_eq!(
        record.collections[old_agent::CID].state,
        CollectionState::Held,
        "the local collection was taken over"
    );
    assert_eq!(
        Record::load(&paths.record).unwrap().unwrap().state,
        State::Complete
    );
    let st = mirror_import::status(&paths.legacy, HOSTED)
        .unwrap()
        .unwrap();
    assert_eq!(st["edits"], 6);
    assert_eq!(st["complete"], false);

    // The hosted collection, joined on this device, as the server had it.
    let mut seq = 0u16;
    let mut c = Collection::open(&root).await;
    seed(&mut c, &mut seq).await;

    // The daemon dies after the second write reached the replica but before
    // its outcome was recorded.
    c.lose_reply_after = Some(1);
    let mut fresh = || v7(&mut seq);
    assert!(
        mirror_import::import(&paths.legacy, HOSTED, &mut c, &mut fresh)
            .await
            .is_err()
    );
    c.stop().await;

    // Restarted: the import resumes from disk and completes.
    let mut c = Collection::open(&root).await;
    let mut seq2 = 1000u16;
    let mut fresh = || v7(&mut seq2);
    let pass = mirror_import::import(&paths.legacy, HOSTED, &mut c, &mut fresh)
        .await
        .unwrap();
    assert!(pass.complete, "{pass:?}");

    // Change, rename, delete and create arrived; each exactly once.
    assert_eq!(c.doc(RA).await, Some(("a.md".into(), "A edited".into())));
    assert_eq!(c.doc(RB).await, Some(("sub/b2.md".into(), "B".into())));
    // The old path is an alias of the moved record, not a second record.
    assert_eq!(c.view("b.md").await.map(|v| v.id.0), Some(uuid(RB)));
    assert_eq!(c.doc(RC).await, None, "deleted");
    assert_eq!(c.doc("n.md").await.map(|d| d.1).as_deref(), Some("New"));
    assert_eq!(c.doc(RU).await, Some(("u.md".into(), "U".into())));
    // The conflict keeps the server's version and holds the unsent one.
    assert_eq!(c.doc(RE).await, Some(("e.md".into(), "E theirs".into())));
    let holds = held::open(&paths.legacy, HOSTED).unwrap();
    assert_eq!(holds.len(), 1, "{holds:?}");
    assert_eq!(holds[0].path, "e.md");
    assert!(holds[0].unsent);
    assert_eq!(holds[0].intended.as_deref(), Some(&b"E mine"[..]));
    // The non-UTF-8 edit is not applied; its bytes stay in the owned capture.
    assert_eq!(c.doc(RD).await, Some(("d.md".into(), "D".into())));
    let st = mirror_import::status(&paths.legacy, HOSTED)
        .unwrap()
        .unwrap();
    assert_eq!(st["complete"], true);
    assert_eq!(st["applied"], 4, "{st}");
    assert_eq!(st["held"], 1);
    let file = PathBuf::from(st["recovered"][0]["file"].as_str().unwrap());
    let digest: String = mdbn_wire::hash::sha256(&BINARY)
        .0
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(
        file,
        mirror_import::dir(&paths.legacy, HOSTED)
            .unwrap()
            .join("bytes")
            .join(digest)
    );
    assert_eq!(std::fs::read(&file).unwrap(), BINARY);
    // The files on disk follow the collection.
    let joined = cfg(&root).root;
    assert_eq!(std::fs::read(joined.join("a.md")).unwrap(), b"A edited");
    assert!(!joined.join("c.md").exists());

    // Running again writes nothing.
    let pass = mirror_import::import(&paths.legacy, HOSTED, &mut c, &mut fresh)
        .await
        .unwrap();
    assert_eq!(pass.settled, 0);
    assert!(pass.complete);

    // The old mirror's queue and folder are exactly as they were.
    assert_eq!(snapshot(&old.join("mirrors")), old_mirror_state);
    assert_eq!(snapshot(&mirror_folder), old_mirror_folder);
    c.stop().await;
}
