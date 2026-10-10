//! Shared logical memory and work accounting for installation attempts.
//!
//! Buffer allocates only after working admission. Callers MUST reserve before allocation and
//! retain the working charge for the lifetime of the charged object(s). All
//! verifier components share one account; cloning does not reset its live use.
//! Persistent candidate reservation must re-read aggregate usage under Store CAS.
//! These primitives neither authenticate usage nor permit any Store/FS effect.

use std::sync::{Arc, Mutex};

/// Approved verifier working set, not a whole-process memory certification.
pub const MAX_WORKING_BYTES: u64 = 64 * 1024 * 1024;
/// All retained candidates, including aborted, old and unknown-outcome ones.
pub const MAX_RETAINED_CANDIDATES: u64 = 100_000;
/// Aggregate staged candidate disk bytes per collection, including old evidence.
pub const MAX_STAGED_BYTES: u64 = 4 * 1024 * 1024 * 1024;
/// Incoming ref-index buffer CAPACITY, admitted before decoding; not body length.
pub const MAX_REF_INDEX_CAPACITY: usize = 1024 * 1024;
/// Cumulative pass-byte work per attempt (16 times the staged-disk ceiling).
pub const MAX_PASS_BYTES: u64 = 16 * MAX_STAGED_BYTES;
/// Cumulative decoded CBOR nodes, including repeated decoding.
pub const MAX_DECODED_NODES: u64 = 1 << 29;
/// Combined signature/policy verification calls per attempt.
pub const MAX_VERIFICATIONS: u64 = 1_000_000;
/// Total C..F/control proof entries visited per attempt, including repetition.
pub const MAX_PROOF_ENTRIES: u64 = 1_000_000;
/// Minimum candidate pass-byte charge, even for empty/tiny candidates.
pub const MIN_CANDIDATE_PASS_BYTES: u64 = 1024;

/// Content/path/ID-free typed refusal, not corrupt persisted-state classification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    /// New verifier working memory would exceed its bound.
    WorkingSet,
    /// All retained candidates would exceed the approved count bound.
    CandidateCount,
    /// Per-collection staged candidate bytes would exceed the aggregate bound.
    StagedBytes,
    /// Incoming ref-index capacity exceeds its separate pre-decoder admission.
    RefIndexCapacity,
    /// Accounting addition/conversion overflowed; do not allocate or repair.
    AccountingOverflow,
    /// Shared accounting unavailable; fail closed, never reset to zero.
    AccountingUnavailable,
    /// Allocator could not honor an already admitted bounded reservation.
    Allocation,
    /// Cumulative repeated-pass bytes exceed the attempt ceiling.
    PassBytes,
    /// Cumulative decoded CBOR nodes exceed the attempt ceiling.
    DecodedNodes,
    /// Combined signature/policy verifications exceed the attempt ceiling.
    Verifications,
    /// Cumulative C..F/control proof entries exceed the attempt ceiling.
    ProofEntries,
    /// A prior work refusal permanently invalidated this attempt's ledger.
    WorkExhausted,
}
impl Error {
    /// Stable diagnostic code; no evidence cleanup or permission implied.
    pub fn code(self) -> &'static str {
        match self {
            Self::WorkingSet => "mirror_verifier_memory_limit",
            Self::CandidateCount => "mirror_retained_candidate_limit",
            Self::StagedBytes => "mirror_staged_bytes_limit",
            Self::RefIndexCapacity => "mirror_ref_index_capacity_limit",
            Self::AccountingOverflow => "mirror_budget_overflow",
            Self::AccountingUnavailable => "mirror_budget_unavailable",
            Self::Allocation => "mirror_verifier_allocation_failed",
            Self::PassBytes => "mirror_pass_bytes_limit",
            Self::DecodedNodes => "mirror_decoded_nodes_limit",
            Self::Verifications => "mirror_verification_limit",
            Self::ProofEntries => "mirror_proof_entries_limit",
            Self::WorkExhausted => "mirror_work_exhausted",
        }
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for Error {}

/// Store-derived aggregate projection. Never itself proof or reservation authority.
/// No subtraction/cleanup API: over-limit historical evidence remains retained.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Retained {
    /// Includes old, interrupted and unknown candidates, not merely this attempt.
    pub candidates: u64,
    /// Includes all their staged bytes in this collection.
    pub staged_bytes: u64,
}
impl Retained {
    /// Prospective accounting, before row/body allocation and again inside CAS.
    /// Does not mutate usage or persist any reservation on success or failure.
    pub fn adding(self, candidates: u64, staged_bytes: u64) -> Result<Self, Error> {
        let next = Self {
            candidates: self
                .candidates
                .checked_add(candidates)
                .ok_or(Error::AccountingOverflow)?,
            staged_bytes: self
                .staged_bytes
                .checked_add(staged_bytes)
                .ok_or(Error::AccountingOverflow)?,
        };
        if next.candidates > MAX_RETAINED_CANDIDATES {
            return Err(Error::CandidateCount);
        }
        if next.staged_bytes > MAX_STAGED_BYTES {
            return Err(Error::StagedBytes);
        }
        Ok(next)
    }
}

