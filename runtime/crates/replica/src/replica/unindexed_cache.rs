//! Device-local bounded byte-validity evidence, never holder/emission authority.
//! This key is not part of Wire snapshot sections or synced state. A malformed,
//! missing or mismatched cache simply causes a complete source re-verification.
use super::AuthenticatedUnindexedSource;
use crate::store::MetaPut;
use mdbn_wire::{
    attachment::FileContent,
    cbor::{self, Cbor},
    schema::Wire,
};
use std::collections::VecDeque;
pub(crate) const KEY: &str = "replica.unindexed_byte_proofs";
const LIMIT: usize = 128;
const MAX_BYTES: usize = 32768;
#[derive(Default)]
pub(crate) struct Cache {
    entries: VecDeque<FileContent>,
}
impl Cache {
    pub(crate) fn load(raw: Option<&[u8]>) -> Self {
        let parse = || {
            let raw = raw?;
            if raw.len() > MAX_BYTES {
                return None;
            }
            let Cbor::Array(top) = cbor::decode(raw).ok()? else {
                return None;
            };
            if top.len() != 2 || top[0] != Cbor::Uint(1) {
                return None;
            }
            let Cbor::Array(entries) = &top[1] else {
                return None;
            };
            if entries.len() > LIMIT {
                return None;
            }
            let entries = entries
                .iter()
                .map(FileContent::from_cbor)
                .collect::<Result<VecDeque<_>, _>>()
                .ok()?;
            Some(Self { entries })
        };
        parse().unwrap_or_default()
    }
    pub(crate) fn hit(&mut self, c: &FileContent) -> bool {
        let Some(i) = self.entries.iter().position(|v| v == c) else {
            return false;
        };
        let known = self.entries.remove(i).expect("located cached descriptor");
        self.entries.push_back(known);
        true
    }
    /// The only insertion seam: an opaque completed whole-source proof, not
    /// host bytes, descriptor shape, manifest authentication or a stored kind.
    pub(crate) fn verified(&mut self, proof: &AuthenticatedUnindexedSource) {
        let c = proof.content();
        if !self.hit(c) {
            self.entries.push_back(c.clone());
        }
        while self.entries.len() > LIMIT {
            self.entries.pop_front();
        }
    }
    pub(crate) fn metadata(&self) -> MetaPut {
        let v = Cbor::Array(vec![
            Cbor::Uint(1),
            Cbor::Array(self.entries.iter().map(Wire::to_cbor).collect()),
        ]);
        let raw = cbor::encode(&v).ok().filter(|b| b.len() <= MAX_BYTES);
        (KEY.into(), raw)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use mdbn_wire::{common::B32, intent::BlobRef};
    fn c(n: u64) -> FileContent {
        FileContent::Blob(BlobRef {
            plain_hash: B32([1; 32]),
            blob_id: B32([2; 32]),
            id_epoch: n,
            size: 1048577,
            part_size: 1048576,
        })
    }
    #[test]
    fn malformed_or_future_or_oversized_cache_is_a_miss() {
        for raw in [
            vec![],
            vec![255],
            vec![0; MAX_BYTES + 1],
            cbor::encode(&Cbor::Array(vec![
                Cbor::Uint(2),
                Cbor::Array(vec![c(1).to_cbor()]),
            ]))
            .unwrap(),
        ] {
            assert!(!Cache::load(Some(&raw)).hit(&c(1)));
        }
    }
    #[test]
    fn complete_descriptor_match_only_and_hit_updates_lru() {
        // Loaded rows stand for device-local evidence written by verified().
        let mut cache = Cache {
            entries: VecDeque::from([c(1), c(2)]),
        };
        assert!(!cache.hit(&c(3)));
        assert!(cache.hit(&c(1)));
        assert_eq!(cache.entries, VecDeque::from([c(2), c(1)]));
        let mut changed = c(1);
        if let FileContent::Blob(b) = &mut changed {
            b.part_size *= 2;
        }
        assert!(!cache.hit(&changed));
        let (_, raw) = cache.metadata();
        assert!(Cache::load(raw.as_deref()).hit(&c(1)));
    }
}
