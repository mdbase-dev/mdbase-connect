use std::collections::BTreeSet;

use super::*;
use crate::preflight::resolve;

/// A small deterministic generator (SplitMix64): no dependency, reproducible seeds.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn pick<'a>(&mut self, xs: &[&'a str]) -> &'a str {
        xs[self.below(xs.len() as u64) as usize]
    }
    fn uuid(&mut self) -> String {
        let a = self.next();
        let b = self.next();
        let hex = format!("{a:016x}{b:016x}");
        format!(
            "{}-{}-{}-{}-{}",
            &hex[0..8],
            &hex[8..12],
            &hex[12..16],
            &hex[16..20],
            &hex[20..32]
        )
    }
}

/// Tokens chosen to exercise every rule `resolve` applies: case and NFC
/// collisions, forbidden characters, hidden and tool folders, reserved names,
/// trailing dots and spaces, and literal suffixes that collide with allocated ones.
const TOKENS: &[&str] = &[
    "a",
    "A",
    "b",
    "note",
    "NOTE",
    "caf\u{e9}",
    "cafe\u{301}",
    "CAF\u{c9}",
    "stra\u{df}e",
    "STRASSE",
    "why?",
    "why_",
    "x:y",
    "x_y",
    "con",
    "CON",
    "a (2)",
    "a (3)",
    "~",
    "-",
    " ",
    ".",
    "tab\t",
    "\u{200b}z",
];
const FOLDERS: &[&str] = &[
    "",
    "",
    "notes/",
    "Notes/",
    ".obsidian/",
    "_obsidian/",
    "a/b/",
];
const EXTS: &[&str] = &[".md", ".md", ".MD", ".png", "", ".", " "];

fn path(rng: &mut Rng) -> String {
    let mut name = String::new();
    for _ in 0..=rng.below(2) {
        name.push_str(rng.pick(TOKENS));
    }
    format!("{}{}{}", rng.pick(FOLDERS), name, rng.pick(EXTS))
}

fn read(rng: &mut Rng) -> (Vec<ResourceRow>, Vec<RecordRow>, Vec<FileRow>) {
    let mut resources: Vec<ResourceRow> = (0..rng.below(4))
        .map(|_| ResourceRow { path: path(rng) })
        .collect();
    resources.sort_by(|a, b| a.path.cmp(&b.path));
    resources.dedup_by(|a, b| a.path == b.path);
    let records = (0..rng.below(25))
        .map(|_| RecordRow {
            record_id: rng.uuid(),
            path: path(rng),
        })
        .collect();
    let files = (0..rng.below(12))
        .map(|_| FileRow {
            file_id: rng.uuid(),
            path: path(rng),
        })
        .collect();
    (resources, records, files)
}

fn pages<T: Clone>(rng: &mut Rng, rows: &[T]) -> Vec<Vec<T>> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < rows.len() {
        let n = 1 + rng.below(6) as usize;
        out.push(rows[i..(i + n).min(rows.len())].to_vec());
        i += n;
    }
    out
}

#[derive(Default)]
struct Collected {
    renames: Vec<Rename>,
    deferred: Vec<PathEntity>,
    unfixable: Vec<PathEntity>,
}

impl Collected {
    fn take(&mut self, s: Step) {
        self.renames.extend(s.renames);
        self.deferred.extend(s.deferred);
        self.unfixable
            .extend(s.unfixable.into_iter().map(|u| u.entity));
    }
}

struct Streamed {
    renames: Vec<Rename>,
    unfixable: Vec<PathEntity>,
    finished: Result<Summary>,
}

