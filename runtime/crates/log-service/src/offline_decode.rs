//! Native-only cumulative decode accounting for one offline verification.
//!
//! This ledger supplements (never replaces) the existing request-local limits.
//! It carries no authority, replay state, storage access or reset operation.

use crate::decode::Budget;
use std::sync::{Arc, Mutex};

const MAX_WORK: u64 = 256 * 1024 * 1024 * 1024;
const MAX_OWNED: u64 = 96 * 1024 * 1024;

#[derive(Debug, Default)]
struct Counters {
    work: u64,
    owned: u64,
    peak_owned: u64,
    poisoned: bool,
}

#[derive(Debug, Default)]
pub(crate) struct Ledger {
    counters: Mutex<Counters>,
}

impl Ledger {
    pub(crate) fn charge(&self, bytes: usize) -> Result<(), &'static str> {
        let mut state = self.counters.lock().map_err(|_| "cbor_offline_budget")?;
        if state.poisoned {
            return Err("cbor_offline_budget");
        }
        let next = u64::try_from(bytes)
            .ok()
            .and_then(|bytes| state.work.checked_add(bytes))
            .filter(|work| *work <= MAX_WORK);
        match next {
            Some(work) => {
                state.work = work;
                Ok(())
            }
            None => {
                state.poisoned = true;
                Err("cbor_offline_work")
            }
        }
    }

    pub(crate) fn reserve_owned(
        self: &Arc<Self>,
        bytes: u64,
    ) -> Result<OfflineOwnedReservation, &'static str> {
        let mut state = self.counters.lock().map_err(|_| "cbor_offline_budget")?;
        if state.poisoned {
            return Err("cbor_offline_budget");
        }
        let Some(owned) = state
            .owned
            .checked_add(bytes)
            .filter(|owned| *owned <= MAX_OWNED)
        else {
            state.poisoned = true;
            return Err("cbor_offline_memory");
        };
        state.owned = owned;
        state.peak_owned = state.peak_owned.max(owned);
        Ok(OfflineOwnedReservation {
            ledger: self.clone(),
            bytes,
        })
    }

    pub(crate) fn poison(&self) {
        // A poisoned mutex itself is already a permanent refusal in charge().
        if let Ok(mut state) = self.counters.lock() {
            state.poisoned = true;
        }
    }
}

/// Opaque native owned-memory allowance on the invocation's shared ledger.
///
/// Retain this guard until its corresponding values and capacities are destroyed.
/// Drop releases only this allowance: never decoder work or permanent poison.
/// There is no public constructor, Clone, Default, setter or reset operation.
/// This is resource accounting, not archive or serving authority.
#[must_use]
pub struct OfflineOwnedReservation {
    ledger: Arc<Ledger>,
    bytes: u64,
}

impl Drop for OfflineOwnedReservation {
    fn drop(&mut self) {
        let mut state = match self.ledger.counters.lock() {
            Ok(state) => state,
            Err(poisoned) => {
                let mut state = poisoned.into_inner();
                state.poisoned = true;
                state
            }
        };
        state.poisoned |= std::thread::panicking();
        match state.owned.checked_sub(self.bytes) {
            Some(owned) => state.owned = owned,
            None => state.poisoned = true,
        }
        // Decode work and poison are never refunded by a memory release.
    }
}

/// One fixed cumulative decode ledger for an entire native offline invocation.
///
/// Clones and every request budget share counters and irreversible failure.
/// Fresh request-local limits never reset cumulative work or poison. This is
/// resource accounting only, not authentication or permission to restore/serve.
#[derive(Clone, Debug, Default)]
pub struct OfflineDecodeBudget {
    ledger: Arc<Ledger>,
}

impl OfflineDecodeBudget {
    /// Start a single fixed 256 GiB cumulative decoder-work ledger.
    pub fn new() -> Self {
        Self::default()
    }

