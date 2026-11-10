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
        Case, HOLDER, NATIVE, RECORD, UNINDEXED, attachment_setup, blob_ref, file_row,
        legacy_setup, native_setup, promotion_setup, record_row, reindex_setup,
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
    attachment::{FileAttach, FileContent, PutAttachmentFile},
    attachment_runtime_v1 as rt,
    client::{Hold, IncidentKind, Receipt, ReceiptState},
    common::{B16, Text, Version},
    entry::{
        Alias, Conflict, ConflictKind, ConflictValue, DeltaOp, Effect, PutFile, PutRecord,
        PutResource, PutSettings, RemoveFile, RemoveRecord, RemoveResource, Status, TextDef,
        TextDefForm, TextDelta, TextSource,
    },
    intent::{ConflictDismiss, FileDelete, FileInclusion, MediaClass, Op, Source},
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
    // Every pending row plans again under the new catalog.
    n.r.pending_keys
        .insert(1, vec!["i:pending".into(), "p:pending.md".into()]);
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
            "i:pending",
            "p:pending.md",
            "p:tasks/new.md",
            "r:_types/gone.md",
            "r:_types/task.md",
            "s:"
        ])
    );
}

// ------------------------------------------------------------------ metadata and receipts

/// Conflicts, aliases and dismissals are stored with the entry. The entry is
/// this replica's own, so its receipt carries the conflicts, stored and pushed.
#[test]
fn conflicts_aliases_and_dismissals_are_stored_with_the_entry() {
    let mut n = node();
    let mut c = legacy_setup(&mut n);
    let id = c.payload.mutation.id;
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
    n.r.submitted_by.insert(id, n.s);
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
    let receipt_conflicts = vec![Conflict {
        kind: ConflictKind::Body,
        id: RECORD,
        field: None,
        base: None,
        kept: ConflictValue::Text(Text::Inline("kept\n".into())),
        lost: ConflictValue::Text(Text::Inline("lost\n".into())),
    }];
    assert_eq!(
        n.r.store.local_receipt(&id).unwrap().map(|r| r.conflicts),
        Some(receipt_conflicts.clone())
    );
    let pushed: Vec<_> =
        n.r.pushes
            .iter()
            .filter_map(|(_, p)| match p {
                Push::Receipt(r) => Some(r.conflicts.clone()),
                _ => None,
            })
            .collect();
    assert_eq!(pushed, [Some(receipt_conflicts)]);
}

