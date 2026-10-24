//! Compaction and GC archive what they remove (per-collection retention tier):
//! exact entries in order with `from`/`to`/`chain(to)`, deletion only after every
//! segment is stored, dead objects copied before their metadata goes, and
//! segment splitting at the 8 MiB bound. Reads are unchanged throughout.

use std::collections::BTreeMap;
use std::future::Future;
use std::sync::Arc;
use std::task::{Context, Poll, Wake, Waker};

use mdbn_log_service::limits::{ARCHIVE_SEGMENT_BYTES, MIB};
use mdbn_log_service::mem::{MemBackend, MemObjects};
use mdbn_log_service::model::{
    CollectionMeta, CollectionState, ObjectMeta, RetentionTier, SnapshotRow, StoredItem,
    archive_object_key, archive_segment_key, object_key,
};
use mdbn_log_service::{Backend, Config, Mode, ObjectStore, Service, Txn, Write};
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::common::{B16, B32, Uuid};
use mdbn_wire::hash::{chain_hash, sha256};

const DAY: i64 = 24 * 60 * 60 * 1000;
const T0: i64 = 1_800_000_000_000;
const GRACE: u64 = 10_000;

struct NoWake;
impl Wake for NoWake {
    fn wake(self: Arc<Self>) {}
}
fn ready<F: Future>(future: F) -> F::Output {
    let waker = Waker::from(Arc::new(NoWake));
    let mut cx = Context::from_waker(&waker);
    let mut future = std::pin::pin!(future);
    match future.as_mut().poll(&mut cx) {
        Poll::Ready(v) => v,
        Poll::Pending => panic!("memory backend pended"),
    }
}

type Svc = Service<MemBackend, MemObjects>;

fn svc() -> Svc {
    Service::new(
        MemBackend::default(),
        MemObjects::default(),
        Config {
            roots: vec![],
            token_issuers: vec![],
            url_secret: vec![7; 32],
            public_base: "http://unused".into(),
        },
    )
}

fn item(seq: u64, kind: u64, bytes: Vec<u8>, refs: Vec<B32>) -> StoredItem {
    StoredItem {
        seq,
        kind,
        bytes,
        appended_at: T0,
        token: None,
        refs,
    }
}

/// A collection of `n` items at `T0`: seq 1 is control (genesis), `control`
/// lists further control positions, every other position is an `entry` of
/// `entry_bytes(seq)` bytes; an endorsed snapshot at `n`.
fn seed(
    svc: &Svc,
    c: &Uuid,
    n: u64,
    control: &[u64],
    entry_bytes: impl Fn(u64) -> Vec<u8>,
    refs: impl Fn(u64) -> Vec<B32>,
) -> Vec<StoredItem> {
    let mut items = Vec::new();
    for seq in 1..=n {
        let kind = if seq == 1 || control.contains(&seq) {
            2
        } else {
            1
        };
        let bytes = if kind == 1 {
            entry_bytes(seq)
        } else {
            format!("control {seq}").into_bytes()
        };
        items.push(item(seq, kind, bytes, refs(seq)));
    }
    let mut meta = CollectionMeta::new(*c, T0);
    meta.head = n;
    meta.head_chain = chain_hash(&items[items.len() - 1].bytes);
    meta.used_bytes = items.iter().map(|i| i.bytes.len() as u64).sum();
    let mut tx = ready(svc.backend.begin(c, Mode::Write)).unwrap();
    tx.write(Write::CreateCollection(CollectionState {
        meta,
        acl: BTreeMap::new(),
    }));
    for i in &items {
        tx.write(Write::InsertItem(i.clone()));
    }
    tx.write(Write::InsertSnapshot(SnapshotRow {
        seq: n,
        manifest: B32([9; 32]),
        author: B16([1; 16]),
        created_at: T0,
        endorsed: true,
        refs: vec![],
    }));
    ready(tx.commit()).unwrap();
    items
}

fn all_items(svc: &Svc, c: &Uuid, control_only: bool) -> Vec<StoredItem> {
    let mut tx = ready(svc.backend.begin(c, Mode::Read)).unwrap();
    ready(tx.items(0, u64::MAX, u64::MAX, control_only)).unwrap()
}

fn meta(svc: &Svc, c: &Uuid) -> CollectionMeta {
    let mut tx = ready(svc.backend.begin(c, Mode::Read)).unwrap();
    ready(tx.load()).unwrap().unwrap().meta
}

fn field(m: &[(Cbor, Cbor)], k: u64) -> &Cbor {
    &m.iter().find(|(kk, _)| *kk == Cbor::Uint(k)).unwrap().1
}

