//! Characterization of what the apply path leaves behind
//! (`Replica::apply_payload_ready`).
//!
//! `apply_void_inventory` pins which check fires. These tests pin the results of
//! an entry that passes them, from outside the apply path: the store's rows
//! after the commit, the transaction the store was handed, the change keys
//! given back to the caller, the verification counters, and the replica's
//! in-memory state after a commit that succeeded and after one that failed.
//! They also pin how each store read on the path fails: as an internal error
//! that commits nothing, or as the verdict the code gives when it treats a
//! failed read as a missing row.
//!
//! Expected rows are the rows before the entry with the entry's changes written
//! out, so a write the entry should not have made fails the comparison too.
use super::{
    apply_void_inventory::{
        Case, HOLDER, NATIVE, RECORD, blob_ref, file_row, legacy_setup, native_setup,
        promotion_setup, record_row, reindex_setup,
    },
    disk::{Disk, DiskStore, TestClock},
    engine::Node,
    unindexed_async::{contents, node, planned},
};
use crate::{
    DeviceSecrets, Host, Replica, UtcOnly,
    api::Push,
    log::{LogPort, LogRequest, LogResponse},
    plan::{id_key, record_meta, record_meta_stamp},
    replica::{DiskKey, apply::Outcome},
    store::{
        AliasRow, ConflictRow, FileLocal, FileRow, Head, LocalReceipt, Page, PendingRow,
        ReceiptRow, RecordRow, Store, StoreError, TailRow, TombstoneLast, TombstoneRow, Tx,
        bucket16, meta_keys,
    },
};
use mdbn_wire::{
    attachment::{FileContent, PutAttachmentFile},
    attachment_runtime_v1 as rt,
    client::{Hold, IncidentKind, Receipt, ReceiptState},
    common::{B16, Text, Version},
    entry::{
        Alias, ConflictKind, ConflictValue, Effect, PutFile, PutRecord, PutResource, PutSettings,
        RemoveFile, RemoveRecord, RemoveResource, Status,
    },
    intent::{ConflictDismiss, FileInclusion, MediaClass, Op},
    snapshot::EntityKind,
    unindexed_markdown::{FileKindV1, RecordToUnindexedMarkdown, UnindexedMarkdownPayloadV1},
};
use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;
use std::sync::Arc;

/// The instant of every fixture payload.
const INSTANT: i64 = 1_700_000_000_000;
const A: B16 = B16([0x50; 16]);
const B: B16 = B16([0x51; 16]);
const FILE: B16 = B16([0x53; 16]);
const OTHER_FILE: B16 = B16([0x54; 16]);
type Setup = fn(&mut Node) -> Case;
const TYPE: &str = "---\nkind: mdbase.type\nname: task\nmatch: {path_glob: 'tasks/*.md'}\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object}\n---\n";

/// The rows an applied entry can write.
#[derive(Debug, Clone, PartialEq)]
struct Rows {
    head: Head,
    records: Vec<RecordRow>,
    files: Vec<FileRow>,
    tombstones: Vec<TombstoneRow>,
    resources: Vec<(String, String)>,
    settings: Option<FileInclusion>,
    aliases: Vec<AliasRow>,
    conflicts: Vec<ConflictRow>,
    receipts: Vec<ReceiptRow>,
    pending: Vec<PendingRow>,
    holds: Vec<Hold>,
    /// `log_time ‖ sem_ratchet`.
    log_state: Option<Vec<u8>>,
    /// Which catalog the records' index entries were derived under.
    record_meta_stamp: Option<Vec<u8>>,
}

fn rows<S: Store>(r: &Replica<S>) -> Rows {
    let s = &r.store;
    let all = || Page {
        after: None,
        limit: 10_000,
    };
    let rows = Rows {
        head: s.head().unwrap(),
        records: s.records(all()).unwrap(),
        files: s.files(all()).unwrap(),
        tombstones: s.tombstones(all()).unwrap(),
        resources: s.resources().unwrap(),
        settings: s.settings().unwrap(),
        aliases: s.aliases().unwrap(),
        conflicts: s.conflicts(None).unwrap(),
        receipts: s.receipts(None, 10_000).unwrap(),
        pending: s.pending(None, 10_000).unwrap(),
        holds: s.holds().unwrap(),
        log_state: s.meta(meta_keys::LOG_STATE).unwrap(),
        record_meta_stamp: s.meta(meta_keys::RECORD_META).unwrap(),
    };
    // Paths resolve to the rows that hold them.
    for record in &rows.records {
        assert_eq!(s.record_at(&record.path_key).unwrap(), Some(record.id));
    }
    for file in &rows.files {
        assert_eq!(s.file_at(&file.path_key).unwrap(), Some(file.id));
    }
    for tombstone in &rows.tombstones {
        let held = s.record_at(&tombstone.path_key).unwrap();
        assert_ne!(held, Some(tombstone.id), "a removed record holds no path");
    }
    rows
}

/// The in-memory state the apply path writes, by field.
fn memory<S: Store>(r: &Replica<S>) -> BTreeMap<&'static str, String> {
    BTreeMap::from([
        ("head", format!("{:?}", r.head)),
        ("log_time", format!("{:?}", r.log_time)),
        ("sem_ratchet", format!("{:?}", r.sem_ratchet)),
        ("catalog", format!("{:p}", Arc::as_ptr(&r.catalog))),
        (
            "query_context",
            format!("{:?}", r.query_context.as_ref().map(Arc::as_ptr)),
        ),
        ("before", format!("{:?}", r.before)),
        (
            "policy",
            format!(
                "seq={} sem_ratchet={} log_time={} content_seen={} voids={}",
                r.policy.seq,
                r.policy.sem_ratchet,
                r.policy.log_time,
                r.policy.content_seen,
                r.policy.voids
            ),
        ),
        ("stats", format!("{:?}", r.stats)),
        ("resurrected", format!("{:?}", r.resurrected)),
        ("submitted_by", format!("{:?}", r.submitted_by)),
        ("pushes", format!("{:?}", r.pushes)),
        ("status_dirty", format!("{:?}", r.status_dirty)),
        ("incidents", format!("{:?}", r.incidents)),
        ("stalled", format!("{:?}", r.stalled)),
        ("apply_fault", format!("{:?}", r.apply_fault)),
        ("retaining", format!("{:?}", r.retaining.is_some())),
    ])
}

