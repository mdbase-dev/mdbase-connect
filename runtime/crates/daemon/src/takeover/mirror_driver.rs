//! Pre-open closed mirror orchestration. No admission/release or runtime caller.
//!
//! The driver owns the bare authoritative store BEFORE FileStore/Replica open.
//! It never exposes a mutable store, including on a commit failure. A failure
//! drops that handle: the host must reopen storage and load the durable fence.
//! Capture/refusal/status is bookkeeping only, not authenticated join proof.

use mdbn_replica::mirror_admission::{
    CaptureRefusal, Fence, Phase, Reason, candidate,
    install_budget::{Buffer, WorkingSet},
};
use mdbn_replica::store::{Store, StoreError};
use serde::Serialize;

/// Non-authorizing, content/path-free joining status for status/doctor/tray.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Diagnostic {
    /// Joining or terminal detached; no replica is serving.
    pub phase: &'static str,
    /// Items still pending authenticated classification/consumption.
    pub pending: u64,
    /// Complete durable holds; never permission to overwrite anything.
    pub held: u64,
    /// Stable reason, not an arbitrary I/O error string.
    pub reason: &'static str,
    /// Any failed store operation makes this instance unusable.
    pub requires_reopen: bool,
}
impl Diagnostic {
    /// Same bounded, content-free message for status/doctor/tray.
    pub fn message(&self) -> String {
        format!(
            "{} sync: {} items pending/held ({} pending, {} held; {})",
            self.phase,
            self.pending.saturating_add(self.held),
            self.pending,
            self.held,
            self.reason
        )
    }
    /// Surface size refusal even before a fence can be persisted.
    pub fn refused(refusal: CaptureRefusal, total: u64) -> Self {
        Self {
            phase: "joining",
            pending: total,
            held: 0,
            reason: refusal.code(),
            requires_reopen: false,
        }
    }
}

/// Start/resume cannot return the owned store through an error.
#[derive(Debug)]
pub enum Error {
    /// A valid mirror exceeds admission-time policy, or invalid capture identity.
    Capture(CaptureRefusal),
    /// A file-backed wrapper was already opened: too late to install the gate.
    AlreadyOpened,
    /// Resume requires an existing durable fence; never infer a fresh join.
    MissingFence,
    /// Different attempts cannot reuse the old replica/store instance.
    DifferentAttempt,
    /// Underlying error retained for diagnosis; handle has been dropped.
    RequiresReopen(StoreError),
    /// Isolated candidate refusal/failure; owned store was dropped. Neither this
    /// error nor durable candidate evidence settles the original write outcome.
    CandidateRequiresReopen(candidate::Error),
    /// This driver instance was terminally invalidated already.
    Terminal,
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Capture(r) => r.code(),
            Self::AlreadyOpened => "mirror_gate_must_precede_open",
            Self::MissingFence => "mirror_fence_missing",
            Self::DifferentAttempt => "mirror_capture_changed",
            Self::RequiresReopen(_) | Self::CandidateRequiresReopen(_) | Self::Terminal => {
                "mirror_requires_reopen"
            }
        })
    }
}
impl std::error::Error for Error {}