/// Decode a segment: (from, to, chain, [(seq, bytes)]).
fn decode_segment(c: &Uuid, bytes: &[u8]) -> (u64, u64, B32, Vec<(u64, Vec<u8>)>) {
    let Cbor::Map(m) = cbor::decode(bytes).unwrap() else {
        panic!("segment is a map");
    };
    assert_eq!(m.len(), 6);
    assert_eq!(field(&m, 0), &Cbor::Uint(1), "format");
    assert_eq!(field(&m, 1), &Cbor::Bytes(c.0.to_vec()), "collection");
    let Cbor::Uint(from) = field(&m, 2) else {
        panic!()
    };
    let Cbor::Uint(to) = field(&m, 3) else {
        panic!()
    };
    let Cbor::Bytes(ch) = field(&m, 4) else {
        panic!()
    };
    let Cbor::Array(rows) = field(&m, 5) else {
        panic!()
    };
    let rows = rows
        .iter()
        .map(|r| {
            let Cbor::Array(p) = r else { panic!() };
            let (Cbor::Uint(s), Cbor::Bytes(b)) = (&p[0], &p[1]) else {
                panic!()
            };
            (*s, b.clone())
        })
        .collect();
    (*from, *to, B32(ch.as_slice().try_into().unwrap()), rows)
}

#[test]
fn compaction_archives_exactly_the_deleted_entries() {
    let svc = svc();
    let c = B16([3; 16]);
    let n = GRACE + 50;
    let before = seed(
        &svc,
        &c,
        n,
        &[10],
        |s| format!("entry {s}").into_bytes(),
        |_| vec![],
    );
    let cp = n - GRACE; // 50

    let rf = ready(svc.compact(&c, T0 + 8 * DAY)).unwrap();
    assert_eq!(rf, cp + 1);
    assert_eq!(meta(&svc, &c).retained_from, cp + 1);

    // Reads: every control item and every entry above C, byte for byte.
    let expect: Vec<StoredItem> = before
        .iter()
        .filter(|i| i.kind != 1 || i.seq > cp)
        .cloned()
        .collect();
    assert_eq!(all_items(&svc, &c, false), expect);
    assert_eq!(
        all_items(&svc, &c, true)
            .iter()
            .map(|i| i.seq)
            .collect::<Vec<_>>(),
        vec![1, 10]
    );

    // The archive: one segment, the deleted entries in order (control skipped).
    let archived = svc.objects.archived();
    let key = archive_segment_key(&c, RetentionTier::Days30, 2, cp);
    assert_eq!(key, format!("archive/30d/{}/segments/2-{cp}", c.to_hex()));
    assert_eq!(archived.keys().collect::<Vec<_>>(), vec![&key]);
    let (from, to, chain, rows) = decode_segment(&c, &archived[&key]);
    assert_eq!((from, to), (2, cp));
    assert_eq!(chain, chain_hash(&before[cp as usize - 1].bytes));
    let deleted: Vec<(u64, Vec<u8>)> = before
        .iter()
        .filter(|i| i.kind == 1 && i.seq <= cp)
        .map(|i| (i.seq, i.bytes.clone()))
        .collect();
    assert_eq!(deleted.len(), cp as usize - 2);
    assert_eq!(rows, deleted);
    // Archive bytes do not count against the quota.
    let live: u64 = expect.iter().map(|i| i.bytes.len() as u64).sum();
    assert_eq!(meta(&svc, &c).used_bytes, live);

    // Nothing more to archive: a second run is a no-op.
    assert_eq!(ready(svc.compact(&c, T0 + 8 * DAY)).unwrap(), cp + 1);
    assert_eq!(svc.objects.archived().len(), 1);
}

#[test]
fn failed_archive_put_deletes_nothing() {
    let svc = svc();
    let c = B16([4; 16]);
    let n = GRACE + 30;
    let before = seed(&svc, &c, n, &[], |s| vec![s as u8; 64], |_| vec![]);
    let m0 = meta(&svc, &c);

    svc.objects.fail_archive(true);
    assert!(ready(svc.compact(&c, T0 + 8 * DAY)).is_err());
    assert_eq!(all_items(&svc, &c, false), before, "nothing deleted");
    assert_eq!(meta(&svc, &c), m0, "retained_from and used_bytes unchanged");
    assert!(svc.objects.archived().is_empty());

    // The next maintenance run succeeds.
    svc.objects.fail_archive(false);
    assert_eq!(ready(svc.compact(&c, T0 + 8 * DAY)).unwrap(), 31);
    assert_eq!(meta(&svc, &c).retained_from, 31);
    assert_eq!(svc.objects.archived().len(), 1);
}

