//! Complete canonical native roots for snapshot build/install. Root collection
//! and object inventory are not plaintext/kind/holder authority proofs.
use super::Replica;
use crate::store::{Page, Store, StoreError, TombstoneLast};
use mdbn_wire::{
    attachment::FileContent, attachment_runtime_v1 as rt, common::Hash, schema::Wire,
    unindexed_markdown::FileKindV1,
};
use std::collections::{BTreeMap, BTreeSet};
#[derive(Default)]
pub(crate) struct Roots(BTreeMap<Vec<u8>, FileContent>);
impl Roots {
    pub(crate) fn add(&mut self, c: &FileContent) -> Result<(), StoreError> {
        let key = c
            .to_bytes()
            .map_err(|_| StoreError::Corrupt("native root descriptor".into()))?;
        self.0.insert(key, c.clone());
        Ok(())
    }
    pub(crate) fn collect(s: &dyn Store) -> Result<Self, StoreError> {
        let mut roots = Self::default();
        let mut after = None;
        loop {
            let rows = s.files(Page { after, limit: 1024 })?;
            let Some(last) = rows.last() else {
                break;
            };
            after = Some(last.id);
            for f in rows {
                if f.kind == FileKindV1::UnindexedOversizedMarkdown {
                    roots.add(&f.content)?;
                }
            }
        }
        let mut after = None;
        loop {
            let rows = s.tombstones(Page { after, limit: 1024 })?;
            let Some(last) = rows.last() else {
                break;
            };
            after = Some(last.id);
            for t in rows {
                if let TombstoneLast::UnindexedMarkdown(p) = t.last {
                    roots.add(&p.content)?;
                }
            }
        }
        for row in s.conflicts(None)? {
            for side in [
                Some(&row.conflict.kept),
                Some(&row.conflict.lost),
                row.conflict.base.as_ref(),
            ]
            .into_iter()
            .flatten()
            {
                if let rt::ConflictValue::UnindexedMarkdown(p) = side {
                    roots.add(&p.content)?;
                }
            }
        }
        Ok(roots)
    }
    pub(crate) fn descriptors(&self) -> impl Iterator<Item = &FileContent> {
        self.0.values()
    }
}
/// Object closure result: missing inventories cause a retry, never partial refs.
pub(crate) enum Inventory {
    Complete(Vec<Hash>),
    Pending(Vec<mdbn_wire::attachment::AttachmentContentV1>),
}
impl<S: Store> Replica<S> {
    pub(crate) fn native_snapshot_inventory(&self, roots: &Roots) -> Result<Inventory, StoreError> {
        let mut refs = BTreeSet::new();
        let mut pending = Vec::new();
        for c in roots.descriptors() {
            if !self.unindexed_content_in_bounds(c) {
                return Err(StoreError::Corrupt(
                    "native snapshot descriptor bounds".into(),
                ));
            }
            match c {
                FileContent::Blob(b) => {
                    let addresses = self
                        .sealer
                        .blob_part_addresses(b)
                        .ok_or_else(|| StoreError::Io("native snapshot key unavailable".into()))?;
                    let expected = b.size.div_ceil(b.part_size);
                    if addresses.len() as u64 != expected
                        || addresses.iter().copied().collect::<BTreeSet<_>>().len()
                            != addresses.len()
                    {
                        return Err(StoreError::Corrupt(
                            "native snapshot Blob part inventory".into(),
                        ));
                    }
                    refs.extend(addresses);
                }
                FileContent::AttachmentV1(a) => {
                    match self.attachment_inventory(&a.reference.manifest_cipher_hash)? {
                        Some(objects) => {
                            if objects.len() < 2
                                || objects.len() > super::attachment_upload::MAX_REFS
                                || !objects.windows(2).all(|w| w[0] < w[1])
                                || objects
                                    .binary_search(&a.reference.manifest_cipher_hash)
                                    .is_err()
                            {
                                return Err(StoreError::Corrupt(
                                    "native snapshot attachment inventory".into(),
                                ));
                            }
                            refs.extend(objects);
                        }
                        None => pending.push(a.clone()),
                    }
                }
                _ => return Err(StoreError::Corrupt("unknown native content profile".into())),
            }
        }
        if pending.is_empty() {
            Ok(Inventory::Complete(refs.into_iter().collect()))
        } else {
            Ok(Inventory::Pending(pending))
        }
    }
}
