//! Strict quarantined restore bounds supplied by a trusted control plane after
//! authenticating a complete consistent archive. Never policy/key authority.
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::common::B32;
use mdbn_wire::hash::sha256;
use mdbn_wire::schema::Wire;

use crate::backend::Txn;
use crate::error::{Result, ServiceError};
use crate::model::{CollectionMeta, ObjectMeta, SnapshotRow, Status};

/// Authenticated source bounds for an empty target's import, not its live quota.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestorePlan {
    /// Exact retained item plus committed object bytes at the source cut.
    pub used_bytes: u64,
    /// Source cut head.
    pub head: u64,
    /// Source chain(head).
    pub chain: B32,
    /// Source lowest retained entry position.
    pub retained_from: u64,
    /// Every retained signed item, in seq order (including all control items).
    pub items: B32,
    /// All committed objects, including unreferenced objects, in address order.
    pub objects: B32,
    /// Snapshot pointers and complete expanded refs, newest pointer first.
    pub snapshots: B32,
    /// Import progress, persisted separately; never accepted from a caller.
    pub(crate) progress: B32,
}

/// Rolling digest over canonical typed inventory rows. Hash exact CBOR bytes,
/// never JSON conversion. Callers must traverse complete canonical inventories.
pub struct InventoryDigest(B32);
impl InventoryDigest {
    /// Initial retained-item root.
    pub fn items() -> Self {
        Self(sha256(b"mdbase-next-backup/1/items"))
    }
    /// Initial committed-object root.
    pub fn objects() -> Self {
        Self(sha256(b"mdbase-next-backup/1/objects"))
    }
    /// Initial snapshot-pointer/expanded-refs root.
    pub fn snapshots() -> Self {
        Self(sha256(b"mdbase-next-backup/1/snapshots"))
    }
    fn add(&mut self, row: Cbor) -> Result<()> {
        let encoded = cbor::encode(&row).map_err(|_| ServiceError::invalid("restore_inventory"))?;
        let mut bytes = self.0.0.to_vec();
        bytes.extend_from_slice(&encoded);
        self.0 = sha256(&bytes);
        Ok(())
    }
    /// Add an item in increasing seq order. Hash the opaque signed bytes first,
    /// avoiding a second huge CBOR serialization of the envelope.
    pub fn item(&mut self, seq: u64, bytes: &[u8]) -> Result<()> {
        self.add(Cbor::Array(vec![Cbor::Uint(seq), sha256(bytes).to_cbor()]))
    }
    /// Add a committed object in increasing address order.
    pub fn object(&mut self, o: &ObjectMeta) -> Result<()> {
        self.add(Cbor::Array(vec![
            o.address.to_cbor(),
            Cbor::Uint(o.kind),
            Cbor::Uint(o.size),
            o.checksum.to_cbor(),
        ]))
    }
    /// Add a pointer in descending seq order, then sorted unique expanded refs.
    /// Ref rows are hashed individually, not as a huge materialized CBOR array.
    pub fn snapshot(&mut self, s: &SnapshotRow, refs: &[B32]) -> Result<()> {
        self.add(Cbor::Array(vec![
            Cbor::Uint(s.seq),
            s.manifest.to_cbor(),
            s.author.to_cbor(),
            Cbor::int(s.created_at),
            Cbor::Bool(s.endorsed),
            Cbor::Uint(refs.len() as u64),
        ]))?;
        for a in refs {
            self.add(a.to_cbor())?;
        }
        Ok(())
    }
    /// Current inventory root.
    pub fn finish(self) -> B32 {
        self.0
    }
}

