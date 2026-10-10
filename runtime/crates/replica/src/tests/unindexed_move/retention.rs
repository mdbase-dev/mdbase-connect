//! Bounded local fence ownership. Synthetic retention rows exercise the scan
//! boundary; genuine captures supply the original fence and pending row.
use super::*;
use mdbn_wire::{
    cbor::{self, Cbor},
    common::Uuid,
    schema::Wire,
};

fn uid(n: u32) -> Uuid {
    let mut bytes = [0; 16];
    bytes[..4].copy_from_slice(&n.to_be_bytes());
    B16(bytes)
}
fn index(ids: &[Uuid]) -> Vec<u8> {
    cbor::encode(&Cbor::Array(ids.iter().map(Wire::to_cbor).collect())).unwrap()
}

#[test]
fn native_move_registry_cap_never_evicts_pending_or_retained_owners() {
    let (_svc, mut a, mut b) = pair();
    let id = native(&mut a, &mut b);
    a.r.test_capture_native_move(id, "before.md", "after.md")
        .unwrap();
    let original = a.r.store.pending(None, 10).unwrap().remove(0);
    settle(&mut [&mut a, &mut b]);
    let ids: Vec<_> = (1..=256).map(uid).collect();
    let original_fence =
        a.r.store
            .meta(&format!("native_move/{}", original.mutation.id.to_hex()))
            .unwrap()
            .unwrap();
    let mut meta = vec![("native_move_index".into(), Some(index(&ids)))];
    let retained = ids
        .iter()
        .enumerate()
        .map(|(n, id)| {
            meta.push((
                format!("native_move/{}", id.to_hex()),
                Some(original_fence.clone()),
            ));
            let mut row = original.clone();
            row.mutation.id = *id;
            (1000 + n as u64, row)
        })
        .collect();
    a.r.store
        .commit(Tx {
            meta,
            own_retained_put: retained,
            ..Tx::default()
        })
        .unwrap();
    let before = a.r.store.meta("native_move_index").unwrap();
    let order = a.r.next_order;
    let head = a.r.head();
    let error =
        a.r.test_capture_native_move(id, "after.md", "again.md")
            .unwrap_err();
    assert_eq!(error.0.reason.as_deref(), Some("native_move_fences_full"));
    assert_eq!(a.r.store.meta("native_move_index").unwrap(), before);
    assert_eq!(a.r.store.pending_count().unwrap(), 0);
    assert_eq!(a.r.next_order, order);
    assert_eq!(a.r.head(), head);
    assert!(a.r.take_log_calls().is_empty());
    for id in ids {
        assert_eq!(
            a.r.store
                .meta(&format!("native_move/{}", id.to_hex()))
                .unwrap(),
            Some(original_fence.clone())
        );
    }
}

#[test]
fn native_move_incomplete_retained_scan_preserves_even_not_yet_seen_owner() {
    let (_svc, mut a, mut b) = pair();
    let id = native(&mut a, &mut b);
    a.r.test_capture_native_move(id, "before.md", "after.md")
        .unwrap();
    let original = a.r.store.pending(None, 10).unwrap().remove(0);
    let fence_key = format!("native_move/{}", original.mutation.id.to_hex());
    settle(&mut [&mut a, &mut b]);
    let fence = a.r.store.meta(&fence_key).unwrap();
    // Exactly 64 full pages plus the owner beyond that bound. A scan cannot
    // prove absence from the first 16,384 rows, so ALL indexed owners survive.
    let retained = (1..=16_385)
        .map(|n| {
            let mut row = original.clone();
            if n != 16_385 {
                row.mutation.id = uid(n);
            }
            (n as u64, row)
        })
        .collect();
    a.r.store
        .commit(Tx {
            own_retained_drop_below: Some(u64::MAX),
            own_retained_put: retained,
            ..Tx::default()
        })
        .unwrap();
    a.r.test_capture_native_move(id, "after.md", "again.md")
        .unwrap();
    assert_eq!(a.r.store.meta(&fence_key).unwrap(), fence);
    let Cbor::Array(ids) =
        cbor::decode(&a.r.store.meta("native_move_index").unwrap().unwrap()).unwrap()
    else {
        panic!()
    };
    assert!(ids.contains(&original.mutation.id.to_cbor()));
    assert_eq!(ids.len(), 2);
    assert_eq!(a.r.store.pending_count().unwrap(), 1);
}

#[test]
fn native_move_malformed_registry_refuses_without_pruning_or_capture() {
    for bytes in [
        vec![0xff],
        index(&[uid(1), uid(1)]),
        index(&(1..=257).map(uid).collect::<Vec<_>>()),
    ] {
        let (_svc, mut a, mut b) = pair();
        let id = native(&mut a, &mut b);
        a.r.store
            .commit(Tx {
                meta: vec![("native_move_index".into(), Some(bytes.clone()))],
                ..Tx::default()
            })
            .unwrap();
        let head = a.r.head();
        let order = a.r.next_order;
        assert!(
            a.r.test_capture_native_move(id, "before.md", "after.md")
                .is_err()
        );
        assert_eq!(a.r.store.meta("native_move_index").unwrap(), Some(bytes));
        assert_eq!(a.r.store.pending_count().unwrap(), 0);
        assert_eq!(a.r.next_order, order);
        assert_eq!(a.r.head(), head);
        assert!(a.r.take_log_calls().is_empty());
    }
}
