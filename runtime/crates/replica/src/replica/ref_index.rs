//! Snapshot ref-index objects (`snapshot.md` §2.1, `sealed-envelope.md` §4.3).
//!
//! **Build.** A refs inventory above [`REF_INDEX_THRESHOLD`] addresses is listed
//! in `ref-index` objects instead of directly: the manifest's envelope `refs`
//! and `put_snapshot` name only the index addresses, and the manifest is
//! encoded with `fmt = 2` listing them in key 12. The log service expands the
//! indices when it registers the snapshot, so it retains every listed object.
//! More than the contract's 262,144 addresses is refused, typed
//! ([`SnapshotBlocked::TooManyRefs`]), never truncated.
//!
//! **Install.** After the manifest verifies, every index it names is fetched,
//! checked (content address, collection, well-formed, depth one) and resolved
//! into the complete refs set ([`resolve_verified_refs`]), kept in
//! `Replica::install_refs` for the rest of the install. A missing or malformed
//! index refuses the install before any row is staged.

use std::collections::{BTreeMap, BTreeSet};

use mdbn_wire::common::{B32, Hash, Uuid};
use mdbn_wire::envelope::ItemKind;
use mdbn_wire::log_service::{ReadParams, SnapshotPointer};
use mdbn_wire::ref_index::{
    MAX_REF_INDEX_ENTRIES, MAX_REF_INDICES, open_ref_index, pack_ref_indices,
};

mod budget;

/// Verified compact members only; no untrusted encoded body survives a response.
#[derive(Debug, Clone)]
pub(crate) struct VerifiedRefIndex(Vec<Hash>);

const MAX_RESOLVED_REFS: usize = MAX_REF_INDICES * MAX_REF_INDEX_ENTRIES;
const MAX_REF_INSTALL_BYTES: usize = 64 << 20;

fn verify_index(
    collection: &Uuid,
    address: &Hash,
    bytes: &[u8],
    indices: &[Hash],
) -> Result<VerifiedRefIndex, &'static str> {
    if bytes.len() > budget::MAX_OBJECT_BYTES {
        return Err("ref-index object byte budget");
    }
    if mdbn_wire::hash::sha256(bytes) != *address {
        return Err("ref-index object does not verify");
    }
    budget::preflight(bytes)?;
    let members = open_ref_index(collection, address, bytes)
        .map_err(|_| "ref-index object does not verify")?;
    if members.iter().any(|m| indices.contains(m)) {
        return Err("ref-index object lists a ref-index object");
    }
    Ok(VerifiedRefIndex(members))
}

fn check_indices(item_refs: &[Hash], indices: &[Hash]) -> Result<(), &'static str> {
    if indices.is_empty()
        || indices.len() > MAX_REF_INDICES
        || !indices.windows(2).all(|w| w[0] < w[1])
        || item_refs.len() > MAX_RESOLVED_REFS
    {
        return Err("ref-index inventory budget or ordering");
    }
    if indices.iter().any(|index| !item_refs.contains(index)) {
        return Err("ref-index object not among the manifest refs");
    }
    Ok(())
}

