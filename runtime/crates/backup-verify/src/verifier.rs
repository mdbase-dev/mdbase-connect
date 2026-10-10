//! Pure feed-only cut verification. No filesystem, backend or serving authority.
use crate::{
    Refusal,
    completion::{self, Completion, Trust},
    header::Header,
    memory::{Owned, poison, scratch},
    memory_vec::OwnedVec,
    pages::PageCursor,
    rows,
};
use mdbn_log_service::{
    Code, OfflineDecodeBudget, OfflineOwnedReservation, OfflineReplayVerifier, ServiceError,
    model::{ObjectMeta, SnapshotRow},
    restore_plan::InventoryDigest,
};
use mdbn_wire::{
    cbor::{self, Cbor},
    common::{B32, Uuid},
    envelope::{Item, ItemKind},
    ref_index::{MAX_REF_INDEX_ENTRIES, MAX_REF_INDICES, ref_index_addresses},
    schema::Wire,
};

const ITEMS: usize = 2_097_152;
const REFS: usize = 6_553_600; // at most65536 bounded100-row pages; memory may refuse sooner
const SNAP_REFS: usize = 32768;
#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Header,
    Pages,
    Objects,
}
struct Snapshot {
    meta: SnapshotRow,
    refs: OwnedVec<B32>,
    direct: OwnedVec<B32>,
    seen: bool,
}
struct Index {
    address: B32,
    members: OwnedVec<B32>,
}

