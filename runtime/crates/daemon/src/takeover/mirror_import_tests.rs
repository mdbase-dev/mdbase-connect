//! Capture and import of an old hosted mirror's unsent edits against an
//! in-memory replica: create, change, rename, delete, a non-text edit, a
//! conflict with the server, and crashes at every step.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use mdbn_legacy::mirror::RegistryEntry;
use mdbn_wire::common::Text;
use mdbn_wire::intent::Op;

use super::*;
use crate::takeover::adapter::CRASH_AT;

#[path = "../../tests/fixtures/hosted_mirror.rs"]
pub(crate) mod hosted_mirror;
use hosted_mirror::{HOSTED, RA, RB, RC, RD, RE, RU, server_records};

fn hx(b: &[u8]) -> String {
    hex_of(b)
}

fn id(s: &str) -> [u8; 16] {
    uuid_of(s).unwrap()
}

fn mirror_device(root: &Path) -> (PathBuf, RegistryEntry) {
    let old = root.join("connect");
    let entry = hosted_mirror::build(&old, &root.join("Hosted notes"));
    (old, entry)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Crash {
    /// The next submit fails before reaching the replica.
    BeforeSubmit,
    /// The next submit is applied, but the answer is lost.
    AfterApply,
}

#[derive(Default)]
struct Fake {
    records: BTreeMap<[u8; 16], (String, String)>,
    receipts: BTreeMap<[u8; 16], Outcome>,
    applies: usize,
    submits: usize,
    /// Crash at the n-th new submission (0-based).
    crash_at: Option<(usize, Crash)>,
}

impl Fake {
    fn new() -> Fake {
        let mut f = Fake::default();
        for (rid, path, doc) in server_records() {
            f.records.insert(id(rid), (path.into(), doc.into()));
        }
        f
    }
    fn at(&self, path: &str) -> Option<String> {
        self.records
            .values()
            .find(|(p, _)| p == path)
            .map(|(_, d)| d.clone())
    }
    fn current(&self, k: &[u8; 16]) -> Option<Current> {
        self.records.get(k).map(|(p, d)| Current {
            id: *k,
            path: p.clone(),
            revision: mdbn_wire::hash::sha256(d.as_bytes()).0,
            document: d.clone(),
        })
    }
    fn text(t: &Text) -> String {
        match t {
            Text::Inline(s) => s.clone(),
            Text::Index(_) => unreachable!(),
        }
    }
    /// Plans like the replica: a document applies over its base, else F is
    /// kept (the conflict is recorded); a delete is superseded by a change.
    fn apply(&mut self, ops: Vec<Op>) -> Outcome {
        self.applies += 1;
        for op in ops {
            match op {
                Op::Document(d) => {
                    let base = d.base.unwrap();
                    let new = d.new.unwrap();
                    let cur = self.records.get_mut(&d.id.0).unwrap();
                    if cur.1 == Self::text(&base.doc) {
                        *cur = (new.path, Self::text(&new.doc));
                    }
                }
                Op::Create(c) => {
                    let path = c.path.unwrap();
                    if self.at(&path).is_some() || path.ends_with(".base") {
                        return Outcome::Rejected;
                    }
                    self.records
                        .insert(c.id.0, (path, Self::text(&c.document.unwrap())));
                }
                Op::Delete(d) => {
                    if let Some(c) = self.current(&d.id.0)
                        && Some(c.revision) == d.base_revision.map(|r| r.0)
                    {
                        self.records.remove(&d.id.0);
                    }
                }
                _ => unreachable!(),
            }
        }
        Outcome::Confirmed
    }
}

impl Target for Fake {
    async fn get(&mut self, key: &str) -> io::Result<Option<Current>> {
        Ok(match uuid_of(key) {
            Some(k) => self.current(&k),
            None => self
                .records
                .iter()
                .find(|(_, (p, _))| p == key)
                .and_then(|(k, _)| self.current(k)),
        })
    }
    async fn submit(&mut self, ops: Vec<Op>, mutation: [u8; 16]) -> io::Result<Outcome> {
        if let Some(o) = self.receipts.get(&mutation) {
            return Ok(*o); // idempotent resubmission
        }
        let n = self.submits;
        self.submits += 1;
        let crash = match self.crash_at {
            Some((at, c)) if at == n => {
                self.crash_at = None;
                Some(c)
            }
            _ => None,
        };
        match crash {
            Some(Crash::BeforeSubmit) => return Err(io::Error::other("crash before submit")),
            Some(Crash::AfterApply) => {
                let o = self.apply(ops);
                self.receipts.insert(mutation, o);
                return Err(io::Error::other("crash after apply"));
            }
            _ => {}
        }
        let o = self.apply(ops);
        self.receipts.insert(mutation, o);
        Ok(o)
    }
    async fn receipt(&mut self, mutation: [u8; 16]) -> io::Result<Option<Outcome>> {
        Ok(self.receipts.get(&mutation).copied())
    }
}

/// Fresh IDs, distinct per `run` (a restarted daemon mints new UUIDv7s).
fn ids(run: u8) -> impl FnMut() -> [u8; 16] + Send {
    let mut n = 0u8;
    move || {
        n += 1;
        let mut b = [0u8; 16];
        b[0] = 0x01;
        b[14] = run;
        b[15] = n;
        b
    }
}

fn counter() -> impl FnMut() -> [u8; 16] + Send {
    ids(0)
}

fn block_on<F: std::future::Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(f)
}