/// This replica's own conflicted attachment: the file is held in the same
/// commit, and the held file's disk state is brought in line with the hold, so
/// its pending fetch stops.
#[test]
fn own_conflicted_attachment_is_held_and_stops_its_fetch() {
    let mut n = node();
    n.r.store.data().borrow_mut().att_disk = Some(Default::default());
    let put = attachment_setup(&mut n);
    let file = B16([71; 16]);
    apply(&mut n.r, &put);
    assert!(
        n.r.attachment_fetch_status(&file).is_some(),
        "the attached file is being fetched"
    );
    let rt::Op::FileAttach(attach) = &put.payload.mutation.ops[0] else {
        unreachable!()
    };
    let kept = attach.content.clone();
    let (FileContent::AttachmentV1(lost), _) = contents(&mut n, b"other picture", true) else {
        unreachable!()
    };
    let mut c = legacy_setup(&mut n);
    c.payload.mutation.id = B16([0x74; 16]);
    c.payload.mutation.source = Source::External;
    c.payload.mutation.ops = vec![rt::Op::FileAttach(FileAttach {
        content: lost.clone(),
        ..attach.clone()
    })];
    c.payload.effects = Vec::new();
    c.payload.status = Status::Conflicted;
    c.payload.conflicts = Some(vec![rt::Conflict {
        kind: ConflictKind::File,
        id: file,
        field: None,
        base: None,
        kept: rt::ConflictValue::Attachment(kept),
        lost: rt::ConflictValue::Attachment(lost),
    }]);
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
    let a = apply(&mut n.r, &c);
    assert_eq!(
        a.after.holds.iter().map(|h| h.id).collect::<Vec<_>>(),
        [file]
    );
    assert_eq!(n.r.attachment_fetch_status(&file), None);
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

/// A native entry this build's planner disagrees with stalls. The caller
/// retries a stalled entry on every read; the mismatch is reported once per
/// stall, not on every retry.
#[test]
fn native_mismatch_is_reported_once_per_stall() {
    let mut n = node();
    let mut c = native_setup(&mut n);
    c.payload.status = Status::Merged;
    let head = retain(&mut n.r);
    let attempt = |n: &mut Node| {
        let outcome = drive(&mut n.r, head, &c, &mut BTreeSet::new()).unwrap();
        assert!(
            matches!(outcome, Outcome::Stall(IncidentKind::UpgradeRequired, _)),
            "{outcome:?}"
        );
        counters(&n.r)
    };
    assert_eq!(attempt(&mut n), (0, 1, 0));
    // As the caller records the stall.
    n.r.stalled = Some((IncidentKind::UpgradeRequired, head.seq));
    assert_eq!(attempt(&mut n), (0, 1, 0));
    assert_eq!(attempt(&mut n), (0, 1, 0));
    // A stall of another kind at the same position is not this one.
    n.r.stalled = Some((IncidentKind::WaitingForKey, head.seq));
    assert_eq!(attempt(&mut n), (0, 2, 0));
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
    // `(setup, the change keys, the counters the attempt moves)`.
    type Counted = (u64, u64, u64);
    let busy_keys = || keys(&[&id_key(&RECORD), "p:a.md", "r:_types/task.md"]);
    let create_keys = || keys(&[&id_key(&RECORD), "p:a.md"]);
    let cases: [(&str, Setup, BTreeSet<String>, Counted); 2] = [
        ("unverified", busy_setup, busy_keys(), (0, 0, 1)),
        ("verified", foreign_create, create_keys(), (1, 0, 0)),
    ];
    for (name, setup, want_changed, counted) in cases {
        for unknown in [false, true] {
            let mut n = node();
            let c = setup(&mut n);
            let rows_before = rows(&n.r);
            let before = memory(&n.r);
            let counted_before = counters(&n.r);
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
                "{name}: {error:?}"
            );
            assert_eq!(rows(&n.r), rows_before, "{name}");
            let failed = memory(&n.r);
            assert_eq!(moved(&before, &failed), ["policy", "stats"], "{name}");
            let after = counters(&n.r);
            assert_eq!(
                (
                    after.0 - counted_before.0,
                    after.1 - counted_before.1,
                    after.2 - counted_before.2
                ),
                counted,
                "{name}: the attempt is counted before the commit"
            );
            // The change keys were already handed back.
            assert_eq!(changed, want_changed, "{name}");

            // The same entry again, against a clean first-time apply.
            let mut clean = node();
            let clean_case = setup(&mut clean);
            let want = apply(&mut clean.r, &clean_case);
            let again = apply(&mut n.r, &c);
            assert_eq!(again.after, want.after, "{name}");
            assert_eq!(again.changed, want.changed, "{name}");
            let (mut retried, mut first) = (memory(&n.r), memory(&clean.r));
            // Each node has its own catalog and query index allocations, and the
            // failed attempt already counted the entry.
            for field in ["catalog", "query_context", "stats"] {
                retried.remove(field);
                first.remove(field);
            }
            let (twice, once) = (counters(&n.r), counters(&clean.r));
            assert_eq!(
                (twice.0 - once.0, twice.1 - once.1, twice.2 - once.2),
                counted,
                "{name}"
            );
            assert_eq!(retried, first, "{name}");
        }
    }
}