/// The fields of [`memory`] that differ.
fn moved(
    before: &BTreeMap<&'static str, String>,
    after: &BTreeMap<&'static str, String>,
) -> Vec<&'static str> {
    before
        .iter()
        .filter(|(k, v)| after[*k] != **v)
        .map(|(k, _)| *k)
        .collect()
}

/// Offer the next position's bytes for retention, as the caller of the apply
/// path does.
fn retain<S: Store>(r: &mut Replica<S>) -> Head {
    let bytes = vec![0x80];
    let head = Head {
        seq: r.head.seq + 1,
        chain: mdbn_wire::hash::chain_hash(&bytes),
    };
    r.retaining = Some(TailRow {
        seq: head.seq,
        item: bytes,
        applied_at: 0,
    });
    head
}

/// Run the apply path on `c` at `head`, serving the sources it asks for.
fn drive<S: Store>(
    r: &mut Replica<S>,
    head: Head,
    c: &Case,
    changed: &mut BTreeSet<String>,
) -> Result<Outcome, StoreError> {
    let writer = r.cfg.device_id;
    for _ in 0..17 {
        let outcome = r.test_apply_authorized_unindexed_with_refs(
            head.seq,
            head,
            c.payload.clone(),
            changed,
            writer,
            &c.refs,
        )?;
        if !matches!(outcome, Outcome::SourcePending) {
            return Ok(outcome);
        }
        for call in r.take_log_calls() {
            if let LogRequest::GetObject { address, .. } = call.request {
                let bytes = c.objects[&address].clone();
                r.on_unindexed_source_reply(
                    head,
                    call.id,
                    Ok(LogResponse::GetObject {
                        size: bytes.len() as u64,
                        checksum: mdbn_wire::hash::sha256(&bytes),
                        bytes,
                    }),
                );
            }
        }
    }
    panic!("bounded source did not finish");
}

struct Applied {
    head: Head,
    before: Rows,
    after: Rows,
    changed: BTreeSet<String>,
}

/// Apply `c` at the next position; it must be applied.
fn apply<S: Store>(r: &mut Replica<S>, c: &Case) -> Applied {
    let before = rows(r);
    let head = retain(r);
    let mut changed = BTreeSet::new();
    let outcome = drive(r, head, c, &mut changed).unwrap();
    assert!(matches!(outcome, Outcome::Applied), "{outcome:?}");
    assert_eq!(r.head, head);
    Applied {
        head,
        before,
        after: rows(r),
        changed,
    }
}

fn log_state(log_time: i64, ratchet: u64) -> Option<Vec<u8>> {
    Some([log_time.to_be_bytes(), ratchet.to_be_bytes()].concat())
}

/// The rows before the entry plus what every applied entry writes whatever its
/// effects: the head, the entry's receipt, and the log state.
fn entry(a: &Applied, p: &rt::EntryPayload) -> Rows {
    let mut rows = a.before.clone();
    rows.head = a.head;
    rows.receipts.push(ReceiptRow {
        mutation: p.mutation.id,
        seq: a.head.seq,
        time: p.mutation.clock.instant,
    });
    rows.log_state = log_state(INSTANT, 1);
    rows
}

/// The row a record put at `seq` stores.
fn stored<S: Store>(
    r: &Replica<S>,
    id: B16,
    path: &str,
    doc: &str,
    seq: u64,
    mtime: Option<i64>,
) -> RecordRow {
    RecordRow {
        modified_seq: seq,
        mtime,
        bucket: bucket16(&id),
        meta: record_meta(&r.catalog, path, doc),
        ..record_row(id, path, doc)
    }
}

fn record(id: B16, path: &str, doc: &str) -> rt::Effect {
    rt::Effect::Legacy(Effect::PutRecord(PutRecord {
        id,
        path: path.into(),
        doc: Text::Inline(doc.into()),
    }))
}

fn remove_record(id: B16, path: &str) -> rt::Effect {
    rt::Effect::Legacy(Effect::RemoveRecord(RemoveRecord {
        id,
        path: path.into(),
    }))
}

fn keys(keys: &[&str]) -> BTreeSet<String> {
    keys.iter().map(|k| k.to_string()).collect()
}

fn seed<S: Store>(r: &mut Replica<S>, tx: Tx) {
    r.store.commit(tx).unwrap();
}

fn by_id(rows: &mut [RecordRow]) {
    rows.sort_by_key(|r| r.id);
}

// ------------------------------------------------------------------ records

#[test]
fn record_put_over_its_tombstone_removes_the_tombstone() {
    let mut n = node();
    let mut c = legacy_setup(&mut n);
    seed(
        &mut n.r,
        Tx {
            tombstones_put: vec![TombstoneRow {
                id: A,
                kind: EntityKind::Record,
                path: "old.md".into(),
                path_key: "old.md".into(),
                last: TombstoneLast::Doc("gone\n".into()),
                seq: 1,
                time: 5,
            }],
            ..Tx::default()
        },
    );
    c.payload.effects = vec![record(A, "a.md", "back\n")];
    let a = apply(&mut n.r, &c);
    let mut want = entry(&a, &c.payload);
    want.tombstones.clear();
    want.records
        .push(stored(&n.r, A, "a.md", "back\n", a.head.seq, Some(INSTANT)));
    by_id(&mut want.records);
    assert_eq!(a.after, want);
    assert_eq!(a.changed, keys(&[&id_key(&A), "p:a.md"]));
}

#[test]
fn record_put_then_removed_in_one_entry_stores_nothing() {
    let mut n = node();
    let mut c = legacy_setup(&mut n);
    c.payload.effects = vec![record(A, "n.md", "n\n"), remove_record(A, "n.md")];
    let a = apply(&mut n.r, &c);
    assert_eq!(a.after, entry(&a, &c.payload));
    assert_eq!(a.changed, keys(&[&id_key(&A), "p:n.md"]));
}