fn snapshot(dir: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut out = BTreeMap::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in fs::read_dir(&d).unwrap().flatten() {
            if e.file_type().unwrap().is_dir() {
                stack.push(e.path());
            } else {
                out.insert(e.path(), fs::read(e.path()).unwrap());
            }
        }
    }
    out
}

struct Setup {
    dir: crate::testutil::TestDir,
    old: PathBuf,
    entry: RegistryEntry,
    legacy: PathBuf,
}

fn setup(tag: &str) -> Setup {
    let dir = crate::testutil::TestDir::new(tag);
    let (old, entry) = mirror_device(dir.path());
    let legacy = dir.path().join("state/legacy");
    fs::create_dir_all(dir.path().join("state")).unwrap();
    Setup {
        dir,
        old,
        entry,
        legacy,
    }
}

fn assert_imported(s: &Setup, f: &Fake) {
    assert_eq!(
        f.records[&id(RA)],
        ("a.md".into(), "A edited".into()),
        "modify"
    );
    assert_eq!(
        f.records[&id(RB)],
        ("sub/b2.md".into(), "B".into()),
        "rename"
    );
    assert!(!f.records.contains_key(&id(RC)), "delete");
    assert_eq!(f.at("n.md").as_deref(), Some("New"), "create");
    assert_eq!(
        f.records[&id(RD)].1,
        "D",
        "the non-text edit is not written"
    );
    assert_eq!(
        f.records[&id(RE)].1,
        "E theirs",
        "the conflict keeps the current version"
    );
    assert_eq!(f.records[&id(RU)].1, "U");
    // The conflict is a hold with the unsent version kept.
    let held = held::open(&s.legacy, HOSTED).unwrap();
    assert_eq!(held.len(), 1, "{held:?}");
    assert_eq!(held[0].path, "e.md");
    assert_eq!(held[0].cause, "changed_elsewhere");
    assert!(held[0].unsent);
    assert_eq!(held[0].intended.as_deref(), Some(&b"E mine"[..]));
    // The non-text edit is recovered beside the old folder, byte for byte.
    let st = status(&s.legacy, HOSTED).unwrap().unwrap();
    assert_eq!(st["complete"], true, "{st}");
    assert_eq!(st["applied"], 4, "{st}");
    assert_eq!(st["held"], 1);
    let rec = &st["recovered"][0];
    assert_eq!(rec["path"], "d.md");
    assert_eq!(rec["reason"], "not_text");
    let file = PathBuf::from(rec["file"].as_str().unwrap());
    assert_eq!(file, s.dir.path().join("Hosted notes (unsent edits)/d.md"));
    assert_eq!(fs::read(file).unwrap(), [0xff, 0xfe, 0x00, 0x01]);
}

#[test]
fn capture_records_every_kind_of_unsent_edit_and_never_touches_old_state() {
    let s = setup("mi-capture");
    let before = snapshot(s.dir.path());
    let got = capture(&s.legacy, &s.old, &s.entry, "2026-10-18T00:00:00Z").unwrap();
    assert_eq!(
        got,
        Captured {
            edits: 6,
            existing: false
        }
    );
    let c = Capture::load(&s.legacy, HOSTED).unwrap().unwrap();
    let kinds: Vec<String> = c.edits.iter().map(Edit::key).collect();
    assert_eq!(
        kinds,
        [
            format!("update:{RA}"),
            format!("update:{RB}"),
            format!("update:{RD}"),
            format!("update:{RE}"),
            format!("delete:{RC}"),
            "create:n.md".to_string(),
        ]
    );
    assert!(
        matches!(&c.edits[1], Edit::Update { from, path, .. } if from == "b.md" && path == "sub/b2.md")
    );
    assert_eq!(c.bytes(&s.legacy, &hx(b"A edited")).unwrap(), b"A edited");
    assert_eq!(
        c.bytes(&s.legacy, &hx(&[0xff, 0xfe, 0x00, 0x01])).unwrap(),
        [0xff, 0xfe, 0x00, 0x01]
    );
    // Old state and folder are read only.
    let after = snapshot(s.dir.path());
    for (p, b) in &before {
        assert_eq!(after.get(p), Some(b), "{p:?} changed");
    }
    // A second capture keeps the first, even if the folder changed since.
    fs::write(s.entry.path.join("a.md"), "later").unwrap();
    let again = capture(&s.legacy, &s.old, &s.entry, "2026-10-19T00:00:00Z").unwrap();
    assert_eq!(
        again,
        Captured {
            edits: 6,
            existing: true
        }
    );
    assert_eq!(Capture::load(&s.legacy, HOSTED).unwrap().unwrap(), c);
}