    /// Charge owned buffer/index/scratch capacity BEFORE allocation or growth.
    ///
    /// All clones, CLI allocations and private helpers share a fixed 96 MiB
    /// ceiling. Refusal permanently poisons future reservations and verification,
    /// including zero-byte requests. Keep the opaque guard through the charged
    /// allocation's complete lifetime; its Drop never refunds work or poison.
    pub fn reserve_owned(&self, bytes: u64) -> crate::error::Result<OfflineOwnedReservation> {
        self.ledger
            .reserve_owned(bytes)
            .map_err(crate::error::ServiceError::invalid)
    }

    /// Create local service decode limits carrying this same global ledger.
    pub fn request(&self) -> Budget {
        Budget::with_offline(self.ledger.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decode::{MAX_NODES, Usage};

    #[test]
    fn clones_and_fresh_requests_preserve_all_pass_work() {
        let work = OfflineDecodeBudget::new();
        let a = work.request();
        let b = work.clone().request();
        let bytes = [0xf6];
        a.raw(&bytes).unwrap();
        a.raw(&bytes).unwrap();
        b.raw(&bytes).unwrap();
        assert_eq!(a.usage().work_bytes, 2);
        assert_eq!(b.usage().work_bytes, 1);
        assert_eq!(work.ledger.counters.lock().unwrap().work, 3);
    }

    #[test]
    fn inclusive_global_limit_then_permanent_refusal() {
        let work = OfflineDecodeBudget::new();
        work.ledger.counters.lock().unwrap().work = MAX_WORK - 1;
        work.request().raw(&[0xf6]).unwrap();
        let e = work.request().raw(&[0xf6]).unwrap_err();
        assert_eq!(e.reason.as_deref(), Some("cbor_offline_work"));
        assert_eq!(work.ledger.counters.lock().unwrap().work, MAX_WORK);
        assert!(work.clone().request().raw(&[0xf6]).is_err());
        assert!(work.ledger.charge(0).is_err());
    }

    #[test]
    fn checked_arithmetic_refuses_without_wrapping() {
        let work = OfflineDecodeBudget::new();
        work.ledger.counters.lock().unwrap().work = u64::MAX;
        assert!(work.ledger.charge(1).is_err());
        assert!(work.ledger.counters.lock().unwrap().poisoned);
        assert_eq!(work.ledger.counters.lock().unwrap().work, u64::MAX);
    }

    #[test]
    fn local_scan_and_materialization_errors_poison_other_requests() {
        let scan = OfflineDecodeBudget::new();
        assert!(scan.request().raw(&[]).is_err());
        assert!(scan.request().raw(&[0xf6]).is_err());

        let canonical = OfflineDecodeBudget::new();
        // Preflight is deliberately not a second canonical-profile decoder.
        assert!(canonical.request().raw(&[0x18, 0]).is_err());
        assert!(canonical.request().raw(&[0xf6]).is_err());

        let typed = OfflineDecodeBudget::new();
        assert!(
            typed
                .request()
                .wire::<mdbn_wire::envelope::Item>(&[0xf6])
                .is_err()
        );
        assert!(typed.request().raw(&[0xf6]).is_err());
    }

    #[test]
    fn local_limits_remain_supplementary_and_default_is_unscoped() {
        let work = OfflineDecodeBudget::new();
        let request = work.request();
        let local = request.clone();
        for _ in 0..MAX_NODES {
            local.raw(&[0xf6]).unwrap();
        }
        assert!(request.raw(&[0xf6]).is_err());
        assert!(work.request().raw(&[0xf6]).is_err());
        assert!(Budget::default().require_offline().is_err());
        assert!(
            Budget::from_usage(Usage::default())
                .unwrap()
                .require_offline()
                .is_err()
        );
        assert!(Budget::default().raw(&[0xf6]).is_ok());
    }

    #[test]
    fn owned_ceiling_overlap_and_drop_never_refund_work_or_poison() {
        let work = OfflineDecodeBudget::new();
        work.request().raw(&[0xf6]).unwrap();
        let a = work.ledger.reserve_owned(MAX_OWNED - 1).unwrap();
        let b = work.ledger.reserve_owned(1).unwrap();
        assert_eq!(work.ledger.counters.lock().unwrap().owned, MAX_OWNED);
        assert!(work.ledger.reserve_owned(1).is_err());
        drop(a);
        drop(b);
        let state = work.ledger.counters.lock().unwrap();
        assert_eq!(state.owned, 0);
        assert_eq!(state.peak_owned, MAX_OWNED);
        assert_eq!(state.work, 1);
        assert!(state.poisoned);
        drop(state);
        assert!(work.request().raw(&[0xf6]).is_err());
        assert!(work.ledger.reserve_owned(0).is_err());
    }

    #[test]
    fn owned_checked_overflow_move_and_forgotten_guards_are_exact_once() {
        let work = OfflineDecodeBudget::new();
        let allocation = work.ledger.reserve_owned(4).unwrap();
        let moved = Some(allocation);
        assert_eq!(work.ledger.counters.lock().unwrap().owned, 4);
        drop(moved);
        assert_eq!(work.ledger.counters.lock().unwrap().owned, 0);
        std::mem::forget(work.ledger.reserve_owned(8).unwrap());
        assert_eq!(work.ledger.counters.lock().unwrap().owned, 8);
        assert!(work.ledger.reserve_owned(u64::MAX).is_err());
        assert!(work.ledger.counters.lock().unwrap().poisoned);
        assert_eq!(work.ledger.counters.lock().unwrap().owned, 8);
    }

    #[test]
    fn owned_release_on_unwind_preserves_permanent_refusal() {
        let work = OfflineDecodeBudget::new();
        let result = std::panic::catch_unwind(|| {
            let _allocation = work.ledger.reserve_owned(16).unwrap();
            panic!("test-only reservation unwind");
        });
        assert!(result.is_err());
        assert_eq!(work.ledger.counters.lock().unwrap().owned, 0);
        assert!(work.ledger.counters.lock().unwrap().poisoned);
        assert!(work.request().raw(&[0xf6]).is_err());
    }

    #[test]
    fn overlapping_contenders_share_one_locked_ceiling() {
        let work = OfflineDecodeBudget::new();
        let barrier = Arc::new(std::sync::Barrier::new(3));
        std::thread::scope(|scope| {
            let mut threads = Vec::new();
            for _ in 0..2 {
                let ledger = work.ledger.clone();
                let barrier = barrier.clone();
                threads.push(scope.spawn(move || {
                    let allocation = ledger.reserve_owned(MAX_OWNED);
                    barrier.wait(); // both admissions happened; success remains live
                    let admitted = allocation.is_ok();
                    drop(allocation);
                    admitted
                }));
            }
            barrier.wait();
            assert_eq!(
                threads
                    .into_iter()
                    .filter_map(|thread| thread.join().ok())
                    .filter(|admitted| *admitted)
                    .count(),
                1
            );
        });
        assert_eq!(work.ledger.counters.lock().unwrap().peak_owned, MAX_OWNED);
        assert_eq!(work.ledger.counters.lock().unwrap().owned, 0);
        assert!(work.ledger.counters.lock().unwrap().poisoned);
    }

    #[test]
    fn nested_decode_is_charged_independently_before_materialization() {
        let work = OfflineDecodeBudget::new();
        let request = work.request();
        let value = request.raw(&[0x41, 0xf6]).unwrap();
        let mdbn_wire::cbor::Cbor::Bytes(inner) = value else {
            panic!("expected opaque bytes");
        };
        request.raw(&inner).unwrap();
        assert_eq!(work.ledger.counters.lock().unwrap().work, 3);
        assert_eq!(request.usage().nodes, 2);
    }
}
