//! Allocated lost-tail codecs only: no repair/state-machine activation.
use mdbn_wire::cbor::Cbor;
use mdbn_wire::client::{IncidentKind, Receipt, ResyncPhase, Resyncing, SyncStatus};
use mdbn_wire::entry::EntryPayload;
use mdbn_wire::schema::Wire;

const ENTRY: &[u8] = include_bytes!("../../../conformance/wire/entry/applied-with-text-table.cbor");
const RECEIPT: &[u8] = include_bytes!("../../../conformance/wire/client/receipt-pending.cbor");
const STATUS: &[u8] = include_bytes!("../../../conformance/wire/client/status.cbor");

fn set(value: &Cbor, key: u64, field: Option<Cbor>) -> Cbor {
    let Cbor::Map(map) = value else {
        panic!("struct expected")
    };
    let mut map = map.clone();
    map.retain(|(k, _)| *k != Cbor::Uint(key));
    if let Some(field) = field {
        map.push((Cbor::Uint(key), field));
    }
    Cbor::Map(map)
}

#[test]
fn legacy_omissions_keep_exact_checked_in_bytes() {
    let entry = EntryPayload::from_bytes(ENTRY).unwrap();
    assert!(entry.resurrect.is_none());
    assert_eq!(entry.to_bytes().unwrap(), ENTRY);
    let receipt = Receipt::from_bytes(RECEIPT).unwrap();
    assert!(receipt.relocated_from.is_none());
    assert_eq!(receipt.to_bytes().unwrap(), RECEIPT);
    let status = SyncStatus::from_bytes(STATUS).unwrap();
    assert!(status.resyncing.is_none());
    assert_eq!(status.to_bytes().unwrap(), STATUS);
}

#[test]
fn position_extensions_use_only_the_allocated_keys_and_preserve_legacy_fields() {
    for position in [0, 1, 42, u64::MAX] {
        let mut entry = EntryPayload::from_bytes(ENTRY).unwrap();
        let old = entry.to_cbor();
        entry.resurrect = Some(position);
        assert_eq!(entry.to_cbor(), set(&old, 8, Some(Cbor::Uint(position))));
        assert_eq!(
            EntryPayload::from_bytes(&entry.to_bytes().unwrap()).unwrap(),
            entry
        );
        entry.resurrect = None;
        assert_eq!(entry.to_bytes().unwrap(), ENTRY);

        let mut receipt = Receipt::from_bytes(RECEIPT).unwrap();
        let old = receipt.to_cbor();
        receipt.relocated_from = Some(position);
        assert_eq!(receipt.to_cbor(), set(&old, 9, Some(Cbor::Uint(position))));
        assert_eq!(
            Receipt::from_bytes(&receipt.to_bytes().unwrap()).unwrap(),
            receipt
        );
        receipt.relocated_from = None;
        assert_eq!(receipt.to_bytes().unwrap(), RECEIPT);
    }
}

#[test]
fn all_resync_phases_and_incidents_have_exact_contract_numbers() {
    for (tag, phase) in [
        (0, ResyncPhase::Probing),
        (1, ResyncPhase::Repairing),
        (2, ResyncPhase::RollingBack),
        (3, ResyncPhase::AwaitingControl),
    ] {
        assert_eq!(phase.to_cbor(), Cbor::Uint(tag));
        assert_eq!(ResyncPhase::from_cbor(&Cbor::Uint(tag)).unwrap(), phase);
        for positions in [0, 1, u64::MAX] {
            let progress = Resyncing { phase, positions };
            assert_eq!(
                progress.to_cbor(),
                Cbor::Map(vec![
                    (Cbor::Uint(0), Cbor::Uint(tag)),
                    (Cbor::Uint(1), Cbor::Uint(positions))
                ])
            );
            let mut status = SyncStatus::from_bytes(STATUS).unwrap();
            let old = status.to_cbor();
            status.resyncing = Some(progress.clone());
            assert_eq!(status.to_cbor(), set(&old, 10, Some(progress.to_cbor())));
            assert_eq!(
                SyncStatus::from_bytes(&status.to_bytes().unwrap()).unwrap(),
                status
            );
            status.resyncing = None;
            assert_eq!(status.to_bytes().unwrap(), STATUS);
        }
    }
    assert_eq!(IncidentKind::LostEntries.to_cbor(), Cbor::Uint(11));
    assert_eq!(IncidentKind::LogRegressed.to_cbor(), Cbor::Uint(12));
    for (tag, kind) in [
        (11, IncidentKind::LostEntries),
        (12, IncidentKind::LogRegressed),
    ] {
        assert_eq!(IncidentKind::from_cbor(&Cbor::Uint(tag)).unwrap(), kind);
    }
    for tag in [4, u64::MAX] {
        assert!(ResyncPhase::from_cbor(&Cbor::Uint(tag)).is_err());
    }
    assert!(IncidentKind::from_cbor(&Cbor::Uint(13)).is_err());
}

#[test]
fn wrong_types_missing_progress_fields_and_unknown_phases_fail_closed() {
    let entry = EntryPayload::from_bytes(ENTRY).unwrap().to_cbor();
    let receipt = Receipt::from_bytes(RECEIPT).unwrap().to_cbor();
    let status = SyncStatus::from_bytes(STATUS).unwrap().to_cbor();
    for wrong in [
        Cbor::Null,
        Cbor::Bool(false),
        Cbor::Nint(0),
        Cbor::Text("42".into()),
    ] {
        assert!(EntryPayload::from_cbor(&set(&entry, 8, Some(wrong.clone()))).is_err());
        assert!(Receipt::from_cbor(&set(&receipt, 9, Some(wrong.clone()))).is_err());
        assert!(SyncStatus::from_cbor(&set(&status, 10, Some(wrong))).is_err());
    }
    let progress = Resyncing {
        phase: ResyncPhase::Probing,
        positions: 1,
    }
    .to_cbor();
    for bad in [
        set(&progress, 0, None),
        set(&progress, 1, None),
        set(&progress, 0, Some(Cbor::Uint(4))),
        set(&progress, 1, Some(Cbor::Null)),
    ] {
        assert!(SyncStatus::from_cbor(&set(&status, 10, Some(bad))).is_err());
    }
}