/// Closed pre-open state. Neither phase can expire, release or serve a replica.
pub struct Closed<S: Store> {
    store: Option<S>,
    fence: Fence,
}
impl<S: Store> Closed<S> {
    /// Begin after immutable capture but BEFORE opening a filesystem wrapper.
    /// The trusted caller must separately authenticate capture/current account.
    pub fn begin(mut store: S, capture: [u8; 16], total: u64) -> Result<Self, Error> {
        if store.has_files() {
            return Err(Error::AlreadyOpened);
        }
        let fence = Fence::new(capture, total).map_err(Error::Capture)?;
        if let Some(old) = Fence::load(&store).map_err(Error::RequiresReopen)? {
            if old.capture != capture || old.total != total {
                return Err(Error::DifferentAttempt);
            }
            return Ok(Self {
                store: Some(store),
                fence: old,
            });
        }
        fence.persist(&mut store).map_err(Error::RequiresReopen)?;
        Ok(Self {
            store: Some(store),
            fence,
        })
    }
    /// Reopen/load only. It does not retry an unknown transaction or flip phases.
    pub fn resume(store: S) -> Result<Self, Error> {
        if store.has_files() {
            return Err(Error::AlreadyOpened);
        }
        let fence = Fence::load(&store)
            .map_err(Error::RequiresReopen)?
            .ok_or(Error::MissingFence)?;
        Ok(Self {
            store: Some(store),
            fence,
        })
    }
    /// Every consumer receives the same non-authorizing counts and reason.
    pub fn diagnostic(&self) -> Diagnostic {
        Diagnostic {
            phase: if self.fence.phase == Phase::Joining {
                "joining"
            } else {
                "detached"
            },
            pending: self.fence.pending,
            held: self.fence.held,
            reason: if self.store.is_none() {
                Reason::UnknownOutcome.as_str()
            } else if self.fence.total > mdbn_replica::mirror_admission::MAX_CANDIDATES
                && self.fence.phase == Phase::Joining
            {
                "mirror_too_large"
            } else {
                self.fence.reason.as_str()
            },
            requires_reopen: self.store.is_none(),
        }
    }
    /// Explicit operator action only. A timeout/proof failure never invokes it.
    /// On failure, even known abort, discard the handle and require reopen.
    pub fn abandon(&mut self) -> Result<(), Error> {
        let mut store = self.store.take().ok_or(Error::Terminal)?;
        let next = self.fence.detached();
        match next.persist(&mut store) {
            Ok(()) => {
                self.fence = next;
                self.store = Some(store);
                Ok(())
            }
            Err(e) => Err(Error::RequiresReopen(e)),
        }
    }
    /// Bounded UNVERIFIED private storage only. Requests are immutable claims,
    /// not native context/capabilities. This route cannot swap, classify, release,
    /// acknowledge observations, or run a replica/normal staging dispatcher.
    pub fn candidate_begin(
        &mut self,
        request: &candidate::Request,
        working: &WorkingSet,
    ) -> Result<(), Error> {
        self.persist_candidate(request, |store| {
            store.mirror_candidate_begin(request, working)
        })
    }
    /// Reserve a disk slot before network/body allocation in the shared account.
    pub fn candidate_reserve(
        &mut self,
        request: &candidate::Request,
        ordinal: u64,
        bytes: u64,
        working: &WorkingSet,
    ) -> Result<(), Error> {
        self.persist_candidate(request, |store| {
            store.mirror_candidate_reserve(request, ordinal, bytes, working)
        })
    }
    /// Pull one resident part as charged DATA, with no installation permit.
    /// The store helper bills initialization before it constructs the Buffer;
    /// the supplied address is not authenticated object membership or custody.
    pub fn candidate_read(
        &mut self,
        request: &candidate::Request,
        ordinal: u64,
        expected_address: &mdbn_wire::common::Hash,
        working: &WorkingSet,
    ) -> Result<Buffer, Error> {
        self.persist_candidate(request, |store| {
            let output =
                store.mirror_candidate_read(request, ordinal, expected_address, working)?;
            // Accounting identity only; never initialization/authentication proof.
            if !working.owns_buffer(&output) {
                return Err(candidate::Error::Invalid);
            }
            Ok(output)
        })
    }
    /// Retain one charged body only; every error terminally drops this store,
    /// including known refusal. Reopen loads evidence, never a reusable authority.
    pub fn candidate_write(
        &mut self,
        request: &candidate::Request,
        ordinal: u64,
        body: Buffer,
        working: &WorkingSet,
    ) -> Result<(), Error> {
        self.persist_candidate(request, |store| {
            store.mirror_candidate_write(request, ordinal, body, working)
        })
    }
    fn persist_candidate<T>(
        &mut self,
        request: &candidate::Request,
        persist: impl FnOnce(&mut S) -> Result<T, candidate::Error>,
    ) -> Result<T, Error> {
        let mut store = self.store.take().ok_or(Error::Terminal)?;
        if request.fence != self.fence || self.fence.phase != Phase::Joining {
            return Err(Error::CandidateRequiresReopen(candidate::Error::Drift));
        }
        match persist(&mut store) {
            Ok(data) => {
                self.store = Some(store);
                Ok(data)
            }
            Err(e) => Err(Error::CandidateRequiresReopen(e)),
        }
    }
    // Deliberately no store_mut(), into_store(), release(), or rejoin() method.
}