#[test]
fn rename_frees_the_old_path_and_keeps_the_time_of_the_bytes() {
    let mut n = node();
    let mut c = legacy_setup(&mut n);
    seed(
        &mut n.r,
        Tx {
            records_put: vec![RecordRow {
                mtime: Some(1234),
                ..record_row(A, "a.md", "one\n")
            }],
            ..Tx::default()
        },
    );
    // `A` moves away and `B` takes the path it held, in one entry.
    c.payload.effects = vec![record(A, "b.md", "one\n"), record(B, "a.md", "two\n")];
    let a = apply(&mut n.r, &c);
    let mut want = entry(&a, &c.payload);
    want.records.retain(|r| r.id != A);
    want.records
        .push(stored(&n.r, A, "b.md", "one\n", a.head.seq, Some(1234)));
    want.records
        .push(stored(&n.r, B, "a.md", "two\n", a.head.seq, Some(INSTANT)));
    by_id(&mut want.records);
    assert_eq!(a.after, want);
    assert_eq!(
        a.changed,
        keys(&[&id_key(&A), &id_key(&B), "p:a.md", "p:b.md"])
    );
}

#[test]
fn record_moved_then_removed_in_one_entry_takes_no_path() {
    let mut n = node();
    let mut c = legacy_setup(&mut n);
    seed(
        &mut n.r,
        Tx {
            records_put: vec![record_row(A, "a.md", "one\n")],
            ..Tx::default()
        },
    );
    // `taken.md` is held by another record: the move alone would be a void.
    c.payload.effects = vec![record(A, "taken.md", "one\n"), remove_record(A, "taken.md")];
    let a = apply(&mut n.r, &c);
    let mut want = entry(&a, &c.payload);
    want.records.retain(|r| r.id != A);
    want.tombstones.push(TombstoneRow {
        id: A,
        kind: EntityKind::Record,
        path: "a.md".into(),
        path_key: "a.md".into(),
        last: TombstoneLast::Doc("one\n".into()),
        seq: a.head.seq,
        time: INSTANT,
    });
    assert_eq!(a.after, want);
    assert_eq!(a.changed, keys(&[&id_key(&A), "p:taken.md"]));
    assert!(a.after.records.iter().any(|r| r.id == HOLDER));
}

#[test]
fn record_written_twice_in_one_entry_takes_the_entry_time() {
    let mut n = node();
    let mut c = legacy_setup(&mut n);
    seed(
        &mut n.r,
        Tx {
            records_put: vec![RecordRow {
                mtime: Some(1234),
                ..record_row(A, "a.md", "x\n")
            }],
            ..Tx::default()
        },
    );
    // The second write restores the stored bytes, but they changed in between.
    c.payload.effects = vec![record(A, "a.md", "y\n"), record(A, "a.md", "x\n")];
    let a = apply(&mut n.r, &c);
    let mut want = entry(&a, &c.payload);
    want.records.retain(|r| r.id != A);
    want.records
        .push(stored(&n.r, A, "a.md", "x\n", a.head.seq, Some(INSTANT)));
    by_id(&mut want.records);
    assert_eq!(a.after, want);
}

// ------------------------------------------------------------------ files

fn ordinary(id: B16, path: &str, content: FileContent) -> FileRow {
    FileRow {
        mtime: Some(77),
        local: FileLocal::Materialized,
        ..file_row(id, path, FileKindV1::Ordinary, content)
    }
}

#[test]
fn file_put_keeps_local_state_for_the_same_blob_only() {
    let mut n = node();
    let mut c = legacy_setup(&mut n);
    let same = blob_ref(crate::replica::apply::MIN_PART);
    let mut other = same.clone();
    other.size = 2;
    seed(
        &mut n.r,
        Tx {
            files_put: vec![
                ordinary(FILE, "f.bin", FileContent::Blob(same.clone())),
                ordinary(OTHER_FILE, "g.bin", FileContent::Blob(same.clone())),
            ],
            ..Tx::default()
        },
    );
    // A rename with the same bytes, and new bytes at the same path.
    c.payload.effects = vec![
        rt::Effect::Legacy(Effect::PutFile(PutFile {
            id: FILE,
            path: "moved.bin".into(),
            blob: same.clone(),
        })),
        rt::Effect::Legacy(Effect::PutFile(PutFile {
            id: OTHER_FILE,
            path: "g.bin".into(),
            blob: other.clone(),
        })),
    ];
    let a = apply(&mut n.r, &c);
    let mut want = entry(&a, &c.payload);
    want.files.retain(|f| f.id != FILE && f.id != OTHER_FILE);
    want.files.push(FileRow {
        id: FILE,
        path: "moved.bin".into(),
        path_key: "moved.bin".into(),
        kind: FileKindV1::Ordinary,
        content: FileContent::Blob(same),
        mtime: None,
        media: MediaClass::of("moved.bin"),
        modified_seq: a.head.seq,
        bucket: bucket16(&FILE),
        local: FileLocal::Materialized,
    });
    want.files.push(FileRow {
        id: OTHER_FILE,
        path: "g.bin".into(),
        path_key: "g.bin".into(),
        kind: FileKindV1::Ordinary,
        content: FileContent::Blob(other),
        mtime: None,
        media: MediaClass::of("g.bin"),
        modified_seq: a.head.seq,
        bucket: bucket16(&OTHER_FILE),
        local: FileLocal::Remote,
    });
    want.files.sort_by_key(|f| f.id);
    assert_eq!(a.after, want);
    assert_eq!(
        a.changed,
        keys(&[
            &id_key(&FILE),
            &id_key(&OTHER_FILE),
            "p:g.bin",
            "p:moved.bin"
        ])
    );
}