/// Run the streaming resolver over the read, in random pages, the way the hosted
/// driver does: records and files in ascending ID order, then the deferred list.
fn stream(
    rng: &mut Rng,
    resources: &[ResourceRow],
    records: &[RecordRow],
    files: &[FileRow],
) -> Streamed {
    let mut records = records.to_vec();
    records.sort_by(|a, b| a.record_id.cmp(&b.record_id));
    let mut files = files.to_vec();
    files.sort_by(|a, b| a.file_id.cmp(&b.file_id));
    // Resources arrive in any order: the source's collation is not byte order.
    let mut resources = resources.to_vec();
    resources.reverse();

    let mut ns = Namespace::new();
    let mut claims = BTreeSet::<Hash>::new();
    let mut out = Collected::default();
    out.take(ns.resources(&mut claims, &resources).unwrap());
    for p in pages(rng, &records) {
        out.take(ns.records(&mut claims, &p).unwrap());
    }
    for p in pages(rng, &files) {
        out.take(ns.files(&mut claims, &p).unwrap());
    }
    let deferred_list: Vec<PathEntity> = std::mem::take(&mut out.deferred);
    for p in pages(rng, &deferred_list) {
        out.take(ns.deferred(&mut claims, &p).unwrap());
    }
    let Collected {
        mut renames,
        deferred,
        mut unfixable,
    } = out;
    assert!(deferred.is_empty(), "pass 2 defers nothing");
    renames.sort_by(|a, b| a.entity.cmp(&b.entity));
    unfixable.sort();
    Streamed {
        renames,
        unfixable,
        finished: ns.finish(),
    }
}

#[test]
fn streaming_resolve_equals_in_memory_resolve() {
    let mut renamed = 0;
    let mut refused = 0;
    for seed in 0..3_000u64 {
        let mut rng = Rng(seed);
        let (resources, records, files) = read(&mut rng);
        let got = stream(&mut rng, &resources, &records, &files);
        match resolve(&resources, &records, &files) {
            Ok(want) => {
                let s = got
                    .finished
                    .expect("streaming accepts what resolve accepts");
                assert!(got.unfixable.is_empty(), "seed {seed}");
                assert_eq!(got.renames, want.renames(), "seed {seed}");
                assert_eq!(
                    s.placed as usize,
                    resources.len() + records.len() + files.len()
                );
                assert_eq!(s.renamed as usize, want.renames().len());
                renamed += usize::from(!want.renames().is_empty());
            }
            Err(Error::Paths(report)) => {
                assert!(got.finished.is_err(), "seed {seed}");
                let mut want: Vec<PathEntity> =
                    report.invalid.into_iter().map(|i| i.entity).collect();
                want.sort();
                assert_eq!(got.unfixable, want, "seed {seed}");
                refused += 1;
            }
            Err(e) => panic!("seed {seed}: {e}"),
        }
    }
    // The generator must actually exercise renames, and the refusal path is covered
    // by its own test below.
    assert!(renamed > 1_000, "renamed {renamed}");
    let _ = refused;
}

#[test]
fn unfixable_names_are_reported_and_refused() {
    let too_long = format!("{}x.png", "a/".repeat(600));
    let files = vec![FileRow {
        file_id: "0192f0c1-7e1a-7b3c-8d4e-0000000000f1".into(),
        path: too_long,
    }];
    let mut ns = Namespace::new();
    let mut claims = BTreeSet::<Hash>::new();
    ns.resources(&mut claims, &[]).unwrap();
    let s = ns.files(&mut claims, &files).unwrap();
    assert_eq!(s.deferred.len(), 1);
    let s = ns.deferred(&mut claims, &s.deferred).unwrap();
    assert_eq!(s.unfixable.len(), 1);
    assert!(ns.finish().is_err());
    assert!(matches!(
        resolve(&[], &[], &files),
        Err(Error::Paths(r)) if r.invalid.len() == 1
    ));
}

