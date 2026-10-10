//! Telemetry is an observation, never key delivery or a grant witness.
use super::*;
use mdbn_wire::client::{Connection, Incident, IncidentKind, SyncMode, SyncStatus};

fn sample() -> SyncStatus {
    SyncStatus {
        mode: SyncMode::Synced,
        confirmed_through: 12,
        head_known: 14,
        pending: 2,
        oldest_pending: None,
        holds: 3,
        unresolved: 4,
        connection: Connection::Online,
        installing: None,
        resyncing: None,
        confirmed_head: None,
        incidents: vec![],
    }
}
#[test]
fn telemetry_exposes_exact_counters_and_distinguishes_digests() {
    let status = sample();
    let out = sync_counters(&status, false, Some("aa".repeat(32)), Some((9, [7; 32])));
    assert_eq!(
        (
            out.confirmed_through,
            out.head_known,
            out.pending,
            out.holds,
            out.unresolved
        ),
        (12, 14, 2, 3, 4)
    );
    assert_eq!(out.connection, "online");
    assert!(out.resyncing);
    let digest = out.confirmed_record_digest.unwrap();
    assert_eq!(digest.algorithm, "sha256-confirmed-record-tuples-v1");
    assert_eq!(digest.records, 9);
    assert_eq!(digest.confirmed_through, 12);
    assert_eq!(digest.digest, "07".repeat(32));
    assert_eq!(out.head_digest, Some("aa".repeat(32)));
}
#[test]
fn telemetry_never_serializes_incident_details_or_invents_missing_digests() {
    let mut status = sample();
    status.incidents.push(Incident {
        kind: IncidentKind::Integrity,
        details: Some(mdbn_wire::common::Value::Text(
            "private-selector-expected-code".into(),
        )),
    });
    let out = sync_counters(&status, true, None, None);
    let json = serde_json::to_string(&out).unwrap();
    assert_eq!(out.last_error.as_deref(), Some("integrity"));
    assert!(!json.contains("private-selector-expected-code"));
    assert!(!json.contains("head_digest"));
    assert!(!json.contains("confirmed_record_digest"));
}
#[test]
fn telemetry_bootstrap_install_and_catchup_are_not_latched_ready() {
    let mut status = sample();
    status.confirmed_through = 0;
    status.head_known = 0;
    assert!(sync_counters(&status, true, None, None).resyncing);
    status.confirmed_through = 12;
    status.head_known = 12;
    assert!(!sync_counters(&status, true, None, None).resyncing);
    assert!(sync_counters(&status, false, None, None).resyncing);
    status.installing = Some(mdbn_wire::client::Progress { done: 1, total: 2 });
    assert!(sync_counters(&status, true, None, None).resyncing);
}
#[test]
fn paged_digest_matches_original_id_sorted_tuple_bytes_across_pages() {
    use mdbn_replica::store::{RecordRow, Store as _, Tx};
    let mut store = mdbn_replica::mem::MemStore::new();
    let mut rows = Vec::new();
    for i in (1u64..=2050).rev() {
        let mut id = [0; 16];
        id[..8].copy_from_slice(&i.to_be_bytes());
        let path = format!("synthetic/fé-{i}.md");
        rows.push(RecordRow {
            id: mdbn_wire::common::B16(id),
            path_key: path.clone(),
            path,
            doc: "synthetic".into(),
            revision: mdbn_wire::common::B32([7; 32]),
            modified_seq: i,
            bucket: 0,
            meta: Default::default(),
        });
    }
    store
        .commit(Tx {
            records_put: rows.clone(),
            ..Default::default()
        })
        .unwrap();
    rows.sort_by_key(|r| r.id);
    let mut original = Vec::new();
    for r in rows {
        original.extend_from_slice(&r.id.0);
        original.extend_from_slice(&(r.path.len() as u64).to_be_bytes());
        original.extend_from_slice(r.path.as_bytes());
        original.extend_from_slice(&r.revision.0);
        original.extend_from_slice(&r.modified_seq.to_be_bytes());
    }
    assert_eq!(
        confirmed_store_digest(&store),
        Some((2050, mdbn_wire::hash::sha256(&original).0))
    );
}

#[test]
fn old_counter_json_remains_readable() {
    let old = r#"{"confirmed_through":1,"head_known":1,"pending":0,"holds":0,"unresolved":0,"connection":"online"}"#;
    let out: crate::control::SyncCounters = serde_json::from_str(old).unwrap();
    assert!(out.confirmed_record_digest.is_none());
    assert!(out.head_digest.is_none());
    assert!(out.last_error.is_none());
    assert!(!out.resyncing);
}
