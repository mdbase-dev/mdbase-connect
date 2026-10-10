//! Durable, closed mirror admission. No proof consumption or release API yet.
//!
//! Proposed replica/store guards reject effects when this metadata exists.
//! No daemon caller begins a join; current proof and guarded effects remain separate.
//! OS folder access remains outside this fence; observations must be retained.

/// The shared public attempt ledger; no duplicate pool or accounting types.
pub use crate::mirror_install_budget as install_budget;

/// Unverified private staging evidence, never a swap or release capability.
#[path = "replica/mirror_candidate.rs"]
pub mod candidate;

use crate::store::{Store, StoreError, Tx};
use mdbn_wire::cbor::{self, Cbor};

/// Versioned admission state; missing is ordinary non-migration operation.
pub const META: &str = "mirror_join_admission_v1";

/// Capture-time size policy, separate from validity of persisted metadata.
pub const MAX_CANDIDATES: u64 = install_budget::MAX_RETAINED_CANDIDATES;

/// Typed admission refusal. A valid large mirror is not corrupt storage.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureRefusal {
    /// The caller must keep the collection closed and surface this diagnostic.
    MirrorTooLarge {
        /// Complete candidate count, before allocating capture content.
        total: u64,
    },
    /// The supplied capture identity is invalid.
    InvalidCapture,
}
impl CaptureRefusal {
    /// Stable status/doctor/tray diagnostic, never permission or proof.
    pub fn code(self) -> &'static str {
        match self {
            Self::MirrorTooLarge { .. } => "mirror_too_large",
            Self::InvalidCapture => "invalid_capture",
        }
    }
}
impl std::fmt::Display for CaptureRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for CaptureRefusal {}

/// Stable diagnostic reason, never arbitrary user content.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    /// Authenticated complete migration proof has not arrived.
    AwaitingProof,
    /// Proof cannot currently validate.
    InvalidProof,
    /// A transaction outcome needs storage reopen.
    UnknownOutcome,
    /// User explicitly abandoned this join.
    UserDetached,
}
impl Reason {
    fn tag(self) -> u64 {
        match self {
            Self::AwaitingProof => 0,
            Self::InvalidProof => 1,
            Self::UnknownOutcome => 2,
            Self::UserDetached => 3,
        }
    }
    fn from_tag(tag: u64) -> Result<Self, StoreError> {
        match tag {
            0 => Ok(Self::AwaitingProof),
            1 => Ok(Self::InvalidProof),
            2 => Ok(Self::UnknownOutcome),
            3 => Ok(Self::UserDetached),
            _ => Err(corrupt()),
        }
    }
    /// Public status/doctor/tray reason.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AwaitingProof => "awaiting_proof",
            Self::InvalidProof => "invalid_proof",
            Self::UnknownOutcome => "requires_reopen",
            Self::UserDetached => "explicitly_detached",
        }
    }
}

/// The replica is closed in BOTH states. Neither expires automatically.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    /// Waiting for every candidate to be durably admitted or held.
    Joining,
    /// Terminal for this replica instance. Fresh explicit rejoin uses a NEW
    /// capture ID in NEW replica state and holds every difference; no phase flip.
    Detached,
}

