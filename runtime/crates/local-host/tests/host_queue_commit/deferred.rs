//! Actual Rust/SQLite/physical queued drive, not TS-host/app qualification.
use super::*;

#[test]
fn queued_store_commit_reports_original_batches_without_starting_or_repeating_io() {
    let (root, native, queue, mut store, index) = fixture_mode(true);
    let mut batches = Vec::new();
    for op in [
        write("source.md", Expect::Absent, "first ORIGINAL document"),
        write(
            "source.md",
            Expect::Revision(revision(b"first ORIGINAL document")),
            "second ORIGINAL document",
        ),
        Publish::Delete {
            id: Some(B16([11; 16])),
            path: "source.md".into(),
            expect: Expect::Revision(revision(b"second ORIGINAL document")),
        },
    ] {
        let report = store
            .commit(Tx {
                publish: vec![op],
                ..Tx::default()
            })
            .unwrap();
        assert!(report.drifts.is_empty());
        batches.push(report.deferred.unwrap());
        assert!(store.take_publish_results().is_empty());
        assert!(queue.take_requests().is_empty());
        assert!(!root.join("source.md").exists());
    }
    assert!(batches.windows(2).all(|w| w[0] != w[1]));
    assert!(matches!(
        store.commit(Tx {
            clear_confirmed: true,
            meta: vec![("refused-reset-row".into(), Some(vec![1]))],
            ..Tx::default()
        }),
        Err(StoreError::CommitAborted(_))
    ));
    assert_eq!(store.meta("refused-reset-row").unwrap(), None);
    assert!(store.observe(None).is_err());
    assert!(queue.take_requests().is_empty());
    let mut direct = store.start_commit(Tx::default());
    assert!(matches!(direct.poll(NOW), Poll::Ready(Err(_))));
    drop(direct);
    let mut ids = BTreeSet::new();
    let mut intents = BTreeMap::new();
    let mut progress = store.start_progress();
    let report = drive(
        &mut progress,
        &native,
        &queue,
        &index,
        &mut ids,
        &mut intents,
    )
    .unwrap();
    assert!(report.drifts.is_empty());
    assert!(progress.is_complete());
    drop(progress);
    assert_eq!(intents.len(), 3);
    assert_eq!(audit_intents(&index, &mut intents), 0);
    assert!(!root.join("source.md").exists());
    let results = store.take_publish_results();
    assert_eq!(results.iter().map(|r| r.batch).collect::<Vec<_>>(), batches);
    assert!(results.iter().all(|r| r.drifts.is_empty()));
    assert!(
        store.take_publish_results().is_empty(),
        "original outcome consumed exactly once"
    );
    assert_eq!(queue.in_flight(), 0);
}

#[test]
fn queued_payload_and_slot_budget_refuse_before_inner_metadata_or_host_effects() {
    let (_root, _native, queue, mut store, index) = fixture_mode(true);
    for publish in [
        vec![write(
            "source.md",
            Expect::Absent,
            &"x".repeat(1024 * 1024 + 1),
        )],
        (0..1025)
            .map(|i| write(&format!("too-many-{i}.md"), Expect::Absent, "x"))
            .collect(),
        vec![write(&"x".repeat(4097), Expect::Absent, "x")],
    ] {
        assert!(matches!(
            store.commit(Tx {
                publish,
                meta: vec![("refused-owner-row".into(), Some(vec![1]))],
                ..Tx::default()
            }),
            Err(StoreError::CommitAborted(_))
        ));
        assert_eq!(store.meta("refused-owner-row").unwrap(), None);
        assert!(queue.take_requests().is_empty());
    }
    for i in 0..64 {
        assert!(
            store
                .commit(Tx {
                    publish: vec![write(&format!("owned-{i}.md"), Expect::Absent, "x")],
                    ..Tx::default()
                })
                .unwrap()
                .deferred
                .is_some()
        );
    }
    assert!(matches!(
        store.commit(Tx {
            publish: vec![write("over-slot.md", Expect::Absent, "x")],
            meta: vec![("refused-owner-row".into(), Some(vec![2]))],
            ..Tx::default()
        }),
        Err(StoreError::CommitAborted(_))
    ));
    assert_eq!(store.meta("refused-owner-row").unwrap(), None);
    assert_eq!(
        audit_intents(&index, &mut BTreeMap::new()),
        0,
        "not-yet-started work never allocates a phantom intent"
    );
    assert_eq!(queue.in_flight(), 0);
    assert!(queue.take_requests().is_empty());
}