#[test]
fn file_remove_leaves_its_tombstone_at_the_entry_time() {
    let mut n = node();
    let mut c = legacy_setup(&mut n);
    let blob = blob_ref(crate::replica::apply::MIN_PART);
    seed(
        &mut n.r,
        Tx {
            files_put: vec![ordinary(FILE, "f.bin", FileContent::Blob(blob.clone()))],
            ..Tx::default()
        },
    );
    c.payload.effects = vec![rt::Effect::Legacy(Effect::RemoveFile(RemoveFile {
        id: FILE,
        path: "f.bin".into(),
    }))];
    let a = apply(&mut n.r, &c);
    let mut want = entry(&a, &c.payload);
    want.files.retain(|f| f.id != FILE);
    want.tombstones.push(TombstoneRow {
        id: FILE,
        kind: EntityKind::File,
        path: "f.bin".into(),
        path_key: "f.bin".into(),
        last: TombstoneLast::Blob(blob),
        seq: a.head.seq,
        time: INSTANT,
    });
    assert_eq!(a.after, want);
    assert_eq!(a.changed, keys(&[&id_key(&FILE), "p:f.bin"]));
}

/// A record converted to an unindexed file under a store that materializes
/// attachments: the record goes without a tombstone, and what the disk showed
/// for it is recorded with the same commit.
#[test]
fn record_to_unindexed_records_what_was_shown() {
    let mut n = node();
    n.r.store.data().borrow_mut().att_disk = Some(Default::default());
    let (content, objects) = contents(&mut n, &vec![b'x'; 1_048_577], true);
    let doc = "small\n";
    seed(
        &mut n.r,
        Tx {
            records_put: vec![record_row(NATIVE, "huge.md", doc)],
            ..Tx::default()
        },
    );
    let mut p = super::unindexed_async::payload(content.clone());
    p.mutation.ops = vec![rt::Op::RecordToUnindexedMarkdown(
        RecordToUnindexedMarkdown {
            id: NATIVE,
            path: "huge.md".into(),
            payload: UnindexedMarkdownPayloadV1 {
                content: content.clone(),
            },
            prior_revision: mdbn_wire::hash::sha256(doc.as_bytes()),
        },
    )];
    let c = Case {
        payload: planned(&n, p),
        refs: objects.keys().copied().collect(),
        objects,
    };
    let shown = crate::replica::attachment_fetch::shown_meta(
        &NATIVE,
        Some(("huge.md", mdbn_wire::hash::sha256(doc.as_bytes()))),
    );
    assert_eq!(n.r.store.meta(&shown.0).unwrap(), None);
    let a = apply(&mut n.r, &c);
    let mut want = entry(&a, &c.payload);
    want.log_state = log_state(INSTANT, mdbn_core::semantics::SEM.major);
    want.records.clear();
    want.files.push(FileRow {
        id: NATIVE,
        path: "huge.md".into(),
        path_key: "huge.md".into(),
        kind: FileKindV1::UnindexedOversizedMarkdown,
        content,
        mtime: None,
        media: MediaClass::of("huge.md"),
        modified_seq: a.head.seq,
        bucket: bucket16(&NATIVE),
        local: FileLocal::Remote,
    });
    assert_eq!(a.after, want);
    assert_eq!(n.r.store.meta(&shown.0).unwrap(), shown.1);
    assert_eq!(a.changed, keys(&[&id_key(&NATIVE), "p:huge.md"]));
}

// ------------------------------------------------------------------ catalog

/// Resource and settings effects: the catalog the entry leaves is the one its
/// records are indexed under, in the same commit and in memory afterwards.
#[test]
fn resource_effects_replace_the_catalog_and_retype_every_record() {
    let mut n = node();
    let mut c = legacy_setup(&mut n);
    let typed = "---\ntype: task\n---\nbody\n";
    seed(
        &mut n.r,
        Tx {
            records_put: vec![record_row(A, "tasks/old.md", typed)],
            resources_put: vec![("_types/gone.md".into(), TYPE.replace("task", "gone"))],
            ..Tx::default()
        },
    );
    let inclusion = FileInclusion {
        include: vec![MediaClass::Image],
        exclude: None,
        max_size: Some(9),
    };
    c.payload.effects = vec![
        rt::Effect::Legacy(Effect::PutResource(PutResource {
            path: "_types/task.md".into(),
            doc: Text::Inline(TYPE.into()),
        })),
        rt::Effect::Legacy(Effect::RemoveResource(RemoveResource {
            path: "_types/gone.md".into(),
        })),
        rt::Effect::Legacy(Effect::PutSettings(PutSettings {
            inclusion: inclusion.clone(),
        })),
        record(B, "tasks/new.md", typed),
    ];
    let catalog = Arc::as_ptr(&n.r.catalog);
    let reindexed = n.r.stats.reindexed;
    let a = apply(&mut n.r, &c);
    assert_ne!(
        Arc::as_ptr(&n.r.catalog),
        catalog,
        "the catalog is replaced"
    );
    let mut want = entry(&a, &c.payload);
    want.resources = vec![("_types/task.md".into(), TYPE.into())];
    want.settings = Some(inclusion);
    want.record_meta_stamp = Some(record_meta_stamp(&want.resources));
    want.records.push(stored(
        &n.r,
        B,
        "tasks/new.md",
        typed,
        a.head.seq,
        Some(INSTANT),
    ));
    // Every stored record is indexed again under the new catalog.
    for r in &mut want.records {
        r.meta = record_meta(&n.r.catalog, &r.path, &r.doc);
    }
    by_id(&mut want.records);
    let typed_now = &want.records.iter().find(|r| r.id == A).unwrap().meta;
    assert_eq!(
        typed_now.types,
        ["task"],
        "the fixture is typed by the entry"
    );
    assert_eq!(a.after, want);
    assert_eq!(n.r.stats.reindexed - reindexed, 3);
    assert_eq!(
        a.changed,
        keys(&[
            &id_key(&B),
            "p:tasks/new.md",
            "r:_types/gone.md",
            "r:_types/task.md",
            "s:"
        ])
    );
}

// ------------------------------------------------------------------ metadata and receipts

