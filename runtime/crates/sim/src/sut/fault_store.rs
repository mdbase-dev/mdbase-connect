//! Atomic Store commit faults without killing the live Replica instance.
//!
//! A control-bearing transaction fails before reaching the underlying Store.
//! All other operations, including optional retention/disk methods, delegate.
//!
//! Deferred-durability windows ([`Store::defer_durability`]) are forwarded, so
//! the replica runs its windows here as it does on the native index. The node
//! models what a crash does to one: commits since the window opened are lost
//! (see [`FaultStore::with_window_snapshot`]). A [`CrashPlan`] can stop the
//! process at each commit and at each edge of a window.

use std::cell::RefCell;
use std::ops::{Deref, Range};
use std::rc::Rc;

use mdbn_replica::policy::PolicyState;
use mdbn_replica::store::*;
use mdbn_wire::client::Hold;
use mdbn_wire::common::{Hash, Uuid};
use mdbn_wire::intent::FileInclusion;

/// One scripted, atomic, retryable control commit failure.
#[derive(Debug, Default)]
pub struct CommitFault {
    /// Control position to fail once.
    pub at: Option<Seq>,
    /// Actual injected failures (the scenario must check non-vacuity).
    pub injected: u64,
    /// Known control position that every acknowledged later head must cover.
    pub expected_control: Option<Seq>,
    /// Successful commits with an acknowledged head but stale durable policy.
    pub missing_policy: Vec<(Seq, Seq)>,
    /// Oracle read failures; never change the underlying commit result.
    pub oracle_read_errors: u64,
    /// One process crash exactly after a head-only durability gap is committed.
    pub crash_after_gap: bool,
    /// Actual crashes at that boundary (zero once the bug is fixed).
    pub gap_crashes: u64,
}

/// A scripted process crash at one numbered point of a run.
///
/// The points are the places where a crash leaves a different durable state or
/// a different set of outputs behind: before and after each store commit, the
/// edges of a deferred-durability window, each file-system call that changes
/// the folder, and each batch of outputs leaving the process. A first run
/// counts them; later runs crash at one each.
#[derive(Debug, Default)]
pub struct CrashPlan {
    /// Points count (and the crash can happen) only while armed.
    pub armed: bool,
    /// Crash at this point of the armed phase (1-based).
    pub at: Option<u64>,
    /// Points passed while armed.
    pub seen: u64,
    /// Points passed while armed, by kind.
    pub kinds: std::collections::BTreeMap<&'static str, u64>,
    /// The kind of point the crash happened at.
    pub crashed_at: Option<&'static str>,
    /// A deferred-durability window was open at the crash.
    pub crashed_in_window: bool,
}

impl CrashPlan {
    /// Pass a point; true if the process crashes here.
    pub fn hit(&mut self, kind: &'static str, in_window: bool) -> bool {
        if !self.armed {
            return false;
        }
        self.seen += 1;
        *self.kinds.entry(kind).or_default() += 1;
        if self.at == Some(self.seen) {
            self.at = None;
            self.crashed_at = Some(kind);
            self.crashed_in_window = in_window;
            return true;
        }
        false
    }
}

/// Simulator-owned Store decorator. No failure changes any underlying state.
pub struct FaultStore<S> {
    inner: S,
    fault: Rc<RefCell<CommitFault>>,
    gap_hook: Option<Box<dyn Fn()>>,
    /// Called right before a deferred-durability window opens.
    window_snapshot: Option<Box<dyn Fn()>>,
    /// Decline windows: every commit is durable on its own.
    per_item: bool,
    crash: Option<(Rc<RefCell<CrashPlan>>, crate::platform::Proc)>,
}

impl<S> FaultStore<S> {
    /// Wrap an existing store with a shared fault plan.
    pub fn new(inner: S, fault: Rc<RefCell<CommitFault>>) -> Self {
        Self {
            inner,
            fault,
            gap_hook: None,
            window_snapshot: None,
            per_item: false,
            crash: None,
        }
    }

    /// Call `snapshot` right before a deferred-durability window opens: the
    /// state a crash inside that window falls back to.
    pub fn with_window_snapshot(mut self, snapshot: impl Fn() + 'static) -> Self {
        self.window_snapshot = Some(Box::new(snapshot));
        self
    }

    /// Decline deferred-durability windows, as a host without them does:
    /// every commit is durable on its own.
    pub fn per_item(mut self, per_item: bool) -> Self {
        self.per_item = per_item;
        self
    }

    /// Crash `proc` at the point `plan` names. A crashed process commits
    /// nothing further.
    pub fn with_crash_plan(
        mut self,
        plan: Rc<RefCell<CrashPlan>>,
        proc: crate::platform::Proc,
    ) -> Self {
        self.crash = Some((plan, proc));
        self
    }