#[test]
fn queued_cas_drift_returns_original_publish_without_clobber_or_replacement() {
    let (root, native, queue, mut store, index) = fixture_mode(true);
    let mut ids = BTreeSet::new();
    let mut intents = BTreeMap::new();
    store
        .commit(Tx {
            publish: vec![write("source.md", Expect::Absent, "original queued source")],
            ..Tx::default()
        })
        .unwrap();
    let mut progress = store.start_progress();
    drive(
        &mut progress,
        &native,
        &queue,
        &index,
        &mut ids,
        &mut intents,
    )
    .unwrap();
    drop(progress);
    store.take_publish_results();
    std::fs::write(root.join("source.md"), "genuine outside writer source").unwrap();
    let original = write(
        "source.md",
        Expect::Revision(revision(b"original queued source")),
        "must not clobber",
    );
    let batch = store
        .commit(Tx {
            publish: vec![original.clone()],
            ..Tx::default()
        })
        .unwrap()
        .deferred
        .unwrap();
    assert!(store.take_publish_results().is_empty());
    let mut progress = store.start_progress();
    drive(
        &mut progress,
        &native,
        &queue,
        &index,
        &mut ids,
        &mut intents,
    )
    .unwrap();
    drop(progress);
    let results = store.take_publish_results();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].batch, batch);
    assert_eq!(results[0].drifts.len(), 1);
    assert_eq!(results[0].drifts[0].publish, original);
    assert_eq!(results[0].drifts[0].reason, "changed");
    assert_eq!(
        std::fs::read(root.join("source.md")).unwrap(),
        b"genuine outside writer source"
    );
    assert_eq!(intents.len(), 2);
    assert_eq!(audit_intents(&index, &mut intents), 0);
    assert!(store.take_publish_results().is_empty());
}

#[test]
fn queued_blob_retains_original_bounded_bytes_when_local_cache_is_later_deleted() {
    let (root, native, queue, mut store, index) = fixture_mode(true);
    let original = vec![0, 1, 255, 99, 7];
    let digest = revision(&original);
    store
        .commit(Tx {
            blob_parts: vec![(digest, 0, original.clone())],
            ..Tx::default()
        })
        .unwrap();
    let batch = store
        .commit(Tx {
            publish: vec![Publish::Write {
                id: None,
                path: "original.bin".into(),
                expect: Expect::Absent,
                content: Content::Blob(digest),
            }],
            ..Tx::default()
        })
        .unwrap()
        .deferred
        .unwrap();
    store
        .commit(Tx {
            blobs_del: vec![digest],
            ..Tx::default()
        })
        .unwrap();
    assert_eq!(store.blob_size(&digest).unwrap(), None);
    let mut progress = store.start_progress();
    let mut ids = BTreeSet::new();
    let mut intents = BTreeMap::new();
    assert!(
        drive(
            &mut progress,
            &native,
            &queue,
            &index,
            &mut ids,
            &mut intents
        )
        .unwrap()
        .drifts
        .is_empty()
    );
    drop(progress);
    assert_eq!(std::fs::read(root.join("original.bin")).unwrap(), original);
    let results = store.take_publish_results();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].batch, batch);
    assert!(results[0].drifts.is_empty());
    assert_eq!(intents.len(), 1);
    assert_eq!(queue.in_flight(), 0);
}

fn evidence_fixture() -> (
    std::path::PathBuf,
    NativePlatform,
    HostQueue,
    Disk,
    Rc<RefCell<SqliteIndex>>,
    mdbn_store_file::platform::RelPath,
    mdbn_replica::store::ObservationId,
) {
    use mdbn_store_file::codec::{EvidenceRec, counter_bytes};
    use mdbn_store_file::platform::RelPath;
    // Seeded evidence provenance ONLY; actual original file, SQLite and IO.
    let (root, native, _queue, store, index) = fixture_mode(true);
    drop(store);
    let path = RelPath::new(".mdbase/held/queued-original-evidence").unwrap();
    std::fs::write(root.join(path.as_str()), "original ACK obligation bytes").unwrap();
    let rec = EvidenceRec {
        path: "source.md".into(),
        evidence: path.clone(),
        base: None,
        suspect: false,
    };
    SqlDiskDb::open(index.clone())
        .unwrap()
        .apply(vec![(
            Kind::Observation,
            counter_bytes(41),
            Some(rec.to_bytes()),
        )])
        .unwrap();
    let (platform, queue) = QueuedPlatform::new(native.capabilities().clone());
    let mut opening = FileStore::start_open(
        Rc::new(platform),
        SqlStore::open(index.clone()).unwrap(),
        SqlDiskDb::open(index.clone()).unwrap(),
        Box::new(FixedClock(NOW)),
        Config {
            queued_publication: true,
            ..Config::default()
        },
    );
    let mut ready = None;
    for turn in 0..32 {
        match opening.poll(NOW + turn) {
            Poll::Ready(Ok(store)) => {
                ready = Some(store);
                break;
            }
            Poll::Ready(Err(e)) => panic!("evidence fixture opening: {e:?}"),
            Poll::Pending => {
                for (id, op) in queue.take_requests() {
                    queue.complete(id, physical(&native, op));
                }
            }
        }
    }
    let mut store = ready.unwrap();
    let mut scan = store.start_observe(Some(&[]));
    let mut observed = None;
    for turn in 0..64 {
        match scan.poll(NOW + turn) {
            Poll::Ready(Ok(o)) => {
                observed = Some(o);
                break;
            }
            Poll::Ready(Err(e)) => panic!("evidence fixture scan: {e:?}"),
            Poll::Pending => {
                for (id, op) in queue.take_requests() {
                    queue.complete(id, physical(&native, op));
                }
            }
        }
    }
    drop(scan);
    let observed = observed.unwrap();
    assert_eq!(observed.len(), 1);
    let token = observed[0].token;
    assert_eq!(token.0, 41);
    (root, native, queue, store, index, path, token)
}

