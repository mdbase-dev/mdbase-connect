//! The host's synchronous, durable, metadata-only store for the driver.

use std::collections::{BTreeMap, BTreeSet};

use mdbn_wire::common::Hash;

use super::{DiffRow, Generation, Key, Meta};
use crate::namespace::Claims;
use crate::preflight::PathEntity;

/// Spill errors are host strings (an SQLite failure); never content.
pub type SpillResult<T> = std::result::Result<T, String>;

/// Durable metadata the driver keeps between requests and across evictions. In
/// the Worker: the collection DO's SQLite (synchronous, transactional). Holds
/// paths, IDs, hashes and sizes only, never keys, documents or attachment bytes.
///
/// Every method is one bounded statement; `limit` never exceeds
/// [`crate::budget::MAX_HYDRATE_RECORDS`].
pub trait Spill {
    /// The saved checkpoint, if any.
    fn load(&mut self) -> SpillResult<Option<Vec<u8>>>;
    /// Replace the checkpoint. Must be durable before the driver's next action.
    fn save(&mut self, checkpoint: &[u8]) -> SpillResult<()>;

    /// Drop every table of one generation (claims, placements, deferred).
    fn clear(&mut self, g: Generation) -> SpillResult<()>;
    /// Whether a name's [`crate::namespace::claim_key`] is claimed in `g`.
    fn is_claimed(&mut self, g: Generation, key: &Hash) -> SpillResult<bool>;
    /// Claim a name in `g`.
    fn claim(&mut self, g: Generation, key: &Hash) -> SpillResult<()>;
    /// Record where an entity lives in `g`'s state.
    fn put_placement(&mut self, g: Generation, key: &Key, meta: &Meta) -> SpillResult<()>;
    /// Keep a non-portable entity (original path in `meta.path`) for pass 2.
    fn push_deferred(&mut self, g: Generation, entity: &PathEntity, meta: &Meta)
    -> SpillResult<()>;
    /// Deferred entities after `after` in entity order, at most `limit`.
    fn deferred_page(
        &mut self,
        g: Generation,
        after: Option<&PathEntity>,
        limit: usize,
    ) -> SpillResult<Vec<(PathEntity, Meta)>>;
    /// Placements of `g` after `after` in key order, at most `limit`.
    fn placements_page(
        &mut self,
        g: Generation,
        after: Option<&Key>,
        limit: usize,
    ) -> SpillResult<Vec<(Key, Meta)>>;
    /// Generation-0 placements in the requested bucket, after `after` in key
    /// order. `bucket = None` selects resources only; numbered buckets exclude
    /// resources. Every page is bounded independently; never hydrate a whole
    /// bucket merely because it has a single bucket number.
    fn placements_in_bucket(
        &mut self,
        g: Generation,
        bits: u64,
        bucket: Option<u64>,
        after: Option<&Key>,
        limit: usize,
    ) -> SpillResult<Vec<(Key, Meta)>>;
    /// Keys whose S0 and final placements differ (either absent, or any field
    /// different), after `after` in key order, at most `limit`, with both sides.
    fn diff_page(&mut self, after: Option<&Key>, limit: usize) -> SpillResult<Vec<DiffRow>>;
}

/// An in-memory [`Spill`] for native callers and tests. Its contents survive a
/// simulated crash of the driver (it stands for SQLite).
#[derive(Debug, Default, Clone)]
pub struct MemSpill {
    checkpoint: Option<Vec<u8>>,
    claims: BTreeMap<Generation, BTreeSet<Hash>>,
    placements: BTreeMap<Generation, BTreeMap<Key, Meta>>,
    deferred: BTreeMap<Generation, BTreeMap<PathEntity, Meta>>,
    /// Saves so far (tests count checkpoint writes).
    pub saves: u64,
}

impl MemSpill {
    /// The placements of one generation, for assertions.
    pub fn placements(&self, g: Generation) -> Option<&BTreeMap<Key, Meta>> {
        self.placements.get(&g)
    }
}

