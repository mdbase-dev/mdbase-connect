use super::*;
const SIMPLE: &str = "views:\n  - type: table\n    filters: 'type == \"task\"'\n    order: [file.name, status, priority]\n    sort:\n      - property: priority\n        direction: ASC\n    groupBy:\n      property: status\n      direction: ASC\n";
fn seeded(count: u32, source: &str) -> (Replica<ProjectionStore>, BTreeMap<String, String>) {
    let (svc, mut a, _) = configured();
    // Source > inline mutation admission is deliberately injected as owned
    // durable synthetic state, like the bulk rows below, not bulk-ingest proof.
    a.create(
        11,
        "Views/scaled.base",
        if source.len() > 512 * 1024 {
            SIMPLE
        } else {
            source
        },
    );
    settle(&mut [&mut a]);
    if source.len() > 512 * 1024 {
        let mut row =
            a.r.store()
                .record(&selection(SIMPLE, 0).record)
                .unwrap()
                .unwrap();
        row.doc = source.into();
        row.revision = mdbn_wire::hash::sha256(source.as_bytes());
        a.r.store()
            .clone()
            .commit(Tx {
                records_put: vec![row],
                ..Tx::default()
            })
            .unwrap();
    }
    a.clock.set(1_781_075_828_070);
    // Owned synthetic durable rows under the actual signed fixture head. No
    // signed bulk-ingest or native/heap/latency claim: this is driver accounting.
    for start in (0..count).step_by(128) {
        let mut rows = Vec::new();
        for n in start..(start + 128).min(count) {
            let mut bytes = [64; 16];
            bytes[12..].copy_from_slice(&n.to_be_bytes());
            let path = format!("Tasks/task-{n:05}.md");
            let doc = format!(
                "---\ntype: task\nstatus: {}\npriority: {}\ndue: 2026-06-10\ntags: [task]\n---\nOwned synthetic task\n",
                if n % 2 == 0 { "open" } else { "done" },
                n % 4
            );
            rows.push(crate::store::RecordRow {
                id: B16(bytes),
                path_key: path.to_lowercase(),
                path,
                revision: mdbn_wire::hash::sha256(doc.as_bytes()),
                doc,
                modified_seq: 0,
                bucket: 0,
                meta: crate::store::RecordMeta::default(),
            });
        }
        let mut store = a.r.store().clone();
        store
            .commit(Tx {
                records_put: rows,
                ..Tx::default()
            })
            .unwrap();
    }
    (
        projected(&svc, a),
        BTreeMap::from_iter([
            ("due".into(), "date".into()),
            ("scheduled".into(), "date".into()),
        ]),
    )
}
#[test]
fn fifty_thousand_actual_streamed_residuals_sort_group_and_hold_identities_without_source_capture()
{
    let (mut r, hints) = seeded(50_000, SIMPLE);
    let result = r
        .execute_indexed_bases_view(
            selection(SIMPLE, 0),
            Some(&hints),
            Some("UTC"),
            policies(),
            &|| false,
        )
        .unwrap();
    assert_eq!(result.rows.len(), 50_000);
    assert_eq!(result.groups.len(), 2);
    assert_eq!(
        result
            .groups
            .iter()
            .map(|group| group.rows.len())
            .sum::<usize>(),
        50_000
    );
    assert_eq!(r.store().pages.get(), 391);
    assert_eq!(r.store().reads.get(), 2);
    let unique: std::collections::BTreeSet<_> = result.rows.iter().map(|row| row.record).collect();
    assert_eq!(unique.len(), 50_000);
    for (slot, group) in result.groups.iter().enumerate() {
        assert_eq!(group.rows.len(), 25_000);
        for index in &group.rows {
            let n = u32::from_be_bytes(result.rows[*index].record.0[12..].try_into().unwrap());
            assert_eq!(n % 2, if slot == 0 { 1 } else { 0 });
        }
    }
}
#[test]
fn twelve_column_unchanged_tasknotes_manual_order_runs_fifty_thousand_rows_without_legacy_cliffs() {
    let reference: serde_json::Value =
        serde_json::from_str(include_str!("../../../data/bases-first-slice.json")).unwrap();
    let source = reference["sources"][0]["source"].as_str().unwrap();
    let (mut r, hints) = seeded(50_000, source);
    let result = r
        .execute_indexed_bases_view(
            selection(source, 0),
            Some(&hints),
            Some("UTC"),
            policies(),
            &|| false,
        )
        .unwrap();
    assert_eq!(result.rows.len(), 50_000);
    assert_eq!(result.columns.len(), 12);
    assert_eq!(r.store().reads.get(), 2);
    assert_eq!(r.store().pages.get(), 391);
}
#[test]
fn all_five_unchanged_tasknotes_views_run_complete_fifty_thousand_task_inventory() {
    let reference: serde_json::Value =
        serde_json::from_str(include_str!("../../../data/bases-first-slice.json")).unwrap();
    for view in reference["views"].as_array().unwrap() {
        let source = reference["sources"]
            .as_array()
            .unwrap()
            .iter()
            .find(|source| source["command"] == view["command"])
            .unwrap()["source"]
            .as_str()
            .unwrap();
        let (mut r, hints) = seeded(50_000, source);
        let result = r
            .execute_indexed_bases_view(
                selection(source, view["index"].as_u64().unwrap() as u32),
                Some(&hints),
                Some("UTC"),
                policies(),
                &|| false,
            )
            .unwrap_or_else(|error| panic!("{}: {error}", view["name"]));
        let count = match view["name"].as_str().unwrap() {
            "All Tasks" | "Kanban Board" => 50_000,
            "Today" | "This Week" => 25_000,
            "Overdue" => 0,
            other => panic!("unhandled unchanged fixture {other}"),
        };
        assert_eq!(result.rows.len(), count, "{}", view["name"]);
        assert_eq!(result.columns.len(), 12);
        assert_eq!(r.store().pages.get(), 391);
        assert_eq!(r.store().reads.get(), 2);
    }
}

