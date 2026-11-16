//! Record history over the retained log (`replica-client-api.md` §4.4).

use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::client::{
    ClientFrame, ClientRequest, HelloParams, RecordHistory, RecordHistoryParams, RecordVersion,
    RecordVersionParams, SubmitParams, SyncMode, VersionKind,
};
use mdbn_wire::common::{B16, Text, Version};
use mdbn_wire::envelope::Item;
use mdbn_wire::intent::{DocVersion, Document, Op, Source};
use mdbn_wire::policy::DeviceKind;
use mdbn_wire::schema::Wire;

use super::engine::{COL, Node, node, settle};
use crate::api::{
    ApiError, ApiResult, ClientApi, ErrorCode, HISTORY_LOADING, SessionAuth, SessionId,
};
use crate::fake::FakeLogService;
use crate::frames::Frames;
use crate::mem::MemStore;
use crate::testkit::{TEST_OWNER, TestControlPlane};

const ID: u8 = 31;

fn reason(e: &ApiError) -> Option<&str> {
    e.problem().reason.as_deref()
}

/// Ask until the log reads behind an answer finish.
fn wait<T>(n: &mut Node, mut ask: impl FnMut(&mut Node) -> ApiResult<T>) -> ApiResult<T> {
    for _ in 0..200 {
        match ask(n) {
            Err(e) if reason(&e) == Some(HISTORY_LOADING) => n.pump(),
            other => return other,
        }
    }
    panic!("history reads never finished");
}

fn history(
    n: &mut Node,
    s: SessionId,
    before: Option<u64>,
    limit: Option<u64>,
) -> ApiResult<RecordHistory> {
    let record = B16([ID; 16]);
    wait(n, |n| {
        n.r.record_history(
            s,
            RecordHistoryParams {
                record,
                before,
                limit,
            },
        )
    })
}

fn version(n: &mut Node, s: SessionId, seq: u64) -> ApiResult<RecordVersion> {
    let record = B16([ID; 16]);
    wait(n, |n| {
        n.r.record_version(s, RecordVersionParams { record, seq })
    })
}

fn submit(n: &mut Node, s: SessionId, op: Op) {
    n.clock.set(n.clock.get() + 60_000);
    n.r.submit(
        s,
        SubmitParams {
            ops: vec![op],
            mutation_id: None,
            conflict_mode: None,
            timezone: None,
            allow_partial: None,
            mutation_ids: None,
            dry_run: None,
            include: None,
            wait: None,
            validation: None,
        },
    )
    .expect("submit");
}

/// Replace the record's document and path; `None` deletes it.
fn put(n: &mut Node, new: Option<(&str, &str)>) {
    let s = n.s;
    let base = crate::Store::record(n.r.store(), &B16([ID; 16]))
        .unwrap()
        .map(|r| DocVersion {
            path: r.path,
            doc: Text::Inline(r.doc),
        });
    submit(
        n,
        s,
        Op::Document(Document {
            id: B16([ID; 16]),
            base,
            new: new.map(|(path, doc)| DocVersion {
                path: path.into(),
                doc: Text::Inline(doc.into()),
            }),
            if_revision: None,
        }),
    );
    settle(&mut [n]);
}

fn create(n: &mut Node) {
    n.clock.set(n.clock.get() + 60_000);
    n.create(ID, "a.md", "v1");
    settle(&mut [n]);
}

fn revision(doc: &str) -> mdbn_wire::common::Hash {
    crate::convert::whash(&mdbn_core::ids::revision(doc))
}