impl Spill for MemSpill {
    fn load(&mut self) -> SpillResult<Option<Vec<u8>>> {
        Ok(self.checkpoint.clone())
    }
    fn save(&mut self, checkpoint: &[u8]) -> SpillResult<()> {
        self.saves += 1;
        self.checkpoint = Some(checkpoint.to_vec());
        Ok(())
    }
    fn clear(&mut self, g: Generation) -> SpillResult<()> {
        self.claims.remove(&g);
        self.placements.remove(&g);
        self.deferred.remove(&g);
        Ok(())
    }
    fn is_claimed(&mut self, g: Generation, key: &Hash) -> SpillResult<bool> {
        Ok(self.claims.get(&g).is_some_and(|c| c.contains(key)))
    }
    fn claim(&mut self, g: Generation, key: &Hash) -> SpillResult<()> {
        self.claims.entry(g).or_default().insert(*key);
        Ok(())
    }
    fn put_placement(&mut self, g: Generation, key: &Key, meta: &Meta) -> SpillResult<()> {
        if key.kind != crate::preflight::EntityKind::Resource {
            super::bucket16(key).map_err(|e| e.to_string())?;
        }
        self.placements
            .entry(g)
            .or_default()
            .insert(key.clone(), meta.clone());
        Ok(())
    }
    fn push_deferred(
        &mut self,
        g: Generation,
        entity: &PathEntity,
        meta: &Meta,
    ) -> SpillResult<()> {
        self.deferred
            .entry(g)
            .or_default()
            .insert(entity.clone(), meta.clone());
        Ok(())
    }
    fn deferred_page(
        &mut self,
        g: Generation,
        after: Option<&PathEntity>,
        limit: usize,
    ) -> SpillResult<Vec<(PathEntity, Meta)>> {
        Ok(self
            .deferred
            .get(&g)
            .into_iter()
            .flat_map(|m| m.iter())
            .filter(|(e, _)| after.is_none_or(|a| *e > a))
            .take(limit)
            .map(|(e, m)| (e.clone(), m.clone()))
            .collect())
    }
    fn placements_page(
        &mut self,
        g: Generation,
        after: Option<&Key>,
        limit: usize,
    ) -> SpillResult<Vec<(Key, Meta)>> {
        Ok(self
            .placements
            .get(&g)
            .into_iter()
            .flat_map(|m| m.iter())
            .filter(|(k, _)| after.is_none_or(|a| *k > a))
            .take(limit)
            .map(|(k, m)| (k.clone(), m.clone()))
            .collect())
    }
    fn placements_in_bucket(
        &mut self,
        g: Generation,
        bits: u64,
        bucket: Option<u64>,
        after: Option<&Key>,
        limit: usize,
    ) -> SpillResult<Vec<(Key, Meta)>> {
        let (lo, hi) = super::bucket_range(bits, bucket.unwrap_or(0)).map_err(|e| e.to_string())?;
        if limit > crate::budget::MAX_HYDRATE_RECORDS {
            return Err("bucket page over row budget".into());
        }
        let mut out = Vec::new();
        for (key, meta) in self.placements.get(&g).into_iter().flat_map(|m| m.iter()) {
            if after.is_some_and(|a| key <= a) {
                continue;
            }
            let resource = key.kind == crate::preflight::EntityKind::Resource;
            let selected = match bucket {
                None => resource,
                Some(_) if resource => false,
                Some(_) => {
                    let b = super::bucket16(key).map_err(|e| e.to_string())?;
                    (lo..=hi).contains(&b)
                }
            };
            if selected && out.len() < limit {
                out.push((key.clone(), meta.clone()));
            }
            if out.len() == limit {
                break;
            }
        }
        Ok(out)
    }
    fn diff_page(&mut self, after: Option<&Key>, limit: usize) -> SpillResult<Vec<DiffRow>> {
        let empty = BTreeMap::new();
        let s0 = self.placements.get(&Generation::S0).unwrap_or(&empty);
        let fin = self.placements.get(&Generation::Final).unwrap_or(&empty);
        let keys: BTreeSet<&Key> = s0
            .keys()
            .chain(fin.keys())
            .filter(|k| after.is_none_or(|a| *k > a))
            .collect();
        Ok(keys
            .into_iter()
            .filter(|k| s0.get(*k) != fin.get(*k))
            .take(limit)
            .map(|k| ((*k).clone(), s0.get(k).cloned(), fin.get(k).cloned()))
            .collect())
    }
}

/// [`Claims`] over one generation of a [`Spill`].
pub(crate) struct GenClaims<'a> {
    pub(crate) spill: &'a mut dyn Spill,
    pub(crate) g: Generation,
}

impl Claims for GenClaims<'_> {
    fn is_claimed(&mut self, key: &Hash) -> SpillResult<bool> {
        self.spill.is_claimed(self.g, key)
    }
    fn claim(&mut self, key: &Hash) -> SpillResult<()> {
        self.spill.claim(self.g, key)
    }
}