/// Admit capacity before a ref-index decoder; a short slice in a huge buffer
/// cannot bypass this test. Does not replace count/ref-index/member checks.
pub fn admit_ref_index_capacity(capacity: usize) -> Result<(), Error> {
    if capacity > MAX_REF_INDEX_CAPACITY {
        Err(Error::RefIndexCapacity)
    } else {
        Ok(())
    }
}

/// Worst prospective work or a diagnostic snapshot; DATA, not proof that any
/// helper precharged its complete work. Consumers must derive conservative costs
/// from bounded input/plain capacities BEFORE scanning, decoding or verifying.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Work {
    /// Every repeated scan/hash/copy/inflate pass, including AAD per AEAD segment.
    pub pass_bytes: u64,
    /// Decoded CBOR nodes, counted again for every decoder pass.
    pub decoded_nodes: u64,
    /// Combined signature and policy verification calls.
    pub verifications: u64,
    /// C..F/control proof entries, counted again for repeated visits.
    pub proof_entries: u64,
}
impl Work {
    fn adding(self, request: Self) -> Result<Self, Error> {
        let next = Self {
            pass_bytes: self
                .pass_bytes
                .checked_add(request.pass_bytes)
                .ok_or(Error::AccountingOverflow)?,
            decoded_nodes: self
                .decoded_nodes
                .checked_add(request.decoded_nodes)
                .ok_or(Error::AccountingOverflow)?,
            verifications: self
                .verifications
                .checked_add(request.verifications)
                .ok_or(Error::AccountingOverflow)?,
            proof_entries: self
                .proof_entries
                .checked_add(request.proof_entries)
                .ok_or(Error::AccountingOverflow)?,
        };
        if next.pass_bytes > MAX_PASS_BYTES {
            return Err(Error::PassBytes);
        }
        if next.decoded_nodes > MAX_DECODED_NODES {
            return Err(Error::DecodedNodes);
        }
        if next.verifications > MAX_VERIFICATIONS {
            return Err(Error::Verifications);
        }
        if next.proof_entries > MAX_PROOF_ENTRIES {
            return Err(Error::ProofEntries);
        }
        Ok(next)
    }
}
#[derive(Debug, Default)]
struct Usage {
    working_bytes: u64,
    work: Work,
    work_refused: bool,
}

