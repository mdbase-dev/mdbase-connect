//! Native generation-0 import and finish over the actual Engine's FULL target
//! and real SQLite: oversized, mismatched, replayed, foreign, partial,
//! lost-acknowledgement and out-of-order inputs never seal into custody, never
//! settle and never advance the Driver.
use super::*;
use crate::migration_action_ledger::{
    JournalDriver, LedgerError, PreparedAction, RunBinding, target_fingerprint, tests::Sqlite,
};
use crate::runtime::ObservedNativeTarget;
use mdbn_migrate_portable::hosted_import::{
    Action, Generation, Key, Outcome, Step, Table, bucket_range, bucket16,
};
use mdbn_migrate_portable::preflight::EntityKind;
use mdbn_replica::crypto::TestEntropy;
use mdbn_replica::replica::gen0::{DigestCounts, StateDigestStream};
use mdbn_wire::cbor::{Cbor, encode};
use mdbn_wire::common::Uuid;
use std::collections::BTreeMap;

const HOLD: [u8; 16] = [0x44; 16];
const SESSION: [u8; 16] = [0x61; 16];
const RUN: [u8; 16] = [0x51; 16];
const HEAD: u64 = 42;
const STARTED: &str = "2026-10-12T08:00:00.000000Z";
/// The run-one GIF fixture's current version.
const GIF: &[u8] = b"GIF89a\x01\x00\x01\x00\x80\x00\x00\xff\xff\xff\x00\x00\x00!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;";

fn b(v: [u8; 16]) -> Cbor {
    Cbor::Bytes(v.to_vec())
}
fn t(v: &str) -> Cbor {
    Cbor::Text(v.into())
}
fn enc(v: Vec<Cbor>) -> Vec<u8> {
    encode(&Cbor::Array(v)).unwrap()
}
fn id(n: u8) -> [u8; 16] {
    let mut v = [0x10; 16];
    v[6] = 0x40;
    v[8] = 0x80;
    v[15] = n;
    v
}
fn key(n: u8) -> String {
    B16(id(n)).to_uuid_string()
}