/// Conflicts, aliases and dismissals are stored with the entry.
#[test]
fn conflicts_aliases_and_dismissals_are_stored_with_the_entry() {
    let mut n = node();
    let mut c = legacy_setup(&mut n);
    let dismissed = rt::Conflict {
        kind: ConflictKind::Body,
        id: HOLDER,
        field: None,
        base: None,
        kept: rt::ConflictValue::Legacy(ConflictValue::Text(Text::Inline("k\n".into()))),
        lost: rt::ConflictValue::Legacy(ConflictValue::Missing),
    };
    seed(
        &mut n.r,
        Tx {
            conflicts_put: vec![ConflictRow {
                mutation: B16([0x70; 16]),
                seq: 1,
                conflict: dismissed,
            }],
            ..Tx::default()
        },
    );
    let conflict = rt::Conflict {
        kind: ConflictKind::Body,
        id: RECORD,
        field: None,
        base: None,
        kept: rt::ConflictValue::Legacy(ConflictValue::Text(Text::Index(0))),
        lost: rt::ConflictValue::Legacy(ConflictValue::Text(Text::Inline("lost\n".into()))),
    };
    c.payload.texts = Some(vec![mdbn_wire::entry::TextDef::Literal("kept\n".into())]);
    c.payload.status = Status::Conflicted;
    c.payload.conflicts = Some(vec![conflict.clone()]);
    c.payload.aliases = Some(vec![Alias {
        path: "Old Name.md".into(),
        record: RECORD,
    }]);
    c.payload
        .mutation
        .ops
        .push(rt::Op::Legacy(Op::ConflictDismiss(ConflictDismiss {
            mutation: B16([0x70; 16]),
            record: HOLDER,
        })));
    let a = apply(&mut n.r, &c);
    let mut want = entry(&a, &c.payload);
    want.records.push(stored(
        &n.r,
        RECORD,
        "a.md",
        "a.md\n",
        a.head.seq,
        Some(INSTANT),
    ));
    by_id(&mut want.records);
    want.aliases = vec![AliasRow {
        path: "Old Name.md".into(),
        path_key: mdbn_core::paths::path_key("Old Name.md"),
        record: RECORD,
    }];
    want.conflicts = vec![ConflictRow {
        mutation: c.payload.mutation.id,
        seq: a.head.seq,
        conflict: rt::Conflict {
            kept: rt::ConflictValue::Legacy(ConflictValue::Text(Text::Inline("kept\n".into()))),
            ..conflict
        },
    }];
    assert_eq!(a.after, want);
}

/// This replica's own pending mutation is confirmed by its entry: the pending
/// row is handed over, the receipt is stored and pushed, and a relocation the
/// replica was waiting on is resolved.
#[test]
fn own_pending_mutation_is_confirmed() {
    let mut n = node();
    let c = legacy_setup(&mut n);
    let id = c.payload.mutation.id;
    let row = PendingRow {
        order: 1,
        mutation: c.payload.mutation.clone(),
        effects: Vec::new(),
        touches: Vec::new(),
        grant: None,
        uploads: Vec::new(),
        refs: Vec::new(),
    };
    seed(
        &mut n.r,
        Tx {
            pending_put: vec![row.clone()],
            ..Tx::default()
        },
    );
    n.r.submitted_by.insert(id, n.s);
    n.r.resurrected.insert(id, 7);
    n.r.resurrected.insert(B16([0x71; 16]), 8);
    n.r.pushes.clear();
    let a = apply(&mut n.r, &c);
    let mut want = entry(&a, &c.payload);
    want.pending.clear();
    want.records.push(stored(
        &n.r,
        RECORD,
        "a.md",
        "a.md\n",
        a.head.seq,
        Some(INSTANT),
    ));
    by_id(&mut want.records);
    assert_eq!(a.after, want);
    assert_eq!(
        n.r.store.own_retained(0, 10).unwrap(),
        vec![(a.head.seq, row)]
    );
    assert_eq!(
        n.r.store.local_receipt(&id).unwrap(),
        Some(LocalReceipt {
            mutation: id,
            state: ReceiptState::Confirmed,
            seq: Some(a.head.seq),
            status: Some(Status::Applied),
            conflicts: Vec::new(),
            problem: None,
            resolved_at: INSTANT,
            grant: None,
        })
    );
    let receipts: Vec<_> =
        n.r.pushes
            .iter()
            .filter(|(_, p)| matches!(p, Push::Receipt(_)))
            .cloned()
            .collect();
    assert_eq!(
        receipts,
        vec![(
            n.s,
            Push::Receipt(Receipt {
                relocated_from: Some(7),
                mutation: id,
                state: ReceiptState::Confirmed,
                seq: Some(a.head.seq),
                status: Some(Status::Applied),
                conflicts: None,
                records: None,
                problem: None,
                published: None,
            })
        )]
    );
    assert_eq!(
        n.r.resurrected,
        BTreeMap::from([(B16([0x71; 16]), 8)]),
        "only this mutation's relocation is resolved"
    );
    assert!(n.r.submitted_by.is_empty());
    assert!(
        n.r.store.meta(meta_keys::RESURRECT).unwrap().is_some(),
        "the other relocation stays recorded"
    );
}

/// The log clock and the semantics ratchet only move forward.
#[test]
fn log_time_and_ratchet_only_move_forward() {
    let mut n = node();
    let mut c = legacy_setup(&mut n);
    n.r.log_time = INSTANT + 5;
    n.r.sem_ratchet = 3;
    c.payload.effects = vec![record(A, "a.md", "a\n")];
    let a = apply(&mut n.r, &c);
    assert_eq!((n.r.log_time, n.r.sem_ratchet), (INSTANT + 5, 3));
    assert_eq!(a.after.log_state, log_state(INSTANT + 5, 3));

    let mut c = legacy_setup(&mut n);
    c.payload.mutation.id = B16([0x72; 16]);
    c.payload.mutation.clock.instant = INSTANT + 9;
    c.payload.sem = Version { major: 4, minor: 0 };
    c.payload.effects = vec![record(B, "b.md", "b\n")];
    let a = apply(&mut n.r, &c);
    assert_eq!((n.r.log_time, n.r.sem_ratchet), (INSTANT + 9, 4));
    assert_eq!(a.after.log_state, log_state(INSTANT + 9, 4));
    let stored = a.after.records.iter().find(|r| r.id == B).unwrap();
    assert_eq!(stored.mtime, Some(INSTANT + 9));
    assert_eq!(
        a.after.receipts.last().map(|r| (r.seq, r.time)),
        Some((a.head.seq, INSTANT + 9))
    );
}