#[test]
fn versions_list_newest_first_with_kinds_authors_and_whole_texts() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut b = node(&svc, 2, MemStore::new());
    settle(&mut [&mut a, &mut b]);
    create(&mut a);
    let created = a.clock.get() as i64;
    put(&mut a, Some(("a.md", "v2")));
    put(&mut a, Some(("b.md", "v2")));
    settle(&mut [&mut a, &mut b]);
    b.clock.set(a.clock.get());
    put(&mut b, Some(("b.md", "v3")));
    settle(&mut [&mut a, &mut b]);
    put(&mut a, None);
    settle(&mut [&mut a, &mut b]);

    let s = b.s;
    let h = history(&mut b, s, None, None).unwrap();
    let kinds: Vec<_> = h
        .versions
        .iter()
        .map(|v| (v.kind, v.path.as_str()))
        .collect();
    assert_eq!(
        kinds,
        [
            (VersionKind::Deleted, "b.md"),
            (VersionKind::Edited, "b.md"),
            (VersionKind::Moved, "b.md"),
            (VersionKind::Edited, "a.md"),
            (VersionKind::Created, "a.md"),
        ]
    );
    assert!(h.versions.windows(2).all(|w| w[0].seq > w[1].seq));
    let devices: Vec<_> = h.versions.iter().map(|v| v.author.device.0[0]).collect();
    assert_eq!(devices, [101, 102, 101, 101, 101]);
    for v in &h.versions {
        assert_eq!(v.author.account, TEST_OWNER);
        assert_eq!(
            (v.author.grant, v.author.grant_account, &v.app),
            (None, None, &None)
        );
        assert_eq!(v.source, Source::Api);
        assert_eq!(v.device_kind, DeviceKind::Desktop);
    }
    assert_eq!(h.versions[4].time, created, "the writer's signed clock");
    assert_eq!(h.versions[0].revision, None);
    assert_eq!(h.versions[1].revision, Some(revision("v3")));
    assert_eq!((h.from, h.next), (1, None), "the whole log is retained");
    assert!(h.from_time.is_some());

    // Each version reads whole from its own entry, on any replica.
    for (i, doc) in [(1, "v3"), (2, "v2"), (3, "v2"), (4, "v1")] {
        let s = a.s;
        let v = version(&mut a, s, h.versions[i].seq).unwrap();
        assert_eq!(
            (v.path.as_str(), v.document.as_str()),
            (h.versions[i].path.as_str(), doc)
        );
    }
    let deleted = version(&mut b, s, h.versions[0].seq).unwrap_err();
    assert_eq!(
        reason(&deleted),
        Some("version_not_found"),
        "a delete has no text"
    );
    let past = b.r.head().seq + 1;
    let ahead = version(&mut b, s, past).unwrap_err();
    assert_eq!(reason(&ahead), Some("version_not_found"));
    let other = wait(&mut b, |n| {
        n.r.record_version(
            s,
            RecordVersionParams {
                record: B16([ID + 1; 16]),
                seq: h.versions[1].seq,
            },
        )
    })
    .unwrap_err();
    assert_eq!(
        reason(&other),
        Some("version_not_found"),
        "another record's entry"
    );
    let none = wait(&mut b, |n| {
        n.r.record_history(
            s,
            RecordHistoryParams {
                record: B16([ID + 1; 16]),
                before: None,
                limit: None,
            },
        )
    })
    .unwrap();
    assert!(none.versions.is_empty());
    assert_eq!(none.next, None);
}

#[test]
fn pages_follow_next_and_new_writes_join_the_index() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    settle(&mut [&mut a]);
    create(&mut a);
    for doc in ["v2", "v3", "v4", "v5"] {
        put(&mut a, Some(("a.md", doc)));
    }
    settle(&mut [&mut a]);
    let s = a.s;
    let mut seen = Vec::new();
    let mut before = None;
    loop {
        let page = history(&mut a, s, before, Some(2)).unwrap();
        assert!(page.versions.len() <= 2);
        seen.extend(page.versions.iter().map(|v| v.revision));
        match page.next {
            Some(n) => {
                assert_eq!(n, page.versions.last().unwrap().seq);
                before = Some(n);
            }
            None => break,
        }
    }
    let expected: Vec<_> = ["v5", "v4", "v3", "v2", "v1"]
        .iter()
        .map(|d| Some(revision(d)))
        .collect();
    assert_eq!(seen, expected);

    put(&mut a, Some(("a.md", "v6")));
    settle(&mut [&mut a]);
    let h = history(&mut a, s, None, Some(1)).unwrap();
    assert_eq!(
        h.versions[0].revision,
        Some(revision("v6")),
        "the index reads forward"
    );
    assert!(h.next.is_some());
}

