//! Private candidate STORAGE requests/evidence, not verified install authority.
//! No request, persisted reservation or matching body can authorize a swap.

use super::{Fence, Phase, install_budget};
use crate::store::{Head, StoreError};
use mdbn_wire::cbor::{self, Cbor};

/// Reserved per-candidate encoded binding/metadata allowance, charged first.
pub const HEADER_BYTES: u64 = 1024;
/// Reserved per-part metadata allowance, in addition to its declared body bound.
pub const PART_METADATA_BYTES: u64 = 128;
/// Each staged body part stays within the existing snapshot chunk ceiling.
pub const MAX_PART_BYTES: u64 = 4 * 1024 * 1024;
/// Existing snapshot expanded-ref ceiling also bounds per-candidate part slots.
pub const MAX_PARTS: u64 = 32 * 8192;

/// Fresh native-context labels. These are NOT authenticated by storage requests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    /// Current collection; must match the store's persisted identity.
    pub collection: [u8; 16],
    /// New private replica instance; must match the persisted identity.
    pub replica: [u8; 16],
    /// Fresh pairing/account incarnation; verifier must authenticate/recheck it.
    pub incarnation: u64,
    /// Captured source generation; verifier must recheck native custody.
    pub generation: u64,
}
/// Immutable target claims; full resident verification is mandatory later.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    /// Next cutover C.
    pub cutover_seq: u64,
    /// Drain F; distinct from legacy positions.
    pub barrier_f: u64,
    /// Drained legacy position, never compared numerically with Next C/F.
    pub s_final: u64,
    /// Authenticated target object address claim.
    pub manifest: [u8; 32],
    /// Expected drained state digest claim.
    pub state_digest: [u8; 32],
    /// Target head chain claim; matching metadata is not verified lineage.
    pub chain: [u8; 32],
    /// Expected native epoch claim.
    pub epoch: u64,
}
/// Bounded immutable candidate request. No raw Tx or bypass flag is accepted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    /// New candidate ID, isolated from every other/ordinary stage.
    pub candidate: [u8; 16],
    /// Exact Joining marker; all fields must still match at each transaction.
    pub fence: Fence,
    /// Current captured native-context claims.
    pub identity: Identity,
    /// Exact old confirmed head CAS; no overwrite of a newer confirmed state.
    pub old_head: Head,
    /// Immutable target claims.
    pub target: Target,
}
/// Nonallocating storage category. Diagnostics are not retained after the
/// operation's control charge drops; every category still requires reopen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StorageRefusal {
    /// I/O or an uncertain acknowledgment; never authorizes a retry.
    Io,
    /// Capacity failure; evidence is retained and the handle is discarded.
    Full,
    /// Unreadable state; no repair or cleanup is authorized.
    Corrupt,
}
/// Typed refusal; unknown storage outcomes are kept distinct from refusal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// Invalid request/part shape; refused before storage or body allocation.
    Invalid,
    /// Marker/head/identity drift, including Detached/missing/future marker.
    Drift,
    /// Candidate/slot ID reused with different exact request or bytes.
    Conflict,
    /// Bounded persistent or live working budget exhausted.
    Budget(install_budget::Error),
    /// Backend has no qualified isolated staging implementation.
    Unsupported,
    /// Read/storage failure; a write result may be unknown and needs reopen.
    Storage(StorageRefusal),
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Invalid => "mirror_candidate_invalid",
            Self::Drift => "mirror_candidate_drift",
            Self::Conflict => "mirror_candidate_conflict",
            Self::Budget(e) => e.code(),
            Self::Unsupported => "mirror_candidate_unsupported",
            Self::Storage(_) => "mirror_candidate_storage_reopen",
        })
    }
}
impl std::error::Error for Error {}
impl From<StoreError> for Error {
    fn from(e: StoreError) -> Self {
        Self::Storage(match e {
            // The ordinary commit guarantee cannot certify a private candidate
            // operation. Preserve terminal/unknown handling even for this kind.
            StoreError::CommitAborted(_) | StoreError::Io(_) => StorageRefusal::Io,
            StoreError::Full => StorageRefusal::Full,
            StoreError::Corrupt(_) => StorageRefusal::Corrupt,
        })
    }
}
impl From<install_budget::Error> for Error {
    fn from(e: install_budget::Error) -> Self {
        Self::Budget(e)
    }
}

impl Request {
    /// Pure structural validation, not authentication or persisted reservation.
    pub fn validate(&self) -> Result<(), Error> {
        if self.candidate == [0; 16]
            || self.identity.collection == [0; 16]
            || self.identity.replica == [0; 16]
            || self.identity.incarnation == 0
            || self.fence.phase != Phase::Joining
            || self.fence.total > super::MAX_CANDIDATES
            || self.target.cutover_seq == 0
            || self.target.cutover_seq > self.target.barrier_f
            || self.target.epoch == 0
        {
            return Err(Error::Invalid);
        }
        self.fence.validate().map_err(|_| Error::Invalid)?;
        Ok(())
    }
    /// Deterministic metadata only, <=HEADER_BYTES; never serialized authority.
    /// Caller charges HEADER_BYTES working/disk allowance BEFORE invoking it.
    pub fn binding(&self) -> Result<Vec<u8>, Error> {
        self.validate()?;
        let i = &self.identity;
        let t = &self.target;
        let bytes = cbor::encode(&Cbor::Array(vec![
            Cbor::Uint(1),
            Cbor::Bytes(self.candidate.to_vec()),
            Cbor::Bytes(self.fence.encode().map_err(|_| Error::Invalid)?),
            Cbor::Bytes(i.collection.to_vec()),
            Cbor::Bytes(i.replica.to_vec()),
            Cbor::Uint(i.incarnation),
            Cbor::Uint(i.generation),
            Cbor::Uint(self.old_head.seq),
            Cbor::Bytes(self.old_head.chain.0.to_vec()),
            Cbor::Uint(t.cutover_seq),
            Cbor::Uint(t.barrier_f),
            Cbor::Uint(t.s_final),
            Cbor::Bytes(t.manifest.to_vec()),
            Cbor::Bytes(t.state_digest.to_vec()),
            Cbor::Bytes(t.chain.to_vec()),
            Cbor::Uint(t.epoch),
        ]))
        .map_err(|_| Error::Invalid)?;
        if bytes.len() as u64 > HEADER_BYTES {
            return Err(Error::Invalid);
        }
        Ok(bytes)
    }
}
/// Validate slot bound before requesting/allocating its body. No cleanup on error.
pub fn part_charge(ordinal: u64, bytes: u64) -> Result<u64, Error> {
    if ordinal >= MAX_PARTS || bytes == 0 || bytes > MAX_PART_BYTES {
        return Err(Error::Invalid);
    }
    bytes
        .checked_add(PART_METADATA_BYTES)
        .ok_or(Error::Budget(install_budget::Error::AccountingOverflow))
}