/// One live verifier account shared across all components and retained charges.
/// There is no caller-configurable larger limit; future configuration needs scope.
#[derive(Debug, Default, Clone)]
pub struct WorkingSet {
    used: Arc<Mutex<Usage>>,
}
/// A non-cloneable charge. Bind it to the charged body/tree/source lifetime;
/// dropping it prematurely while keeping allocations would violate the contract.
#[derive(Debug)]
pub struct Charge {
    used: Arc<Mutex<Usage>>,
    bytes: u64,
}
impl WorkingSet {
    /// Fail BEFORE calling an allocator, decoder, buffer grow or tree insertion.
    /// A failed request does not change the existing account.
    pub fn reserve(&self, bytes: u64) -> Result<Charge, Error> {
        let mut used = self.used.lock().map_err(|_| Error::AccountingUnavailable)?;
        if used.work_refused {
            return Err(Error::WorkExhausted);
        }
        let next = used
            .working_bytes
            .checked_add(bytes)
            .ok_or(Error::AccountingOverflow)?;
        if next > MAX_WORKING_BYTES {
            return Err(Error::WorkingSet);
        }
        used.working_bytes = next;
        Ok(Charge {
            used: self.used.clone(),
            bytes,
        })
    }
    /// Current charged live working bytes, never a new allocation capability.
    pub fn used(&self) -> Result<u64, Error> {
        self.used
            .lock()
            .map(|n| n.working_bytes)
            .map_err(|_| Error::AccountingUnavailable)
    }
    /// Precharge ALL worst-case work before execution. Clones share these exact
    /// cumulative counters; no work is refunded when memory leases are dropped.
    /// Overflow/exhaustion preserves counters and permanently refuses subsequent
    /// work AND memory requests, even zero-sized ones. No reset/override exists.
    pub fn precharge(&self, request: Work) -> Result<(), Error> {
        let mut used = self.used.lock().map_err(|_| Error::AccountingUnavailable)?;
        if used.work_refused {
            return Err(Error::WorkExhausted);
        }
        match used.work.adding(request) {
            Ok(next) => {
                used.work = next;
                Ok(())
            }
            Err(error) => {
                used.work_refused = true;
                Err(error)
            }
        }
    }
    /// Charge one candidate's prospective work, with a mandatory 1 KiB pass-byte
    /// floor BEFORE its first work. Repeated candidate attempts cost again.
    pub fn precharge_candidate(&self, mut request: Work) -> Result<(), Error> {
        request.pass_bytes = request.pass_bytes.max(MIN_CANDIDATE_PASS_BYTES);
        self.precharge(request)
    }
    /// Precharge an inclusive C..F/control span BEFORE visiting any entry.
    /// Scalar positions are DATA; this checks resource bounds, not the chain.
    pub fn precharge_proof_span(&self, first: u64, through: u64) -> Result<(), Error> {
        let Some(entries) = through.checked_sub(first).and_then(|n| n.checked_add(1)) else {
            let mut used = self.used.lock().map_err(|_| Error::AccountingUnavailable)?;
            if used.work_refused {
                return Err(Error::WorkExhausted);
            }
            used.work_refused = true;
            return Err(if through < first {
                Error::ProofEntries
            } else {
                Error::AccountingOverflow
            });
        };
        self.precharge(Work {
            proof_entries: entries,
            ..Work::default()
        })
    }
    /// Cumulative diagnostic DATA, including after exhaustion; not a new permit.
    pub fn work_used(&self) -> Result<Work, Error> {
        self.used
            .lock()
            .map(|used| used.work)
            .map_err(|_| Error::AccountingUnavailable)
    }
}
/// One exact-size charged body; no grow, clone or uncharged extraction API.
/// Borrows cannot escape the allocation's charge lifetime.
///
/// ```compile_fail,E0597
/// use mdbn_replica::mirror_install_budget::WorkingSet;
/// let bytes;
/// {
///     let body = WorkingSet::default().buffer(37).unwrap();
///     bytes = body.as_slice();
/// }
/// assert_eq!(bytes.len(), 37);
/// ```
pub struct Buffer {
    // Drop fields in this order: allocation first, then its accounting lease.
    body: Vec<u8>,
    charge: Charge,
}
impl std::fmt::Debug for Buffer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Buffer")
            .field("capacity", &self.body.capacity())
            .finish_non_exhaustive()
    }
}
impl WorkingSet {
    /// Admit BEFORE allocating body bytes. Caller first reserves its disk slot.
    pub fn buffer(&self, bytes: usize) -> Result<Buffer, Error> {
        let charge = self.reserve(u64::try_from(bytes).map_err(|_| Error::AccountingOverflow)?)?;
        let mut body = Vec::new();
        body.try_reserve_exact(bytes)
            .map_err(|_| Error::Allocation)?;
        // Never return a buffer with logical capacity exceeding its charge.
        // Allocator/page overhead is not certified by this byte account.
        if body.capacity() != bytes {
            return Err(Error::Allocation);
        }
        body.resize(bytes, 0);
        Ok(Buffer { body, charge })
    }
    /// Pool identity is accounting only, NEVER install or native authority.
    pub fn owns_buffer(&self, buffer: &Buffer) -> bool {
        Arc::ptr_eq(&self.used, &buffer.charge.used)
    }
}
impl Buffer {
    /// Fixed bounded body, mutable without allowing capacity growth.
    pub fn as_mut_slice(&mut self) -> &mut [u8] {
        &mut self.body
    }
    /// Borrow retained bytes without copying.
    pub fn as_slice(&self) -> &[u8] {
        &self.body
    }
    /// Actual capacity charged for the body.
    pub fn capacity(&self) -> usize {
        self.body.capacity()
    }
}