#[test]
fn history_stops_at_the_compaction_point() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    settle(&mut [&mut a]);
    create(&mut a);
    put(&mut a, Some(("a.md", "v2")));
    settle(&mut [&mut a]);
    let s = a.s;
    let before = history(&mut a, s, None, None).unwrap();
    assert_eq!(before.versions.len(), 2);

    a.r.build_snapshot_now().unwrap();
    settle(&mut [&mut a]);
    let cut = a.r.head().seq;
    svc.compact(&COL, cut);
    put(&mut a, Some(("a.md", "v3")));
    settle(&mut [&mut a]);

    // Indexed before the compaction: listed, but the text is gone.
    let gone = version(&mut a, s, before.versions[1].seq).unwrap_err();
    assert_eq!(gone.code(), Some(ErrorCode::NotFound));
    assert_eq!(reason(&gone), Some("version_compacted"));

    // A replica that joins from the snapshot sees only what the log retains.
    let mut b = node(&svc, 2, MemStore::new());
    settle(&mut [&mut a, &mut b]);
    assert_eq!(b.r.stats.snapshots_installed, 1);
    let s = b.s;
    let h = history(&mut b, s, None, None).unwrap();
    assert_eq!(h.versions.len(), 1);
    assert_eq!(h.versions[0].revision, Some(revision("v3")));
    assert_eq!((h.from, h.next), (cut + 1, None));
    assert_eq!(h.from_time, Some(h.versions[0].time));
    assert_eq!(
        version(&mut b, s, h.versions[0].seq).unwrap().document,
        "v3"
    );
    let gone = version(&mut b, s, before.versions[0].seq).unwrap_err();
    assert_eq!(reason(&gone), Some("version_compacted"));
}

fn hello() -> HelloParams {
    HelloParams {
        versions: vec![Version { major: 1, minor: 4 }],
        client_name: "app".into(),
        client_version: "0".into(),
        features: None,
        timezone: None,
    }
}

#[test]
fn history_needs_its_own_capability_and_names_the_writing_app() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    settle(&mut [&mut a]);
    let (reader, writer) = (B16([0x61; 16]), B16([0x62; 16]));
    let mut cp = TestControlPlane::new(COL);
    cp.approved_grant(
        &svc,
        reader,
        [0x61; 32],
        &["collection.read"],
        None,
        B16([101; 16]),
    );
    cp.approved_grant(
        &svc,
        writer,
        [0x62; 32],
        &["collection.read", "records.create", "history.read"],
        None,
        B16([101; 16]),
    );
    settle(&mut [&mut a]);
    let auth = |grant: B16| SessionAuth::Grant {
        grant,
        client_pk: [grant.0[0]; 32],
    };
    let (r, _) = a.r.hello(auth(reader), hello()).unwrap();
    let (w, info) = a.r.hello(auth(writer), hello()).unwrap();
    assert_eq!(info.version, Version { major: 1, minor: 4 });
    assert!(info.grant.capabilities.iter().any(|c| c == "history.read"));
    submit(
        &mut a,
        w,
        Op::Create(mdbn_wire::intent::Create {
            id: B16([ID; 16]),
            path: Some("a.md".into()),
            type_name: None,
            frontmatter: None,
            body: None,
            document: Some(Text::Inline("by app".into())),
        }),
    );
    settle(&mut [&mut a]);

    for e in [
        a.r.record_history(
            r,
            RecordHistoryParams {
                record: B16([ID; 16]),
                before: None,
                limit: None,
            },
        )
        .unwrap_err(),
        a.r.record_version(
            r,
            RecordVersionParams {
                record: B16([ID; 16]),
                seq: a.r.head().seq,
            },
        )
        .unwrap_err(),
    ] {
        assert_eq!(e.code(), Some(ErrorCode::Forbidden));
        assert!(e.problem().message.contains("history.read"));
    }
    let h = history(&mut a, w, None, None).unwrap();
    let author = &h.versions[0].author;
    assert_eq!((author.grant, author.grant_account), (Some(writer), None));
    assert_eq!(h.versions[0].app.as_deref(), Some("app"));
    assert_eq!(
        version(&mut a, w, h.versions[0].seq).unwrap().document,
        "by app"
    );
}

