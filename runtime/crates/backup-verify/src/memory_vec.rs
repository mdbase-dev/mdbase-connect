//! Private bounded index growth with admission BEFORE each reallocation.
use crate::Refusal;
use crate::memory::poison;
use mdbn_log_service::{OfflineDecodeBudget, OfflineOwnedReservation};
use std::ops::{Deref, DerefMut};

pub(crate) struct OwnedVec<T> {
    values: Vec<T>,
    work: OfflineDecodeBudget,
    limit: usize,
    // Value destruction precedes release; old/new credits overlap on growth.
    allocation: Option<OfflineOwnedReservation>,
}

impl<T> OwnedVec<T> {
    pub(crate) fn new(work: &OfflineDecodeBudget, limit: usize) -> Self {
        Self {
            values: Vec::new(),
            work: work.clone(),
            limit,
            allocation: None,
        }
    }

    pub(crate) fn release(&mut self) {
        self.values = Vec::new(); // destroy allocations BEFORE releasing credit
        self.allocation = None;
    }

    pub(crate) fn sort_unique(&mut self)
    where
        T: Ord,
    {
        self.values.sort_unstable();
        self.values.dedup(); // capacity remains charged; no growth
    }

    pub(crate) fn insert_unique(&mut self, value: T) -> Result<(), Refusal>
    where
        T: Ord,
    {
        let _alive = self.work.reserve_owned(0).map_err(|_| Refusal::Bounds)?;
        match self.values.binary_search(&value) {
            Ok(_) => Ok(()),
            Err(index) => {
                self.push(value)?;
                self.values[index..].rotate_right(1);
                Ok(())
            }
        }
    }

    pub(crate) fn push(&mut self, value: T) -> Result<(), Refusal> {
        let result = self.push_checked(value);
        if result.is_err() {
            poison(&self.work);
        }
        result
    }

    fn push_checked(&mut self, value: T) -> Result<(), Refusal> {
        let _alive = self.work.reserve_owned(0).map_err(|_| Refusal::Bounds)?;
        if self.values.len() == self.limit {
            return Err(Refusal::Bounds);
        }
        if self.values.len() == self.values.capacity() {
            let capacity = self
                .values
                .capacity()
                .checked_mul(2)
                .ok_or(Refusal::Bounds)?
                .max(4)
                .min(self.limit);
            let bytes = capacity
                .checked_mul(std::mem::size_of::<T>())
                .ok_or(Refusal::Bounds)?;
            let upper = u64::try_from(bytes)
                .ok()
                .and_then(|bytes| bytes.checked_mul(2))
                .ok_or(Refusal::Bounds)?;
            let preallocation = self
                .work
                .reserve_owned(upper)
                .map_err(|_| Refusal::Bounds)?;
            let replacement = (|| {
                self.values
                    .try_reserve_exact(capacity - self.values.len())
                    .map_err(|_| Refusal::Bounds)?;
                let actual = self
                    .values
                    .capacity()
                    .checked_mul(std::mem::size_of::<T>())
                    .ok_or(Refusal::Bounds)? as u64;
                if actual > upper {
                    return Err(Refusal::Bounds);
                }
                self.work.reserve_owned(actual).map_err(|_| Refusal::Bounds)
            })();
            match replacement {
                Ok(allocation) => {
                    // Replacement credit is already live before retiring old credit.
                    self.allocation = Some(allocation);
                }
                Err(error) => {
                    poison(&self.work);
                    // Reallocation may already have enlarged self.values. Destroy
                    // that capacity AND its elements while preallocation is live;
                    // never leave enlarged storage covered only by the old guard.
                    self.release();
                    return Err(error);
                }
            }
            drop(preallocation);
        }
        self.values.push(value); // proved within admitted reported capacity
        Ok(())
    }
}

impl<T> Deref for OwnedVec<T> {
    type Target = [T];
    fn deref(&self) -> &[T] {
        &self.values
    }
}
impl<T> DerefMut for OwnedVec<T> {
    fn deref_mut(&mut self) -> &mut [T] {
        &mut self.values
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const LIMIT: u64 = 96 * 1024 * 1024;
    #[test]
    fn bounded_index_growth_tracks_capacity_and_releases_only_after_values() {
        let work = OfflineDecodeBudget::new();
        let mut values = OwnedVec::new(&work, 16);
        for number in 0..16u64 {
            values.push(number).unwrap();
        }
        assert_eq!(&*values, &(0..16u64).collect::<Vec<_>>());
        let rest = work.reserve_owned(LIMIT - 16 * 8).unwrap();
        drop(rest);
        drop(values);
        let all = work.reserve_owned(LIMIT).unwrap();
        drop(all);
    }
    #[test]
    fn failed_replacement_after_growth_destroys_capacity_before_credit_release() {
        let work = OfflineDecodeBudget::new();
        let mut values = OwnedVec::new(&work, 16);
        for number in 0..4u64 {
            values.push(number).unwrap();
        }
        assert_eq!(values.values.capacity(), 4);
        // Next growth requests64B and reserves128B before reallocating. Leave
        // exactly128B free: preallocation succeeds, but replacement64B refuses
        // AFTER the vector has grown. The old32B guard cannot cover that growth.
        let held = work.reserve_owned(LIMIT - 32 - 128).unwrap();
        assert_eq!(values.push(4), Err(Refusal::Bounds));
        assert!(values.is_empty());
        assert_eq!(values.values.capacity(), 0);
        assert!(values.allocation.is_none());
        drop(held);
        assert!(work.reserve_owned(0).is_err());
        assert!(values.push(5).is_err());
    }

    #[test]
    fn index_limit_refusal_poison_carries_without_truncation() {
        let work = OfflineDecodeBudget::new();
        let mut values = OwnedVec::new(&work, 1);
        values.push(1u64).unwrap();
        assert!(values.push(2).is_err());
        assert_eq!(&*values, &[1]);
        assert!(work.request().raw(&[0xf6]).is_err());
        assert!(values.push(1).is_err());
    }
}