/// Historical capture verification only. Feed exact original bytes in phase
/// order; every failure irreversibly poisons the same invocation ledger.
pub struct CutVerifier {
    trust: Trust,
    completion: Completion,
    cursor: Option<PageCursor>,
    replay: Option<OfflineReplayVerifier>,
    objects: OwnedVec<ObjectMeta>,
    snapshots: OwnedVec<Snapshot>,
    expected_refs: OwnedVec<rows::RefRow>,
    actual_refs: OwnedVec<rows::RefRow>,
    retained: OwnedVec<u64>,
    expected_tokens: OwnedVec<(Uuid, u64)>,
    tokens: OwnedVec<rows::TokenRow>,
    indices: OwnedVec<Index>,
    item_root: Option<InventoryDigest>,
    items: u64,
    item_bytes: u64,
    object_bytes: u64,
    next_object: usize,
    last_nonce: Option<B32>,
    last_item: Option<(u64, B32)>,
    metadata_refs_invalid: bool,
    metadata_inventory_invalid: bool,
    phase: Phase,
    failed: bool,
    work: OfflineDecodeBudget,
    // Fixed bookkeeping/digest scratch; data fields destroy before allowance.
    _baseline: OfflineOwnedReservation,
}
/// Content-free completed counts. This is never a current-authority permit.
pub struct Verified {
    items: u64,
    objects: u64,
    object_bytes: u64,
}
impl Verified {
    /// Exact single success line frozen by the native verifier contract.
    pub fn json_line(&self) -> String {
        format!(
            "{{\"verified\":true,\"items\":{},\"objects\":{},\"object_bytes\":{},\"current_authority_verified\":false}}\n",
            self.items, self.objects, self.object_bytes
        )
    }
}
fn service(error: ServiceError, fallback: Refusal) -> Refusal {
    if error.code == Code::TooLarge
        || error
            .reason
            .as_deref()
            .is_some_and(|reason| reason.starts_with("cbor_") && !matches!(reason, "cbor_shape"))
    {
        Refusal::Bounds
    } else if error.reason.as_deref() == Some("signature") {
        Refusal::Signature
    } else {
        fallback
    }
}
impl CutVerifier {
    /// Authenticate caller-frozen trust/completion BEFORE any bulk input.
    pub fn new(
        trust: &[u8],
        completion: &[u8],
        work: &OfflineDecodeBudget,
    ) -> Result<Self, Refusal> {
        let result = (|| {
            let baseline = work
                .reserve_owned(1024 * 1024)
                .map_err(|_| Refusal::Bounds)?;
            let trust = Trust::parse(trust, work)?;
            let completion = Completion::authenticate(completion, &trust, work)?;
            Ok(Self {
                trust,
                completion,
                cursor: None,
                replay: None,
                objects: OwnedVec::new(work, 65536),
                snapshots: OwnedVec::new(work, 64),
                expected_refs: OwnedVec::new(work, REFS),
                actual_refs: OwnedVec::new(work, REFS),
                retained: OwnedVec::new(work, ITEMS),
                expected_tokens: OwnedVec::new(work, ITEMS),
                tokens: OwnedVec::new(work, REFS),
                indices: OwnedVec::new(work, 65536),
                item_root: Some(InventoryDigest::items()),
                items: 0,
                item_bytes: 0,
                object_bytes: 0,
                next_object: 0,
                last_nonce: None,
                last_item: None,
                metadata_refs_invalid: false,
                metadata_inventory_invalid: false,
                phase: Phase::Header,
                failed: false,
                work: work.clone(),
                _baseline: baseline,
            })
        })();
        if result.is_err() {
            poison(work);
        }
        result
    }
    /// Authenticated resource count for layout admission, not a verified cut.
    pub fn expected_pages(&self) -> u64 {
        self.completion.page_count
    }
    /// Authenticated resource count for layout admission, not permission.
    pub fn expected_objects(&self) -> u64 {
        self.completion.object_count
    }
    fn active(&self, phase: Phase) -> Result<(), Refusal> {
        let _alive = self.work.reserve_owned(0).map_err(|_| Refusal::Bounds)?;
        if self.failed || self.phase != phase {
            return Err(Refusal::Binding);
        }
        Ok(())
    }
    fn record<T>(&mut self, result: Result<T, Refusal>) -> Result<T, Refusal> {
        if result.is_err() {
            self.failed = true;
            poison(&self.work);
        }
        result
    }
    /// Bind exact source header and actual successful FINISH tuple.
    pub fn bind_header(&mut self, header: &[u8], finish: &[u8]) -> Result<(), Refusal> {
        let result = (|| {
            self.active(Phase::Header)?;
            let header = Header::bind(header, finish, &self.trust, &self.completion, &self.work)?;
            self.replay = Some(
                OfflineReplayVerifier::new(
                    self.trust.collection,
                    header.retained_from,
                    &self.trust.roots,
                    &self.work,
                )
                .map_err(|error| service(error, Refusal::History))?,
            );
            self.cursor = Some(PageCursor::new(
                header,
                self.completion.page_count,
                self.completion.final_hash,
                &self.work,
            ));
            self.phase = Phase::Pages;
            Ok(())
        })();
        self.record(result)
    }
    /// Feed one original page. No signed-item byte inventory is retained.
    pub fn push_page(&mut self, raw: &[u8]) -> Result<(), Refusal> {
        let result = (|| {
            self.active(Phase::Pages)?;
            let page = self.cursor.as_mut().ok_or(Refusal::Binding)?.push(raw)?;
            for row in page.rows.iter() {
                self.row(page.section, row)?;
            }
            Ok(())
        })();
        self.record(result)
    }
    fn row(&mut self, section: u64, row: &Cbor) -> Result<(), Refusal> {
        match section {
            1 => self.item(row),
            2 => {
                let meta = rows::snapshot(row, self.completion.plan.head)?;
                self.snapshots.push(Snapshot {
                    meta,
                    refs: OwnedVec::new(&self.work, SNAP_REFS),
                    direct: OwnedVec::new(&self.work, SNAP_REFS),
                    seen: false,
                })
            }
            3 => {
                let edge = rows::reference(row, self.completion.plan.head)?;
                if edge.kind == 0 {
                    self.actual_refs.push(edge)
                } else {
                    let snapshot = self
                        .snapshots
                        .iter_mut()
                        .find(|snapshot| snapshot.meta.seq == edge.holder)
                        .ok_or(Refusal::Refs)?;
                    snapshot.refs.push(edge.address)
                }
            }
            4 => {
                let meta = rows::object(row)?;
                if self
                    .objects
                    .last()
                    .is_some_and(|previous| previous.address >= meta.address)
                {
                    return Err(Refusal::Inventory);
                }
                self.object_bytes = self
                    .object_bytes
                    .checked_add(meta.size)
                    .filter(|bytes| *bytes <= completion::MAX_OBJECT_BYTES)
                    .ok_or(Refusal::Bounds)?;
                self.objects.push(meta)
            }
            5 => {
                let token = rows::token(row, self.completion.plan.head)?;
                if self
                    .tokens
                    .last()
                    .is_some_and(|previous| previous.token >= token.token)
                {
                    return Err(Refusal::Inventory);
                }
                self.tokens.push(token)
            }
            6 => {
                let nonce = rows::nonce(row)?;
                if self
                    .last_nonce
                    .is_some_and(|previous| previous >= nonce.nonce)
                {
                    return Err(Refusal::Inventory);
                }
                self.last_nonce = Some(nonce.nonce);
                let _captured_expiry = nonce.expires_at; // traversed, NEVER restored/permission
                Ok(())
            }
            _ => Err(Refusal::Pages),
        }
    }
    fn item(&mut self, row: &Cbor) -> Result<(), Refusal> {
        let row = rows::item(row, self.completion.plan.head)?;
        if row.seq == 1 && completion::hash(row.bytes, &self.work)? != self.trust.genesis {
            return Err(Refusal::Trust);
        }
        self.replay
            .as_mut()
            .ok_or(Refusal::Binding)?
            .push(row.seq, row.bytes)
            .map_err(|error| service(error, Refusal::History))?;
        let item = Owned::construct(&self.work, scratch(row.bytes.len())?, || {
            self.work
                .request()
                .wire::<Item>(row.bytes)
                .map_err(|error| service(error, Refusal::History))
        })?;
        if item.kind.value() != row.kind {
            return Err(Refusal::History);
        }
        for address in item.refs.iter().flatten() {
            self.expected_refs.push(rows::RefRow {
                kind: 0,
                holder: row.seq,
                address: *address,
            })?;
        }
        if let Some(token) = item.idem {
            self.expected_tokens.push((token, row.seq))?;
        }
        self.retained.push(row.seq)?;
        self.items = self
            .items
            .checked_add(1)
            .filter(|items| *items <= ITEMS as u64)
            .ok_or(Refusal::Bounds)?;
        self.item_bytes = self
            .item_bytes
            .checked_add(row.bytes.len() as u64)
            .ok_or(Refusal::Bounds)?;
        self.work
            .request()
            .preflight(row.bytes)
            .map_err(|_| Refusal::Bounds)?; // inventory's whole-byte SHA
        charge(
            &self.work,
            &Cbor::Array(vec![Cbor::Uint(row.seq), B32([0; 32]).to_cbor()]),
        )?;
        self.item_root
            .as_mut()
            .ok_or(Refusal::Binding)?
            .item(row.seq, row.bytes)
            .map_err(|_| Refusal::Inventory)?;
        self.work
            .request()
            .preflight(row.bytes)
            .map_err(|_| Refusal::Bounds)?;
        self.last_item = Some((row.seq, mdbn_wire::hash::chain_hash(row.bytes)));
        let _captured_time = row.created_at;
        Ok(())
    }
    /// Seal all six explicit terminals and match retained metadata links.
    pub fn finish_pages(&mut self) -> Result<(), Refusal> {
        let result = (|| {
            self.active(Phase::Pages)?;
            self.cursor.take().ok_or(Refusal::Binding)?.finish()?;
            self.expected_refs.sort_unique();
            self.actual_refs.sort_unstable();
            if self.last_item != Some((self.completion.plan.head, self.completion.plan.chain)) {
                return Err(Refusal::History);
            }
            self.metadata_refs_invalid = self.actual_refs.windows(2).any(|pair| pair[0] == pair[1])
                || *self.expected_refs != *self.actual_refs;
            for edge in self.expected_refs.iter() {
                if self.object_meta(&edge.address).is_none() {
                    self.metadata_refs_invalid = true;
                }
            }
            self.expected_tokens.sort_unstable();
            let mut next = 0;
            for actual in self.tokens.iter() {
                if self
                    .expected_tokens
                    .get(next)
                    .is_some_and(|expected| expected.0 == actual.token && expected.1 == actual.seq)
                {
                    next += 1;
                } else if actual.seq >= self.completion.plan.retained_from
                    || self.retained.binary_search(&actual.seq).is_ok()
                {
                    self.metadata_inventory_invalid = true;
                }
            }
            if next != self.expected_tokens.len() {
                self.metadata_inventory_invalid = true;
            }
            for snapshot in self.snapshots.iter_mut() {
                snapshot.refs.sort_unstable();
                if snapshot.refs.windows(2).any(|pair| pair[0] == pair[1]) {
                    self.metadata_refs_invalid = true;
                }
            }
            self.expected_refs.release();
            self.actual_refs.release();
            self.expected_tokens.release();
            self.tokens.release();
            self.retained.release();
            self.phase = Phase::Objects;
            Ok(())
        })();
        self.record(result)
    }
    fn object_meta(&self, address: &B32) -> Option<&ObjectMeta> {
        self.objects
            .binary_search_by_key(address, |meta| meta.address)
            .ok()
            .map(|index| &self.objects[index])
    }
    /// Feed each sealed object in canonical address order, including unrefs.
    pub fn push_object(&mut self, address: &B32, bytes: &[u8]) -> Result<(), Refusal> {
        let result = self.object_checked(address, bytes);
        self.record(result)
    }
    fn object_checked(&mut self, address: &B32, bytes: &[u8]) -> Result<(), Refusal> {
        self.active(Phase::Objects)?;
        let meta = self.objects.get(self.next_object).ok_or(Refusal::Objects)?;
        if meta.address != *address {
            return Err(Refusal::Objects);
        }
        let kind = meta.kind;
        let budget = self.work.request();
        OfflineReplayVerifier::validate_object_with_budget(
            &self.trust.collection,
            address,
            kind,
            meta.size,
            &meta.checksum,
            bytes,
            &budget,
        )
        .map_err(|error| service(error, Refusal::Objects))?;
        if kind == ItemKind::Manifest.value() {
            let signer = {
                let item = Owned::construct(&self.work, scratch(bytes.len())?, || {
                    self.work
                        .request()
                        .wire::<Item>(bytes)
                        .map_err(|error| service(error, Refusal::Objects))
                })?;
                item.signer.ok_or(Refusal::Signature)?
            }; // destroy typed item BEFORE existing signature scratch admission
            self.replay
                .as_ref()
                .ok_or(Refusal::Binding)?
                .verify_manifest(bytes, &signer)
                .map_err(|error| service(error, Refusal::Signature))?;
            let item = Owned::construct(&self.work, scratch(bytes.len())?, || {
                self.work
                    .request()
                    .wire::<Item>(bytes)
                    .map_err(|error| service(error, Refusal::Objects))
            })?;
            for index in 0..self.snapshots.len() {
                if self.snapshots[index].meta.manifest != *address {
                    continue;
                }
                // Pointer.author is signed capture metadata, NOT signer/permission.
                let snapshot = &mut self.snapshots[index];
                snapshot.direct.insert_unique(*address)?;
                for root in item.refs.iter().flatten() {
                    snapshot.direct.insert_unique(*root)?;
                }
                snapshot.seen = true;
            }
        } else if kind == ItemKind::RefIndex.value()
            && self
                .snapshots
                .iter()
                .any(|snapshot| snapshot.refs.binary_search(address).is_ok())
        {
            let item = Owned::construct(&self.work, scratch(bytes.len())?, || {
                self.work
                    .request()
                    .wire::<Item>(bytes)
                    .map_err(|error| service(error, Refusal::Objects))
            })?;
            // Same nested-payload admission as log-service ref_index_body;
            // charge AGAIN before this repeated shared wire expansion.
            self.work
                .request()
                .preflight(&item.body.0)
                .map_err(|_| Refusal::Bounds)?;
            let members = ref_index_addresses(&item).map_err(|_| Refusal::Refs)?;
            let mut retained = OwnedVec::new(&self.work, MAX_REF_INDEX_ENTRIES);
            for member in members {
                retained.push(member)?;
            }
            self.indices.push(Index {
                address: *address,
                members: retained,
            })?;
        }
        self.next_object += 1;
        Ok(())
    }
    fn refs(&mut self) -> Result<(), Refusal> {
        for position in 0..self.snapshots.len() {
            if !self.snapshots[position].seen {
                return Err(Refusal::Refs);
            }
            let snapshot = &self.snapshots[position];
            if snapshot
                .direct
                .iter()
                .any(|address| snapshot.refs.binary_search(address).is_err())
            {
                return Err(Refusal::Refs);
            }
            let mut index_count = 0;
            // Extra committed metadata roots are legal and must remain closed.
            for address in snapshot.refs.iter() {
                let meta = self.object_meta(address).ok_or(Refusal::Refs)?;
                let manifest = self.snapshots[position].meta.manifest;
                if *address == manifest {
                    if meta.kind != 16 {
                        return Err(Refusal::Refs);
                    }
                } else if !matches!(meta.kind, 17..=19) {
                    return Err(Refusal::Refs);
                }
                if meta.kind == 19 {
                    index_count += 1;
                    if index_count > MAX_REF_INDICES {
                        return Err(Refusal::Bounds);
                    }
                    let index = self
                        .indices
                        .iter()
                        .find(|index| index.address == *address)
                        .ok_or(Refusal::Refs)?;
                    for member in index.members.iter() {
                        if !self
                            .object_meta(member)
                            .is_some_and(|meta| matches!(meta.kind, 17 | 18))
                        {
                            return Err(Refusal::Refs);
                        }
                        if snapshot.refs.binary_search(member).is_err() {
                            return Err(Refusal::Refs);
                        }
                    }
                }
            }
        }
        Ok(())
    }
    /// Consume complete verified historical closure; never return replay state.
    pub fn finish(mut self) -> Result<Verified, Refusal> {
        let work = self.work.clone();
        let result = (|| {
            self.active(Phase::Objects)?;
            if self.next_object != self.objects.len() {
                return Err(Refusal::Objects);
            }
            if self.metadata_refs_invalid {
                return Err(Refusal::Refs);
            }
            self.refs()?;
            self.replay
                .take()
                .ok_or(Refusal::Binding)?
                .finish(self.completion.plan.head, &self.completion.plan.chain)
                .map_err(|error| service(error, Refusal::History))?;
            let mut objects = InventoryDigest::objects();
            for meta in self.objects.iter() {
                charge(
                    &self.work,
                    &Cbor::Array(vec![
                        meta.address.to_cbor(),
                        Cbor::Uint(meta.kind),
                        Cbor::Uint(meta.size),
                        meta.checksum.to_cbor(),
                    ]),
                )?;
                objects.object(meta).map_err(|_| Refusal::Inventory)?;
            }
            let mut snapshots = InventoryDigest::snapshots();
            for snapshot in self.snapshots.iter().rev() {
                let meta = &snapshot.meta;
                charge(
                    &self.work,
                    &Cbor::Array(vec![
                        Cbor::Uint(meta.seq),
                        meta.manifest.to_cbor(),
                        meta.author.to_cbor(),
                        Cbor::int(meta.created_at),
                        Cbor::Bool(meta.endorsed),
                        Cbor::Uint(snapshot.refs.len() as u64),
                    ]),
                )?;
                for address in snapshot.refs.iter() {
                    charge(&self.work, &address.to_cbor())?;
                }
                snapshots
                    .snapshot(meta, &snapshot.refs)
                    .map_err(|_| Refusal::Inventory)?;
            }
            let used = self
                .item_bytes
                .checked_add(self.object_bytes)
                .ok_or(Refusal::Bounds)?;
            if self.metadata_inventory_invalid
                || self.items == 0
                || self.objects.len() as u64 != self.completion.object_count
                || self.object_bytes != self.completion.object_bytes
                || used != self.completion.plan.used_bytes
                || self.item_root.take().ok_or(Refusal::Binding)?.finish()
                    != self.completion.plan.items
                || objects.finish() != self.completion.plan.objects
                || snapshots.finish() != self.completion.plan.snapshots
            {
                return Err(Refusal::Inventory);
            }
            Ok(Verified {
                items: self.items,
                objects: self.objects.len() as u64,
                object_bytes: self.object_bytes,
            })
        })();
        if result.is_err() {
            poison(&work);
        }
        result
    }
}
#[cfg(test)]
mod tests;

// All inventory digests reuse existing code. Twice the canonical-row preflight
// conservatively covers both row serializations plus root||row hashing.
fn charge(work: &OfflineDecodeBudget, row: &Cbor) -> Result<(), Refusal> {
    let bytes = cbor::encode(row).map_err(|_| Refusal::Canonical)?;
    let budget = work.request();
    for _ in 0..4 {
        budget.preflight(&bytes).map_err(|_| Refusal::Bounds)?;
    }
    Ok(())
}