/// Charged ref-install peak, including retained capacities, single request slots,
/// incoming/decode/candidate workspace and final tree conversion. This is an
/// explicit subsystem budget, not a claim about the complete runtime's RSS.
fn check_install_budget(
    manifest: &ManifestPayload,
    item_refs: &Vec<Hash>,
    indices: &Vec<Hash>,
    fetched: &BTreeMap<Hash, VerifiedRefIndex>,
    incoming: usize,
) -> Result<(), &'static str> {
    let members = fetched
        .values()
        .try_fold(0usize, |n, members| n.checked_add(members.0.len()))
        .ok_or("ref-index retained budget")?;
    if members > MAX_RESOLVED_REFS || incoming > budget::MAX_OBJECT_BYTES {
        return Err("ref-index retained budget");
    }
    let chunks = manifest
        .sections
        .iter()
        .try_fold(0usize, |n, section| {
            n.checked_add(
                section
                    .chunks
                    .capacity()
                    .checked_mul(std::mem::size_of::<mdbn_wire::snapshot::ChunkRef>())?,
            )
        })
        .ok_or("ref-index metadata budget")?;
    let retained = fetched
        .values()
        .try_fold(0usize, |n, members| {
            n.checked_add(
                members
                    .0
                    .capacity()
                    .checked_mul(std::mem::size_of::<Hash>())?,
            )
        })
        .ok_or("ref-index retained budget")?;
    let final_refs = item_refs
        .len()
        .checked_add(members)
        .ok_or("ref-index retained budget")?
        .min(MAX_RESOLVED_REFS);
    let charges = [
        Some(std::mem::size_of::<ManifestPayload>()),
        Some(chunks),
        manifest
            .sections
            .capacity()
            .checked_mul(std::mem::size_of::<mdbn_wire::attachment_runtime_v1::Section>()),
        item_refs
            .capacity()
            .checked_mul(std::mem::size_of::<Hash>()),
        indices.capacity().checked_mul(std::mem::size_of::<Hash>()),
        fetched.len().checked_mul(256), // tree key/node/entry allowance
        Some(retained),
        final_refs.checked_mul(128), // final BTreeSet allowance
        incoming.checked_mul(4),
        Some(256 << 10), // bounded decoder structure
        Some(MAX_REF_INDEX_ENTRIES * std::mem::size_of::<Hash>()), // candidate
        Some(2048),      // one queued request and one inflight entry
    ];
    let total = charges
        .into_iter()
        .try_fold(0usize, |n, charge| n.checked_add(charge?))
        .ok_or("ref-index install byte budget")?;
    if total > MAX_REF_INSTALL_BYTES {
        return Err("ref-index install byte budget");
    }
    Ok(())
}

fn resolve_verified_refs(
    item_refs: &[Hash],
    indices: &[Hash],
    fetched: BTreeMap<Hash, VerifiedRefIndex>,
) -> Result<BTreeSet<Hash>, &'static str> {
    check_indices(item_refs, indices)?;
    let mut out: BTreeSet<Hash> = item_refs
        .iter()
        .filter(|r| !indices.contains(r))
        .copied()
        .collect();
    if fetched.len() != indices.len() || indices.iter().any(|i| !fetched.contains_key(i)) {
        return Err("ref-index object not fetched");
    }
    // Consume each compact vector while converting, never duplicate all vectors.
    for members in fetched.into_values() {
        for member in members.0 {
            if !out.contains(&member) && out.len() == MAX_RESOLVED_REFS {
                return Err("ref-index resolved inventory budget");
            }
            out.insert(member);
        }
    }
    Ok(out)
}

use super::Replica;
use super::append::Inflight;
use super::snapshot::{Install, SnapshotBlocked, Upload};
use crate::log::LogRequest;
use crate::store::Store;
use mdbn_wire::attachment_runtime_v1::ManifestPayload;

/// Direct refs at most: comfortably inside one request's node budget (about
/// 3,950 refs), so a direct snapshot never meets the frame cap.
pub const REF_INDEX_THRESHOLD: usize = 2048;

/// The complete refs set of a snapshot: its envelope `refs` minus the
/// ref-index objects, plus every address those indices list. `fetched` holds
/// each index's stored bytes. Fails closed: an index that is not among the
/// envelope refs, missing, malformed, of another collection, or that lists an
/// index (depth one).
#[cfg(test)]
pub fn resolve_snapshot_refs(
    collection: &Uuid,
    item_refs: &[Hash],
    ref_indices: &[Hash],
    fetched: &BTreeMap<Hash, Vec<u8>>,
) -> Result<BTreeSet<Hash>, &'static str> {
    if ref_indices.is_empty() {
        if item_refs.len() > MAX_RESOLVED_REFS {
            return Err("ref-index resolved inventory budget");
        }
        return Ok(item_refs.iter().copied().collect());
    }
    check_indices(item_refs, ref_indices)?;
    let mut verified = BTreeMap::new();
    for a in ref_indices {
        let bytes = fetched.get(a).ok_or("ref-index object not fetched")?;
        verified.insert(*a, verify_index(collection, a, bytes, ref_indices)?);
    }
    resolve_verified_refs(item_refs, ref_indices, verified)
}