// ------------------------------------------------------------------ verification

fn counters<S: Store>(r: &Replica<S>) -> (u64, u64, u64) {
    (
        r.stats.verified,
        r.stats.verify_mismatch,
        r.stats.unverified,
    )
}

/// A legacy create by another replica, planned by this build's planner.
fn foreign_create(n: &mut Node) -> Case {
    let mut c = legacy_setup(n);
    c.payload.mutation.origin = B16([2; 16]);
    c.payload = planned(n, c.payload);
    c
}

/// Which entries are re-planned, and how each result is counted:
/// `(verified, verify_mismatch, unverified)`.
#[test]
fn verification_counts_each_entry_once() {
    let other_sem = Version {
        major: mdbn_core::semantics::SEM.major,
        minor: mdbn_core::semantics::SEM.minor + 1,
    };
    let cases: [(&str, Setup, (u64, u64, u64)); 7] = [
        ("native, this build's sem", native_setup, (1, 0, 0)),
        ("native reindex", reindex_setup, (1, 0, 0)),
        ("native promotion", promotion_setup, (1, 0, 0)),
        (
            "legacy, another replica's, agreeing",
            foreign_create,
            (1, 0, 0),
        ),
        (
            "legacy, another replica's, differing",
            |n| {
                let mut c = foreign_create(n);
                c.payload.effects = vec![record(RECORD, "a.md", "not what the planner writes\n")];
                c
            },
            (0, 1, 0),
        ),
        (
            "legacy, another replica's, differing only in status",
            |n| {
                let mut c = foreign_create(n);
                c.payload.status = Status::Merged;
                c
            },
            (0, 1, 0),
        ),
        ("legacy, this replica's own", legacy_setup, (0, 0, 0)),
    ];
    for (name, setup, want) in cases {
        let mut n = node();
        let c = setup(&mut n);
        let before = counters(&n.r);
        apply(&mut n.r, &c);
        let after = counters(&n.r);
        assert_eq!(
            (after.0 - before.0, after.1 - before.1, after.2 - before.2),
            want,
            "{name}"
        );
        assert_eq!(
            n.r.incidents
                .contains_key(&IncidentKind::VerificationMismatch.value()),
            want.1 == 1,
            "{name}"
        );
    }
    // Another sem is not re-planned, native or not.
    for (name, setup) in [
        ("native", native_setup as Setup),
        ("legacy", foreign_create),
    ] {
        let mut n = node();
        let mut c = setup(&mut n);
        c.payload.sem = other_sem;
        let before = counters(&n.r);
        apply(&mut n.r, &c);
        let after = counters(&n.r);
        assert_eq!(
            (after.0 - before.0, after.1 - before.1, after.2 - before.2),
            (0, 0, 1),
            "{name}, another sem"
        );
    }
}

// ------------------------------------------------------------------ the commit

/// An entry with a resource, a record and this replica's pending row: it writes
/// every piece of in-memory state the apply path owns.
fn busy_setup(n: &mut Node) -> Case {
    let mut c = foreign_create(n);
    c.payload
        .effects
        .push(rt::Effect::Legacy(Effect::PutResource(PutResource {
            path: "_types/task.md".into(),
            doc: Text::Inline(TYPE.into()),
        })));
    c.payload.mutation.clock.instant = INSTANT + 9;
    c.payload.sem.major += 1;
    seed(
        &mut n.r,
        Tx {
            pending_put: vec![PendingRow {
                order: 1,
                mutation: c.payload.mutation.clone(),
                effects: Vec::new(),
                touches: Vec::new(),
                grant: None,
                uploads: Vec::new(),
                refs: Vec::new(),
            }],
            ..Tx::default()
        },
    );
    n.r.resurrected.insert(c.payload.mutation.id, 7);
    c
}

/// The in-memory fields a successful apply of `busy_setup` moves.
const MOVED_BY_APPLY: &[&str] = &[
    "catalog",
    "head",
    "log_time",
    "policy",
    "pushes",
    "query_context",
    "resurrected",
    "sem_ratchet",
    "stats",
];

#[test]
fn applied_entry_moves_memory_after_the_commit() {
    let mut n = node();
    let c = busy_setup(&mut n);
    let before = memory(&n.r);
    apply(&mut n.r, &c);
    let after = memory(&n.r);
    assert_eq!(moved(&before, &after), MOVED_BY_APPLY);
    assert_eq!(n.r.log_time, INSTANT + 9);
    assert_eq!(n.r.sem_ratchet, c.payload.sem.major);
    assert_eq!(
        after["policy"],
        format!(
            "seq={} sem_ratchet={} log_time={} content_seen=true voids=0",
            n.r.head.seq,
            c.payload.sem.major,
            INSTANT + 9
        )
    );
}

/// A commit that fails is an internal error. The store keeps its rows, and in
/// memory only what the path writes before the commit has moved: the policy's
/// note of the entry and the verification counters. A second attempt then
/// leaves what a first-time apply leaves, with the entry counted twice.
#[test]
fn failed_commit_stores_nothing_and_moves_no_committed_memory() {
    for unknown in [false, true] {
        let mut n = node();
        let c = busy_setup(&mut n);
        let rows_before = rows(&n.r);
        let before = memory(&n.r);
        let head = retain(&mut n.r);
        if unknown {
            n.r.store.fail_unknown_commits(1);
        } else {
            n.r.store.fail_commits(1);
        }
        let mut changed = BTreeSet::new();
        let error = drive(&mut n.r, head, &c, &mut changed).unwrap_err();
        assert_eq!(
            matches!(error, StoreError::CommitAborted(_)),
            !unknown,
            "{error:?}"
        );
        assert_eq!(rows(&n.r), rows_before);
        let failed = memory(&n.r);
        assert_eq!(moved(&before, &failed), ["policy", "stats"]);
        // The change keys were already handed back.
        assert_eq!(
            changed,
            keys(&[&id_key(&RECORD), "p:a.md", "r:_types/task.md"])
        );

        // The same entry again, against a clean first-time apply.
        let mut clean = node();
        let clean_case = busy_setup(&mut clean);
        let want = apply(&mut clean.r, &clean_case);
        let again = apply(&mut n.r, &c);
        assert_eq!(again.after, want.after);
        assert_eq!(again.changed, want.changed);
        let (mut retried, mut first) = (memory(&n.r), memory(&clean.r));
        // Each node has its own catalog and query index allocations, and the
        // failed attempt already counted the entry.
        for field in ["catalog", "query_context", "stats"] {
            retried.remove(field);
            first.remove(field);
        }
        assert_eq!(n.r.stats.unverified, clean.r.stats.unverified + 1);
        assert_eq!(retried, first);
    }
}

