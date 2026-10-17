//! SAME SqlSpill completion plans: metadata + original settlement + checkpoint
//! are committed together. No metadata/checkpoint writes escape during capture.
use mdbn_migrate_portable::hosted_import::{DiffRow, Generation, Key, Meta, Spill, SqlSpill};
use mdbn_migrate_portable::preflight::PathEntity;
use mdbn_store_file::index::{IndexStorage, Stmt};
use mdbn_wire::common::Hash;
use std::collections::BTreeSet;
type SpillResult<T> = std::result::Result<T, String>;

pub(super) struct CheckpointCapture<'a, I: IndexStorage> {
    spill: &'a mut SqlSpill<I>,
    saved: Option<Vec<u8>>,
    claims: BTreeSet<(u8, [u8; 32])>,
    cleared: [bool; 2],
    wrote: bool,
    failed: bool,
}
fn generation(g: Generation) -> u8 {
    match g {
        Generation::S0 => 0,
        Generation::Final => 1,
    }
}
fn unsupported<T>() -> SpillResult<T> {
    Err("migration completion read after staged metadata".into())
}
impl<'a, I: IndexStorage> CheckpointCapture<'a, I> {
    pub(super) fn new(spill: &'a mut SqlSpill<I>) -> SpillResult<Self> {
        spill.begin_completion()?;
        Ok(Self {
            spill,
            saved: None,
            claims: BTreeSet::new(),
            cleared: [false; 2],
            wrote: false,
            failed: false,
        })
    }
    /// Any refusal during capture is sticky: earlier staged plans can never be
    /// returned for commit once a later write, read or budget check failed.
    pub(super) fn finish(mut self) -> SpillResult<(Option<Vec<u8>>, Vec<Stmt>)> {
        if self.failed {
            return Err("migration completion failed".into());
        }
        let statements = self.spill.take_completion()?;
        Ok((self.saved.take(), statements))
    }
    fn refuse_if_failed(&self) -> SpillResult<()> {
        if self.failed {
            return Err("migration completion failed".into());
        }
        Ok(())
    }
    fn record<T>(&mut self, result: SpillResult<T>) -> SpillResult<T> {
        if result.is_err() {
            self.failed = true;
        }
        result
    }
}
impl<I: IndexStorage> Drop for CheckpointCapture<'_, I> {
    fn drop(&mut self) {
        self.spill.discard_completion();
    }
}
impl<I: IndexStorage> CheckpointCapture<'_, I> {
    fn load_unchecked(&mut self) -> SpillResult<Option<Vec<u8>>> {
        match &self.saved {
            Some(saved) => Ok(Some(saved.clone())),
            None => self.spill.load(),
        }
    }
    fn save_unchecked(&mut self, b: &[u8]) -> SpillResult<()> {
        if b.len() > super::MAX_CHECKPOINT || self.saved.is_some() {
            return Err("migration completion checkpoint over budget".into());
        }
        self.saved = Some(b.to_vec());
        Ok(())
    }
    fn clear_unchecked(&mut self, g: Generation) -> SpillResult<()> {
        self.spill.clear(g)?;
        let generation = generation(g);
        self.cleared[usize::from(generation)] = true;
        self.claims.retain(|(old, _)| *old != generation);
        self.wrote = true;
        Ok(())
    }
    fn is_claimed_unchecked(&mut self, g: Generation, key: &Hash) -> SpillResult<bool> {
        let generation = generation(g);
        if self.claims.contains(&(generation, key.0)) {
            return Ok(true);
        }
        if self.cleared[usize::from(generation)] {
            return Ok(false);
        }
        self.spill.is_claimed(g, key)
    }
    fn claim_unchecked(&mut self, g: Generation, key: &Hash) -> SpillResult<()> {
        if self.claims.len() >= 512 && !self.claims.contains(&(generation(g), key.0)) {
            return Err("migration completion claims over budget".into());
        }
        self.spill.claim(g, key)?;
        self.claims.insert((generation(g), key.0));
        self.wrote = true;
        Ok(())
    }
    fn put_placement_unchecked(
        &mut self,
        g: Generation,
        key: &Key,
        meta: &Meta,
    ) -> SpillResult<()> {
        self.spill.put_placement(g, key, meta)?;
        self.wrote = true;
        Ok(())
    }
    fn push_deferred_unchecked(
        &mut self,
        g: Generation,
        entity: &PathEntity,
        meta: &Meta,
    ) -> SpillResult<()> {
        self.spill.push_deferred(g, entity, meta)?;
        self.wrote = true;
        Ok(())
    }
    fn deferred_page_unchecked(
        &mut self,
        g: Generation,
        after: Option<&PathEntity>,
        limit: usize,
    ) -> SpillResult<Vec<(PathEntity, Meta)>> {
        if self.wrote {
            return unsupported();
        }
        self.spill.deferred_page(g, after, limit)
    }
    fn placements_page_unchecked(
        &mut self,
        g: Generation,
        after: Option<&Key>,
        limit: usize,
    ) -> SpillResult<Vec<(Key, Meta)>> {
        if self.wrote {
            return unsupported();
        }
        self.spill.placements_page(g, after, limit)
    }
    fn placements_in_bucket_unchecked(
        &mut self,
        g: Generation,
        bits: u64,
        bucket: Option<u64>,
        after: Option<&Key>,
        limit: usize,
    ) -> SpillResult<Vec<(Key, Meta)>> {
        if self.wrote {
            return unsupported();
        }
        self.spill
            .placements_in_bucket(g, bits, bucket, after, limit)
    }
    fn diff_page_unchecked(
        &mut self,
        after: Option<&Key>,
        limit: usize,
    ) -> SpillResult<Vec<DiffRow>> {
        if self.wrote {
            return unsupported();
        }
        self.spill.diff_page(after, limit)
    }
}