#[cfg(test)]
#[path = "mirror_driver_native_tests.rs"]
mod native_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use mdbn_replica::mem::MemStore;
    #[test]
    fn start_is_closed_and_reopen_only_loads() {
        let s = MemStore::new();
        let data = s.data();
        let d = Closed::begin(s, [1; 16], 3).unwrap();
        assert_eq!(
            d.diagnostic().message(),
            "joining sync: 3 items pending/held (3 pending, 0 held; awaiting_proof)"
        );
        assert!(!d.diagnostic().requires_reopen);
        drop(d);
        let d = Closed::resume(MemStore::shared(data)).unwrap();
        assert_eq!(d.diagnostic().pending, 3);
    }
    #[test]
    fn size_policy_refusal_is_visible_before_storage_and_never_corruption() {
        let s = MemStore::new();
        let data = s.data();
        let total = mdbn_replica::mirror_admission::MAX_CANDIDATES + 1;
        let Err(Error::Capture(r @ CaptureRefusal::MirrorTooLarge { .. })) =
            Closed::begin(s, [1; 16], total)
        else {
            panic!("typed size refusal")
        };
        assert_eq!(Diagnostic::refused(r, total).reason, "mirror_too_large");
        assert!(Fence::load(&MemStore::shared(data)).unwrap().is_none());
    }
    #[test]
    fn unknown_or_aborted_begin_does_not_return_an_usable_driver() {
        for after in [false, true] {
            let s = MemStore::new();
            let data = s.data();
            if after {
                s.fail_after_commit(1)
            } else {
                s.fail_commits(1)
            }
            assert!(matches!(
                Closed::begin(s, [1; 16], 3),
                Err(Error::RequiresReopen(_))
            ));
            let loaded = Closed::resume(MemStore::shared(data));
            if after {
                assert_eq!(loaded.unwrap().diagnostic().phase, "joining")
            } else {
                assert!(matches!(loaded, Err(Error::MissingFence)))
            }
        }
    }
    #[test]
    fn detach_failures_invalidate_handle_even_when_state_may_be_durable() {
        for after in [false, true] {
            let s = MemStore::new();
            let data = s.data();
            let mut d = Closed::begin(s, [1; 16], 3).unwrap();
            let injected = MemStore::shared(data.clone());
            if after {
                injected.fail_after_commit(1)
            } else {
                injected.fail_commits(1)
            }
            assert!(matches!(d.abandon(), Err(Error::RequiresReopen(_))));
            assert!(d.diagnostic().requires_reopen);
            assert_eq!(d.diagnostic().reason, "requires_reopen");
            assert!(matches!(d.abandon(), Err(Error::Terminal)));
            let loaded = Closed::resume(MemStore::shared(data)).unwrap();
            assert_eq!(
                loaded.diagnostic().phase,
                if after { "detached" } else { "joining" }
            );
        }
    }
    #[test]
    fn explicit_detach_restarts_terminal_and_cannot_rejoin_under_new_id() {
        let s = MemStore::new();
        let data = s.data();
        let mut d = Closed::begin(s, [1; 16], 3).unwrap();
        d.abandon().unwrap();
        drop(d);
        let d = Closed::resume(MemStore::shared(data.clone())).unwrap();
        assert_eq!(d.diagnostic().phase, "detached");
        let d = Closed::begin(MemStore::shared(data.clone()), [1; 16], 3).unwrap();
        assert_eq!(d.diagnostic().phase, "detached");
        assert!(matches!(
            Closed::begin(MemStore::shared(data), [2; 16], 3),
            Err(Error::DifferentAttempt)
        ));
    }
    #[test]
    fn unsupported_candidate_backend_is_terminal_without_normal_commit_fallback() {
        let store = MemStore::new();
        let data = store.data();
        let mut d = Closed::begin(store, [1; 16], 3).unwrap();
        let request = candidate::Request {
            candidate: [2; 16],
            fence: Fence::new([1; 16], 3).unwrap(),
            identity: candidate::Identity {
                collection: [3; 16],
                replica: [4; 16],
                incarnation: 1,
                generation: 0,
            },
            old_head: mdbn_replica::store::Head::GENESIS,
            target: candidate::Target {
                cutover_seq: 1,
                barrier_f: 1,
                s_final: 7,
                manifest: [5; 32],
                state_digest: [6; 32],
                chain: [7; 32],
                epoch: 1,
            },
        };
        let working = WorkingSet::default();
        assert!(matches!(
            d.candidate_begin(&request, &working),
            Err(Error::CandidateRequiresReopen(
                candidate::Error::Unsupported
            ))
        ));
        assert!(d.diagnostic().requires_reopen);
        assert!(matches!(
            d.candidate_begin(&request, &working),
            Err(Error::Terminal)
        ));
        assert!(matches!(d.abandon(), Err(Error::Terminal)));
        assert_eq!(
            Closed::resume(MemStore::shared(data))
                .unwrap()
                .diagnostic()
                .phase,
            "joining"
        );
    }
    #[test]
    fn unsupported_resident_reader_is_terminal_without_an_uncharged_fallback() {
        let store = MemStore::new();
        let data = store.data();
        let mut closed = Closed::begin(store, [1; 16], 3).unwrap();
        let request = candidate::Request {
            candidate: [2; 16],
            fence: Fence::new([1; 16], 3).unwrap(),
            identity: candidate::Identity {
                collection: [3; 16],
                replica: [4; 16],
                incarnation: 1,
                generation: 0,
            },
            old_head: mdbn_replica::store::Head::GENESIS,
            target: candidate::Target {
                cutover_seq: 1,
                barrier_f: 1,
                s_final: 7,
                manifest: [5; 32],
                state_digest: [6; 32],
                chain: [7; 32],
                epoch: 1,
            },
        };
        let working = WorkingSet::default();
        let address = mdbn_wire::hash::sha256(b"body");
        assert!(matches!(
            closed.candidate_read(&request, 0, &address, &working),
            Err(Error::CandidateRequiresReopen(
                candidate::Error::Unsupported
            ))
        ));
        assert_eq!(working.used().unwrap(), 0);
        assert!(closed.diagnostic().requires_reopen);
        assert!(matches!(
            closed.candidate_read(&request, 0, &address, &working),
            Err(Error::Terminal)
        ));
        assert!(matches!(closed.abandon(), Err(Error::Terminal)));
        assert_eq!(
            Closed::resume(MemStore::shared(data))
                .unwrap()
                .diagnostic()
                .phase,
            "joining"
        );
    }
    #[test]
    fn missing_fence_is_not_permission_to_bootstrap_a_replica() {
        assert!(matches!(
            Closed::resume(MemStore::new()),
            Err(Error::MissingFence)
        ));
    }
}