/// The direct refs, or the ref-index objects to upload in their place.
pub(super) struct Indexed {
    /// What the envelope `refs` and `put_snapshot` name.
    pub(super) refs: Vec<B32>,
    /// Manifest key 12 (empty: fmt 1).
    pub(super) ref_indices: Vec<Hash>,
    /// Index objects to upload.
    pub(super) uploads: Vec<Upload>,
}

/// Index `refs` (sorted, distinct) when they exceed [`REF_INDEX_THRESHOLD`].
pub(super) fn index_refs(collection: Uuid, refs: Vec<B32>) -> Result<Indexed, SnapshotBlocked> {
    if refs.len() <= REF_INDEX_THRESHOLD {
        return Ok(Indexed {
            refs,
            ref_indices: Vec::new(),
            uploads: Vec::new(),
        });
    }
    let packed = pack_ref_indices(collection, &refs).map_err(|_| SnapshotBlocked::TooManyRefs {
        refs: refs.len() as u64,
    })?;
    let mut ref_indices: Vec<Hash> = packed.iter().map(|(a, _)| *a).collect();
    ref_indices.sort();
    ref_indices.dedup();
    Ok(Indexed {
        refs: ref_indices.clone(),
        ref_indices,
        uploads: packed
            .into_iter()
            .map(|(address, bytes)| Upload {
                address,
                kind: ItemKind::RefIndex,
                bytes,
            })
            .collect(),
    })
}

impl<S: Store> Replica<S> {
    /// The manifest verified: fetch its ref-index objects, if any, then check
    /// its chain against the log.
    pub(super) fn install_after_manifest(
        &mut self,
        p: SnapshotPointer,
        m: Box<ManifestPayload>,
        item_refs: Vec<Hash>,
        ref_indices: Vec<Hash>,
    ) {
        if ref_indices.is_empty() {
            self.install_refs = Some(item_refs.into_iter().collect());
            return self.request_install_chain(p, m);
        }
        // Only the completed verified union becomes an install source closure.
        // Do not retain a prior/header preview tree beside charged fmt-2 state.
        self.install_refs = None;
        // Hosted isolates already carry two engines/READ working sets. The
        // native ref-install budget is not authority to spend that shared heap.
        // Refuse fmt-2 until a stricter hosted composition is qualified.
        if self.hosted.is_some() {
            return self.install_fail("hosted_ref_index_install_unqualified");
        }
        if let Err(why) = check_indices(&item_refs, &ref_indices)
            .and_then(|_| check_install_budget(&m, &item_refs, &ref_indices, &BTreeMap::new(), 0))
        {
            return self.install_fail(why);
        }
        self.install = Some(Install::RefIndices {
            p,
            m,
            item_refs,
            ref_indices,
            fetched: BTreeMap::new(),
        });
        self.request_next_ref_index();
    }

    /// Ask for the next ref-index object not yet fetched.
    pub(super) fn request_next_ref_index(&mut self) {
        // Enforce the scratch/request reservation even if a retry/tick asks
        // again while the preceding install request is still outstanding.
        if self
            .inflight
            .values()
            .any(|kind| *kind == Inflight::Install)
        {
            return;
        }
        let Some(Install::RefIndices {
            ref_indices,
            fetched,
            ..
        }) = &self.install
        else {
            return;
        };
        let Some(next) = ref_indices
            .iter()
            .find(|a| !fetched.contains_key(*a))
            .copied()
        else {
            return;
        };
        let id = self.queue(LogRequest::GetObject {
            collection: self.cfg.collection,
            address: next,
            range: None,
        });
        self.inflight.insert(id, Inflight::Install);
    }

