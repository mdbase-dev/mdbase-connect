//! Bounded top-k over the same compact keys used by SQL. Holds IDs and keys,
//! never source documents or selection payloads. Hydration/work budgets belong
//! to the request driver and are cumulative across its scan steps.

use std::cmp::Ordering;
use std::collections::BinaryHeap;
use std::sync::Arc;

use super::Direction;
use super::indexed::SortAtom;
use crate::ids::RecordId;

/// Maximum retained result IDs in one bounded request.
pub const MAX_TOP_K: usize = 1000;
/// Maximum owned key/container bytes retained by this accumulator.
pub const MAX_KEY_BYTES: usize = 1 << 20;

/// Invalid shape or exhausted resource bounds. An error faults the accumulator,
/// so it cannot subsequently publish a seemingly successful partial result.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TopKError {
    /// Requested result window exceeds the bounded profile.
    TooMany,
    /// A candidate has a different number of keys than the order plan.
    Arity,
    /// Owned key/container bytes exceed the explicit limit.
    TooWide,
}

/// One matching record, produced once per record in a fixed snapshot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyedRecord {
    /// Stable final ascending tie-break, independent of path and direction.
    pub id: RecordId,
    /// One key for each requested order term.
    pub keys: Vec<SortAtom>,
}

impl KeyedRecord {
    fn retained_bytes(&self) -> Option<usize> {
        let mut bytes = std::mem::size_of::<Entry>().checked_add(
            self.keys
                .capacity()
                .checked_mul(std::mem::size_of::<SortAtom>())?,
        )?;
        for key in &self.keys {
            bytes = bytes.checked_add(key.allocated_key_bytes())?;
        }
        Some(bytes)
    }
}

/// Compare keys by direction, then record ID ascending in both directions.
pub fn compare(a: &KeyedRecord, b: &KeyedRecord, directions: &[Direction]) -> Ordering {
    for ((a, b), direction) in a.keys.iter().zip(&b.keys).zip(directions) {
        let order = a.cmp(b);
        let order = if *direction == Direction::Desc {
            order.reverse()
        } else {
            order
        };
        if order != Ordering::Equal {
            return order;
        }
    }
    a.id.cmp(&b.id)
}

#[derive(Clone, Debug)]
struct Entry {
    row: KeyedRecord,
    directions: Arc<[Direction]>,
    bytes: usize,
}
impl PartialEq for Entry {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}
impl Eq for Entry {}
impl PartialOrd for Entry {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Entry {
    fn cmp(&self, other: &Self) -> Ordering {
        compare(&self.row, &other.row, &self.directions)
    }
}

/// Bounded matching-ID accumulator. Scans may stream arbitrarily many records
/// through successive bounded requests; the driver enforces snapshot/clock
/// continuity and counts each record once. It must not treat a partial scan's
/// match count as the query's exact total.
pub struct TopK {
    limit: usize,
    max_bytes: usize,
    bytes: usize,
    directions: Arc<[Direction]>,
    heap: BinaryHeap<Entry>,
    fault: Option<TopKError>,
}

impl TopK {
    /// Allocate at most `limit` entries, including capacity in the byte budget.
    pub fn new(
        limit: usize,
        directions: Vec<Direction>,
        max_bytes: usize,
    ) -> Result<Self, TopKError> {
        if limit > MAX_TOP_K {
            return Err(TopKError::TooMany);
        }
        let max_bytes = max_bytes.min(MAX_KEY_BYTES);
        let base = limit
            .checked_mul(std::mem::size_of::<Entry>())
            .and_then(|n| {
                n.checked_add(
                    directions
                        .capacity()
                        .checked_mul(std::mem::size_of::<Direction>())?,
                )
            })
            .ok_or(TopKError::TooWide)?;
        if base > max_bytes {
            return Err(TopKError::TooWide);
        }
        Ok(Self {
            limit,
            max_bytes,
            bytes: base,
            directions: directions.into(),
            heap: BinaryHeap::with_capacity(limit),
            fault: None,
        })
    }

    fn fail<T>(&mut self, error: TopKError) -> Result<T, TopKError> {
        self.heap.clear();
        self.fault = Some(error);
        Err(error)
    }

    /// Retain a candidate only if it belongs to the best `limit` records. Keys
    /// are checked before retention; the caller must bound their construction.
    pub fn push(&mut self, row: KeyedRecord) -> Result<(), TopKError> {
        if let Some(error) = self.fault {
            return Err(error);
        }
        if row.keys.len() != self.directions.len() {
            return self.fail(TopKError::Arity);
        }
        if self.limit == 0 {
            return Ok(());
        }
        if self.heap.len() == self.limit
            && self
                .heap
                .peek()
                .is_some_and(|worst| compare(&row, &worst.row, &self.directions) != Ordering::Less)
        {
            return Ok(());
        }
        let Some(bytes) = row
            .retained_bytes()
            .and_then(|n| n.checked_sub(std::mem::size_of::<Entry>()))
        else {
            return self.fail(TopKError::TooWide);
        };
        let replaced = if self.heap.len() == self.limit {
            self.heap.peek().map_or(0, |entry| entry.bytes)
        } else {
            0
        };
        let Some(total) = self
            .bytes
            .checked_sub(replaced)
            .and_then(|n| n.checked_add(bytes))
        else {
            return self.fail(TopKError::TooWide);
        };
        if total > self.max_bytes {
            return self.fail(TopKError::TooWide);
        }
        if self.heap.len() == self.limit {
            self.heap.pop();
        }
        self.heap.push(Entry {
            row,
            directions: self.directions.clone(),
            bytes,
        });
        self.bytes = total;
        Ok(())
    }

    /// Results in final query order. A prior failure cannot be ignored.
    pub fn finish(self) -> Result<Vec<KeyedRecord>, TopKError> {
        if let Some(error) = self.fault {
            return Err(error);
        }
        Ok(self
            .heap
            .into_sorted_vec()
            .into_iter()
            .map(|entry| entry.row)
            .collect())
    }
}