/// A read that fails after the commit does not undo it: the entry is applied,
/// and the replica fences itself instead of writing its follow-up state.
///
/// What it stored is what it staged, with no reindex after it: the entry's
/// records carry their index entries under the catalog the entry leaves.
#[test]
fn read_fault_after_the_commit_is_applied_and_fenced() {
    let mut n = node();
    let mut c = busy_setup(&mut n);
    // A type the entry's record matches, so the two catalogs index it apart.
    let Some(rt::Effect::Legacy(Effect::PutResource(resource))) = c.payload.effects.last_mut()
    else {
        panic!("expected the resource effect")
    };
    resource.doc = Text::Inline(TYPE.replace("tasks/*.md", "*.md"));
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
    let resources = n.r.store.resources().unwrap();
    let left =
        mdbn_core::types::Catalog::load(resources.iter().map(|(a, b)| (a.as_str(), b.as_str())));
    let stored = n.r.store.record(&RECORD).unwrap().unwrap();
    assert_ne!(
        record_meta(&left, &stored.path, &stored.doc),
        record_meta(&n.r.catalog, &stored.path, &stored.doc),
        "the fixture is indexed apart by the two catalogs"
    );
    assert_eq!(stored.meta, record_meta(&left, &stored.path, &stored.doc));
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

/// On a store that shows files, an apply that fails part-way leaves memory as
/// far as the path got: before its last reads, nothing; after them, what the
/// disk showed is merged into the before map (an earlier capture of the same
/// key wins), the policy has noted the entry and the change keys are handed
/// back. A failed commit leaves the same as a failure just before it.
#[test]
fn failed_apply_on_disk_moves_memory_as_far_as_it_got() {
    // A clean apply: what it leaves in the before map and the policy.
    let (shown, noted) = {
        let mut n = node();
        let c = promotion_setup(&mut n);
        let mut d = on_disk(n);
        apply(&mut d.r, &c);
        (d.r.before.clone(), memory(&d.r)["policy"].clone())
    };
    assert_eq!(shown.keys().collect::<Vec<_>>(), [&DiskKey::Record(NATIVE)]);
    #[derive(Clone, Copy)]
    enum Fault {
        Read(&'static str),
        Commit,
    }
    // `(fault, whether NATIVE was captured before, reached the merge)`.
    let cases = [
        (Fault::Read("pending_get"), false, false),
        (Fault::Read("resources"), false, true),
        (Fault::Commit, false, true),
        (Fault::Commit, true, true),
    ];
    for (fault, captured, merged) in cases {
        let mut n = node();
        let c = promotion_setup(&mut n);
        let mut d = on_disk(n);
        seen_before(&mut d.r);
        if captured {
            // NATIVE is a file, not a record: the view shows nothing for it.
            d.r.capture_before(DiskKey::Record(NATIVE));
        }
        let seen = d.r.before.clone();
        let head = retain(&mut d.r);
        let before = memory(&d.r);
        let name = match fault {
            Fault::Read(read) => {
                // The last read of that method on the path.
                let reads = {
                    let mut n = node();
                    let c = promotion_setup(&mut n);
                    let mut r = on_disk(n);
                    seen_before(&mut r.r);
                    let start = r.disk.borrow().row_reads.len();
                    let head = retain(&mut r.r);
                    drive(&mut r.r, head, &c, &mut BTreeSet::new()).unwrap();
                    r.disk.borrow().row_reads[start..].to_vec()
                };
                let k = reads.iter().rposition(|r| *r == read).unwrap();
                d.disk.borrow_mut().fail_row_read = Some(k as u64);
                format!("read {read}")
            }
            Fault::Commit => {
                d.r.store.inner.fail_commits(1);
                "commit".to_string()
            }
        };
        let name = format!("{name}, captured {captured}");
        let mut changed = BTreeSet::new();
        drive(&mut d.r, head, &c, &mut changed).unwrap_err();
        let mut want_before = seen.clone();
        let mut want_moved = vec!["stats"];
        if merged {
            for (key, value) in &shown {
                want_before.entry(key.clone()).or_insert(value.clone());
            }
            want_moved = vec!["before", "policy", "stats"];
        }
        if matches!(fault, Fault::Commit) {
            // The commit took the retained bytes with it.
            want_moved.insert(2, "retaining");
        }
        if captured {
            // The earlier capture is kept, so the before map does not move.
            want_moved.retain(|f| *f != "before");
            assert!(matches!(
                d.r.before.get(&DiskKey::Record(NATIVE)),
                Some(None)
            ));
        }
        assert_eq!(
            format!("{:?}", d.r.before),
            format!("{want_before:?}"),
            "{name}"
        );
        assert_eq!(moved(&before, &memory(&d.r)), want_moved, "{name}");
        if merged {
            assert_eq!(memory(&d.r)["policy"], noted, "{name}");
        }
        assert_eq!(
            changed,
            if merged {
                keys(&[&id_key(&NATIVE), "p:note.md"])
            } else {
                BTreeSet::new()
            },
            "{name}"
        );
    }
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
        Ok(Outcome::Void(reason)) => {
            assert_eq!(at, head);
            reason
        }
        Ok(other) => panic!("{other:?}"),
    }
}

/// A record no fixture entry touches.
const SEEN: B16 = B16([0x55; 16]);

/// Store a record the entry does not touch and capture what the disk shows
/// for it, so the before map the entry merges into is not empty.
fn seen_before<S: Store>(r: &mut Replica<S>) {
    seed(
        r,
        Tx {
            records_put: vec![record_row(SEEN, "seen.md", "seen\n")],
            ..Tx::default()
        },
    );
    r.capture_before(DiskKey::Record(SEEN));
    assert!(matches!(
        r.before.get(&DiskKey::Record(SEEN)),
        Some(Some(_))
    ));
}

/// What one read-fault run moved in memory: the fields of [`memory`], and
/// `changed` when change keys were handed back.
fn moved_by_fault(
    before: &BTreeMap<&'static str, String>,
    r: &Replica<DiskStore>,
    changed: &BTreeSet<String>,
) -> Vec<&'static str> {
    let mut fields = moved(before, &memory(r));
    if !changed.is_empty() {
        fields.push("changed");
    }
    fields
}