    /// One ref-index object arrived; when all have, resolve the complete refs.
    pub(super) fn on_ref_index_object(&mut self, state: Install, bytes: Vec<u8>) {
        let Install::RefIndices {
            p,
            m,
            item_refs,
            ref_indices,
            mut fetched,
        } = state
        else {
            return;
        };
        let Some(next) = ref_indices
            .iter()
            .find(|a| !fetched.contains_key(*a))
            .copied()
        else {
            return;
        };
        if let Err(why) =
            check_install_budget(&m, &item_refs, &ref_indices, &fetched, bytes.capacity())
        {
            return self.install_fail(why);
        }
        let members = match verify_index(&self.cfg.collection, &next, &bytes, &ref_indices) {
            Ok(members) => members,
            Err(why) => return self.install_fail(why),
        };
        drop(bytes);
        fetched.insert(next, members);
        if let Err(why) = check_install_budget(&m, &item_refs, &ref_indices, &fetched, 0) {
            return self.install_fail(why);
        }
        if fetched.len() < ref_indices.len() {
            self.install = Some(Install::RefIndices {
                p,
                m,
                item_refs,
                ref_indices,
                fetched,
            });
            return self.request_next_ref_index();
        }
        match resolve_verified_refs(&item_refs, &ref_indices, fetched) {
            Ok(all) => {
                self.install_refs = Some(all);
                self.request_install_chain(p, m);
            }
            Err(why) => self.install_fail(why),
        }
    }

    /// Check the manifest's chain against the item after it.
    pub(super) fn request_install_chain(&mut self, p: SnapshotPointer, m: Box<ManifestPayload>) {
        let id = self.queue(LogRequest::Read(ReadParams {
            collection: self.cfg.collection,
            after: m.seq,
            limit: 1,
            kinds: None,
            max_bytes: None,
        }));
        self.inflight.insert(id, Inflight::Install);
        self.install = Some(Install::Chain(p, m));
    }
}

