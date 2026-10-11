//! Capture Driver.complete's checkpoint without committing ahead of settlement.
//! Initial settlement adapters are checkpoint/RAM-only; metadata-page mutations
//! refuse rather than escaping the atomic settlement transaction.
use mdbn_migrate_portable::hosted_import::{DiffRow, Generation, Key, Meta, Spill};
type SpillResult<T> = std::result::Result<T, String>;
use mdbn_migrate_portable::preflight::PathEntity;
use mdbn_wire::common::Hash;
pub(super) struct CheckpointCapture<'a> {
    spill: &'a mut dyn Spill,
    pub(super) saved: Option<Vec<u8>>,
}
impl<'a> CheckpointCapture<'a> {
    pub(super) fn new(spill: &'a mut dyn Spill) -> Self {
        Self { spill, saved: None }
    }
}
fn unsupported<T>() -> SpillResult<T> {
    Err("migration completion needs atomic metadata adapter".into())
}
impl Spill for CheckpointCapture<'_> {
    fn load(&mut self) -> SpillResult<Option<Vec<u8>>> {
        self.spill.load()
    }
    fn save(&mut self, b: &[u8]) -> SpillResult<()> {
        if b.len() > super::MAX_CHECKPOINT || self.saved.is_some() {
            return unsupported();
        }
        self.saved = Some(b.to_vec());
        Ok(())
    }
    fn clear(&mut self, _g: Generation) -> SpillResult<()> {
        unsupported()
    }
    fn is_claimed(&mut self, _g: Generation, _key: &Hash) -> SpillResult<bool> {
        unsupported()
    }
    fn claim(&mut self, _g: Generation, _key: &Hash) -> SpillResult<()> {
        unsupported()
    }
    fn put_placement(&mut self, _g: Generation, _key: &Key, _meta: &Meta) -> SpillResult<()> {
        unsupported()
    }
    fn push_deferred(
        &mut self,
        _g: Generation,
        _entity: &PathEntity,
        _meta: &Meta,
    ) -> SpillResult<()> {
        unsupported()
    }
    fn deferred_page(
        &mut self,
        _g: Generation,
        _after: Option<&PathEntity>,
        _limit: usize,
    ) -> SpillResult<Vec<(PathEntity, Meta)>> {
        unsupported()
    }
    fn placements_page(
        &mut self,
        _g: Generation,
        _after: Option<&Key>,
        _limit: usize,
    ) -> SpillResult<Vec<(Key, Meta)>> {
        unsupported()
    }
    fn placements_in_bucket(
        &mut self,
        _g: Generation,
        _bits: u64,
        _bucket: Option<u64>,
        _after: Option<&Key>,
        _limit: usize,
    ) -> SpillResult<Vec<(Key, Meta)>> {
        unsupported()
    }
    fn diff_page(&mut self, _after: Option<&Key>, _limit: usize) -> SpillResult<Vec<DiffRow>> {
        unsupported()
    }
}
