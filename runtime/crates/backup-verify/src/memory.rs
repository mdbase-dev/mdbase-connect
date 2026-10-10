//! Invocation-owned lifetimes: values are destroyed before allowances release.
use crate::Refusal;
use mdbn_log_service::{OfflineDecodeBudget, OfflineOwnedReservation};
use std::ops::Deref;

pub(crate) fn poison(work: &OfflineDecodeBudget) {
    // Use the permanent resource-refusal path; no setter/reset or
    // allocation occurs for an allowance that exceeds the fixed ceiling.
    let _ = work.reserve_owned(u64::MAX);
}

pub(crate) struct Owned<T> {
    value: T,
    allocation: OfflineOwnedReservation,
}

impl<T> Owned<T> {
    pub(crate) fn construct(
        work: &OfflineDecodeBudget,
        allowance: u64,
        build: impl FnOnce() -> Result<T, Refusal>,
    ) -> Result<Self, Refusal> {
        let allocation = work.reserve_owned(allowance).map_err(|_| Refusal::Bounds)?;
        match build() {
            Ok(value) => Ok(Self { value, allocation }),
            Err(error) => {
                poison(work);
                Err(error)
            }
        }
    }

    pub(crate) fn map<U>(self, transform: impl FnOnce(T) -> U) -> Owned<U> {
        let Self { value, allocation } = self;
        let value = transform(value);
        Owned { value, allocation }
    }
}

impl<T> Deref for Owned<T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.value
    }
}

pub(crate) fn scratch(bytes: usize) -> Result<u64, Refusal> {
    u64::try_from(bytes)
        .ok()
        .and_then(|bytes| bytes.checked_mul(8))
        .and_then(|bytes| bytes.checked_add(2 * 1024 * 1024))
        .ok_or(Refusal::Bounds)
}

/// A charged, fixed-capacity input buffer. Cannot grow or release its allowance
/// independently from its owned bytes; filling uses only a bounded mutable slice.
pub struct OwnedBytes {
    bytes: Vec<u8>,
    _allocation: OfflineOwnedReservation,
}

impl OwnedBytes {
    /// Admit a fixed capacity before allocating. The shared hard ceiling applies
    /// across these buffers, indices, typed copies and private replay helpers.
    pub fn allocate(work: &OfflineDecodeBudget, capacity: usize) -> Result<Self, Refusal> {
        let result = Self::allocate_checked(work, capacity);
        if result.is_err() {
            poison(work);
        }
        result
    }

    fn allocate_checked(work: &OfflineDecodeBudget, capacity: usize) -> Result<Self, Refusal> {
        let upper = u64::try_from(capacity)
            .ok()
            .and_then(|capacity| capacity.checked_mul(2))
            .ok_or(Refusal::Bounds)?;
        let preallocation = work.reserve_owned(upper).map_err(|_| Refusal::Bounds)?;
        let mut bytes = Vec::new();
        bytes
            .try_reserve_exact(capacity)
            .map_err(|_| Refusal::Bounds)?;
        if bytes.capacity() as u64 > upper {
            return Err(Refusal::Bounds);
        }
        // Transfer conservative preallocation admission to the actual reported
        // capacity with overlap: acquire replacement BEFORE releasing old credit.
        let allocation = work
            .reserve_owned(bytes.capacity() as u64)
            .map_err(|_| Refusal::Bounds)?;
        bytes.resize(capacity, 0);
        drop(preallocation);
        Ok(Self {
            bytes,
            _allocation: allocation,
        })
    }

    /// Fixed-length writable storage; cannot reallocate or exceed capacity.
    pub fn fill_slice(&mut self) -> &mut [u8] {
        &mut self.bytes
    }

    /// Retain only bytes actually read, without releasing capacity allowance.
    pub fn truncate(&mut self, length: usize) {
        self.bytes.truncate(length);
    }

    /// Exact retained bytes for hashing/validation, with the same live allowance.
    pub fn as_slice(&self) -> &[u8] {
        &self.bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const LIMIT: u64 = 96 * 1024 * 1024;
    #[test]
    fn value_destruction_precedes_allowance_release() {
        struct Witness(OfflineDecodeBudget);
        impl Drop for Witness {
            fn drop(&mut self) {
                assert!(self.0.reserve_owned(1).is_err());
            }
        }
        let work = OfflineDecodeBudget::new();
        let value = Owned::construct(&work, LIMIT, || Ok(Witness(work.clone()))).unwrap();
        drop(value); // witness still sees its original full charge
        assert!(work.reserve_owned(0).is_err()); // destructor refusal stays poison
    }
    #[test]
    fn mapped_value_keeps_same_charge_and_fixed_buffer_cannot_grow() {
        let work = OfflineDecodeBudget::new();
        let value = Owned::construct(&work, 8, || Ok(1))
            .unwrap()
            .map(|number| number + 1);
        assert_eq!(*value, 2);
        drop(value);
        let mut bytes = OwnedBytes::allocate(&work, 16).unwrap();
        bytes.fill_slice().fill(7);
        bytes.truncate(4);
        assert_eq!(bytes.as_slice(), &[7; 4]);
        drop(bytes);
        let full = work.reserve_owned(LIMIT).unwrap();
        drop(full);
        work.request().raw(&[0xf6]).unwrap();
    }
}