macro_rules! checked {
    ($self:ident, $call:expr) => {{
        $self.refuse_if_failed()?;
        let result = $call;
        $self.record(result)
    }};
}
impl<I: IndexStorage> Spill for CheckpointCapture<'_, I> {
    fn load(&mut self) -> SpillResult<Option<Vec<u8>>> {
        checked!(self, self.load_unchecked())
    }
    fn save(&mut self, b: &[u8]) -> SpillResult<()> {
        checked!(self, self.save_unchecked(b))
    }
    fn clear(&mut self, g: Generation) -> SpillResult<()> {
        checked!(self, self.clear_unchecked(g))
    }
    fn is_claimed(&mut self, g: Generation, key: &Hash) -> SpillResult<bool> {
        checked!(self, self.is_claimed_unchecked(g, key))
    }
    fn claim(&mut self, g: Generation, key: &Hash) -> SpillResult<()> {
        checked!(self, self.claim_unchecked(g, key))
    }
    fn put_placement(&mut self, g: Generation, key: &Key, meta: &Meta) -> SpillResult<()> {
        checked!(self, self.put_placement_unchecked(g, key, meta))
    }
    fn push_deferred(
        &mut self,
        g: Generation,
        entity: &PathEntity,
        meta: &Meta,
    ) -> SpillResult<()> {
        checked!(self, self.push_deferred_unchecked(g, entity, meta))
    }
    fn deferred_page(
        &mut self,
        g: Generation,
        after: Option<&PathEntity>,
        limit: usize,
    ) -> SpillResult<Vec<(PathEntity, Meta)>> {
        checked!(self, self.deferred_page_unchecked(g, after, limit))
    }
    fn placements_page(
        &mut self,
        g: Generation,
        after: Option<&Key>,
        limit: usize,
    ) -> SpillResult<Vec<(Key, Meta)>> {
        checked!(self, self.placements_page_unchecked(g, after, limit))
    }
    fn placements_in_bucket(
        &mut self,
        g: Generation,
        bits: u64,
        bucket: Option<u64>,
        after: Option<&Key>,
        limit: usize,
    ) -> SpillResult<Vec<(Key, Meta)>> {
        checked!(
            self,
            self.placements_in_bucket_unchecked(g, bits, bucket, after, limit)
        )
    }
    fn diff_page(&mut self, after: Option<&Key>, limit: usize) -> SpillResult<Vec<DiffRow>> {
        checked!(self, self.diff_page_unchecked(after, limit))
    }
}