/// What [`read_fault_sweep`] finds: the reads, the exceptions, and from which
/// read on each set of moved memory holds.
type Sweep = (
    String,
    Vec<(usize, &'static str)>,
    Vec<(usize, Vec<&'static str>)>,
);

/// Fail each row read of an apply in turn. Gives the reads the path makes, in
/// order and by store method, every read whose failure is not an internal
/// error that stores nothing, `(read, how the apply ended)`, and the memory a
/// failure at each read leaves moved, as `(first read, moved)` wherever it
/// changes from the read before.
fn read_fault_sweep(setup: Setup) -> Sweep {
    let reads = {
        let mut n = node();
        let c = setup(&mut n);
        let mut d = on_disk(n);
        seen_before(&mut d.r);
        let start = d.disk.borrow().row_reads.len();
        let head = retain(&mut d.r);
        drive(&mut d.r, head, &c, &mut BTreeSet::new()).unwrap();
        d.disk.borrow().row_reads[start..].to_vec()
    };
    let mut exceptions = Vec::new();
    let mut memory_moved: Vec<(usize, Vec<&'static str>)> = Vec::new();
    for k in 0..reads.len() {
        let mut n = node();
        let c = setup(&mut n);
        let mut d = on_disk(n);
        seen_before(&mut d.r);
        let seen = d.r.before.clone();
        let before = d.r.store.head().unwrap();
        let rows_before = rows(&d.r);
        let head = retain(&mut d.r);
        let memory_before = memory(&d.r);
        d.disk.borrow_mut().fail_row_read = Some(k as u64);
        let mut changed = BTreeSet::new();
        let result = drive(&mut d.r, head, &c, &mut changed);
        assert_eq!(d.disk.borrow().fail_row_read, None, "read {k} was made");
        match exit(&d.r, &result, before, head) {
            "error" => assert_eq!(rows(&d.r), rows_before, "read {k}: nothing is stored"),
            other => exceptions.push((k, other)),
        }
        for (key, shown) in &seen {
            assert_eq!(
                format!("{:?}", d.r.before.get(key)),
                format!("{:?}", Some(shown)),
                "read {k}: what was captured before the entry is kept"
            );
        }
        let fields = moved_by_fault(&memory_before, &d.r, &changed);
        if memory_moved.last().map(|(_, m)| m) != Some(&fields) {
            memory_moved.push((k, fields));
        }
    }
    (reads.join(" "), exceptions, memory_moved)
}

/// A delegated entry with two file operations, one an attachment, and a text
/// read from a record: the delegation guard reads each operation's file, in
/// operation order, before the text table is resolved.
fn delegated_file_ops(n: &mut Node) -> Case {
    let mut c = legacy_setup(n);
    let (FileContent::AttachmentV1(content), _) = contents(n, b"picture", true) else {
        unreachable!()
    };
    c.payload.mutation.on_behalf = Some(B16([0x73; 16]));
    c.payload.mutation.ops.extend([
        rt::Op::Legacy(Op::FileDelete(FileDelete {
            id: FILE,
            if_revision: None,
            base: None,
        })),
        rt::Op::FileAttach(FileAttach {
            id: OTHER_FILE,
            path: "pic.png".into(),
            content,
            if_revision: None,
            base: None,
            mtime: None,
        }),
    ]);
    c.payload.texts = Some(vec![TextDef::Form(TextDefForm::Delta(TextDelta {
        source: TextSource::PrevRecord(HOLDER),
        ops: vec![DeltaOp::Copy { offset: 0, len: 4 }],
    }))]);
    c
}

/// The delegation guard reads the files of the operations in order and stalls
/// at the first native one, before anything else is read: an attachment is
/// guarded like the legacy file operations.
#[test]
fn delegation_guard_stops_at_the_first_native_file() {
    let mut n = node();
    let mut c = delegated_file_ops(&mut n);
    let Some(rt::Op::FileAttach(attach)) = c.payload.mutation.ops.last_mut() else {
        panic!("expected the attachment")
    };
    attach.id = UNINDEXED;
    // The attachment, then a file operation after it.
    let attach = c.payload.mutation.ops.pop().unwrap();
    c.payload.mutation.ops.insert(1, attach);
    let mut d = on_disk(n);
    let start = d.disk.borrow().row_reads.len();
    let head = retain(&mut d.r);
    let outcome = drive(&mut d.r, head, &c, &mut BTreeSet::new()).unwrap();
    assert!(
        matches!(
            &outcome,
            Outcome::Stall(IncidentKind::UpgradeRequired, why)
                if why == "delegated native file mediation is not supported"
        ),
        "{outcome:?}"
    );
    assert_eq!(d.disk.borrow().row_reads[start..], ["file"]);
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
/// is an error with the entry already stored. (A delta text's source record is
/// read the same way, so a failed read there persists a void.) Each failure
/// leaves memory moved as listed, and keeps what was captured before the entry.
#[test]
fn read_faults_by_read() {
    type Exceptions = &'static [(usize, &'static str)];
    type Memory = &'static [(usize, &'static [&'static str])];
    // Everything an applied entry moves, with the change keys.
    const ALL: &[&str] = &[
        "before",
        "head",
        "log_time",
        "policy",
        "query_context",
        "retaining",
        "sem_ratchet",
        "stats",
        "changed",
    ];
    // An applied entry that changes the catalog.
    const ALL_CATALOG: &[&str] = &[
        "before",
        "catalog",
        "head",
        "log_time",
        "policy",
        "query_context",
        "retaining",
        "sem_ratchet",
        "stats",
        "changed",
    ];
    let cases: [(&str, Setup, &str, Exceptions, Memory); 6] = [
        (
            "delegated file ops",
            delegated_file_ops,
            "file file record file record tombstone record_at file_at pending_get holds record \
             resources",
            // The text table reads a failed source record as a missing one and
            // voids; then the capture of what the disk shows.
            &[(2, "V7: text table"), (10, "applied")],
            &[
                (0, &[]),
                // The void.
                (2, &["head", "policy", "retaining"]),
                (3, &[]),
                (9, &["changed"]),
                // Applied, and this replica's own entry is not counted.
                (
                    10,
                    &[
                        "before",
                        "head",
                        "log_time",
                        "policy",
                        "query_context",
                        "retaining",
                        "sem_ratchet",
                        "changed",
                    ],
                ),
                (11, &["before", "policy", "changed"]),
            ],
        ),
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
            &[
                (0, &[]),
                (13, &["changed"]),
                (14, ALL_CATALOG),
                (16, &["before", "policy", "changed"]),
                (17, ALL_CATALOG),
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
            &[
                (0, &[]),
                (5, ALL),
                (11, &["stats"]),
                (12, &["stats", "changed"]),
                (13, ALL),
                (14, &["before", "policy", "stats", "changed"]),
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
            &[
                (0, &[]),
                (36, &["stats"]),
                (37, &["stats", "changed"]),
                (38, &["policy", "stats", "changed"]),
            ],
        ),
        (
            "native reindex",
            reindex_setup,
            "file record_at file_at file file record_at file_at record pending_get holds \
             resources",
            &[],
            &[
                (0, &[]),
                (8, &["stats"]),
                (9, &["stats", "changed"]),
                (10, &["before", "policy", "stats", "changed"]),
            ],
        ),
        (
            "native promotion",
            promotion_setup,
            "file record_at file_at file record tombstone record_at file_at file record_at \
             file_at record file record_at file_at file record tombstone record_at file_at \
             file record_at file_at record pending_get holds resources",
            &[],
            &[
                (0, &[]),
                (24, &["stats"]),
                (25, &["stats", "changed"]),
                (26, &["before", "policy", "stats", "changed"]),
            ],
        ),
    ];
    for (name, setup, reads, exceptions, memory) in cases {
        let got = read_fault_sweep(setup);
        let memory: Vec<(usize, Vec<&str>)> =
            memory.iter().map(|(k, m)| (*k, m.to_vec())).collect();
        assert_eq!(
            (got.0.as_str(), got.1.as_slice(), &got.2),
            (reads, exceptions, &memory),
            "{name}"
        );
    }
}