#[test]
fn local_only_collections_have_no_history() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    settle(&mut [&mut a]);
    a.r.cfg.mode = SyncMode::LocalOnly;
    let s = a.s;
    let e =
        a.r.record_history(
            s,
            RecordHistoryParams {
                record: B16([ID; 16]),
                before: None,
                limit: None,
            },
        )
        .unwrap_err();
    assert_eq!(e.code(), Some(ErrorCode::UpgradeRequired));
    assert_eq!(reason(&e), Some("history_unsupported"));
}

/// Replace the item at the log's head with other bytes, as a lying service would.
fn rewrite_head(svc: &FakeLogService) {
    let raw = svc.items(&COL).pop().unwrap();
    let mut item = Item::from_bytes(&raw).unwrap();
    item.sig = Some(mdbn_wire::common::B64([0xee; 64]));
    svc.lose_tail(&COL, 1);
    svc.push_raw(&COL, item.to_bytes().unwrap());
}

#[test]
fn a_log_that_disagrees_with_the_verified_chain_is_refused() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut b = node(&svc, 2, MemStore::new());
    settle(&mut [&mut a, &mut b]);
    create(&mut a);
    settle(&mut [&mut a, &mut b]);
    let s = a.s;
    let h = history(&mut a, s, None, None).unwrap();
    rewrite_head(&svc);
    // The indexed entry no longer has the bytes the index verified.
    let e = version(&mut a, s, h.versions[0].seq).unwrap_err();
    assert_eq!(reason(&e), Some("history_integrity"), "{e:?}");
    // A fresh index cannot link the rewritten item to the chain B applied.
    let s = b.s;
    let e = history(&mut b, s, None, None).unwrap_err();
    assert_eq!(reason(&e), Some("history_integrity"), "{e:?}");
}

fn request(id: u64, method: &str, params: Cbor) -> Vec<u8> {
    cbor::encode(
        &ClientFrame::Request(ClientRequest {
            id,
            method: method.into(),
            params,
        })
        .to_cbor(),
    )
    .unwrap()
}

fn responses(frames: &mut Frames) -> Vec<(u64, Result<Cbor, String>)> {
    frames
        .take_outgoing()
        .into_iter()
        .filter_map(
            |(_, b)| match ClientFrame::from_cbor(&cbor::decode(&b).unwrap()).unwrap() {
                ClientFrame::Response(r) => Some((
                    r.id,
                    match r.problem {
                        Some(p) => Err(p.reason.unwrap_or(p.code)),
                        None => Ok(r.result.unwrap_or(Cbor::Null)),
                    },
                )),
                _ => None,
            },
        )
        .collect()
}

#[test]
fn the_frame_layer_holds_a_history_read_until_its_log_reads_finish() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    settle(&mut [&mut a]);
    create(&mut a);
    settle(&mut [&mut a]);
    let mut frames = Frames::new();
    let session = frames
        .hello(
            &mut a.r,
            SessionAuth::Host,
            &request(0, "hello", hello().to_cbor()),
        )
        .session
        .unwrap();
    frames.take_outgoing();
    let params = RecordHistoryParams {
        record: B16([ID; 16]),
        before: None,
        limit: Some(5),
    };
    frames.on_frame(
        &mut a.r,
        session,
        &request(1, "record_history", params.to_cbor()),
    );
    assert!(
        responses(&mut frames).is_empty(),
        "held while the log is read"
    );
    let mut out = Vec::new();
    for _ in 0..50 {
        a.pump();
        frames.pump(&mut a.r);
        out.extend(responses(&mut frames));
        if !out.is_empty() {
            break;
        }
    }
    let [(1, Ok(result))] = out.as_slice() else {
        panic!("{out:?}")
    };
    let h = RecordHistory::from_cbor(result).unwrap();
    assert_eq!(h.versions[0].kind, VersionKind::Created);

    let too_many = Cbor::Map(vec![
        (Cbor::Uint(0), B16([ID; 16]).to_cbor()),
        (Cbor::Uint(2), Cbor::Uint(201)),
    ]);
    frames.on_frame(&mut a.r, session, &request(2, "record_history", too_many));
    let unknown = Cbor::Map(vec![
        (Cbor::Uint(0), B16([ID; 16]).to_cbor()),
        (Cbor::Uint(9), Cbor::Uint(1)),
    ]);
    frames.on_frame(&mut a.r, session, &request(3, "record_history", unknown));
    let out = responses(&mut frames);
    assert_eq!(out.len(), 2, "{out:?}");
    assert!(out.iter().all(|(_, r)| r.is_err()), "{out:?}");

    let params = RecordVersionParams {
        record: B16([ID; 16]),
        seq: h.versions[0].seq,
    };
    frames.on_frame(
        &mut a.r,
        session,
        &request(4, "record_version", params.to_cbor()),
    );
    let mut out = responses(&mut frames);
    for _ in 0..50 {
        if !out.is_empty() {
            break;
        }
        a.pump();
        frames.pump(&mut a.r);
        out.extend(responses(&mut frames));
    }
    let [(4, Ok(result))] = out.as_slice() else {
        panic!("{out:?}")
    };
    assert_eq!(RecordVersion::from_cbor(result).unwrap().document, "v1");
}