#[test]
fn a_crash_during_capture_leaves_no_partial_capture() {
    let s = setup("mi-capture-crash");
    CRASH_AT.with(|c| c.set(Some("mirror_capture")));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        capture(&s.legacy, &s.old, &s.entry, "2026-10-18T00:00:00Z")
    }));
    CRASH_AT.with(|c| c.set(None));
    assert!(r.is_err());
    assert_eq!(Capture::load(&s.legacy, HOSTED).unwrap(), None);
    assert!(captured(&s.legacy).unwrap().is_empty());
    let got = capture(&s.legacy, &s.old, &s.entry, "2026-10-18T00:00:00Z").unwrap();
    assert_eq!(got.edits, 6);
    assert_eq!(captured(&s.legacy).unwrap(), [HOSTED]);
}

#[test]
fn import_applies_edits_holds_the_conflict_and_recovers_the_binary() {
    let s = setup("mi-import");
    capture(&s.legacy, &s.old, &s.entry, "2026-10-18T00:00:00Z").unwrap();
    let mut f = Fake::new();
    let pass = block_on(import(&s.legacy, HOSTED, &mut f, &mut counter())).unwrap();
    assert!(pass.complete);
    assert_eq!(pass.settled, 6);
    assert_imported(&s, &f);
    // Idempotent: a second pass writes nothing.
    let applies = f.applies;
    let pass = block_on(import(&s.legacy, HOSTED, &mut f, &mut counter())).unwrap();
    assert_eq!(
        pass,
        Pass {
            settled: 0,
            waiting: 0,
            complete: true
        }
    );
    assert_eq!(f.applies, applies);
}

#[test]
fn a_crash_at_any_submit_resumes_without_applying_twice() {
    for crash in [Crash::BeforeSubmit, Crash::AfterApply] {
        for at in 0..4 {
            let s = setup("mi-crash");
            capture(&s.legacy, &s.old, &s.entry, "2026-10-18T00:00:00Z").unwrap();
            let mut f = Fake::new();
            f.crash_at = Some((at, crash));
            let mut fresh = counter();
            // The interrupted pass: the daemon dies at the `at`th write.
            assert!(block_on(import(&s.legacy, HOSTED, &mut f, &mut fresh)).is_err());
            let p = Progress::load(&s.legacy, HOSTED).unwrap();
            assert!(
                p.items.values().any(|i| matches!(i, Item::InFlight(_))),
                "{crash:?}@{at}: the identity was saved before submitting"
            );
            // A restarted daemon resumes from disk alone.
            let pass = block_on(import(&s.legacy, HOSTED, &mut f, &mut ids(1))).unwrap();
            assert!(pass.complete, "{crash:?}@{at}");
            assert_eq!(
                f.applies, 4,
                "{crash:?}@{at}: every write applied exactly once"
            );
            assert_imported(&s, &f);
        }
    }
}

#[test]
fn edits_already_on_the_server_are_not_written_again() {
    let s = setup("mi-present");
    capture(&s.legacy, &s.old, &s.entry, "2026-10-18T00:00:00Z").unwrap();
    let mut f = Fake::new();
    // The old mirror managed to upload a and n before it stopped.
    f.records.get_mut(&id(RA)).unwrap().1 = "A edited".into();
    f.records.insert([9; 16], ("n.md".into(), "New".into()));
    block_on(import(&s.legacy, HOSTED, &mut f, &mut counter())).unwrap();
    assert_eq!(f.applies, 2, "only the rename and the delete");
    let st = status(&s.legacy, HOSTED).unwrap().unwrap();
    assert_eq!(st["already_present"], 2);
}