    /// Process-crash hook at the committed-head/control-state durability gap.
    pub fn with_gap_hook(mut self, hook: impl Fn() + 'static) -> Self {
        self.gap_hook = Some(Box::new(hook));
        self
    }
}

impl<S: Store> FaultStore<S> {
    /// Pass a crash point. `Err` once the process has crashed, here or earlier.
    fn point(&self, kind: &'static str) -> StoreResult<()> {
        let Some((plan, proc)) = &self.crash else {
            return Ok(());
        };
        let dead = || StoreError::Io("process crashed".into());
        if proc.crashed.get() {
            return Err(dead());
        }
        if plan
            .borrow_mut()
            .hit(kind, self.inner.durability_deferred())
        {
            proc.crash();
            return Err(dead());
        }
        Ok(())
    }
}

impl<S> Deref for FaultStore<S> {
    type Target = S;
    fn deref(&self) -> &S {
        &self.inner
    }
}

macro_rules! reads {
    ($(fn $name:ident(&self $(, $arg:ident: $ty:ty)*) -> $ret:ty;)*) => {
        $(fn $name(&self $(, $arg: $ty)*) -> $ret {
            self.inner.$name($($arg),*)
        })*
    };
}

impl<S: Store> Store for FaultStore<S> {
    fn records_visit<B>(
        &self,
        page: Page,
        visitor: &mut dyn FnMut(RecordRow) -> std::ops::ControlFlow<B>,
    ) -> StoreResult<std::ops::ControlFlow<B>> {
        self.inner.records_visit(page, visitor)
    }
    reads! {
        fn head(&self) -> StoreResult<Head>;
        fn record(&self, id: &Uuid) -> StoreResult<Option<RecordRow>>;
        fn record_at(&self, path_key: &str) -> StoreResult<Option<Uuid>>;
        fn records(&self, page: Page) -> StoreResult<Vec<RecordRow>>;
        fn records_in_buckets(&self, range: Range<u32>, page: Page) -> StoreResult<Vec<RecordRow>>;
        fn record_count(&self) -> StoreResult<u64>;
        fn file(&self, id: &Uuid) -> StoreResult<Option<FileRow>>;
        fn file_at(&self, path_key: &str) -> StoreResult<Option<Uuid>>;
        fn files(&self, page: Page) -> StoreResult<Vec<FileRow>>;
        fn files_in_buckets(&self, range: Range<u32>, page: Page) -> StoreResult<Vec<FileRow>>;
        fn resource(&self, path: &str) -> StoreResult<Option<String>>;
        fn resources(&self) -> StoreResult<Vec<(String, String)>>;
        fn settings(&self) -> StoreResult<Option<FileInclusion>>;
        fn tombstone(&self, id: &Uuid) -> StoreResult<Option<TombstoneRow>>;
        fn tombstones_at(&self, path_key: &str) -> StoreResult<Vec<TombstoneRow>>;
        fn tombstones(&self, page: Page) -> StoreResult<Vec<TombstoneRow>>;
        fn alias(&self, path_key: &str) -> StoreResult<Option<Uuid>>;
        fn aliases(&self) -> StoreResult<Vec<AliasRow>>;
        fn conflicts(&self, of: Option<&Uuid>) -> StoreResult<Vec<ConflictRow>>;
        fn conflict_count(&self) -> StoreResult<u64>;
        fn receipt(&self, mutation: &Uuid) -> StoreResult<Option<ReceiptRow>>;
        fn receipts(&self, after: Option<Uuid>, limit: u32) -> StoreResult<Vec<ReceiptRow>>;
        fn referrers(&self, target_keys: &[String]) -> StoreResult<Vec<Uuid>>;
        fn unique_holders(&self, field: &str, value_key: &str) -> StoreResult<Vec<Uuid>>;
        fn candidates(&self, q: &Candidate, page: Page) -> StoreResult<Vec<RecordRow>>;
        fn pending(&self, after_order: Option<u64>, limit: u32) -> StoreResult<Vec<PendingRow>>;
        fn pending_get(&self, mutation: &Uuid) -> StoreResult<Option<PendingRow>>;
        fn pending_count(&self) -> StoreResult<u64>;
        fn local_receipt(&self, mutation: &Uuid) -> StoreResult<Option<LocalReceipt>>;
        fn holds(&self) -> StoreResult<Vec<Hold>>;
        fn hold(&self, id: &Uuid) -> StoreResult<Option<Hold>>;
        fn meta(&self, key: &str) -> StoreResult<Option<Vec<u8>>>;
        fn transfer(&self, id: &Uuid) -> StoreResult<Option<TransferRow>>;
        fn transfer_chunk(&self, id: &Uuid, index: u64) -> StoreResult<Option<Vec<u8>>>;
        fn blob_size(&self, digest: &Hash) -> StoreResult<Option<u64>>;
        fn blob_read(&self, digest: &Hash, offset: u64, len: u64) -> StoreResult<Vec<u8>>;
        fn tail(&self, after: Seq, limit: u32) -> StoreResult<Vec<TailRow>>;
        fn tail_stats(&self) -> StoreResult<TailStats>;
        fn own_retained_stats(&self) -> StoreResult<TailStats>;
        fn own_retained(&self, after: Seq, limit: u32) -> StoreResult<Vec<(Seq, PendingRow)>>;
        fn has_files(&self) -> bool;
        fn disk_revision(&self, path: &str) -> StoreResult<Option<Hash>>;
        fn disk_paths(&self) -> StoreResult<Vec<(String, Hash)>>;
    }