#[cfg(test)]
#[path = "ref_index/runtime_tests.rs"]
mod runtime_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use mdbn_wire::common::B16;
    use mdbn_wire::ref_index::ref_index_item;
    use mdbn_wire::schema::Wire;

    const C: Uuid = B16([3; 16]);

    fn a(i: u64) -> B32 {
        let mut h = [0u8; 32];
        h[..8].copy_from_slice(&i.to_be_bytes());
        h[31] = 7;
        B32(h)
    }

    #[test]
    fn small_inventories_stay_direct_and_large_ones_resolve_completely() {
        let small: Vec<B32> = (0..REF_INDEX_THRESHOLD as u64).map(a).collect();
        let x = index_refs(C, small.clone()).unwrap();
        assert_eq!(x.refs, small);
        assert!(x.ref_indices.is_empty() && x.uploads.is_empty());

        let big: Vec<B32> = (0..20_000).map(a).collect();
        let x = index_refs(C, big.clone()).unwrap();
        assert_eq!(x.refs, x.ref_indices);
        assert_eq!(x.uploads.len(), 3);
        let fetched: BTreeMap<Hash, Vec<u8>> = x
            .uploads
            .iter()
            .map(|u| (u.address, u.bytes.clone()))
            .collect();
        let all = resolve_snapshot_refs(&C, &x.refs, &x.ref_indices, &fetched).unwrap();
        assert_eq!(all, big.into_iter().collect());

        let over: Vec<B32> = (0..262_145).map(a).collect();
        assert_eq!(
            index_refs(C, over).err(),
            Some(SnapshotBlocked::TooManyRefs { refs: 262_145 })
        );
    }

    fn manifest() -> ManifestPayload {
        use mdbn_wire::{common::Version, snapshot::Horizon};
        ManifestPayload {
            seq: 1,
            chain: a(1),
            state_digest: a(2),
            bucket_bits: 0,
            sections: vec![],
            horizon: Horizon {
                seq_floor: 0,
                time_floor: 0,
            },
            sem: Version { major: 1, minor: 0 },
            record_count: 0,
            file_count: 0,
            previous: None,
            control_chain: a(3),
        }
    }

    #[test]
    fn verified_state_keeps_members_not_raw_bodies_and_accounts_peak_conversion() {
        let refs: Vec<_> = (0..MAX_RESOLVED_REFS as u64).map(a).collect();
        let packed = pack_ref_indices(C, &refs).unwrap();
        let mut indices: Vec<_> = packed.iter().map(|(a, _)| *a).collect();
        indices.sort();
        let mut verified = BTreeMap::new();
        let m = manifest();
        for (address, raw) in packed {
            check_install_budget(&m, &indices, &indices, &verified, raw.len()).unwrap();
            let members = verify_index(&C, &address, &raw, &indices).unwrap();
            assert_eq!(members.0.len(), MAX_REF_INDEX_ENTRIES);
            drop(raw);
            verified.insert(address, members);
            check_install_budget(&m, &indices, &indices, &verified, 0).unwrap();
        }
        assert_eq!(
            verified.values().map(|m| m.0.len()).sum::<usize>(),
            MAX_RESOLVED_REFS
        );
        let all = resolve_verified_refs(&indices, &indices, verified).unwrap();
        assert_eq!(all.len(), MAX_RESOLVED_REFS);
        assert_eq!(all, refs.into_iter().collect());
    }

    #[test]
    fn incoming_and_cumulative_metadata_budgets_refuse_before_admission() {
        let indices = vec![a(1)];
        let mut m = manifest();
        assert!(
            check_install_budget(
                &m,
                &indices,
                &indices,
                &BTreeMap::new(),
                budget::MAX_OBJECT_BYTES
            )
            .is_ok()
        );
        assert!(
            check_install_budget(
                &m,
                &indices,
                &indices,
                &BTreeMap::new(),
                budget::MAX_OBJECT_BYTES + 1
            )
            .is_err()
        );
        // Retained capacity is charged even when the vector is currently empty.
        let metadata =
            Vec::<Hash>::with_capacity(MAX_REF_INSTALL_BYTES / std::mem::size_of::<Hash>());
        assert!(check_install_budget(&m, &metadata, &indices, &BTreeMap::new(), 0).is_err());
        m.sections = Vec::with_capacity(
            MAX_REF_INSTALL_BYTES
                / std::mem::size_of::<mdbn_wire::attachment_runtime_v1::Section>(),
        );
        assert!(check_install_budget(&m, &indices, &indices, &BTreeMap::new(), 0).is_err());
    }

    #[test]
    fn resolution_fails_closed() {
        let one = ref_index_item(C, &[a(1), a(2)])
            .unwrap()
            .to_bytes()
            .unwrap();
        let ia = mdbn_wire::hash::sha256(&one);
        let mut fetched = BTreeMap::from([(ia, one.clone())]);
        // Not named among the envelope refs.
        assert!(resolve_snapshot_refs(&C, &[a(9)], &[ia], &fetched).is_err());
        // Not fetched.
        assert!(resolve_snapshot_refs(&C, &[ia], &[ia], &BTreeMap::new()).is_err());
        // Bytes that do not hash to the address.
        let mut bad = one.clone();
        *bad.last_mut().unwrap() ^= 1;
        fetched.insert(ia, bad);
        assert!(resolve_snapshot_refs(&C, &[ia], &[ia], &fetched).is_err());
        // Another collection.
        let other = ref_index_item(B16([4; 16]), &[a(1)])
            .unwrap()
            .to_bytes()
            .unwrap();
        let oa = mdbn_wire::hash::sha256(&other);
        fetched.insert(oa, other);
        assert!(resolve_snapshot_refs(&C, &[oa], &[oa], &fetched).is_err());
        // Depth two: an index listing an index.
        fetched.insert(ia, one);
        let mut pair = vec![ia, a(5)];
        pair.sort();
        let deep = ref_index_item(C, &pair).unwrap().to_bytes().unwrap();
        let da = mdbn_wire::hash::sha256(&deep);
        fetched.insert(da, deep);
        let mut both = vec![ia, da];
        both.sort();
        assert_eq!(
            resolve_snapshot_refs(&C, &both, &both, &fetched),
            Err("ref-index object lists a ref-index object")
        );
        // Direct refs pass through unchanged.
        let all = resolve_snapshot_refs(&C, &[a(7), ia], &[ia], &fetched).unwrap();
        assert_eq!(all, BTreeSet::from([a(1), a(2), a(7)]));
    }
}
