//! Read faults are not typed planner refusals or proof of safe cleanup.
use super::*;
use crate::{mem::MemStore, store::*};
use mdbn_wire::{
    client::Hold,
    common::{Hash, Uuid},
    intent::FileInclusion,
};
use std::{cell::Cell, ops::Range, rc::Rc};

struct ReadFaultStore {
    inner: MemStore,
    fault: Rc<Cell<Option<&'static str>>>,
}
impl ReadFaultStore {
    fn check(&self, seam: &str) -> StoreResult<()> {
        if self.fault.get() == Some(seam) {
            return Err(StoreError::Io(format!("native move {seam} read fault")));
        }
        Ok(())
    }
}
macro_rules! forward {
    ($($name:ident($($arg:ident:$ty:ty),*)->$out:ty;)+) => {$ (
        fn $name(&self, $($arg:$ty),*) -> $out {
            self.check(stringify!($name))?;
            self.inner.$name($($arg),*)
        }
    )+};
}
impl Store for ReadFaultStore {
    forward! {
        head()->StoreResult<Head>;
        record(id:&Uuid)->StoreResult<Option<RecordRow>>;
        record_at(key:&str)->StoreResult<Option<Uuid>>;
        records(page:Page)->StoreResult<Vec<RecordRow>>;
        records_in_buckets(range:Range<u32>,page:Page)->StoreResult<Vec<RecordRow>>;
        record_count()->StoreResult<u64>;
        file(id:&Uuid)->StoreResult<Option<FileRow>>;
        file_at(key:&str)->StoreResult<Option<Uuid>>;
        files(page:Page)->StoreResult<Vec<FileRow>>;
        files_in_buckets(range:Range<u32>,page:Page)->StoreResult<Vec<FileRow>>;
        resource(path:&str)->StoreResult<Option<String>>;
        resources()->StoreResult<Vec<(String,String)>>;
        settings()->StoreResult<Option<FileInclusion>>;
        tombstone(id:&Uuid)->StoreResult<Option<TombstoneRow>>;
        tombstones_at(key:&str)->StoreResult<Vec<TombstoneRow>>;
        tombstones(page:Page)->StoreResult<Vec<TombstoneRow>>;
        alias(key:&str)->StoreResult<Option<Uuid>>;
        aliases()->StoreResult<Vec<AliasRow>>;
        conflicts(of:Option<&Uuid>)->StoreResult<Vec<ConflictRow>>;
        conflict_count()->StoreResult<u64>;
        receipt(id:&Uuid)->StoreResult<Option<ReceiptRow>>;
        receipts(after:Option<Uuid>,limit:u32)->StoreResult<Vec<ReceiptRow>>;
        referrers(keys:&[String])->StoreResult<Vec<Uuid>>;
        unique_holders(field:&str,key:&str)->StoreResult<Vec<Uuid>>;
        candidates(q:&Candidate,page:Page)->StoreResult<Vec<RecordRow>>;
        pending(after:Option<u64>,limit:u32)->StoreResult<Vec<PendingRow>>;
        pending_get(id:&Uuid)->StoreResult<Option<PendingRow>>;
        pending_count()->StoreResult<u64>;
        local_receipt(id:&Uuid)->StoreResult<Option<LocalReceipt>>;
        holds()->StoreResult<Vec<Hold>>;
        hold(id:&Uuid)->StoreResult<Option<Hold>>;
        transfer(id:&Uuid)->StoreResult<Option<TransferRow>>;
        transfer_chunk(id:&Uuid,index:u64)->StoreResult<Option<Vec<u8>>>;
        blob_size(digest:&Hash)->StoreResult<Option<u64>>;
        blob_read(digest:&Hash,offset:u64,len:u64)->StoreResult<Vec<u8>>;
        tail(after:Seq,limit:u32)->StoreResult<Vec<TailRow>>;
        tail_stats()->StoreResult<TailStats>;
        own_retained(after:Seq,limit:u32)->StoreResult<Vec<(Seq,PendingRow)>>;
    }
    fn meta(&self, key: &str) -> StoreResult<Option<Vec<u8>>> {
        let seam = if key.starts_with("replica.attachment_inventory.") {
            "inventory"
        } else {
            "meta"
        };
        self.check(seam)?;
        self.inner.meta(key)
    }
    fn commit(&mut self, tx: Tx) -> StoreResult<CommitReport> {
        self.inner.commit(tx)
    }
    fn stages(&self) -> bool {
        self.inner.stages()
    }
    fn keyring_persistence(&self) -> KeyringPersistence {
        self.inner.keyring_persistence()
    }
}
fn wrapped(
    a: Node,
    svc: &crate::fake::FakeLogService,
) -> (
    crate::Replica<ReadFaultStore>,
    Rc<Cell<Option<&'static str>>>,
) {
    let cfg = a.r.cfg.clone();
    let fault = Rc::new(Cell::new(None));
    let mut r = crate::Replica::open(
        cfg,
        ReadFaultStore {
            inner: a.r.into_store(),
            fault: fault.clone(),
        },
        Box::new(crate::plan::CorePlanner),
        Box::new(crate::seal::KeyringSealer::new(
            super::super::engine::COL,
            B16([101; 16]),
            &[0x31; 32],
            &[0x32; 32],
        )),
        crate::Host {
            clock: Box::new(mdbn_core::host::FixedClock(1_700_000_000_000)),
            entropy: Box::new(crate::crypto::TestEntropy::new(81)),
            zones: Box::new(crate::UtcOnly),
        },
        crate::DeviceSecrets {
            sign_sk: [0x31; 32],
            kem_sk: [0x32; 32],
        },
    )
    .unwrap();
    let mut log = svc.client(B16([101; 16]));
    for _ in 0..20 {
        crate::log::pump(&mut r, &mut log, 100);
        r.tick();
    }
    assert!(r.caught_up);
    assert!(r.take_log_calls().is_empty());
    (r, fault)
}
#[test]
fn native_move_capture_registry_and_holder_read_faults_never_mint_or_prune() {
    for seam in [
        "file",
        "file_at",
        "record_at",
        "hold",
        "inventory",
        "meta",
        "own_retained",
        "pending_get",
    ] {
        let (svc, mut a, mut b) = pair();
        let id = native(&mut a, &mut b);
        a.r.test_capture_native_move(id, "before.md", "after.md")
            .unwrap();
        settle(&mut [&mut a, &mut b]); // retain a real owner for registry reads
        let (mut r, fault) = wrapped(a, &svc);
        let before = r.store.inner.meta("native_move_index").unwrap();
        let order = r.next_order;
        let head = r.head();
        // Exercise pending_get instead of short-circuiting on a retained owner.
        if seam == "pending_get" {
            r.store
                .inner
                .commit(Tx {
                    own_retained_drop_below: Some(u64::MAX),
                    ..Tx::default()
                })
                .unwrap();
        }
        fault.set(Some(seam));
        assert!(
            r.test_capture_native_move(id, "after.md", "again.md")
                .is_err(),
            "{seam}"
        );
        fault.set(None);
        assert_eq!(r.store.meta("native_move_index").unwrap(), before, "{seam}");
        assert_eq!(r.store.pending_count().unwrap(), 0);
        assert_eq!(r.next_order, order);
        assert_eq!(r.head(), head);
        assert!(r.take_log_calls().is_empty());
    }
}
#[test]
fn native_move_head_and_recovery_read_faults_propagate_with_pending_ownership_intact() {
    for recovery in [false, true] {
        for seam in ["file", "file_at", "hold", "inventory", "meta"] {
            let (svc, mut a, mut b) = pair();
            let id = native(&mut a, &mut b);
            let (mut r, fault) = wrapped(a, &svc);
            r.test_capture_native_move(id, "before.md", "after.md")
                .unwrap();
            let row = r.store.pending(None, 10).unwrap().remove(0);
            if recovery {
                r.resurrected.insert(row.mutation.id, r.head().seq);
            }
            fault.set(Some(seam));
            assert!(
                r.test_native_move_pending_check(&row).is_err(),
                "recovery={recovery}, seam={seam}"
            );
            fault.set(None);
            assert_eq!(r.store.pending_get(&row.mutation.id).unwrap(), Some(row));
            assert_eq!(r.store.file_at("before.md").unwrap(), Some(id));
            assert!(r.take_log_calls().is_empty());
        }
    }
}