#[test]
fn gc_archives_dead_objects_before_deleting_them() {
    let svc = svc();
    let c = B16([5; 16]);
    let dead_bytes = b"blob part".to_vec();
    let dead = sha256(&dead_bytes);
    let live = B32([2; 32]);
    let n = GRACE + 20;
    // The dead object is referenced only by entry 5 (compacted); the live one by
    // entry n (retained). A pending (uncommitted) upload has no bytes.
    seed(
        &svc,
        &c,
        n,
        &[],
        |s| vec![s as u8; 16],
        |s| match s {
            5 => vec![dead],
            s if s == n => vec![live],
            _ => vec![],
        },
    );
    let pending = B32([6; 32]);
    {
        let mut tx = ready(svc.backend.begin(&c, Mode::Write)).unwrap();
        for (a, size, committed) in [(dead, 9u64, true), (live, 4, true), (pending, 4, false)] {
            tx.write(Write::PutObject(ObjectMeta {
                address: a,
                kind: 18,
                size,
                checksum: a,
                committed,
                created_at: T0,
            }));
        }
        ready(tx.commit()).unwrap();
    }
    ready(svc.objects.put(&object_key(&c, &dead), dead_bytes.clone())).unwrap();
    ready(svc.objects.put(&object_key(&c, &live), b"live".to_vec())).unwrap();
    let now = T0 + 8 * DAY;
    assert_eq!(ready(svc.compact(&c, now)).unwrap(), 21);
    let used = meta(&svc, &c).used_bytes;

    // Archive unavailable: the committed dead object is kept (row and bytes);
    // the pending row, which has nothing to archive, goes.
    svc.objects.fail_archive(true);
    assert_eq!(ready(svc.gc(&c, now)).unwrap(), 1);
    {
        let mut tx = ready(svc.backend.begin(&c, Mode::Read)).unwrap();
        let got = ready(tx.objects(&[dead, live, pending])).unwrap();
        assert_eq!(
            got.iter().map(Option::is_some).collect::<Vec<_>>(),
            [true, true, false]
        );
    }
    assert_eq!(
        ready(svc.objects.get(&object_key(&c, &dead), None)).unwrap(),
        Some(dead_bytes.clone())
    );
    assert_eq!(svc.objects.archived().len(), 1, "only the segment so far");
    assert_eq!(
        meta(&svc, &c).used_bytes,
        used,
        "pending rows are not counted"
    );

    // Archive back: the dead object is copied, then its row and bytes go; the
    // live object stays.
    svc.objects.fail_archive(false);
    assert_eq!(ready(svc.gc(&c, now)).unwrap(), 1);
    {
        let mut tx = ready(svc.backend.begin(&c, Mode::Read)).unwrap();
        let got = ready(tx.objects(&[dead, live, pending])).unwrap();
        assert_eq!(
            got.iter().map(Option::is_some).collect::<Vec<_>>(),
            [false, true, false]
        );
    }
    assert_eq!(
        ready(svc.objects.get(&object_key(&c, &dead), None)).unwrap(),
        None
    );
    let archived = svc.objects.archived();
    let key = archive_object_key(&c, RetentionTier::Days30, &dead);
    assert_eq!(
        key,
        format!("archive/30d/{}/objects/{}", c.to_hex(), dead.to_hex())
    );
    assert_eq!(archived.get(&key), Some(&dead_bytes));
    assert_eq!(
        archived.len(),
        2,
        "segment + dead object, not the pending row"
    );
    assert_eq!(
        meta(&svc, &c).used_bytes,
        used - 9,
        "archived bytes not counted"
    );
}

#[test]
fn segments_split_at_the_byte_bound() {
    let svc = svc();
    let c = B16([8; 16]);
    let n = GRACE + 20;
    // Entries 2..=20 are 1 MiB each: 19 MiB over the 8 MiB bound → 8 + 8 + 3.
    let before = seed(
        &svc,
        &c,
        n,
        &[],
        |s| {
            if s <= 20 {
                vec![s as u8; MIB as usize]
            } else {
                vec![s as u8; 8]
            }
        },
        |_| vec![],
    );
    assert_eq!(ready(svc.compact(&c, T0 + 8 * DAY)).unwrap(), 21);
    let archived = svc.objects.archived();
    let keys: Vec<String> = [(2, 9), (10, 17), (18, 20)]
        .into_iter()
        .map(|(f, t)| archive_segment_key(&c, RetentionTier::Days30, f, t))
        .collect();
    let mut sorted = keys.clone();
    sorted.sort();
    assert_eq!(archived.keys().cloned().collect::<Vec<_>>(), sorted);
    let mut all = Vec::new();
    for (key, (f, t)) in keys.iter().zip([(2u64, 9u64), (10, 17), (18, 20)]) {
        let (from, to, chain, rows) = decode_segment(&c, &archived[key]);
        assert_eq!((from, to), (f, t));
        assert_eq!(chain, chain_hash(&before[t as usize - 1].bytes));
        let bytes: u64 = rows.iter().map(|(_, b)| b.len() as u64).sum();
        assert!(bytes <= ARCHIVE_SEGMENT_BYTES);
        all.extend(rows);
    }
    let deleted: Vec<(u64, Vec<u8>)> = before[1..20]
        .iter()
        .map(|i| (i.seq, i.bytes.clone()))
        .collect();
    assert_eq!(all, deleted);
    assert_eq!(all_items(&svc, &c, false).len(), 1 + (n - 20) as usize);
}