/// Closed-admission bookkeeping, not authenticated proof or permission.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fence {
    /// Immutable identifier of this capture/join attempt.
    pub capture: [u8; 16],
    /// Joining or explicitly detached.
    pub phase: Phase,
    /// Complete captured candidate count.
    pub total: u64,
    /// Items still awaiting valid proof/consumption.
    pub pending: u64,
    /// Items durably retained as conflicts.
    pub held: u64,
    /// Stable diagnostic explanation.
    pub reason: Reason,
}
impl Fence {
    /// Prepare a new closed gate. It must be persisted before first disk effects.
    pub fn new(capture: [u8; 16], total: u64) -> Result<Self, CaptureRefusal> {
        if total > MAX_CANDIDATES {
            return Err(CaptureRefusal::MirrorTooLarge { total });
        }
        let f = Self {
            capture,
            phase: Phase::Joining,
            total,
            pending: total,
            held: 0,
            reason: Reason::AwaitingProof,
        };
        f.validate().map_err(|_| CaptureRefusal::InvalidCapture)?;
        Ok(f)
    }
    fn validate(&self) -> Result<(), StoreError> {
        if self.capture == [0; 16]
            || self
                .pending
                .checked_add(self.held)
                .is_none_or(|n| n > self.total)
            || (self.phase == Phase::Detached && self.reason != Reason::UserDetached)
            || (self.phase == Phase::Joining && self.reason == Reason::UserDetached)
        {
            return Err(corrupt());
        }
        Ok(())
    }
    /// Strict versioned CBOR. Unknown/corrupt metadata must fail closed.
    pub fn encode(&self) -> Result<Vec<u8>, StoreError> {
        self.validate()?;
        cbor::encode(&Cbor::Array(vec![
            Cbor::Uint(1),
            Cbor::Uint(if self.phase == Phase::Joining { 0 } else { 1 }),
            Cbor::Bytes(self.capture.to_vec()),
            Cbor::Uint(self.total),
            Cbor::Uint(self.pending),
            Cbor::Uint(self.held),
            Cbor::Uint(self.reason.tag()),
        ]))
        .map_err(|_| corrupt())
    }
    /// Decode only the current complete shape.
    pub fn decode(bytes: &[u8]) -> Result<Self, StoreError> {
        let Cbor::Array(a) = cbor::decode(bytes).map_err(|_| corrupt())? else {
            return Err(corrupt());
        };
        let [
            Cbor::Uint(1),
            Cbor::Uint(phase),
            Cbor::Bytes(capture),
            Cbor::Uint(total),
            Cbor::Uint(pending),
            Cbor::Uint(held),
            Cbor::Uint(reason),
        ] = a.as_slice()
        else {
            return Err(corrupt());
        };
        let f = Self {
            capture: capture.as_slice().try_into().map_err(|_| corrupt())?,
            phase: match phase {
                0 => Phase::Joining,
                1 => Phase::Detached,
                _ => return Err(corrupt()),
            },
            total: *total,
            pending: *pending,
            held: *held,
            reason: Reason::from_tag(*reason)?,
        };
        f.validate()?;
        Ok(f)
    }
    /// Missing metadata is ordinary operation; invalid metadata is NOT missing.
    pub fn load(store: &impl Store) -> Result<Option<Self>, StoreError> {
        store.meta(META)?.as_deref().map(Self::decode).transpose()
    }
    /// Diagnostic status for all consumers while admission is closed.
    pub fn status(&self) -> String {
        let phase = if self.phase == Phase::Joining {
            "joining sync"
        } else {
            "detached sync"
        };
        format!(
            "{phase}: {} items pending/held ({} pending, {} held; {})",
            self.pending.saturating_add(self.held),
            self.pending,
            self.held,
            if self.total > MAX_CANDIDATES && self.phase == Phase::Joining {
                "mirror_too_large"
            } else {
                self.reason.as_str()
            }
        )
    }
    /// An explicit operator/user command, never called on timeout or proof failure.
    /// Only admission metadata changes; files/proof/pending/holds are untouched.
    pub fn detached(&self) -> Self {
        Self {
            phase: Phase::Detached,
            reason: Reason::UserDetached,
            ..self.clone()
        }
    }
    /// Begin/refresh a CLOSED gate; same attempt, monotone progress only.
    /// No release/delete/fresh-rejoin operation is provided by this primitive.
    /// Only use before replica/file-store open. On ANY commit error the host must
    /// close/drop and reopen storage; cached reads cannot settle unknown outcome.
    pub fn persist(&self, store: &mut impl Store) -> Result<(), StoreError> {
        self.validate()?;
        if let Some(old) = Self::load(store)? {
            if old.capture != self.capture
                || old.total != self.total
                || (old.phase == Phase::Detached && self != &old)
                || self.pending > old.pending
                || self.held < old.held
            {
                return Err(StoreError::CommitAborted(
                    "mirror admission transition refused".into(),
                ));
            }
        } else if self.phase != Phase::Joining || self.pending != self.total || self.held != 0 {
            return Err(StoreError::CommitAborted(
                "mirror admission must begin closed".into(),
            ));
        }
        store.commit(Tx {
            meta: vec![(META.into(), Some(self.encode()?))],
            ..Tx::default()
        })?;
        Ok(())
    }
}
/// Refuse effects on a closed or detached replica, without touching OS files.
pub fn ensure_open(store: &impl Store) -> Result<(), StoreError> {
    if Fence::load(store)?.is_some() {
        return Err(closed());
    }
    Ok(())
}