#[test]
fn a_delete_of_a_record_changed_elsewhere_keeps_it() {
    let s = setup("mi-superseded");
    capture(&s.legacy, &s.old, &s.entry, "2026-10-18T00:00:00Z").unwrap();
    let mut f = Fake::new();
    f.records.get_mut(&id(RC)).unwrap().1 = "C changed elsewhere".into();
    block_on(import(&s.legacy, HOSTED, &mut f, &mut counter())).unwrap();
    assert_eq!(f.records[&id(RC)].1, "C changed elsewhere");
    let st = status(&s.legacy, HOSTED).unwrap().unwrap();
    assert_eq!(st["superseded"], 1);
}

#[test]
fn a_held_edit_resolves_like_a_takeover_hold() {
    let s = setup("mi-resolve");
    capture(&s.legacy, &s.old, &s.entry, "2026-10-18T00:00:00Z").unwrap();
    let mut f = Fake::new();
    block_on(import(&s.legacy, HOSTED, &mut f, &mut counter())).unwrap();
    let record = s.dir.path().join("state/takeover.json");
    assert_eq!(
        held::resolve(&record, &s.legacy, HOSTED, &["e.md".into()]).unwrap(),
        0
    );
    assert!(held::open(&s.legacy, HOSTED).unwrap().is_empty());
    assert_eq!(status(&s.legacy, HOSTED).unwrap().unwrap()["held"], 0);
}

#[test]
fn plan_table() {
    let cur = |rid: &str, path: &str, doc: &str| Current {
        id: id(rid),
        path: path.into(),
        revision: mdbn_wire::hash::sha256(doc.as_bytes()).0,
        document: doc.into(),
    };
    let upd = Edit::Update {
        record_id: RA.into(),
        from: "a.md".into(),
        path: "a.md".into(),
        base: hx(b"A"),
        content: hx(b"A2"),
    };
    let a = cur(RA, "a.md", "A");
    assert!(matches!(
        plan(&upd, Some(b"A2"), true, Some(&a), Some(&a)),
        Plan::Edit { .. }
    ));
    assert_eq!(
        plan(&upd, Some(b"A2"), false, Some(&a), Some(&a)),
        Plan::Hold("unknown_base")
    );
    let a2 = cur(RA, "a.md", "A2");
    assert_eq!(
        plan(&upd, Some(b"A2"), true, Some(&a2), Some(&a2)),
        Plan::AlreadyPresent
    );
    let ax = cur(RA, "a.md", "AX");
    assert_eq!(
        plan(&upd, Some(b"A2"), true, Some(&ax), Some(&ax)),
        Plan::Hold("changed_elsewhere")
    );
    // Deleted elsewhere: recreated (D8), unless the path is taken.
    assert!(matches!(
        plan(&upd, Some(b"A2"), true, None, None),
        Plan::Create { .. }
    ));
    let other = cur(RB, "a.md", "other");
    assert_eq!(
        plan(&upd, Some(b"A2"), true, None, Some(&other)),
        Plan::Hold("deleted_elsewhere")
    );
    // A rename onto another record's path.
    let mv = Edit::Update {
        record_id: RA.into(),
        from: "a.md".into(),
        path: "b.md".into(),
        base: hx(b"A"),
        content: hx(b"A"),
    };
    let b = cur(RB, "b.md", "B");
    assert_eq!(
        plan(&mv, Some(b"A"), true, Some(&a), Some(&b)),
        Plan::Hold("path_taken")
    );
    assert_eq!(
        plan(&upd, Some(&[0xff]), true, Some(&a), Some(&a)),
        Plan::Recover("not_text")
    );
    let create = Edit::Create {
        path: "n.md".into(),
        content: hx(b"N"),
    };
    assert!(matches!(
        plan(&create, Some(b"N"), true, None, None),
        Plan::Create { .. }
    ));
    let n = cur(RB, "n.md", "N");
    assert_eq!(
        plan(&create, Some(b"N"), true, None, Some(&n)),
        Plan::AlreadyPresent
    );
    let n2 = cur(RB, "n.md", "N2");
    assert_eq!(
        plan(&create, Some(b"N"), true, None, Some(&n2)),
        Plan::Hold("created_elsewhere")
    );
    let del = Edit::Delete {
        record_id: RA.into(),
        path: "a.md".into(),
        base: hx(b"A"),
    };
    assert!(matches!(
        plan(&del, None, true, Some(&a), Some(&a)),
        Plan::Delete { .. }
    ));
    assert_eq!(
        plan(&del, None, true, Some(&ax), Some(&ax)),
        Plan::Superseded
    );
    assert_eq!(
        plan(&del, None, false, Some(&a), Some(&a)),
        Plan::Superseded
    );
    assert_eq!(plan(&del, None, true, None, None), Plan::AlreadyPresent);
}
