//! Issue #1497's shape: 150 records with about 10 KB of frontmatter each
//! (about 1.5 MB). A cold replica catches up on all of them through ordinary
//! log read pages. Without a maintained index (MemStore has none) every query
//! is a per-record scan, which the memory-constrained (browser) profile bounds
//! at 1 MiB of sources: past it the refusal names `too_large`, never a vague
//! failure. The SQLite store keeps its index for this shape (platform-native
//! `large_metadata`), so the browser's reads do not reach this scan.
use super::engine::{node, settle};
use crate::api::{ClientApi, ErrorCode};
use crate::fake::FakeLogService;
use crate::mem::MemStore;
use mdbn_wire::client::Include;
use mdbn_wire::common::Value;

const RECORDS: u8 = 150;
const DESCRIPTION_BYTES: usize = 10 * 1024;

fn source(n: u8) -> String {
    let description: String = (0..DESCRIPTION_BYTES)
        .map(|i| char::from(b'a' + ((i + usize::from(n)) % 26) as u8))
        .collect();
    format!(
        "---\ntype: reader-source\ntitle: Source {n}\ndescription: {description}\n---\nBody {n}\n"
    )
}

#[test]
fn a_cold_replica_catches_up_on_150_records_of_10_kb_and_an_unindexed_scan_names_too_large() {
    let svc = FakeLogService::new();
    let mut writer = node(&svc, 1, MemStore::new());
    let mut cold = node(&svc, 2, MemStore::new());
    settle(&mut [&mut writer, &mut cold]);
    for n in 1..=RECORDS {
        writer.create(n, &format!("sources/{n:03}.md"), &source(n));
    }
    settle(&mut [&mut writer, &mut cold]);
    assert_eq!(cold.r.head(), writer.r.head());
    let seeded: usize = (1..=RECORDS)
        .map(|n| cold.doc(n).expect("caught up").len())
        .sum();
    assert!(seeded > 1_500_000, "{seeded} bytes");

    let refused = cold
        .r
        .query(
            cold.s,
            Value::Map(vec![("limit".into(), Value::Int(1))]),
            Include {
                effective: None,
                body: None,
                document: None,
                diagnostics: None,
            },
        )
        .unwrap_err();
    assert_eq!(refused.code(), Some(ErrorCode::TooLarge));
    assert_eq!(
        refused.problem().reason.as_deref(),
        Some("query_budget_exceeded")
    );
}