/// Store-boundary guard. While closed, only a validated admission-only transition
/// is accepted; no publish, observation ack, adoption, staging swap or cleanup.
/// This checks BEFORE any inner commit or filesystem effect. No release exists.
/// The I/O-shaped refusal makes no claim about preceding deferred durability.
pub fn check_tx(current: Option<&[u8]>, tx: &Tx) -> Result<(), StoreError> {
    let old = current.map(Fence::decode).transpose()?;
    let writes: Vec<_> = tx.meta.iter().filter(|(key, _)| key == META).collect();
    if old.is_none() && writes.is_empty() {
        return Ok(());
    }
    if tx.is_empty() && old.is_some() {
        return Ok(());
    }
    let [(key, Some(bytes))] = writes.as_slice() else {
        return Err(closed());
    };
    let next = Fence::decode(bytes)?;
    // Equality with an admission-only Tx rejects EVERY other transaction arm,
    // including future fields, rather than an incomplete blacklist of writes.
    if tx
        != &(Tx {
            meta: vec![((*key).clone(), Some((*bytes).clone()))],
            ..Tx::default()
        })
    {
        return Err(closed());
    }
    match old {
        None if next.phase == Phase::Joining && next.pending == next.total && next.held == 0 => {
            Ok(())
        }
        Some(old)
            if old.capture == next.capture
                && old.total == next.total
                && next.pending <= old.pending
                && next.held >= old.held
                && (old.phase != Phase::Detached || old == next) =>
        {
            Ok(())
        }
        _ => Err(closed()),
    }
}
fn closed() -> StoreError {
    StoreError::Io("mirror admission closed: preserve evidence and files".into())
}
fn corrupt() -> StoreError {
    StoreError::Corrupt("invalid mirror admission fence".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mem::MemStore;
    #[test]
    fn large_mirror_is_a_typed_capture_refusal_not_corrupt_metadata() {
        assert_eq!(
            Fence::new([1; 16], MAX_CANDIDATES + 1),
            Err(CaptureRefusal::MirrorTooLarge {
                total: MAX_CANDIDATES + 1
            })
        );
        assert_eq!(
            CaptureRefusal::MirrorTooLarge {
                total: MAX_CANDIDATES + 1
            }
            .code(),
            "mirror_too_large"
        );
        let mut f = Fence::new([1; 16], MAX_CANDIDATES).unwrap();
        // Reopen may encounter valid old metadata written under another policy.
        f.total += 1;
        f.pending += 1;
        let reopened = Fence::decode(&f.encode().unwrap()).unwrap();
        assert_eq!(reopened, f);
        assert!(reopened.status().contains("mirror_too_large"));
        assert!(
            check_tx(
                Some(&f.encode().unwrap()),
                &Tx {
                    clear_confirmed: true,
                    ..Tx::default()
                }
            )
            .is_err()
        );
    }

    #[test]
    fn closed_state_reopens_and_explains_pending_held_reason() {
        let mut s = MemStore::new();
        assert_eq!(Fence::load(&s).unwrap(), None);
        let mut f = Fence::new([1; 16], 3).unwrap();
        f.persist(&mut s).unwrap();
        assert_eq!(Fence::load(&s).unwrap(), Some(f.clone()));
        f.pending = 1;
        f.held = 2;
        f.reason = Reason::InvalidProof;
        f.persist(&mut s).unwrap();
        assert_eq!(
            Fence::load(&s).unwrap().unwrap().status(),
            "joining sync: 3 items pending/held (1 pending, 2 held; invalid_proof)"
        );
    }
    #[test]
    fn explicit_detach_is_sticky_and_cannot_auto_rejoin_or_replace_attempt() {
        let mut s = MemStore::new();
        let f = Fence::new([1; 16], 3).unwrap();
        f.persist(&mut s).unwrap();
        let d = f.detached();
        d.persist(&mut s).unwrap();
        assert_eq!(Fence::load(&s).unwrap(), Some(d.clone()));
        assert!(f.persist(&mut s).is_err());
        assert!(Fence::new([2; 16], 3).unwrap().persist(&mut s).is_err());
        assert_eq!(Fence::load(&s).unwrap(), Some(d));
    }
    #[test]
    fn abort_and_unknown_begin_or_detach_are_never_reported_as_success() {
        for after in [false, true] {
            let mut s = MemStore::new();
            let f = Fence::new([1; 16], 3).unwrap();
            if after {
                s.fail_after_commit(1);
            } else {
                s.fail_commits(1);
            }
            assert!(f.persist(&mut s).is_err());
            let reopened = MemStore::shared(s.data());
            assert_eq!(
                Fence::load(&reopened).unwrap(),
                if after { Some(f.clone()) } else { None }
            );
            // Never continue from cached state after unknown commit outcome.
            let mut s = MemStore::shared(s.data());
            f.persist(&mut s).unwrap();
            let detached = f.detached();
            if after {
                s.fail_after_commit(1);
            } else {
                s.fail_commits(1);
            }
            assert!(detached.persist(&mut s).is_err());
            let reopened = MemStore::shared(s.data());
            assert_eq!(
                Fence::load(&reopened).unwrap(),
                Some(if after { detached } else { f })
            );
            assert!(ensure_open(&reopened).is_err());
        }
    }

    #[test]
    fn store_boundary_rejects_every_effect_and_raw_fence_removal() {
        let mut s = MemStore::new();
        let f = Fence::new([1; 16], 3).unwrap();
        f.persist(&mut s).unwrap();
        for tx in [
            Tx {
                clear_confirmed: true,
                ..Tx::default()
            },
            Tx {
                stage: crate::store::Stage::Swap,
                ..Tx::default()
            },
            Tx {
                ack_observations: vec![crate::store::ObservationId(1)],
                ..Tx::default()
            },
            Tx {
                resources_put: vec![("types/note.yaml".into(), "new".into())],
                ..Tx::default()
            },
            Tx {
                blobs_del: vec![mdbn_wire::common::B32([1; 32])],
                ..Tx::default()
            },
            Tx {
                meta: vec![(META.into(), None)],
                ..Tx::default()
            },
            Tx {
                meta: vec![("other".into(), Some(vec![1]))],
                ..Tx::default()
            },
        ] {
            assert!(s.commit(tx).is_err());
            assert_eq!(Fence::load(&s).unwrap(), Some(f.clone()));
        }
        assert!(ensure_open(&s).is_err());
        assert!(s.commit(Tx::default()).is_ok());
    }

    #[test]
    fn gate_cannot_be_combined_with_first_adoption_or_cleanup() {
        let mut s = MemStore::new();
        let f = Fence::new([1; 16], 3).unwrap();
        assert!(
            s.commit(Tx {
                clear_confirmed: true,
                meta: vec![(META.into(), Some(f.encode().unwrap()))],
                ..Tx::default()
            })
            .is_err()
        );
        assert_eq!(Fence::load(&s).unwrap(), None);
    }

    #[test]
    fn future_corrupt_missing_and_overflow_are_not_equivalent() {
        let mut s = MemStore::new();
        assert!(
            s.commit(Tx {
                meta: vec![(META.into(), Some(vec![0]))],
                ..Tx::default()
            })
            .is_err()
        );
        assert_eq!(Fence::load(&s).unwrap(), None);
        assert!(check_tx(Some(&[0]), &Tx::default()).is_err());
        let mut f = Fence::new([1; 16], 3).unwrap();
        f.pending = u64::MAX;
        f.held = 1;
        assert!(f.encode().is_err());
        let bytes = cbor::encode(&Cbor::Array(vec![Cbor::Uint(2)])).unwrap();
        assert!(Fence::decode(&bytes).is_err());
        assert!(Fence::new([0; 16], 1).is_err());
    }
}