#[test]
fn queued_ack_only_obligation_precedes_publication_and_cannot_report_pending_as_ready() {
    use mdbn_store_file::codec::counter_bytes;
    let (root, native, queue, mut store, index, path, token) = evidence_fixture();
    let ack = store
        .commit(Tx {
            ack_observations: vec![token],
            ..Tx::default()
        })
        .unwrap();
    assert_eq!(
        ack.deferred, None,
        "no fake publication identity for zero-publish ACK cleanup"
    );
    let publication = store
        .commit(Tx {
            publish: vec![write(
                "source.md",
                Expect::Absent,
                "original later publication",
            )],
            ..Tx::default()
        })
        .unwrap()
        .deferred
        .unwrap();
    assert!(store.take_publish_results().is_empty());
    assert!(queue.take_requests().is_empty());
    let mut progress = store.start_progress();
    assert!(progress.poll(NOW).is_pending());
    let requests = queue.take_requests();
    assert_eq!(requests.len(), 1);
    let (id, op) = requests.into_iter().next().unwrap();
    assert_eq!(op, FileOp::RemoveFile { path: path.clone() });
    for _ in 0..3 {
        assert!(progress.poll(NOW + 1).is_pending());
        assert!(queue.take_requests().is_empty());
        assert!(root.join(path.as_str()).exists());
        assert!(!root.join("source.md").exists());
        assert!(
            SqlDiskDb::open(index.clone())
                .unwrap()
                .load()
                .unwrap()
                .iter()
                .any(|(k, key, _)| *k == Kind::Observation && key == &counter_bytes(41))
        );
    }
    queue.complete(id, physical(&native, op));
    let mut ids = BTreeSet::from([id]);
    let mut intents = BTreeMap::new();
    assert!(
        drive(
            &mut progress,
            &native,
            &queue,
            &index,
            &mut ids,
            &mut intents
        )
        .unwrap()
        .drifts
        .is_empty()
    );
    drop(progress);
    assert!(!root.join(path.as_str()).exists());
    assert_eq!(
        std::fs::read(root.join("source.md")).unwrap(),
        b"original later publication"
    );
    assert!(
        !SqlDiskDb::open(index.clone())
            .unwrap()
            .load()
            .unwrap()
            .iter()
            .any(|(k, key, _)| *k == Kind::Observation && key == &counter_bytes(41))
    );
    let results = store.take_publish_results();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].batch, publication);
    assert!(results[0].drifts.is_empty());
    assert!(store.take_publish_results().is_empty());
    assert_eq!(intents.len(), 1);
}

#[test]
fn queued_failed_ack_keeps_original_evidence_and_blocks_later_publication_certification() {
    use mdbn_store_file::codec::counter_bytes;
    let (root, _native, queue, mut store, index, path, token) = evidence_fixture();
    store
        .commit(Tx {
            ack_observations: vec![token],
            ..Tx::default()
        })
        .unwrap();
    store
        .commit(Tx {
            publish: vec![write("source.md", Expect::Absent, "must not certify")],
            ..Tx::default()
        })
        .unwrap();
    let mut progress = store.start_progress();
    assert!(progress.poll(NOW).is_pending());
    let requests = queue.take_requests();
    assert_eq!(requests.len(), 1);
    let (id, op) = requests.into_iter().next().unwrap();
    assert_eq!(op, FileOp::RemoveFile { path: path.clone() });
    queue.complete(
        id,
        Err(FsError::new(
            FsErrorKind::NoSpace,
            "original evidence cleanup refused",
        )),
    );
    assert!(matches!(
        progress.poll(NOW + 1),
        Poll::Ready(Err(StoreError::Full))
    ));
    drop(progress);
    assert!(store.head().is_err());
    assert!(store.meta("health").is_err());
    assert!(store.commit(Tx::default()).is_err());
    assert!(store.take_publish_results().is_empty());
    assert!(root.join(path.as_str()).exists());
    assert!(!root.join("source.md").exists());
    assert!(queue.take_requests().is_empty());
    assert_eq!(queue.in_flight(), 0);
    assert!(
        SqlDiskDb::open(index.clone())
            .unwrap()
            .load()
            .unwrap()
            .iter()
            .any(|(k, key, _)| *k == Kind::Observation && key == &counter_bytes(41))
    );
    assert_eq!(
        audit_intents(&index, &mut BTreeMap::new()),
        0,
        "later work never starts or remints after original failed fence"
    );
}