impl RestorePlan {
    /// Strict source tuple. Does not contain mutable import progress.
    pub fn to_cbor(&self) -> Cbor {
        Cbor::Array(vec![
            Cbor::Uint(1),
            Cbor::Uint(self.used_bytes),
            Cbor::Uint(self.head),
            self.chain.to_cbor(),
            Cbor::Uint(self.retained_from),
            self.items.to_cbor(),
            self.objects.to_cbor(),
            self.snapshots.to_cbor(),
        ])
    }
    /// Reject unknown versions, missing/extra fields and malformed digest types.
    pub fn parse(value: &Cbor) -> Result<Self> {
        let bad = || ServiceError::invalid("restore_plan");
        let Cbor::Array(fields) = value else {
            return Err(bad());
        };
        let [
            Cbor::Uint(1),
            Cbor::Uint(used_bytes),
            Cbor::Uint(head),
            chain,
            Cbor::Uint(retained_from),
            items,
            objects,
            snapshots,
        ] = fields.as_slice()
        else {
            return Err(bad());
        };
        if *head == 0
            || *retained_from == 0
            || head.checked_add(1).is_none_or(|end| *retained_from > end)
        {
            return Err(bad());
        }
        Ok(Self {
            used_bytes: *used_bytes,
            head: *head,
            retained_from: *retained_from,
            chain: B32::from_cbor(chain).map_err(|_| bad())?,
            items: B32::from_cbor(items).map_err(|_| bad())?,
            objects: B32::from_cbor(objects).map_err(|_| bad())?,
            snapshots: B32::from_cbor(snapshots).map_err(|_| bad())?,
            progress: InventoryDigest::items().finish(),
        })
    }
    /// Reference plan from a CONSISTENT source transaction. Caller must ensure a
    /// stable cut (e.g. isolated fixture/WriteTX); unconstrained reads are not proof.
    pub async fn capture(tx: &mut impl Txn, meta: &CollectionMeta) -> Result<Self> {
        if meta.status != Status::Live || meta.restore_plan.is_some() {
            return Err(ServiceError::invalid("restore_state"));
        }
        let (objects, snapshots) = inventory(tx).await?;
        let mut root = InventoryDigest::items();
        let mut after = 0;
        loop {
            let rows = tx.items(after, 32, 3 << 20, false).await?;
            if rows.is_empty() {
                break;
            }
            for i in rows {
                if i.seq <= after || i.seq > meta.head {
                    return Err(ServiceError::invalid("restore_inventory"));
                }
                root.item(i.seq, &i.bytes)?;
                after = i.seq;
            }
        }
        if after != meta.head {
            return Err(ServiceError::invalid("restore_inventory"));
        }
        Ok(Self {
            used_bytes: meta.used_bytes,
            head: meta.head,
            chain: meta.head_chain,
            retained_from: meta.retained_from,
            items: root.finish(),
            objects,
            snapshots,
            progress: InventoryDigest::items().finish(),
        })
    }
    pub(crate) fn record(&mut self, seq: u64, bytes: &[u8]) -> Result<()> {
        let mut root = InventoryDigest(self.progress);
        root.item(seq, bytes)?;
        self.progress = root.finish();
        Ok(())
    }
    /// Final transaction must match source accounting, every retained item and refs.
    pub(crate) async fn verify(&self, tx: &mut impl Txn, meta: &CollectionMeta) -> Result<()> {
        if meta.used_bytes != self.used_bytes
            || meta.head != self.head
            || meta.head_chain != self.chain
            || meta.retained_from != self.retained_from
        {
            return Err(ServiceError::invalid("restore_accounting"));
        }
        if self.progress != self.items {
            return Err(ServiceError::invalid("restore_inventory"));
        }
        let (objects, snapshots) = inventory(tx).await?;
        if objects != self.objects || snapshots != self.snapshots {
            return Err(ServiceError::invalid("restore_inventory"));
        }
        Ok(())
    }
}
async fn inventory(tx: &mut impl Txn) -> Result<(B32, B32)> {
    let mut root = InventoryDigest::objects();
    let mut after = None;
    loop {
        let rows = tx.list_objects(after, 1000).await?;
        if rows.is_empty() {
            break;
        }
        for o in &rows {
            if !o.committed || after.is_some_and(|a| o.address <= a) {
                return Err(ServiceError::invalid("restore_inventory"));
            }
            root.object(o)?;
            after = Some(o.address);
        }
    }
    let objects = root.finish();
    let mut root = InventoryDigest::snapshots();
    let mut previous = None;
    for s in tx.snapshots().await? {
        if previous.is_some_and(|seq| s.seq >= seq) {
            return Err(ServiceError::invalid("restore_inventory"));
        }
        previous = Some(s.seq);
        let mut refs = tx.snapshot_refs(s.seq).await?;
        refs.sort();
        refs.dedup();
        if !refs.contains(&s.manifest) {
            return Err(ServiceError::invalid("restore_inventory"));
        }
        for chunk in refs.chunks(1000) {
            if tx
                .objects(chunk)
                .await?
                .iter()
                .any(|m| !m.as_ref().is_some_and(|m| m.committed))
            {
                return Err(ServiceError::invalid("restore_inventory"));
            }
        }
        root.snapshot(&s, &refs)?;
    }
    Ok((objects, root.finish()))
}
