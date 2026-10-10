use super::*;
use crate::replica::{BasesExecutionWindow, BasesReadRequest};
#[test]
fn all_five_independent_windows_match_full_rows_cells_and_group_placement() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../data/bases-first-slice.json")).unwrap();
    for view in fixture["views"].as_array().unwrap() {
        let source = fixture["sources"]
            .as_array()
            .unwrap()
            .iter()
            .find(|source| source["command"] == view["command"])
            .unwrap()["source"]
            .as_str()
            .unwrap();
        let (svc, mut a, _) = configured();
        a.create(11, "Views/actual.base", source);
        for (i, record) in fixture["records"].as_array().unwrap().iter().enumerate() {
            a.create(
                (i + 1) as u8,
                record["path"].as_str().unwrap(),
                record["source"].as_str().unwrap(),
            );
        }
        settle(&mut [&mut a]);
        a.clock.set(fixture["now_ms"].as_u64().unwrap());
        let mut r = projected(&svc, a);
        let hints = BTreeMap::from([
            ("due".into(), "date".into()),
            ("scheduled".into(), "date".into()),
        ]);
        let selected = selection(source, view["index"].as_u64().unwrap() as u32);
        let full = r
            .execute_indexed_bases_view(selected, Some(&hints), Some("UTC"), policies(), &|| false)
            .unwrap();
        assert!(full.window.is_none());
        let full_json = output(&full);
        for (request_index, (offset, limit)) in
            [(0, 200), (0, 1), (1, 2), (2, 1), (u32::MAX, 65_536)]
                .into_iter()
                .enumerate()
        {
            let window = BasesExecutionWindow { offset, limit };
            let result = r
                .execute_indexed_bases_window_view(
                    selected,
                    Some(&hints),
                    Some("UTC"),
                    window,
                    &|| false,
                )
                .unwrap();
            let start = (offset as usize).min(full.rows.len());
            let end = start.saturating_add(limit as usize).min(full.rows.len());
            assert_eq!(
                output(&result)["rows"],
                serde_json::json!(&full_json["rows"].as_array().unwrap()[start..end]),
                "{} {offset}/{limit}",
                view["name"]
            );
            // Each independent read captures its own monotonic instant. These
            // fixture views use date boundaries, not a cross-request clock lease.
            assert_eq!(
                result.clock.instant_ms,
                full.clock.instant_ms + request_index as i64 + 1
            );
            assert_eq!(result.clock.tz, full.clock.tz);
            assert_eq!(result.clock.local_date, full.clock.local_date);
            assert_eq!(result.collection_revision, full.collection_revision);
            let info = result.window.as_ref().unwrap();
            assert_eq!(info.request, window);
            assert_eq!(info.total_rows as usize, full.rows.len());
            let expected = full
                .groups
                .iter()
                .enumerate()
                .filter_map(|(ordinal, group)| {
                    let selected = group
                        .rows
                        .iter()
                        .enumerate()
                        .filter(|(_, global)| (start..end).contains(global))
                        .map(|(inside, global)| (inside, *global - start))
                        .collect::<Vec<_>>();
                    (!selected.is_empty()).then_some((ordinal, group, selected))
                })
                .collect::<Vec<_>>();
            assert_eq!(expected.len(), result.groups.len());
            assert_eq!(expected.len(), info.groups.len());
            for ((ordinal, original, selected), (returned, placement)) in expected
                .into_iter()
                .zip(result.groups.iter().zip(&info.groups))
            {
                assert_eq!(original.key, returned.key);
                assert_eq!(placement.ordinal as usize, ordinal);
                assert_eq!(placement.total_rows as usize, original.rows.len());
                assert_eq!(
                    returned.rows,
                    selected.iter().map(|(_, local)| *local).collect::<Vec<_>>()
                );
                assert_eq!(
                    placement.row_ordinals,
                    selected
                        .iter()
                        .map(|(inside, _)| *inside as u32)
                        .collect::<Vec<_>>()
                );
            }
        }
    }
}
#[test]
fn invalid_window_and_unknown_session_refuse_before_any_key_or_display_scan() {
    let (svc, mut a, source) = configured();
    a.create(11, "Views/actual.base", &source);
    settle(&mut [&mut a]);
    let mut r = projected(&svc, a);
    let hints = BTreeMap::new();
    for limit in [0, 65_537, u32::MAX] {
        assert_eq!(
            r.execute_indexed_bases_window_view(
                selection(&source, 0),
                Some(&hints),
                Some("UTC"),
                BasesExecutionWindow { offset: 0, limit },
                &|| false
            )
            .err()
            .unwrap()
            .problem()
            .reason
            .as_deref(),
            Some("invalid_bases_window")
        );
    }
    assert!(
        r.encode_indexed_bases_read_request(
            SessionId(u64::MAX),
            BasesReadRequest {
                selection: selection(&source, 0),
                property_types: &hints,
                timezone: "UTC",
                window: Some(BasesExecutionWindow {
                    offset: 0,
                    limit: 200
                })
            },
            |_| panic!("must not measure"),
            |_, _| panic!("must not encode")
        )
        .is_err()
    );
    assert_eq!(r.store().reads.get(), 0);
    assert_eq!(r.store().pages.get(), 0);
}
