//! Replica read-outs: capture counts, inventory, record digests and sync counters.

use super::*;

/// Successful raw ownership/count reads, not the lossy display SyncStatus.
pub(crate) fn capture_counts(store: &impl mdbn_replica::store::Store) -> Option<(u64, u64)> {
    if store.pending_count().ok()? != 0 {
        return None;
    }
    Some((
        store.holds().ok()?.len() as u64,
        store.conflict_count().ok()?,
    ))
}

#[cfg(test)]
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct TestHoldWitness {
    pub inventory: Inventory,
    pub head: mdbn_replica::store::Head,
    pub receipts: Vec<mdbn_replica::store::ReceiptRow>,
    pub local_receipts: Vec<Option<mdbn_replica::store::LocalReceipt>>,
    pub holds: Vec<mdbn_wire::client::Hold>,
    pub pending: u64,
    pub conflicts: u64,
}

#[cfg(test)]
pub(super) fn test_hold_witness(rep: &Replica<Store>) -> Option<TestHoldWitness> {
    use mdbn_replica::store::Store as _;
    let store = rep.store();
    // A small fixture-only bound. Refuse rather than compare a truncated ledger.
    let receipts = store.receipts(None, 65).ok()?;
    if receipts.len() > 64 {
        return None;
    }
    let local_receipts = receipts
        .iter()
        .map(|r| store.local_receipt(&r.mutation))
        .collect::<mdbn_replica::store::StoreResult<Vec<_>>>()
        .ok()?;
    Some(TestHoldWitness {
        inventory: inventory(rep)?,
        head: store.head().ok()?,
        receipts,
        local_receipts,
        holds: store.holds().ok()?,
        pending: store.pending_count().ok()?,
        conflicts: store.conflict_count().ok()?,
    })
}

pub(super) fn inventory(rep: &Replica<Store>) -> Option<Inventory> {
    use mdbn_replica::store::{Page, Store as _};
    let store = rep.store();
    let mut records = Vec::new();
    let mut after = None;
    loop {
        let rows = store.records(Page { after, limit: 1024 }).ok()?;
        let Some(last) = rows.last() else { break };
        after = Some(last.id);
        records.extend(rows.into_iter().map(|r| (r.id.0, r.path)));
    }
    let resources = store
        .resources()
        .ok()?
        .into_iter()
        .map(|(p, _)| p)
        .collect();
    Some((records, resources))
}

pub(super) fn confirmed_digest(rep: &Replica<Store>) -> Option<(u64, [u8; 32])> {
    confirmed_store_digest(rep.store())
}
pub(super) fn confirmed_store_digest(
    store: &impl mdbn_replica::store::Store,
) -> Option<(u64, [u8; 32])> {
    use mdbn_replica::store::Page;
    // Store::records promises ID order. Stream the SAME existing tuple byte
    // contract in bounded pages, never collect the whole corpus or hash buffer.
    let mut hash = ring::digest::Context::new(&ring::digest::SHA256);
    let mut after = None;
    let mut count = 0u64;
    loop {
        let rows = store.records(Page { after, limit: 1024 }).ok()?;
        if rows.is_empty() {
            break;
        }
        for r in rows {
            if after.is_some_and(|id| id >= r.id) {
                return None;
            }
            hash.update(&r.id.0);
            hash.update(&(r.path.len() as u64).to_be_bytes());
            hash.update(r.path.as_bytes());
            hash.update(&r.revision.0);
            hash.update(&r.modified_seq.to_be_bytes());
            after = Some(r.id);
            count = count.checked_add(1)?;
        }
    }
    Some((count, hash.finish().as_ref().try_into().ok()?))
}

/// No remote incident details are included in control telemetry.
pub(super) fn sync_counters(
    status: &mdbn_wire::client::SyncStatus,
    caught_up: bool,
    head_digest: Option<String>,
    records: Option<(u64, [u8; 32])>,
) -> crate::control::SyncCounters {
    use mdbn_wire::client::{Connection, IncidentKind as K, SyncMode};
    let incident_code = |kind| match kind {
        K::UpgradeRequired => "upgrade_required",
        K::WaitingForKey => "waiting_for_key",
        K::Integrity => "integrity",
        K::AccessRevoked => "access_revoked",
        K::QuotaExceeded => "quota_exceeded",
        K::ReadOnly => "read_only",
        K::VerificationMismatch => "verification_mismatch",
        K::VoidedItems => "voided_items",
        K::KeyInconsistent => "key_inconsistent",
        K::ForeignSyncTool => "foreign_sync_tool",
        K::Gone => "gone",
        K::LostEntries => "lost_entries",
        K::LogRegressed => "log_regressed",
    };
    crate::control::SyncCounters {
        confirmed_through: status.confirmed_through,
        head_known: status.head_known,
        pending: status.pending,
        holds: status.holds,
        unresolved: status.unresolved,
        connection: match status.connection {
            Connection::Online => "online",
            Connection::Connecting => "connecting",
            Connection::Offline => "offline",
        }
        .into(),
        head_digest,
        confirmed_record_digest: records.map(|(count, hash)| {
            crate::control::ConfirmedRecordDigest {
                algorithm: "sha256-confirmed-record-tuples-v1".into(),
                records: count,
                digest: crate::secrets::hex(&hash),
                confirmed_through: status.confirmed_through,
            }
        }),
        last_error: status
            .incidents
            .last()
            .map(|i| incident_code(i.kind).into()),
        resyncing: status.installing.is_some()
            || status.resyncing.is_some()
            || (status.mode == SyncMode::Synced
                && (status.confirmed_through == 0
                    || !caught_up
                    || status.head_known > status.confirmed_through)),
        unsupported_entries: 0,
    }
}
