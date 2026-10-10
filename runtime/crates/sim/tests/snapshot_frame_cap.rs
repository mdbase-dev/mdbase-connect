//! The replica's snapshot refs budget against the log service's real
//! whole-request decode budget: the largest refs inventory the replica admits
//! decodes within one service request (`put_snapshot`, and `put_object` of the
//! manifest Item that repeats the refs); a larger one is refused by the
//! replica before anything is sent, and would have been refused by the service.

use mdbn_log_service::decode::{Budget, MAX_NODES};
use mdbn_replica::{MAX_REQUEST_NODES, SnapshotBlocked, snapshot_refs_fit};
use mdbn_wire::common::{B16, B32, B64, Bytes};
use mdbn_wire::envelope::{Item, ItemKind};
use mdbn_wire::log_service::{LsFrame, LsRequest, PutObjectParams, PutSnapshotParams};
use mdbn_wire::schema::Wire;

const COL: B16 = B16([7; 16]);

fn manifest(n: usize) -> Item {
    Item {
        kind: ItemKind::Manifest,
        collection: COL,
        seq: None,
        prev: None,
        epoch: Some(1),
        signer: Some(B16([1; 16])),
        salt: Some(B16([2; 16])),
        idem: None,
        refs: Some(
            (0..n as u64)
                .map(|i| {
                    let mut h = [0u8; 32];
                    h[..8].copy_from_slice(&i.to_be_bytes());
                    B32(h)
                })
                .collect(),
        ),
        stream: None,
        body: Bytes(vec![0; 4096]),
        sig: Some(B64([3; 64])),
    }
}

fn frame(method: &str, params: mdbn_wire::cbor::Cbor) -> Vec<u8> {
    LsFrame::Request(LsRequest {
        id: 1 << 40,
        method: method.into(),
        params,
    })
    .to_bytes()
    .unwrap()
}

/// Whether the service admits both snapshot requests for this manifest.
fn service_admits(item: &Item) -> bool {
    let refs = item.refs.clone().unwrap_or_default();
    let put_snapshot = frame(
        "put_snapshot",
        PutSnapshotParams {
            collection: COL,
            seq: 1 << 40,
            manifest: B32([4; 32]),
            refs,
        }
        .to_cbor(),
    );
    let bytes = item.to_bytes().unwrap();
    let put_object = frame(
        "put_object",
        PutObjectParams {
            collection: COL,
            address: B32([4; 32]),
            kind: ItemKind::Manifest,
            size: bytes.len() as u64,
            checksum: B32([5; 32]),
            bytes: Some(Bytes(bytes.clone())),
        }
        .to_cbor(),
    );
    let snapshot_ok = Budget::default().preflight(&put_snapshot).is_ok();
    let object = Budget::default();
    let object_ok = object.preflight(&put_object).is_ok() && object.preflight(&bytes).is_ok();
    snapshot_ok && object_ok
}

#[test]
fn the_replica_refs_budget_fits_the_service_request_budget() {
    assert_eq!(MAX_REQUEST_NODES, MAX_NODES);
    let largest = (1..MAX_NODES)
        .rev()
        .find(|n| snapshot_refs_fit(COL, 1 << 40, &manifest(*n)).is_ok())
        .expect("some inventory fits");
    // An attachment costs 1 + ceil(size / 8 MiB) refs: 129 at 1 GiB.
    assert!(
        largest > 30 * 129,
        "thirty full attachments fit directly: {largest}"
    );
    assert!(service_admits(&manifest(largest)), "admitted at {largest}");
    assert!(matches!(
        snapshot_refs_fit(COL, 1 << 40, &manifest(largest + 1)),
        Err(SnapshotBlocked::FrameCap { .. })
    ));
    assert!(!service_admits(&manifest(MAX_NODES)), "the cap is real");
}
