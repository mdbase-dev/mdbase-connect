//! The rehearsal harness: generator determinism and shape, ledger, and the gate-2
//! oracle's rules.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, missing_docs)]

use std::fs;
use std::path::{Path, PathBuf};

use mdbn_migrate::rehearsal::ledger::{self, Outcome, Row};
use mdbn_migrate::rehearsal::oracle::{self, Violation};
use mdbn_migrate::rehearsal::shape::{self, Profile};

fn scratch(name: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR"))
        .join("mdbn-migrate-rehearsal")
        .join(name);
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn tree_digest(root: &Path) -> String {
    fn walk(d: &Path, out: &mut Vec<(String, Vec<u8>)>, root: &Path) {
        let mut es: Vec<_> = fs::read_dir(d)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .collect();
        es.sort();
        for p in es {
            if p.is_dir() {
                walk(&p, out, root);
            } else {
                out.push((
                    p.strip_prefix(root).unwrap().to_string_lossy().into_owned(),
                    fs::read(&p).unwrap(),
                ));
            }
        }
    }
    let mut v = Vec::new();
    walk(root, &mut v, root);
    let mut all = Vec::new();
    for (p, b) in v {
        all.extend(p.into_bytes());
        all.extend(b);
    }
    mdbn_legacy::revision_of(&all)
}

#[test]
fn generator_is_deterministic_and_real_shaped() {
    let a = scratch("gen-a");
    let b = scratch("gen-b");
    let p = Profile {
        records: 1000,
        attachments_per_mille: 30,
        links_x10: 6,
        legacy_hazards: false,
    };
    let ga = shape::generate(&a, &p, 7).unwrap();
    let gb = shape::generate(&b, &p, 7).unwrap();
    assert_eq!(ga, gb);
    assert_eq!(tree_digest(&a), tree_digest(&b));
    assert_eq!(ga.records, 1000);
    assert_eq!(ga.attachments, 30);
    // Median document size near the fixtures' 4.5 KB.
    let mean = ga.record_bytes / ga.records;
    assert!((2_500..7_000).contains(&mean), "{mean}");
    // Records parse as frontmatter.
    let doc = fs::read_to_string(a.join(shape::record_path("tasknotes-task", 0))).unwrap();
    assert!(oracle::frontmatter_field(&doc, "status").is_some());
    // Never into a non-empty folder.
    assert!(shape::generate(&a, &p, 7).is_err());
}

fn row(order: u64, writer: &str, path: &str, field: &str, value: &str, outcome: Outcome) -> Row {
    Row {
        order,
        writer: writer.into(),
        path: path.into(),
        field: field.into(),
        value: value.into(),
        outcome,
        phase: "R5/H6".into(),
    }
}

fn doc(fields: &[(&str, &str)]) -> String {
    let mut s = String::from("---\ntitle: \"x\"\n");
    for (k, v) in fields {
        s.push_str(&format!("{k}: \"{v}\"\n"));
    }
    s + "---\nbody\n"
}

#[test]
fn oracle_rules() {
    let base = scratch("oracle");
    let root = base.join("final");
    let kept = base.join("kept");
    fs::create_dir_all(root.join("n")).unwrap();
    fs::create_dir_all(&kept).unwrap();
    fs::write(
        root.join("n/a.md"),
        doc(&[("rh_sdk1_0", "v3"), ("rh_mirror_0", "m1")]),
    )
    .unwrap();
    // A hold kept the user's other version.
    fs::write(kept.join("a.md.held"), doc(&[("rh_cli_0", "c9")])).unwrap();

    let ledger_path = base.join("ledger.jsonl");
    for r in [
        row(1, "sdk1", "n/a.md", "rh_sdk1_0", "v1", Outcome::Acked),
        row(2, "sdk1", "n/a.md", "rh_sdk1_0", "v3", Outcome::Acked), // supersedes v1
        row(
            3,
            "mirror",
            "n/a.md",
            "rh_mirror_0",
            "m1",
            Outcome::MustSurvive,
        ),
        row(4, "cli", "n/a.md", "rh_cli_0", "c9", Outcome::Acked), // kept in a hold
        row(5, "sdk2", "n/a.md", "rh_sdk2_0", "gone", Outcome::NotAcked),
    ] {
        ledger::append(&ledger_path, &r).unwrap();
    }
    // A torn final line (a driver crashed mid-append) is ignored.
    fs::OpenOptions::new()
        .append(true)
        .open(&ledger_path)
        .and_then(|mut f| std::io::Write::write_all(&mut f, b"{\"order\":6,\"wri"))
        .unwrap();

    let v = oracle::check_folder(&ledger_path, &root, std::slice::from_ref(&kept)).unwrap();
    assert!(v.green(), "{v:?}");
    assert_eq!((v.acked, v.must_survive, v.not_acked), (3, 1, 1));

    // Now lose things.
    fs::write(root.join("n/a.md"), doc(&[("rh_sdk1_0", "v1")])).unwrap();
    fs::remove_file(kept.join("a.md.held")).unwrap();
    let v = oracle::check_folder(&ledger_path, &root, &[kept]).unwrap();
    assert!(!v.green());
    let kinds: Vec<_> = v
        .violations
        .iter()
        .map(|x| match x {
            Violation::LostAck { row, .. } => format!("ack:{}", row.value),
            Violation::LostUserBytes { row } => format!("user:{}", row.value),
        })
        .collect();
    assert_eq!(kinds, ["user:m1", "ack:c9", "ack:v3"]);
}

/// R11: non-portable and colliding legacy paths are migrated by renaming, every rename
/// is reported, and the oracle finds every acknowledged write at its new path.
#[test]
fn r11_legacy_path_hazards_are_renamed_and_nothing_is_lost() {
    use std::collections::BTreeMap;

    use mdbn_legacy::hosted::Record;
    use mdbn_migrate::preflight;

    let base = scratch("r11");
    let legacy = base.join("legacy");
    let g = shape::generate(&legacy, &Profile::HAZARDS, 11).unwrap();
    assert_eq!(g.hazards as usize, shape::HAZARDS.len());

    // The hosted read, as the old provider would return the hazard records.
    let records: Vec<Record> = shape::HAZARDS
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let doc = fs::read_to_string(legacy.join(p)).unwrap();
            Record {
                record_id: format!("0192f0c1-7e1a-7b3c-8d4e-{i:012x}"),
                path: (*p).to_owned(),
                revision: mdbn_legacy::revision_of(doc.as_bytes()),
                document: doc,
            }
        })
        .collect();
    let resolved = preflight::resolve(&[], &records, &[]).unwrap();
    assert_eq!(resolved.renames().len(), shape::HAZARDS.len() - 1);
    assert!(preflight::inspect_paths(&[], resolved.records(), &[]).is_clear());
    assert_eq!(records.len(), resolved.records().len());
    for (old, new) in records.iter().zip(resolved.records()) {
        assert_eq!(
            (&old.record_id, &old.document, &old.revision),
            (&new.record_id, &new.document, &new.revision)
        );
    }
    let warnings: std::collections::BTreeSet<_> = resolved
        .tool_folder_renames()
        .map(|r| r.entity.path.as_str())
        .collect();
    assert_eq!(
        warnings,
        [
            ".obsidian/workspace.md",
            "node_modules/pkg/readme.md",
            ".git/config.md",
            ".vscode/settings.md"
        ]
        .into_iter()
        .collect()
    );

    // The migrated collection, materialized at the new paths.
    let migrated = base.join("migrated");
    for r in resolved.records() {
        let full = migrated.join(&r.path);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, &r.document).unwrap();
    }
    let renames: BTreeMap<String, String> = resolved
        .renames()
        .iter()
        .map(|r| (r.entity.path.clone(), r.to.clone()))
        .collect();
    let renames_file = base.join("renames.jsonl");
    fs::write(
        &renames_file,
        resolved
            .renames()
            .iter()
            .map(|r| {
                format!(
                    "{}\n",
                    serde_json::json!({
                        "from": r.entity.path,
                        "to": r.to,
                        "reason": r.reason,
                        "tool_folder": r.tool_folder,
                    })
                )
            })
            .collect::<String>(),
    )
    .unwrap();
    let report: Vec<serde_json::Value> = fs::read_to_string(&renames_file)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(report.len(), renames.len());
    let reported_warnings: std::collections::BTreeSet<_> = report
        .iter()
        .filter(|r| r["tool_folder"] == true)
        .map(|r| r["from"].as_str().unwrap())
        .collect();
    assert_eq!(reported_warnings, warnings);

    // Acknowledged writes recorded against the old paths before migration.
    let ledger_path = base.join("ledger.jsonl");
    for (i, p) in shape::HAZARDS.iter().enumerate() {
        ledger::append(
            &ledger_path,
            &row(i as u64, "sdk", p, "status", "open", Outcome::Acked),
        )
        .unwrap();
    }
    let renamed = oracle::read_renames(&renames_file).unwrap();
    let v = oracle::check_folder_renamed(&ledger_path, &migrated, &[], renamed).unwrap();
    assert!(v.green(), "{v:?}");
    // Without following the renames, the writes would look lost: the check is real.
    let v = oracle::check_folder(&ledger_path, &migrated, &[]).unwrap();
    assert_eq!(v.violations.len(), shape::HAZARDS.len() - 1);
}
