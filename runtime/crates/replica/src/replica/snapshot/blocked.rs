//! Why a due build is refused, and the log service's request-size check that refuses it.

use super::*;

/// Why the replica did not build a snapshot it was due to build. Typed and
/// never silent: the previous snapshot, and every object it retains, stay.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapshotBlocked {
    /// The confirmed record text is over what this host can build in memory. The
    /// previous snapshot stays; the next attempt is one snapshot period later.
    RecordBytes {
        /// The limit it passed.
        limit: u64,
    },
    /// Some attachments' object inventories are still being read from their
    /// authenticated manifests. The build runs again once they are known.
    InventoryPending {
        /// Attachments without a known inventory.
        attachments: u64,
    },
    /// Some attachments' manifests could not be read or authenticated (the log
    /// no longer has them, or they do not open). Compaction stays blocked.
    InventoryUnavailable {
        /// Attachments whose inventory cannot be established.
        attachments: u64,
    },
    /// The complete refs inventory does not fit in one log-service request
    /// (`put_snapshot`, or the manifest object), whose CBOR node budget is
    /// [`MAX_REQUEST_NODES`]. Never truncated.
    FrameCap {
        /// Distinct objects the snapshot must retain.
        refs: u64,
        /// CBOR nodes the larger of the two requests needs.
        nodes: u64,
    },
    /// The refs inventory exceeds what ref-index objects can carry
    /// (`snapshot.md` §2.1: 262,144 addresses). Never truncated.
    TooManyRefs {
        /// Distinct objects the snapshot must retain.
        refs: u64,
    },
}

/// The log service's whole-request CBOR value budget (`MAX_NODES` in its
/// decode boundary; `log-service-api.md`): every value in one request frame and
/// the objects it carries, map keys included.
pub const MAX_REQUEST_NODES: usize = 4096;

/// Nodes kept free in each snapshot request for what a transport adds to the
/// same budget (a bearer token's claims, for one).
const REQUEST_NODE_RESERVE: usize = 64;

/// CBOR values in `c`, counted as the log service's preflight counts them.
fn cbor_nodes(c: &Cbor) -> usize {
    match c {
        Cbor::Array(v) => 1 + v.iter().map(cbor_nodes).sum::<usize>(),
        Cbor::Map(m) => {
            1 + m
                .iter()
                .map(|(k, v)| cbor_nodes(k) + cbor_nodes(v))
                .sum::<usize>()
        }
        _ => 1,
    }
}

fn request_nodes(method: &str, params: Cbor) -> usize {
    cbor_nodes(
        &mdbn_wire::log_service::LsFrame::Request(mdbn_wire::log_service::LsRequest {
            id: u64::MAX,
            method: method.into(),
            params,
        })
        .to_cbor(),
    )
}

/// The nodes the two snapshot requests need: `put_snapshot` with `refs`, and
/// `put_object` of the manifest Item (whose envelope repeats `refs`).
fn snapshot_request_nodes(collection: mdbn_wire::common::Uuid, seq: u64, manifest: &Item) -> usize {
    let refs = manifest.refs.clone().unwrap_or_default();
    let put_snapshot = request_nodes(
        "put_snapshot",
        PutSnapshotParams {
            collection,
            seq,
            manifest: B32([0; 32]),
            refs,
        }
        .to_cbor(),
    );
    let put_object = request_nodes(
        "put_object",
        mdbn_wire::log_service::PutObjectParams {
            collection,
            address: B32([0; 32]),
            kind: ItemKind::Manifest,
            size: u64::MAX,
            checksum: B32([0; 32]),
            bytes: Some(Bytes(Vec::new())),
        }
        .to_cbor(),
    ) + cbor_nodes(&manifest.to_cbor());
    put_snapshot.max(put_object)
}

/// Refuse, typed, a manifest whose requests would exceed the service's budget.
pub fn snapshot_refs_fit(
    collection: mdbn_wire::common::Uuid,
    seq: u64,
    manifest: &Item,
) -> Result<(), SnapshotBlocked> {
    let nodes = snapshot_request_nodes(collection, seq, manifest);
    if nodes + REQUEST_NODE_RESERVE > MAX_REQUEST_NODES {
        return Err(SnapshotBlocked::FrameCap {
            refs: manifest.refs.as_ref().map_or(0, Vec::len) as u64,
            nodes: nodes as u64,
        });
    }
    Ok(())
}