    fn observe(&mut self, paths: Option<&[String]>) -> StoreResult<Vec<Observation>> {
        self.inner.observe(paths)
    }

    fn durability_deferred(&self) -> bool {
        self.inner.durability_deferred()
    }

    fn defer_durability(&mut self, on: bool) -> StoreResult<()> {
        if self.per_item {
            return Ok(());
        }
        if on == self.inner.durability_deferred() {
            return self.inner.defer_durability(on);
        }
        if on {
            if let Some(snapshot) = &self.window_snapshot {
                snapshot();
            }
            self.inner.defer_durability(true)?;
            self.point("window opened")
        } else {
            // Everything in the window is applied; none of it is durable yet.
            self.point("window closing")?;
            self.inner.defer_durability(false)?;
            self.point("window closed")
        }
    }

    fn commit(&mut self, tx: Tx) -> StoreResult<CommitReport> {
        self.point("commit")?;
        let mut fault = self.fault.borrow_mut();
        // Control read-ahead can checkpoint policy without advancing the
        // applied head. Fault that transaction too, not only ordinary apply.
        let policy_seq = fault.at.and_then(|_| {
            tx.meta
                .iter()
                .filter(|(k, _)| k == meta_keys::POLICY)
                .find_map(|(_, bytes)| {
                    bytes
                        .as_deref()
                        .and_then(|b| PolicyState::from_bytes(b).ok())
                        .map(|p| p.seq)
                })
        });
        if fault.at.is_some()
            && (tx.head.map(|h| h.seq) == fault.at || policy_seq == fault.at)
            && tx.meta.iter().any(|(k, _)| k == meta_keys::POLICY)
        {
            let seq = fault.at.take().expect("checked above");
            fault.injected += 1;
            return Err(StoreError::Io(format!(
                "injected atomic control commit failure at seq {seq}"
            )));
        }
        drop(fault);
        let result = self.inner.commit(tx);
        if result.is_ok() {
            // The commit landed; the process may die before it learns so.
            self.point("committed")?;
            let mut fault = self.fault.borrow_mut();
            if let Some(expected) = fault.expected_control {
                match (self.inner.head(), self.inner.meta(meta_keys::POLICY)) {
                    (Ok(head), Ok(bytes)) => {
                        let policy_seq = bytes
                            .as_deref()
                            .and_then(|b| PolicyState::from_bytes(b).ok())
                            .map_or(0, |p| p.seq);
                        if head.seq >= expected
                            && policy_seq < expected
                            && fault.missing_policy.last() != Some(&(head.seq, policy_seq))
                        {
                            fault.missing_policy.push((head.seq, policy_seq));
                            if fault.crash_after_gap {
                                fault.crash_after_gap = false;
                                fault.gap_crashes += 1;
                                if let Some(hook) = &self.gap_hook {
                                    hook();
                                }
                            }
                        }
                    }
                    _ => fault.oracle_read_errors += 1,
                }
            }
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mdbn_replica::mem::MemStore;
    use mdbn_wire::common::B32;

    #[test]
    fn failure_is_atomic_one_shot_and_not_a_crash() {
        let fault = Rc::new(RefCell::new(CommitFault {
            at: Some(3),
            ..CommitFault::default()
        }));
        let mut s = FaultStore::new(MemStore::default(), fault.clone());
        let tx = Tx {
            head: Some(Head {
                seq: 3,
                chain: B32([3; 32]),
            }),
            meta: vec![(meta_keys::POLICY.into(), Some(vec![1, 2, 3]))],
            ..Tx::default()
        };
        assert!(matches!(s.commit(tx.clone()), Err(StoreError::Io(_))));
        assert_eq!(s.head().unwrap(), Head::GENESIS);
        assert_eq!(s.meta(meta_keys::POLICY).unwrap(), None);
        assert_eq!(fault.borrow().injected, 1);
        s.commit(tx).unwrap();
        assert_eq!(s.head().unwrap().seq, 3);
        assert_eq!(s.meta(meta_keys::POLICY).unwrap(), Some(vec![1, 2, 3]));
        assert_eq!(fault.borrow().injected, 1);
    }
}