/// A read that fails after the commit does not undo it: the entry is applied,
/// and the replica fences itself instead of writing its follow-up state.
#[test]
fn read_fault_after_the_commit_is_applied_and_fenced() {
    let mut n = node();
    let c = busy_setup(&mut n);
    let before = memory(&n.r);
    let head = retain(&mut n.r);
    n.r.store.fail_tail_stats(1, false);
    let mut changed = BTreeSet::new();
    let outcome = drive(&mut n.r, head, &c, &mut changed).unwrap();
    assert!(matches!(outcome, Outcome::Applied), "{outcome:?}");
    assert_eq!(n.r.store.head().unwrap(), head);
    assert!(n.r.apply_fault);
    assert_eq!(
        moved(&before, &memory(&n.r)),
        [
            "apply_fault",
            "head",
            "incidents",
            "policy",
            "pushes",
            "stats",
            "status_dirty"
        ]
    );
    assert!(
        !n.r.pushes
            .iter()
            .any(|(_, p)| matches!(p, Push::Receipt(_))),
        "no receipt is pushed"
    );
}

// ------------------------------------------------------------------ a disk-backed store

struct OnDisk {
    r: Replica<DiskStore>,
    disk: Rc<RefCell<Disk>>,
}

/// Reopen `n`'s store as a disk-backed one: it reports files, keeps the
/// transactions it is handed, and can fail a chosen row read.
fn on_disk(mut n: Node) -> OnDisk {
    let stored = Box::new(crate::seal::PlainSealer::for_device(n.r.cfg.device_id));
    let sealer = std::mem::replace(&mut n.r.sealer, stored.clone());
    let cfg = n.r.cfg.clone();
    let disk = Rc::new(RefCell::new(Disk::default()));
    disk.borrow_mut().keep_committed = true;
    let mut r = Replica::open(
        cfg,
        DiskStore {
            inner: n.r.into_store(),
            disk: disk.clone(),
            barrier_fails: false,
        },
        Box::new(crate::plan::CorePlanner),
        stored,
        Host {
            clock: Box::new(TestClock(Rc::new(Cell::new(INSTANT as u64)))),
            entropy: Box::new(crate::crypto::TestEntropy::new(1)),
            zones: Box::new(UtcOnly),
        },
        DeviceSecrets {
            sign_sk: [1; 32],
            kem_sk: [1; 32],
        },
    )
    .unwrap();
    // The fixtures' sealed content is under the node's sealer.
    r.sealer = sealer;
    OnDisk { r, disk }
}

impl OnDisk {
    /// The transaction of the last commit.
    fn committed(&self) -> Tx {
        self.disk.borrow().committed.last().cloned().unwrap()
    }
}

/// Reindexing an unindexed file, or promoting an ordinary one, replaces a file
/// the disk shows with a record: what was shown is kept for the publish.
#[test]
fn reindex_and_promotion_keep_what_the_disk_showed() {
    for setup in [reindex_setup, promotion_setup] {
        let mut n = node();
        let c = setup(&mut n);
        let held = n.r.store.file(&NATIVE).unwrap().unwrap();
        let mut d = on_disk(n);
        assert!(d.r.before.is_empty());
        apply(&mut d.r, &c);
        let shown: Vec<_> =
            d.r.before
                .iter()
                .map(|(key, shown)| {
                    let shown = shown.as_ref().map(|s| (s.path.clone(), s.rev));
                    (key.clone(), shown)
                })
                .collect();
        assert_eq!(
            shown,
            [(
                DiskKey::Record(NATIVE),
                Some((held.path.clone(), held.content.plain_hash()))
            )]
        );
        let tx = d.committed();
        assert_eq!(tx.files_del, [NATIVE]);
        assert!(tx.files_put.is_empty() && tx.records_del.is_empty());
        assert_eq!(tx.records_put.len(), 1);
        assert_eq!(tx.records_put[0].mtime, held.mtime);
    }
}

/// A file removed and attached again in one entry: the transaction puts the
/// file and no longer deletes it, so the outcome does not depend on the order
/// a store applies puts and deletes in. (It also carries the remove's
/// tombstone: the file ends up live with a tombstone beside it.)
#[test]
fn file_removed_then_attached_in_one_entry_is_put_not_deleted() {
    let mut n = node();
    let mut c = legacy_setup(&mut n);
    let (FileContent::AttachmentV1(content), _) = contents(&mut n, b"picture", true) else {
        unreachable!()
    };
    seed(
        &mut n.r,
        Tx {
            files_put: vec![ordinary(
                FILE,
                "pic.png",
                FileContent::AttachmentV1(content.clone()),
            )],
            ..Tx::default()
        },
    );
    c.payload.effects = vec![
        rt::Effect::Legacy(Effect::RemoveFile(RemoveFile {
            id: FILE,
            path: "pic.png".into(),
        })),
        rt::Effect::PutAttachmentFile(PutAttachmentFile {
            id: FILE,
            path: "moved.png".into(),
            content: content.clone(),
            mtime: None,
        }),
    ];
    let mut d = on_disk(n);
    let a = apply(&mut d.r, &c);
    let tx = d.committed();
    let put = FileRow {
        id: FILE,
        path: "moved.png".into(),
        path_key: "moved.png".into(),
        kind: FileKindV1::Ordinary,
        content: FileContent::AttachmentV1(content.clone()),
        mtime: Some(77),
        media: MediaClass::of("moved.png"),
        modified_seq: a.head.seq,
        bucket: bucket16(&FILE),
        local: FileLocal::Materialized,
    };
    let tombstone = TombstoneRow {
        id: FILE,
        kind: EntityKind::File,
        path: "pic.png".into(),
        path_key: "pic.png".into(),
        last: TombstoneLast::Attachment(content),
        seq: a.head.seq,
        time: INSTANT,
    };
    assert_eq!(tx.files_put, vec![put.clone()]);
    assert_eq!(tx.files_del, []);
    assert_eq!(tx.tombstones_put, vec![tombstone.clone()]);
    assert_eq!(tx.tombstones_del, []);
    let mut want = entry(&a, &c.payload);
    want.files.retain(|f| f.id != FILE);
    want.files.push(put);
    want.files.sort_by_key(|f| f.id);
    want.tombstones.push(tombstone);
    assert_eq!(a.after, want);
}