#[test]
fn order_budget_and_completeness_are_enforced() {
    let r = |id: &str, p: &str| RecordRow {
        record_id: id.into(),
        path: p.into(),
    };
    let a = "00000000-0000-4000-8000-000000000001";
    let b = "00000000-0000-4000-8000-000000000002";

    // Records out of ID order, across pages too.
    let mut ns = Namespace::new();
    let mut claims = BTreeSet::<Hash>::new();
    ns.resources(&mut claims, &[]).unwrap();
    ns.records(&mut claims, &[r(b, "b.md")]).unwrap();
    assert!(ns.records(&mut claims, &[r(a, "a.md")]).is_err());

    // A record page after files.
    let mut ns = Namespace::new();
    let mut claims = BTreeSet::<Hash>::new();
    ns.resources(&mut claims, &[]).unwrap();
    ns.files(&mut claims, &[]).unwrap();
    assert!(ns.records(&mut claims, &[r(a, "a.md")]).is_err());

    // Records before resources.
    let mut ns = Namespace::new();
    let mut claims = BTreeSet::<Hash>::new();
    assert!(ns.records(&mut claims, &[r(a, "a.md")]).is_err());

    // Over the request budget.
    let mut ns = Namespace::new();
    let mut claims = BTreeSet::<Hash>::new();
    ns.resources(&mut claims, &[]).unwrap();
    let many: Vec<RecordRow> = (0..1_001)
        .map(|i| r(&format!("00000000-0000-4000-8000-{i:012x}"), "x.md"))
        .collect();
    assert!(ns.records(&mut claims, &many).is_err());

    // A deferred entity never handed back.
    let mut ns = Namespace::new();
    let mut claims = BTreeSet::<Hash>::new();
    ns.resources(&mut claims, &[]).unwrap();
    let s = ns.records(&mut claims, &[r(a, "why?.md")]).unwrap();
    assert_eq!(s.deferred.len(), 1);
    assert!(ns.finish().is_err());

    // A portable entity handed back as deferred, or one handed back twice.
    let mut ns = Namespace::new();
    let mut claims = BTreeSet::<Hash>::new();
    ns.resources(&mut claims, &[]).unwrap();
    let s = ns
        .records(&mut claims, &[r(a, "why?.md"), r(b, "ok.md")])
        .unwrap();
    let ok = PathEntity {
        kind: EntityKind::Record,
        id: Some(b.into()),
        path: "ok.md".into(),
    };
    assert!(ns.deferred(&mut claims, &[ok]).is_err());
    let mut ns2 = Namespace::new();
    let mut claims2 = BTreeSet::<Hash>::new();
    ns2.resources(&mut claims2, &[]).unwrap();
    ns2.records(&mut claims2, &[r(a, "why?.md")]).unwrap();
    let mut twice = s.deferred.clone();
    twice.extend(s.deferred);
    assert!(ns2.deferred(&mut claims2, &twice).is_err());

    // Duplicate resources.
    let mut ns = Namespace::new();
    let mut claims = BTreeSet::<Hash>::new();
    let res = ResourceRow {
        path: "mdbase.yaml".into(),
    };
    assert!(ns.resources(&mut claims, &[res.clone(), res]).is_err());
}

#[test]
fn claim_keys_follow_the_path_key_and_spill_no_text() {
    assert_eq!(
        claim_key("Notes/Caf\u{e9}.md"),
        claim_key("NOTES/CAFE\u{301}.MD")
    );
    assert_eq!(claim_key("Stra\u{df}e.md"), claim_key("STRASSE.md"));
    assert_ne!(claim_key("a.md"), claim_key("b.md"));
    let ns = Namespace::new();
    assert!(!format!("{ns:?}").contains(".md"));
}

#[test]
fn a_spill_failure_stops_the_page() {
    struct Broken;
    impl Claims for Broken {
        fn is_claimed(&mut self, _: &Hash) -> std::result::Result<bool, String> {
            Err("sqlite busy".into())
        }
        fn claim(&mut self, _: &Hash) -> std::result::Result<(), String> {
            Err("sqlite busy".into())
        }
    }
    let mut ns = Namespace::new();
    let e = ns
        .resources(
            &mut Broken,
            &[ResourceRow {
                path: "mdbase.yaml".into(),
            }],
        )
        .unwrap_err();
    assert!(e.to_string().contains("namespace spill"));
}
