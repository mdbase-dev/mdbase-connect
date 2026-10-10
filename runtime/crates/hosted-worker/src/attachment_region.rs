//! One Engine-owned zeroizing9MiB backing, explicitly leased to one operation.
//! Owner/lease labels are memory arbitration, NOT native or adapter authority.
//! Every consumer must separately recheck current subject/epoch/wake/admission.
use mdbn_replica::api::{SessionId, StreamId};
use mdbn_replica::attachments::MAX_SEALED_CHUNK;
use mdbn_wire::common::Uuid;
use zeroize::{Zeroize, Zeroizing};

/// Native operation identity; never filled from an unchecked client/SQL permit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RegionOwner {
    /// A pinned read stream for its authenticated session.
    Read {
        /// Original currently authenticated native session.
        session: SessionId,
        /// Native-minted stream identifier.
        stream: StreamId,
    },
    /// One native grant-owned upload mutation.
    Upload {
        /// Original currently authenticated native session.
        session: SessionId,
        /// Native grant-owned mutation identifier.
        mutation: Uuid,
    },
    /// Committed-prefix rehash for one native resumed mutation.
    Rehash {
        /// Freshly authenticated native resume session.
        session: SessionId,
        /// Authenticated original native mutation identifier.
        mutation: Uuid,
    },
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct RegionLease {
    owner: RegionOwner,
    generation: u64,
}
pub(crate) struct AttachmentRegion {
    bytes: Zeroizing<Vec<u8>>,
    held: Option<RegionLease>,
    generation: u64,
}
impl AttachmentRegion {
    pub fn new() -> Self {
        Self {
            bytes: Zeroizing::new(vec![0; MAX_SEALED_CHUNK as usize]),
            held: None,
            generation: 0,
        }
    }
    pub fn acquire(&mut self, owner: RegionOwner) -> Option<RegionLease> {
        if self.held.is_some() {
            return None;
        }
        let generation = self.generation.checked_add(1)?;
        self.bytes.as_mut_slice().zeroize();
        let lease = RegionLease { owner, generation };
        self.generation = generation;
        self.held = Some(lease);
        Some(lease)
    }
    #[cfg(test)]
    pub fn held_lease(&self) -> Option<RegionLease> {
        self.held
    }
    pub fn owns(&self, lease: RegionLease) -> bool {
        self.held == Some(lease)
    }
    pub fn borrow(&mut self, lease: RegionLease) -> Option<&mut [u8]> {
        self.owns(lease).then_some(&mut self.bytes)
    }
    /// Scrub while retaining ownership (manifest input/chunk drain/transport retry).
    pub fn scrub(&mut self, lease: RegionLease) -> bool {
        if !self.owns(lease) {
            return false;
        }
        self.bytes.as_mut_slice().zeroize();
        true
    }
    /// Exact-lease handoff only. Stale cleanup cannot wipe or release a successor.
    pub fn release(&mut self, lease: RegionLease) -> bool {
        if !self.scrub(lease) {
            return false;
        }
        self.held = None;
        true
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use mdbn_wire::common::B16;
    #[test]
    fn exclusive_read_upload_rehash_handoff_reuses_one_allocation_and_wipes_all_bytes() {
        let mut region = AttachmentRegion::new();
        let read = RegionOwner::Read {
            session: SessionId(1),
            stream: StreamId(1),
        };
        let upload = RegionOwner::Upload {
            session: SessionId(2),
            mutation: B16([2; 16]),
        };
        let rehash = RegionOwner::Rehash {
            session: SessionId(3),
            mutation: B16([2; 16]),
        };
        let first = region.acquire(read).unwrap();
        let pointer = region.borrow(first).unwrap().as_ptr();
        assert_eq!(region.borrow(first).unwrap().len(), 9 << 20);
        region.borrow(first).unwrap().fill(0xad);
        assert!(region.acquire(upload).is_none());
        assert!(region.borrow(first).unwrap().iter().all(|b| *b == 0xad));
        assert!(region.release(first));
        for owner in [upload, rehash, read] {
            let lease = region.acquire(owner).unwrap();
            assert!(region.borrow(first).is_none());
            assert!(!region.scrub(first));
            assert!(!region.release(first));
            let bytes = region.borrow(lease).unwrap();
            assert_eq!(bytes.as_ptr(), pointer);
            assert_eq!(bytes.len(), 9 << 20);
            assert!(bytes.iter().all(|b| *b == 0));
            bytes.fill(0xbe);
            assert!(region.scrub(lease));
            assert!(region.borrow(lease).unwrap().iter().all(|b| *b == 0));
            assert!(region.release(lease));
        }
    }
    #[test]
    fn same_owner_reacquire_does_not_revalidate_stale_generation_and_wrap_fails_closed() {
        let mut region = AttachmentRegion::new();
        let owner = RegionOwner::Read {
            session: SessionId(1),
            stream: StreamId(1),
        };
        let old = region.acquire(owner).unwrap();
        assert!(region.acquire(owner).is_none());
        region.release(old);
        let new = region.acquire(owner).unwrap();
        assert_ne!(old, new);
        assert!(region.borrow(old).is_none());
        assert!(!region.release(old));
        assert!(region.owns(new));
        region.release(new);
        region.generation = u64::MAX;
        assert!(region.acquire(owner).is_none());
    }
}