/// Current legacy content, as the step-7 reader streams it.
struct Legacy {
    resources: Vec<(&'static str, String)>,
    records: Vec<(u8, &'static str, String)>,
    files: Vec<(u8, &'static str, Vec<u8>)>,
}
fn legacy() -> Legacy {
    Legacy {
        resources: vec![
            ("mdbase.yaml", "name: run one\n".into()),
            ("_types/person.md", "---\nname: person\n---\n".into()),
        ],
        records: vec![
            (1, "notes/a.md", format!("# A\n{}\n", "a".repeat(2048))),
            (2, "notes/b.md", "# B\n".into()),
            (3, "people/ada.md", "---\ntype: person\n---\nAda\n".into()),
        ],
        files: vec![(9, "assets/pixel.gif", GIF.to_vec())],
    }
}

fn binding(target: &ObservedNativeTarget) -> RunBinding {
    RunBinding {
        collection: target.admission().collection(),
        owner: target.genesis_owner(),
        started_us: "10413792000000001".into(),
        target: target_fingerprint(target),
    }
}
thread_local! {
    /// Nonzero for a second run on one ledger, so the same fixed seeds never
    /// repeat the first run's action IDs.
    static RUN_SALT: std::cell::Cell<u8> = const { std::cell::Cell::new(0) };
}
struct Salted(TestEntropy);
impl mdbn_replica::crypto::Entropy for Salted {
    fn fill(&mut self, buf: &mut [u8]) {
        self.0.fill(buf);
        if let Some(last) = buf.last_mut() {
            *last ^= RUN_SALT.get();
        }
    }
}
#[track_caller]
fn next(d: &mut JournalDriver<Sqlite>, seed: u8) -> (PreparedAction, Action) {
    loop {
        // Metadata work polls consume no entropy or action IDs.
        match d.prepare(&mut Salted(TestEntropy::new(seed))) {
            Err(LedgerError::Unsupported) => {}
            other => return other.unwrap(),
        }
    }
}
fn account(collection: Uuid, owner: Uuid) -> Vec<u8> {
    enc(vec![
        Cbor::Uint(1),
        b(owner.0),
        t("legacy"),
        t("lab-run-1"),
        Cbor::Bool(true),
        Cbor::Bool(true),
        Cbor::Bool(false),
        Cbor::Bool(false),
        Cbor::Array(vec![b(collection.0)]),
        Cbor::Array(vec![]),
        Cbor::Array(vec![]),
    ])
}
fn page_row(id: Option<[u8; 16]>, path: &str, bytes: &[u8]) -> Cbor {
    Cbor::Array(vec![
        id.map_or(Cbor::Null, b),
        t(path),
        Cbor::Bytes(sha256(bytes).0.to_vec()),
        Cbor::Uint(bytes.len() as u64),
    ])
}
fn page(collection: Uuid, table: &str, rows: Vec<Cbor>) -> Vec<u8> {
    enc(vec![
        Cbor::Uint(1),
        b(collection.0),
        Cbor::Uint(HEAD),
        b(SESSION),
        t(table),
        Cbor::Null,
        Cbor::Array(rows),
        Cbor::Null,
    ])
}

/// Backup, actual native creation, fence, drain and the S0 read of `l`'s
/// metadata (with `file_size` overriding declared file sizes); the resource window
/// is pending.
/// One attempt's backup hold and provider migration run.
struct Attempt {
    hold: u8,
    run: [u8; 16],
    started: &'static str,
}
const FIRST: Attempt = Attempt {
    hold: HOLD[0],
    run: RUN,
    started: STARTED,
};
fn read_with(
    h: &mut AppHosted,
    target: &ObservedNativeTarget,
    l: &Legacy,
    file_size: Option<u64>,
) -> (JournalDriver<Sqlite>, PreparedAction) {
    let mut d =
        JournalDriver::resume(Sqlite::new(), binding(target), &mut TestEntropy::new(81)).unwrap();
    let p = read_attempt(&mut d, h, target, l, file_size, &FIRST, &mut |seed| seed);
    (d, p)
}
/// From `Start`: hold, create, fence, drain and read every legacy page;
/// `ImportGen0` pending. `seed` maps each step's entropy seed.
fn read_attempt(
    d: &mut JournalDriver<Sqlite>,
    h: &mut AppHosted,
    target: &ObservedNativeTarget,
    l: &Legacy,
    file_size: Option<u64>,
    attempt: &Attempt,
    seed: &mut dyn FnMut(u8) -> u8,
) -> PreparedAction {
    let c = target.admission().collection();
    let hold = [attempt.hold; 16];
    let (p, _) = next(d, seed(20));
    d.settle_provider(
        &p,
        &crate::migration_action_ledger::tests::backup(attempt.hold),
    )
    .unwrap();
    let (p, a) = next(d, seed(30));
    assert_eq!(a, Action::CreateCollection);
    d.settle_created(&p, &mut h.e, target).unwrap();
    let (p, a) = next(d, seed(40));
    assert_eq!(a, Action::MayFence);
    d.settle_provider(&p, &account(c, target.genesis_owner()))
        .unwrap();
    let (p, a) = next(d, seed(50));
    assert_eq!(a, Action::Fence);
    let fence = enc(vec![
        Cbor::Uint(2),
        b(c.0),
        t("migrating"),
        b(attempt.run),
        t(attempt.started),
        Cbor::Null,
        Cbor::Array(vec![]),
    ]);
    d.settle_provider(&p, &fence).unwrap();
    let (p, _) = next(d, seed(60));
    let drain = enc(vec![
        Cbor::Uint(3),
        b(c.0),
        t("migrating"),
        b(attempt.run),
        Cbor::Uint(HEAD),
        t(attempt.started),
        Cbor::Null,
        Cbor::Uint(0),
        Cbor::Uint(1),
        Cbor::Uint(0),
    ]);
    d.settle_provider(&p, &drain).unwrap();
    let (p, a) = next(d, seed(64));
    assert!(matches!(a, Action::OpenSource { .. }));
    let opened = enc(vec![
        Cbor::Uint(0),
        b(c.0),
        t("migrating"),
        Cbor::Uint(HEAD),
        b(SESSION),
        b(hold),
    ]);
    d.settle_source(&p, &opened).unwrap();
    let mut s = 70;
    for table in [Table::Resources, Table::Records, Table::Files] {
        let (mut p, a) = next(d, seed(s));
        s += 1;
        assert!(matches!(a, Action::ReadPage { table: t, .. } if t == table));
        let body = match table {
            Table::Resources => page(
                c,
                "resources",
                l.resources
                    .iter()
                    .map(|(path, text)| page_row(None, path, text.as_bytes()))
                    .collect(),
            ),
            Table::Records => page(
                c,
                "records",
                l.records
                    .iter()
                    .map(|(n, path, doc)| page_row(Some(id(*n)), path, doc.as_bytes()))
                    .collect(),
            ),
            Table::Files => {
                let rows = l
                    .files
                    .iter()
                    .map(|(n, path, bytes)| match file_size {
                        None => page_row(Some(id(*n)), path, bytes),
                        Some(size) => Cbor::Array(vec![
                            b(id(*n)),
                            t(path),
                            Cbor::Bytes(sha256(bytes).0.to_vec()),
                            Cbor::Uint(size),
                        ]),
                    })
                    .collect();
                page(c, "files", rows)
            }
        };
        let Cbor::Array(mut fields) = mdbn_wire::cbor::decode(&body).unwrap() else {
            panic!()
        };
        let Cbor::Array(rows) = std::mem::replace(&mut fields[6], Cbor::Null) else {
            panic!()
        };
        let mut after = Cbor::Null;
        for (i, chunk) in rows.chunks(64).enumerate() {
            if i > 0 {
                p = next(d, seed(s)).0;
                s += 1;
            }
            let last = if (i + 1) * 64 < rows.len() {
                let Cbor::Array(row) = chunk.last().unwrap() else {
                    panic!()
                };
                match table {
                    Table::Resources => row[1].clone(),
                    _ => {
                        let Cbor::Bytes(id) = &row[0] else { panic!() };
                        t(&B16(id.as_slice().try_into().unwrap()).to_uuid_string())
                    }
                }
            } else {
                Cbor::Null
            };
            fields[5] = after;
            fields[6] = Cbor::Array(chunk.to_vec());
            fields[7] = last.clone();
            d.settle_source(&p, &encode(&Cbor::Array(fields.clone())).unwrap())
                .unwrap();
            after = last;
        }
        if rows.is_empty() {
            d.settle_source(&p, &body).unwrap();
        }
    }
    let (p, a) = next(d, seed(80));
    assert!(matches!(
        a,
        Action::ImportGen0 {
            bucket: None,
            after: None,
            ..
        }
    ));
    p
}

struct Run {
    svc: FakeLogService,
    cp: TestControlPlane,
    h: AppHosted,
    target: ObservedNativeTarget,
    l: Legacy,
    d: JournalDriver<Sqlite>,
    p: PreparedAction,
}
fn run() -> Run {
    run_legacy(legacy())
}
fn run_legacy(l: Legacy) -> Run {
    let (svc, cp, _, _) = fixture();
    let mut h = open(&svc);
    h.pump(false);
    let target = h.e.observe_native_target().unwrap();
    let (d, p) = read_with(&mut h, &target, &l, None);
    Run {
        svc,
        cp,
        h,
        target,
        l,
        d,
        p,
    }
}

/// The host's view of the collection's object store.
#[derive(Default)]
struct Objects(BTreeMap<B32, Vec<u8>>);
impl Objects {
    fn put(&mut self, out: &crate::migration_action_ledger::Gen0Output) {
        for o in &out.objects {
            assert_eq!(o.address, sha256(&o.bytes));
            self.0.insert(o.address, o.bytes.clone());
        }
    }
    fn result(&self, collection: Uuid, verify: &[B32]) -> Vec<u8> {
        enc(vec![
            b(collection.0),
            Cbor::Array(
                verify
                    .iter()
                    .map(|a| Cbor::Bool(self.0.contains_key(a)))
                    .collect(),
            ),
        ])
    }
}

fn source_head(c: Uuid) -> [Cbor; 3] {
    [b(c.0), Cbor::Uint(HEAD), b(SESSION)]
}
fn file_input(c: Uuid, n: u8, bytes: &[u8]) -> Vec<u8> {
    let [c, h, s] = source_head(c);
    enc(vec![c, h, s, b(id(n)), Cbor::Bytes(bytes.to_vec())])
}
fn file_chunk_input(c: Uuid, n: u8, offset: u64, bytes: &[u8]) -> Vec<u8> {
    let [c, h, s] = source_head(c);
    enc(vec![
        c,
        h,
        s,
        b(id(n)),
        Cbor::Uint(offset),
        Cbor::Bytes(bytes.to_vec()),
    ])
}
fn window_input(c: Uuid, rows: Vec<(Cbor, String)>) -> Vec<u8> {
    let [c, h, s] = source_head(c);
    enc(vec![
        c,
        h,
        s,
        Cbor::Array(
            rows.into_iter()
                .map(|(k, text)| Cbor::Array(vec![k, Cbor::Text(text)]))
                .collect(),
        ),
    ])
}
fn resource_rows(l: &Legacy) -> Vec<(Cbor, String)> {
    l.resources
        .iter()
        .map(|(path, text)| (t(path), text.clone()))
        .collect()
}
fn in_bucket(bits: u64, bucket: u64, n: u8) -> bool {
    let (lo, hi) = bucket_range(bits, bucket).unwrap();
    let k = Key {
        kind: EntityKind::Record,
        id: key(n),
    };
    (lo..=hi).contains(&bucket16(&k).unwrap())
}
fn record_rows(l: &Legacy, bits: u64, bucket: u64) -> Vec<(Cbor, String)> {
    l.records
        .iter()
        .filter(|(n, _, _)| in_bucket(bits, bucket, *n))
        .map(|(n, _, doc)| (b(id(*n)), doc.clone()))
        .collect()
}

impl Run {
    fn c(&self) -> Uuid {
        self.target.admission().collection()
    }
    /// Seal, upload and settle the pending window; the next action is pending.
    fn window(&mut self, store: &mut Objects, seed: u8) {
        let c = self.c();
        let selected = self
            .d
            .gen0_placement_input(&self.p, &mut self.h.e, &self.target)
            .unwrap();
        let Cbor::Array(fields) = mdbn_wire::cbor::decode(&selected).unwrap() else {
            panic!()
        };
        let Cbor::Array(placements) = &fields[0] else {
            panic!()
        };
        let mut rows = Vec::new();
        for placement in placements {
            let Cbor::Array(row) = placement else {
                panic!()
            };
            let [Cbor::Uint(kind), Cbor::Text(legacy_key), ..] = row.as_slice() else {
                panic!()
            };
            match kind {
                0 => {
                    let (path, doc) = self
                        .l
                        .resources
                        .iter()
                        .find(|(path, _)| *path == legacy_key)
                        .unwrap();
                    rows.push((t(path), doc.clone()));
                }
                1 => {
                    let (n, _, doc) = self
                        .l
                        .records
                        .iter()
                        .find(|(n, _, _)| key(*n) == *legacy_key)
                        .unwrap();
                    rows.push((b(id(*n)), doc.clone()));
                }
                2 => {
                    let (n, _, bytes) = self
                        .l
                        .files
                        .iter()
                        .find(|(n, _, _)| key(*n) == *legacy_key)
                        .unwrap();
                    for (index, chunk) in bytes.chunks(8 << 20).enumerate() {
                        let input = file_chunk_input(c, *n, (index * (8 << 20)) as u64, chunk);
                        let out = self
                            .d
                            .gen0_file_chunk(&self.p, &mut self.h.e, &self.target, &input)
                            .unwrap();
                        assert!(out.verify.is_empty());
                        store.put(&out);
                    }
                    if bytes.is_empty() {
                        let out = self
                            .d
                            .gen0_file_chunk(
                                &self.p,
                                &mut self.h.e,
                                &self.target,
                                &file_chunk_input(c, *n, 0, bytes),
                            )
                            .unwrap();
                        store.put(&out);
                    }
                }
                _ => panic!(),
            }
        }
        let out = self
            .d
            .gen0_window(&self.p, &mut self.h.e, &self.target, &window_input(c, rows))
            .unwrap();
        store.put(&out);
        let result = self
            .d
            .settle_gen0(
                &self.p,
                &mut self.h.e,
                &self.target,
                &store.result(c, &out.verify),
            )
            .unwrap();
        self.d.assert_settled(&self.p, result).unwrap();
        self.p = next(&mut self.d, seed).0;
    }
    /// Every window settled; `FinishGen0` is pending.
    fn windows(&mut self, store: &mut Objects, seed: u8) {
        let mut seed = seed;
        while !matches!(self.d.prepared_action(&self.p).unwrap(), Action::FinishGen0) {
            self.window(store, seed);
            seed += 1;
        }
    }
    /// Nothing settled, the Driver unmoved and the pending still original.
    fn unmoved(&mut self, settled: i64, step: Step) {
        assert_eq!(self.d.test_settled(), settled);
        assert_eq!(self.d.test_checkpoint().step, step);
        self.d.assert_prepared(&self.p).unwrap();
    }
}

/// `snapshot.md` §4 digest fed from the CONTENT (text, document, sealed file
/// hash), independently of the native placements-only stream.
fn expected_digest(l: &Legacy) -> B32 {
    let settings = mdbn_replica::convert::winclusion(&Default::default());
    let mut s = StateDigestStream::new(
        DigestCounts {
            resources: l.resources.len() as u64,
            records: l.records.len() as u64,
            files: l.files.len() as u64,
            unindexed: 0,
        },
        &settings,
    );
    let mut resources = l.resources.clone();
    resources.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    for (path, text) in &resources {
        s.resource(path, text).unwrap();
    }
    let mut records = l.records.clone();
    records.sort_by_key(|r| id(r.0));
    for (n, path, doc) in &records {
        s.record(B16(id(*n)), path, sha256(doc.as_bytes())).unwrap();
    }
    for (n, path, bytes) in &l.files {
        s.file_revision(B16(id(*n)), path, sha256(bytes)).unwrap();
    }
    s.finish().unwrap()
}

#[test]
fn gen0_windows_and_finish_settle_from_verified_uploads_to_base_intent() {
    let mut r = run();
    let mut store = Objects::default();
    r.windows(&mut store, 90);
    let settled = r.d.test_settled();
    let out = r.d.gen0_finish(&r.p, &mut r.h.e, &r.target).unwrap();
    // The output encoding is the host's exact upload list and verify list.
    let Cbor::Array(parts) = mdbn_wire::cbor::decode(&out.encode()).unwrap() else {
        panic!()
    };
    assert_eq!(parts.len(), 2);
    store.put(&out);
    // Every base ref (manifest included) must be shown present.
    assert!(out.verify.contains(&out.objects.last().unwrap().address));
    let flags = store.result(r.c(), &out.verify);
    let result =
        r.d.settle_gen0(&r.p, &mut r.h.e, &r.target, &flags)
            .unwrap();
    r.d.assert_settled(&r.p, result).unwrap();
    assert_eq!(r.d.test_settled(), settled + 1);
    let cp = r.d.test_checkpoint();
    assert_eq!(cp.step, Step::BaseIntent);
    assert_eq!(cp.manifest, Some(out.objects.last().unwrap().address));
    // The placements-only stream equals the content-fed digest: the verified
    // bytes and the metadata the base commits to are the same state.
    assert_eq!(cp.state_digest, Some(expected_digest(&r.l)));
    assert_eq!(cp.s0, Some(HEAD));
    let (_, a) = next(&mut r.d, 120);
    assert!(matches!(a, Action::AppendBase { .. } | Action::FindBase));
}

#[test]
fn gen0_refuses_a_file_over_one_mib_before_sealing() {
    let (svc, cp, _, _) = fixture();
    let mut h = open(&svc);
    h.pump(false);
    let target = h.e.observe_native_target().unwrap();
    let mut l = legacy();
    let big = vec![7u8; (1 << 20) + 1];
    l.files = vec![(9, "assets/big.bin", big.clone())];
    let (d, p) = read_with(&mut h, &target, &l, None);
    let mut r = Run {
        svc,
        cp,
        h,
        target,
        l,
        d,
        p,
    };
    let mut store = Objects::default();
    r.window(&mut store, 90);
    let settled = r.d.test_settled();
    let c = r.c();
    // The input itself is over the bound, and so is the placement.
    assert_eq!(
        r.d.gen0_file(&r.p, &mut r.h.e, &r.target, &file_input(c, 9, &big))
            .err(),
        Some(LedgerError::Unsupported)
    );
    assert_eq!(
        r.d.gen0_file(
            &r.p,
            &mut r.h.e,
            &r.target,
            &file_input(c, 9, &big[..1 << 20])
        )
        .err(),
        Some(LedgerError::Unsupported)
    );
    // Without the file the bucket window cannot be sealed.
    let bits = match r.d.prepared_action(&r.p).unwrap() {
        Action::ImportGen0 { bits, .. } => *bits,
        _ => unreachable!(),
    };
    let rows = record_rows(&r.l, bits, 0);
    assert_eq!(
        r.d.gen0_window(&r.p, &mut r.h.e, &r.target, &window_input(c, rows))
            .err(),
        Some(LedgerError::Conflict)
    );
    let step = r.d.test_checkpoint().step;
    r.unmoved(settled, step);
}

#[test]
fn gen0_refuses_content_that_does_not_match_its_hash_or_size() {
    let mut r = run();
    let c = r.c();
    let step = r.d.test_checkpoint().step;
    let settled = r.d.test_settled();
    // Resource text differing in content, then in size.
    for wrong in ["name: run 0ne\n", "name: run one\n\n"] {
        let mut rows = resource_rows(&r.l);
        rows[0].1 = wrong.into();
        assert_eq!(
            r.d.gen0_window(&r.p, &mut r.h.e, &r.target, &window_input(c, rows))
                .err(),
            Some(LedgerError::Conflict)
        );
    }
    r.unmoved(settled, step);
    let mut store = Objects::default();
    r.window(&mut store, 90);
    let settled = r.d.test_settled();
    let bits = match r.d.prepared_action(&r.p).unwrap() {
        Action::ImportGen0 { bits, .. } => *bits,
        _ => unreachable!(),
    };
    let mut gif = GIF.to_vec();
    gif[10] ^= 1;
    assert_eq!(
        r.d.gen0_file(&r.p, &mut r.h.e, &r.target, &file_input(c, 9, &gif))
            .err(),
        Some(LedgerError::Conflict)
    );
    assert_eq!(
        r.d.gen0_file(&r.p, &mut r.h.e, &r.target, &file_input(c, 9, &GIF[1..]))
            .err(),
        Some(LedgerError::Conflict)
    );
    // A file not placed in S0 at all.
    assert_eq!(
        r.d.gen0_file(&r.p, &mut r.h.e, &r.target, &file_input(c, 8, GIF))
            .err(),
        Some(LedgerError::Conflict)
    );
    r.d.gen0_file(&r.p, &mut r.h.e, &r.target, &file_input(c, 9, GIF))
        .unwrap();
    let mut rows = record_rows(&r.l, bits, 0);
    rows[0].1.push('!');
    assert_eq!(
        r.d.gen0_window(&r.p, &mut r.h.e, &r.target, &window_input(c, rows))
            .err(),
        Some(LedgerError::Conflict)
    );
    r.unmoved(settled, step);
}

#[test]
fn gen0_refuses_replayed_and_duplicate_imports() {
    let mut r = run();
    let c = r.c();
    let mut store = Objects::default();
    // Duplicate rows in one window are malformed.
    let mut rows = resource_rows(&r.l);
    rows.push(rows[0].clone());
    assert_eq!(
        r.d.gen0_window(&r.p, &mut r.h.e, &r.target, &window_input(c, rows))
            .err(),
        Some(LedgerError::Invalid)
    );
    let out =
        r.d.gen0_window(
            &r.p,
            &mut r.h.e,
            &r.target,
            &window_input(c, resource_rows(&r.l)),
        )
        .unwrap();
    // The same window again, while staged.
    assert_eq!(
        r.d.gen0_window(
            &r.p,
            &mut r.h.e,
            &r.target,
            &window_input(c, resource_rows(&r.l))
        )
        .err(),
        Some(LedgerError::Conflict)
    );
    store.put(&out);
    let first = r.p;
    let result =
        r.d.settle_gen0(&first, &mut r.h.e, &r.target, &store.result(c, &out.verify))
            .unwrap();
    r.d.assert_settled(&first, result).unwrap();
    // A replayed settlement or window on the settled ticket.
    assert_eq!(
        r.d.settle_gen0(&first, &mut r.h.e, &r.target, &store.result(c, &out.verify)),
        Err(LedgerError::Refused)
    );
    assert_eq!(
        r.d.gen0_window(
            &first,
            &mut r.h.e,
            &r.target,
            &window_input(c, resource_rows(&r.l))
        )
        .err(),
        Some(LedgerError::Refused)
    );
    r.p = next(&mut r.d, 90).0;
    let settled = r.d.test_settled();
    let step = r.d.test_checkpoint().step;
    // The resource window replayed against the bucket window.
    assert_eq!(
        r.d.gen0_window(
            &r.p,
            &mut r.h.e,
            &r.target,
            &window_input(c, resource_rows(&r.l))
        )
        .err(),
        Some(LedgerError::Conflict)
    );
    // The same file twice.
    r.d.gen0_file(&r.p, &mut r.h.e, &r.target, &file_input(c, 9, GIF))
        .unwrap();
    assert_eq!(
        r.d.gen0_file(&r.p, &mut r.h.e, &r.target, &file_input(c, 9, GIF))
            .err(),
        Some(LedgerError::Conflict)
    );
    r.unmoved(settled, step);
    // A settlement with nothing staged.
    assert_eq!(
        r.d.settle_gen0(&r.p, &mut r.h.e, &r.target, &store.result(c, &[])),
        Err(LedgerError::Conflict)
    );
    r.unmoved(settled, step);
}

#[test]
fn gen0_refuses_foreign_collection_read_session_and_engine() {
    let mut r = run();
    let c = r.c();
    let step = r.d.test_checkpoint().step;
    let settled = r.d.test_settled();
    let rows = |c: Cbor, h: u64, s: [u8; 16], l: &Legacy| {
        enc(vec![
            c,
            Cbor::Uint(h),
            b(s),
            Cbor::Array(
                resource_rows(l)
                    .into_iter()
                    .map(|(k, v)| Cbor::Array(vec![k, Cbor::Text(v)]))
                    .collect(),
            ),
        ])
    };
    for wrong in [
        rows(b([3; 16]), HEAD, SESSION, &r.l),
        // Another read: a different head or session than the settled open.
        rows(b(c.0), HEAD + 1, SESSION, &r.l),
        rows(b(c.0), HEAD, [0x62; 16], &r.l),
    ] {
        assert_eq!(
            r.d.gen0_window(&r.p, &mut r.h.e, &r.target, &wrong).err(),
            Some(LedgerError::Conflict)
        );
    }
    // Another Engine over the same collection is not this run's target.
    let mut other = open(&r.svc);
    other.pump(false);
    let input = window_input(c, resource_rows(&r.l));
    assert_eq!(
        r.d.gen0_window(&r.p, &mut other.e, &r.target, &input).err(),
        Some(LedgerError::Refused)
    );
    // Nor is that Engine's own observation a target for this run's Engine.
    let foreign = other.e.observe_native_target().unwrap();
    assert_eq!(
        r.d.gen0_window(&r.p, &mut r.h.e, &foreign, &input).err(),
        Some(LedgerError::Refused)
    );
    r.unmoved(settled, step);
    // A result naming another collection never settles, and keeps the staging.
    let mut store = Objects::default();
    let out =
        r.d.gen0_window(&r.p, &mut r.h.e, &r.target, &input)
            .unwrap();
    store.put(&out);
    assert_eq!(
        r.d.settle_gen0(
            &r.p,
            &mut r.h.e,
            &r.target,
            &store.result(B16([3; 16]), &out.verify)
        ),
        Err(LedgerError::Conflict)
    );
    r.unmoved(settled, step);
    r.d.settle_gen0(&r.p, &mut r.h.e, &r.target, &store.result(c, &out.verify))
        .unwrap();
}

#[test]
fn gen0_partial_window_then_crash_stays_unknown_and_unsettled() {
    let mut r = run();
    let c = r.c();
    let mut store = Objects::default();
    r.window(&mut store, 90);
    let settled = r.d.test_settled();
    let before = r.d.test_checkpoint();
    // Half a bucket: the file is sealed, the window is not.
    r.d.gen0_file(&r.p, &mut r.h.e, &r.target, &file_input(c, 9, GIF))
        .unwrap();
    let bits = match r.d.prepared_action(&r.p).unwrap() {
        Action::ImportGen0 { bits, .. } => *bits,
        _ => unreachable!(),
    };
    // A window missing a placement is refused outright.
    let mut rows = record_rows(&r.l, bits, 0);
    rows.pop();
    assert_eq!(
        r.d.gen0_window(&r.p, &mut r.h.e, &r.target, &window_input(c, rows))
            .err(),
        Some(LedgerError::Conflict)
    );
    // Crash: RAM custody and staging are gone; the saved pending is UNKNOWN.
    let pending = r.d.saved_pending().unwrap().unwrap();
    let index = r.d.into_index();
    let mut d =
        JournalDriver::resume(index, binding(&r.target), &mut TestEntropy::new(99)).unwrap();
    assert_eq!(d.saved_pending().unwrap(), Some(pending));
    assert!(matches!(
        d.prepare(&mut TestEntropy::new(100)),
        Err(LedgerError::OutstandingUnknown)
    ));
    assert_eq!(d.test_settled(), settled);
    assert_eq!(d.test_checkpoint().step, before.step);
    // The old ticket belongs to the dead instance.
    assert_eq!(
        d.gen0_file(&r.p, &mut r.h.e, &r.target, &file_input(c, 9, GIF))
            .err(),
        Some(LedgerError::Refused)
    );
}

#[test]
fn gen0_missing_upload_keeps_staging_and_lost_commit_ack_poisons() {
    let mut r = run();
    let c = r.c();
    let mut store = Objects::default();
    let out =
        r.d.gen0_window(
            &r.p,
            &mut r.h.e,
            &r.target,
            &window_input(c, resource_rows(&r.l)),
        )
        .unwrap();
    let settled = r.d.test_settled();
    let step = r.d.test_checkpoint().step;
    // A lost PutObject reply: nothing present. Refused, staging kept.
    assert_eq!(
        r.d.settle_gen0(&r.p, &mut r.h.e, &r.target, &store.result(c, &out.verify)),
        Err(LedgerError::Conflict)
    );
    // Too few or too many flags are refused too.
    store.put(&out);
    let mut flags = out.verify.clone();
    flags.pop();
    assert_eq!(
        r.d.settle_gen0(&r.p, &mut r.h.e, &r.target, &store.result(c, &flags)),
        Err(LedgerError::Conflict)
    );
    flags = out.verify.clone();
    flags.push(out.verify[0]);
    assert_eq!(
        r.d.settle_gen0(&r.p, &mut r.h.e, &r.target, &store.result(c, &flags)),
        Err(LedgerError::Conflict)
    );
    r.unmoved(settled, step);
    // The SAME transaction lands; only its acknowledgement is lost.
    r.d.test_lose_settlement();
    assert_eq!(
        r.d.settle_gen0(&r.p, &mut r.h.e, &r.target, &store.result(c, &out.verify)),
        Err(LedgerError::StorageUnknown)
    );
    assert!(matches!(
        r.d.prepare(&mut TestEntropy::new(101)),
        Err(LedgerError::StorageUnknown)
    ));
    assert_eq!(
        r.d.settle_gen0(&r.p, &mut r.h.e, &r.target, &store.result(c, &out.verify)),
        Err(LedgerError::Refused)
    );
    assert_eq!(
        r.d.gen0_finish(&r.p, &mut r.h.e, &r.target).err(),
        Some(LedgerError::Refused)
    );
    assert_eq!(r.d.test_settled(), settled + 1);
}

#[test]
fn gen0_finish_refuses_before_every_window_settles_and_twice() {
    let mut r = run();
    let c = r.c();
    let mut store = Objects::default();
    // Not the retained action: a window is pending.
    assert_eq!(
        r.d.gen0_finish(&r.p, &mut r.h.e, &r.target).err(),
        Some(LedgerError::Conflict)
    );
    let out =
        r.d.gen0_window(
            &r.p,
            &mut r.h.e,
            &r.target,
            &window_input(c, resource_rows(&r.l)),
        )
        .unwrap();
    // Staged but not settled.
    assert_eq!(
        r.d.gen0_finish(&r.p, &mut r.h.e, &r.target).err(),
        Some(LedgerError::Conflict)
    );
    store.put(&out);
    r.d.settle_gen0(&r.p, &mut r.h.e, &r.target, &store.result(c, &out.verify))
        .unwrap();
    r.p = next(&mut r.d, 90).0;
    assert_eq!(
        r.d.gen0_finish(&r.p, &mut r.h.e, &r.target).err(),
        Some(LedgerError::Conflict)
    );
    r.windows(&mut store, 100);
    let settled = r.d.test_settled();
    let step = r.d.test_checkpoint().step;
    let out = r.d.gen0_finish(&r.p, &mut r.h.e, &r.target).unwrap();
    // Twice: the custody slot is consumed and the finish is staged.
    assert_eq!(
        r.d.gen0_finish(&r.p, &mut r.h.e, &r.target).err(),
        Some(LedgerError::Conflict)
    );
    // A window input on the finish action.
    assert_eq!(
        r.d.gen0_window(
            &r.p,
            &mut r.h.e,
            &r.target,
            &window_input(c, resource_rows(&r.l))
        )
        .err(),
        Some(LedgerError::Conflict)
    );
    r.unmoved(settled, step);
    store.put(&out);
    let finish = r.p;
    r.d.settle_gen0(
        &finish,
        &mut r.h.e,
        &r.target,
        &store.result(c, &out.verify),
    )
    .unwrap();
    // And after settling: the ticket is spent.
    assert_eq!(
        r.d.gen0_finish(&finish, &mut r.h.e, &r.target).err(),
        Some(LedgerError::Refused)
    );
    assert_eq!(r.d.test_checkpoint().step, Step::BaseIntent);
}

#[test]
fn generic_settlement_refuses_gen0_outcomes() {
    let mut r = run();
    assert_eq!(
        r.d.settle(
            &r.p,
            Outcome::Gen0Progress {
                last: None,
                done: true
            }
        ),
        Err(LedgerError::Unsupported)
    );
    r.d.assert_prepared(&r.p).unwrap();
    let _ = Generation::S0;
}

mod hazards;
mod log_path;
mod windows;