/// How one apply attempt ended, for the read-fault sweep.
fn exit<S: Store>(
    r: &Replica<S>,
    result: &Result<Outcome, StoreError>,
    before: Head,
    head: Head,
) -> &'static str {
    let at = r.store.head().unwrap();
    match result {
        Err(_) if at == before => "error",
        Err(_) => "error after the commit",
        Ok(Outcome::Applied) => {
            assert_eq!(at, head);
            "applied"
        }
        Ok(other) => panic!("{other:?}"),
    }
}

/// Fail each row read of an apply in turn. Gives the reads the path makes, in
/// order and by store method, and every read whose failure is not an internal
/// error that stores nothing: `(read, how the apply ended)`.
fn read_fault_sweep(setup: Setup) -> (String, Vec<(usize, &'static str)>) {
    let reads = {
        let mut n = node();
        let c = setup(&mut n);
        let mut d = on_disk(n);
        let start = d.disk.borrow().row_reads.len();
        let head = retain(&mut d.r);
        drive(&mut d.r, head, &c, &mut BTreeSet::new()).unwrap();
        d.disk.borrow().row_reads[start..].to_vec()
    };
    let mut exceptions = Vec::new();
    for k in 0..reads.len() {
        let mut n = node();
        let c = setup(&mut n);
        let mut d = on_disk(n);
        let before = d.r.store.head().unwrap();
        let rows_before = rows(&d.r);
        let head = retain(&mut d.r);
        d.disk.borrow_mut().fail_row_read = Some(k as u64);
        let result = drive(&mut d.r, head, &c, &mut BTreeSet::new());
        assert_eq!(d.disk.borrow().fail_row_read, None, "read {k} was made");
        match exit(&d.r, &result, before, head) {
            "error" => assert_eq!(rows(&d.r), rows_before, "read {k}: nothing is stored"),
            other => exceptions.push((k, other)),
        }
    }
    (reads.join(" "), exceptions)
}

/// Every legacy effect arm, in this replica's own entry (so nothing is
/// re-planned).
fn every_legacy_arm(n: &mut Node) -> Case {
    let mut c = legacy_setup(n);
    let blob = blob_ref(crate::replica::apply::MIN_PART);
    seed(
        &mut n.r,
        Tx {
            records_put: vec![record_row(A, "gone.md", "gone\n")],
            files_put: vec![ordinary(FILE, "f.bin", FileContent::Blob(blob.clone()))],
            resources_put: vec![("_types/gone.md".into(), TYPE.replace("task", "gone"))],
            ..Tx::default()
        },
    );
    c.payload.effects.extend([
        remove_record(A, "gone.md"),
        rt::Effect::Legacy(Effect::PutFile(PutFile {
            id: OTHER_FILE,
            path: "g.bin".into(),
            blob,
        })),
        rt::Effect::Legacy(Effect::RemoveFile(RemoveFile {
            id: FILE,
            path: "f.bin".into(),
        })),
        rt::Effect::Legacy(Effect::PutResource(PutResource {
            path: "_types/task.md".into(),
            doc: Text::Inline(TYPE.into()),
        })),
        rt::Effect::Legacy(Effect::RemoveResource(RemoveResource {
            path: "_types/gone.md".into(),
        })),
    ]);
    c
}

/// A failed store read on the apply path is an internal error that stores
/// nothing, with the exceptions listed: a legacy entry is re-planned, and what
/// the disk shows is captured, through views that read a failed row as a
/// missing one, so the apply goes on; and a read that fails after the commit
/// is an error with the entry already stored.
#[test]
fn read_faults_by_read() {
    type Exceptions = &'static [(usize, &'static str)];
    let cases: [(&str, Setup, &str, Exceptions); 5] = [
        (
            "legacy effects",
            every_legacy_arm,
            "file record tombstone record file tombstone file record_at file_at record_at \
             file_at resources pending_get holds record record resources resources",
            // The two captures of what the disk shows, then the catalog reload.
            &[
                (14, "applied"),
                (15, "applied"),
                (17, "error after the commit"),
            ],
        ),
        (
            "legacy verification",
            foreign_create,
            "file record tombstone record_at file_at record tombstone file record_at file_at \
             record pending_get holds record resources",
            // The planner's reads, then the capture of what the disk shows.
            &[
                (5, "applied"),
                (6, "applied"),
                (7, "applied"),
                (8, "applied"),
                (9, "applied"),
                (10, "applied"),
                (13, "applied"),
            ],
        ),
        (
            "native put",
            native_setup,
            "file record tombstone record_at file_at record file record_at file_at tombstone \
             record file file record tombstone record_at file_at record file record_at file_at \
             tombstone record file file record tombstone record_at file_at record file \
             record_at file_at tombstone record file pending_get holds resources",
            &[],
        ),
        (
            "native reindex",
            reindex_setup,
            "file record_at file_at file file record_at file_at record pending_get holds \
             resources",
            &[],
        ),
        (
            "native promotion",
            promotion_setup,
            "file record_at file_at file record tombstone record_at file_at file record_at \
             file_at record file record_at file_at file record tombstone record_at file_at \
             file record_at file_at record pending_get holds resources",
            &[],
        ),
    ];
    for (name, setup, reads, exceptions) in cases {
        let got = read_fault_sweep(setup);
        assert_eq!(
            (got.0.as_str(), got.1.as_slice()),
            (reads, exceptions),
            "{name}"
        );
    }
}