impl Drop for Charge {
    fn drop(&mut self) {
        // Poison never permits a new reservation, but destruction must not panic
        // or reset other retained charges. The only mutation is our own charge.
        let mut used = self.used.lock().unwrap_or_else(|e| e.into_inner());
        used.working_bytes -= self.bytes;
        // Work and irreversible work refusal are never refunded by memory Drop.
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn work_clones_share_cumulative_costs_and_memory_drop_never_refunds_work() {
        let budget = WorkingSet::default();
        let shared = budget.clone();
        let memory = budget.reserve(17).unwrap();
        let first = Work {
            pass_bytes: 31,
            decoded_nodes: 7,
            verifications: 2,
            proof_entries: 3,
        };
        budget.precharge(first).unwrap();
        shared.precharge(first).unwrap();
        assert_eq!(
            budget.work_used().unwrap(),
            Work {
                pass_bytes: 62,
                decoded_nodes: 14,
                verifications: 4,
                proof_entries: 6
            }
        );
        drop(memory);
        assert_eq!(budget.used().unwrap(), 0);
        assert_eq!(shared.work_used().unwrap().pass_bytes, 62);
        let fresh = WorkingSet::default();
        assert_eq!(fresh.work_used().unwrap(), Work::default());
        assert_eq!(budget.work_used().unwrap().pass_bytes, 62);
    }
    #[test]
    fn every_work_ceiling_is_inclusive_then_atomic_irreversible_refusal() {
        let exact = Work {
            pass_bytes: MAX_PASS_BYTES,
            decoded_nodes: MAX_DECODED_NODES,
            verifications: MAX_VERIFICATIONS,
            proof_entries: MAX_PROOF_ENTRIES,
        };
        for (request, expected) in [
            (
                Work {
                    pass_bytes: 1,
                    ..Work::default()
                },
                Error::PassBytes,
            ),
            (
                Work {
                    decoded_nodes: 1,
                    ..Work::default()
                },
                Error::DecodedNodes,
            ),
            (
                Work {
                    verifications: 1,
                    ..Work::default()
                },
                Error::Verifications,
            ),
            (
                Work {
                    proof_entries: 1,
                    ..Work::default()
                },
                Error::ProofEntries,
            ),
        ] {
            let budget = WorkingSet::default();
            let memory = budget.reserve(17).unwrap();
            budget.precharge(exact).unwrap();
            assert_eq!(budget.clone().precharge(request), Err(expected));
            assert_eq!(budget.work_used().unwrap(), exact);
            assert_eq!(budget.used().unwrap(), 17);
            assert_eq!(budget.precharge(Work::default()), Err(Error::WorkExhausted));
            assert_eq!(budget.reserve(0).unwrap_err(), Error::WorkExhausted);
            drop(memory);
            assert_eq!(budget.used().unwrap(), 0);
            assert_eq!(budget.work_used().unwrap(), exact);
            assert_eq!(
                budget.clone().precharge(Work::default()),
                Err(Error::WorkExhausted)
            );
        }
    }
    #[test]
    fn work_overflow_never_partially_charges_or_resets_an_attempt() {
        let first = Work {
            pass_bytes: 1,
            decoded_nodes: 1,
            verifications: 1,
            proof_entries: 1,
        };
        for request in [
            Work {
                pass_bytes: u64::MAX,
                ..Work::default()
            },
            Work {
                pass_bytes: 1,
                decoded_nodes: u64::MAX,
                ..Work::default()
            },
            Work {
                pass_bytes: 1,
                verifications: u64::MAX,
                ..Work::default()
            },
            Work {
                pass_bytes: 1,
                proof_entries: u64::MAX,
                ..Work::default()
            },
        ] {
            let budget = WorkingSet::default();
            budget.precharge(first).unwrap();
            assert_eq!(budget.precharge(request), Err(Error::AccountingOverflow));
            assert_eq!(budget.work_used().unwrap(), first);
            assert_eq!(budget.precharge(first), Err(Error::WorkExhausted));
        }
    }
    #[test]
    fn proof_span_is_inclusive_bounded_and_refuses_overflow_or_reversal_before_iteration() {
        let budget = WorkingSet::default();
        budget
            .precharge_proof_span(7, 7 + MAX_PROOF_ENTRIES - 1)
            .unwrap();
        assert_eq!(budget.work_used().unwrap().proof_entries, MAX_PROOF_ENTRIES);
        assert_eq!(budget.precharge_proof_span(1, 1), Err(Error::ProofEntries));
        assert_eq!(budget.work_used().unwrap().proof_entries, MAX_PROOF_ENTRIES);
        for (first, through, expected) in [
            (9, 8, Error::ProofEntries),
            (0, u64::MAX, Error::AccountingOverflow),
        ] {
            let budget = WorkingSet::default();
            budget
                .precharge(Work {
                    pass_bytes: 1,
                    ..Work::default()
                })
                .unwrap();
            assert_eq!(budget.precharge_proof_span(first, through), Err(expected));
            assert_eq!(
                budget.work_used().unwrap(),
                Work {
                    pass_bytes: 1,
                    ..Work::default()
                }
            );
            assert_eq!(budget.precharge(Work::default()), Err(Error::WorkExhausted));
        }
    }
    #[test]
    fn tiny_candidates_pay_a_floor_each_time_without_refunds() {
        let budget = WorkingSet::default();
        budget.precharge_candidate(Work::default()).unwrap();
        budget
            .clone()
            .precharge_candidate(Work {
                pass_bytes: 1,
                ..Work::default()
            })
            .unwrap();
        budget
            .precharge_candidate(Work {
                pass_bytes: MIN_CANDIDATE_PASS_BYTES + 1,
                ..Work::default()
            })
            .unwrap();
        assert_eq!(
            budget.work_used().unwrap().pass_bytes,
            3 * MIN_CANDIDATE_PASS_BYTES + 1
        );
    }
    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn exhausted_work_refuses_before_execution_or_buffer_allocation() {
        let budget = WorkingSet::default();
        budget
            .precharge(Work {
                pass_bytes: MAX_PASS_BYTES,
                ..Work::default()
            })
            .unwrap();
        let mut executed = false;
        let measured = allocation_counter::measure(|| {
            if budget.precharge_candidate(Work::default()).is_ok() {
                executed = true;
            }
            assert_eq!(budget.buffer(1).unwrap_err(), Error::WorkExhausted);
        });
        assert!(!executed);
        assert_eq!(measured.count_total, 0);
        assert_eq!(budget.work_used().unwrap().pass_bytes, MAX_PASS_BYTES);
    }
    #[test]
    fn buffer_retains_exact_charge_until_allocation_is_dropped() {
        let budget = WorkingSet::default();
        let mut body = budget.buffer(37).unwrap();
        body.as_mut_slice().fill(9);
        assert_eq!(body.capacity(), 37);
        assert_eq!(budget.used().unwrap(), 37);
        assert!(budget.clone().owns_buffer(&body));
        assert!(!WorkingSet::default().owns_buffer(&body));
        assert_eq!(body.as_slice(), &[9; 37]);
        assert_eq!(format!("{body:?}"), "Buffer { capacity: 37, .. }");
        drop(body);
        assert_eq!(budget.used().unwrap(), 0);
        let charge = budget.reserve(MAX_WORKING_BYTES).unwrap();
        assert_eq!(budget.buffer(1).unwrap_err(), Error::WorkingSet);
        assert_eq!(budget.used().unwrap(), MAX_WORKING_BYTES);
        drop(charge);
        assert_eq!(budget.used().unwrap(), 0);
    }
    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn refused_buffer_never_calls_allocator_and_does_not_reset_shared_use() {
        let budget = WorkingSet::default();
        let live = budget.reserve(MAX_WORKING_BYTES).unwrap();
        let shared = budget.clone();
        let mut outcome = None;
        let measured = allocation_counter::measure(|| {
            outcome = Some(shared.buffer(1).unwrap_err());
        });
        assert_eq!(outcome, Some(Error::WorkingSet));
        assert_eq!(measured.count_total, 0);
        assert_eq!(budget.used().unwrap(), MAX_WORKING_BYTES);
        drop(live);
        assert_eq!(shared.used().unwrap(), 0);
    }
    #[test]
    fn shared_working_budget_refuses_before_allocation_and_releases_exact_charges() {
        let budget = WorkingSet::default();
        let shared = budget.clone();
        let first = budget.reserve(MAX_WORKING_BYTES - 1).unwrap();
        let before = budget.used().unwrap();
        assert_eq!(shared.reserve(2).unwrap_err(), Error::WorkingSet);
        assert_eq!(budget.used().unwrap(), before);
        let last = shared.reserve(1).unwrap();
        assert_eq!(budget.used().unwrap(), MAX_WORKING_BYTES);
        assert_eq!(budget.reserve(1).unwrap_err(), Error::WorkingSet);
        drop(first);
        assert_eq!(shared.used().unwrap(), 1);
        drop(last);
        assert_eq!(budget.used().unwrap(), 0);
    }
    #[test]
    fn memory_overflow_never_resets_live_account_or_allocates() {
        let budget = WorkingSet::default();
        let retained = budget.reserve(1).unwrap();
        assert_eq!(
            budget.reserve(u64::MAX).unwrap_err(),
            Error::AccountingOverflow
        );
        assert_eq!(budget.used().unwrap(), 1);
        drop(retained);
    }
    #[test]
    fn retained_old_unknown_candidates_are_not_repaired_to_fit() {
        for historical in [
            Retained {
                candidates: MAX_RETAINED_CANDIDATES,
                staged_bytes: 0,
            },
            Retained {
                candidates: MAX_RETAINED_CANDIDATES + 1,
                staged_bytes: 0,
            },
        ] {
            let original = historical;
            assert_eq!(historical.adding(1, 0), Err(Error::CandidateCount));
            assert_eq!(historical, original);
        }
        let historical = Retained {
            candidates: 7,
            staged_bytes: MAX_STAGED_BYTES,
        };
        assert_eq!(historical.adding(0, 1), Err(Error::StagedBytes));
        assert_eq!(historical.staged_bytes, MAX_STAGED_BYTES);
        assert_eq!(historical.adding(0, 0).unwrap(), historical);
        assert_eq!(
            Retained {
                candidates: 0,
                staged_bytes: MAX_STAGED_BYTES + 1
            }
            .adding(0, 0),
            Err(Error::StagedBytes)
        );
    }
    #[test]
    fn exact_retained_bounds_are_allowed_and_overflow_refuses() {
        assert_eq!(
            Retained::default()
                .adding(MAX_RETAINED_CANDIDATES, MAX_STAGED_BYTES)
                .unwrap(),
            Retained {
                candidates: MAX_RETAINED_CANDIDATES,
                staged_bytes: MAX_STAGED_BYTES
            }
        );
        assert_eq!(
            Retained {
                candidates: u64::MAX,
                staged_bytes: 0
            }
            .adding(1, 0),
            Err(Error::AccountingOverflow)
        );
        assert_eq!(
            Retained {
                candidates: 0,
                staged_bytes: u64::MAX
            }
            .adding(0, 1),
            Err(Error::AccountingOverflow)
        );
    }
    #[test]
    fn ref_index_capacity_not_short_body_len_is_the_admission_boundary() {
        assert!(admit_ref_index_capacity(MAX_REF_INDEX_CAPACITY).is_ok());
        assert_eq!(
            admit_ref_index_capacity(MAX_REF_INDEX_CAPACITY + 1),
            Err(Error::RefIndexCapacity)
        );
        let body = Vec::<u8>::with_capacity(MAX_REF_INDEX_CAPACITY + 1);
        assert_eq!(body.len(), 0);
        assert_eq!(
            admit_ref_index_capacity(body.capacity()),
            Err(Error::RefIndexCapacity)
        );
    }
    #[test]
    fn unavailable_working_account_is_not_reinitialized() {
        let budget = WorkingSet::default();
        let poison = budget.clone();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _held = poison.used.lock().unwrap();
            panic!("fixture");
        }));
        assert!(result.is_err());
        assert_eq!(budget.reserve(1).unwrap_err(), Error::AccountingUnavailable);
        assert_eq!(budget.used(), Err(Error::AccountingUnavailable));
        assert_eq!(
            budget.precharge(Work::default()),
            Err(Error::AccountingUnavailable)
        );
        assert_eq!(budget.work_used(), Err(Error::AccountingUnavailable));
    }
}