struct Bytes(Vec<u8>);
impl crate::replica::AttachmentSource for Bytes {
    fn len(&self) -> u64 {
        self.0.len() as u64
    }
    fn read_at(&mut self, o: u64, b: &mut [u8]) -> Result<(), String> {
        let o = usize::try_from(o).unwrap();
        b.copy_from_slice(&self.0[o..o + b.len()]);
        Ok(())
    }
}

#[test]
fn a_promoted_records_blob_text_reads_from_the_log_objects() {
    let (svc, mut a, mut b) = super::unindexed_end_to_end::pair();
    let id = B16([ID; 16]);
    let path = "large.md".to_string();
    let mut large = b"---\r\ntitle: large\r\n---\r\n".to_vec();
    large.resize(2_097_153, b'x');
    let proof =
        a.r.prepare_unindexed_markdown_capture(id, path.clone(), Box::new(Bytes(large)))
            .unwrap();
    let upload = a.r.start_unindexed_markdown_upload(proof).unwrap();
    settle(&mut [&mut a, &mut b]);
    let p = a.r.take_prepared_unindexed_upload(&upload).unwrap();
    a.r.capture_prepared_unindexed_upload(p).unwrap();
    settle(&mut [&mut a, &mut b]);
    let mut text = b"---\r\ntitle: promoted\r\n---\r\n".to_vec();
    text.resize(1_048_576, b'y');
    let proof =
        a.r.prepare_unindexed_markdown_reindex(id, path.clone(), Box::new(Bytes(text.clone())))
            .unwrap();
    let upload = a.r.start_unindexed_markdown_reindex_upload(proof).unwrap();
    settle(&mut [&mut a, &mut b]);
    let p = a.r.take_prepared_unindexed_reindex_upload(&upload).unwrap();
    a.r.capture_prepared_unindexed_reindex_upload(p).unwrap();
    settle(&mut [&mut a, &mut b]);
    let text = String::from_utf8(text).unwrap();

    let s = b.s;
    let h = history(&mut b, s, None, None).unwrap();
    let [v] = h.versions.as_slice() else {
        panic!("{:?}", h.versions)
    };
    assert_eq!(
        (v.kind, v.path.as_str()),
        (VersionKind::Created, "large.md")
    );
    assert_eq!(v.revision, Some(revision(&text)));
    let read = version(&mut b, s, v.seq).unwrap();
    assert_eq!(read.document, text, "read from the blob, not B's store");

    // An object the log no longer holds is reported, not papered over.
    for (address, _) in svc.objects(&COL) {
        svc.forget_object(&COL, &address);
    }
    let s = a.s;
    let e = version(&mut a, s, v.seq).unwrap_err();
    assert_eq!(e.code(), Some(ErrorCode::NotFound));
    assert_eq!(reason(&e), Some("version_text_unavailable"));
}