#[test]
fn page_failure_and_cancellation_suppress_previously_matched_rows() {
    let (mut r, hints) = seeded(130, SIMPLE);
    r.store().fail_page.set(2);
    assert!(
        r.execute_indexed_bases_view(
            selection(SIMPLE, 0),
            Some(&hints),
            Some("UTC"),
            policies(),
            &|| false
        )
        .is_err()
    );
    assert_eq!(r.store().pages.get(), 2);
    assert_eq!(r.store().reads.get(), 1);
    let (mut r, hints) = seeded(130, SIMPLE);
    let pages = r.store().pages.clone();
    let error = r
        .execute_indexed_bases_view(
            selection(SIMPLE, 0),
            Some(&hints),
            Some("UTC"),
            policies(),
            &|| pages.get() >= 2,
        )
        .err()
        .unwrap();
    assert!(error.to_string().contains("cancelled"));
    assert_eq!(r.store().reads.get(), 1);
}
#[test]
fn same_head_source_drift_and_raw_readiness_drift_suppress_whole_output() {
    let (mut r, hints) = seeded(3, SIMPLE);
    let mut store = r.store().inner.clone();
    let pages = r.store().pages.clone();
    let changed = Cell::new(false);
    let mut source = store.record(&B16([11; 16])).unwrap().unwrap();
    source.doc.push_str("\n# owned selected-source drift\n");
    source.revision = mdbn_wire::hash::sha256(source.doc.as_bytes());
    let store = std::cell::RefCell::new(&mut store);
    let error = r
        .execute_indexed_bases_view(
            selection(SIMPLE, 0),
            Some(&hints),
            Some("UTC"),
            policies(),
            &|| {
                if pages.get() > 0 && !changed.replace(true) {
                    store
                        .borrow_mut()
                        .commit(Tx {
                            records_put: vec![source.clone()],
                            ..Tx::default()
                        })
                        .unwrap();
                }
                false
            },
        )
        .err()
        .unwrap();
    assert_eq!(error.code(), Some(ErrorCode::Conflict));
    assert_eq!(r.store().reads.get(), 2);
    let (mut r, hints) = seeded(3, SIMPLE);
    let ready = r.store().ready.clone();
    let pages = r.store().pages.clone();
    assert!(
        r.execute_indexed_bases_view(
            selection(SIMPLE, 0),
            Some(&hints),
            Some("UTC"),
            policies(),
            &|| {
                if pages.get() > 0 {
                    ready.set(false);
                }
                false
            }
        )
        .is_err()
    );
}
#[test]
fn large_selected_source_cannot_escape_shared_initial_and_final_read_budget() {
    let source = format!("{SIMPLE}\n# {}\n", "x".repeat(600 * 1024));
    let (mut r, hints) = seeded(3, &source);
    let error = r
        .execute_indexed_bases_view(
            selection(&source, 0),
            Some(&hints),
            Some("UTC"),
            policies(),
            &|| false,
        )
        .err()
        .unwrap();
    assert!(
        error.to_string().contains("query_budget_exceeded"),
        "{error}"
    );
    assert_eq!(r.store().reads.get(), 2); // Final attempted source read is refused before a second copy.
    assert!(r.store().pages.get() > 0); // Actual residual pages reached final source CAS admission.
}

#[test]
fn authority_denial_precedes_any_projection_or_source_read() {
    let (mut r, hints) = seeded(3, SIMPLE);
    let account = r.policy.devices[&r.cfg.device_id].account;
    r.policy
        .members
        .insert(account, mdbn_wire::policy::Role::Viewer);
    assert_eq!(
        r.execute_indexed_bases_view(
            selection(SIMPLE, 0),
            Some(&hints),
            Some("UTC"),
            policies(),
            &|| false
        )
        .err()
        .unwrap()
        .code(),
        Some(ErrorCode::Forbidden)
    );
    assert_eq!(r.store().reads.get(), 0);
    assert_eq!(r.store().pages.get(), 0);
}
