//! The item envelope and the key items (`docs/contracts/sealed-envelope.md` §2, §5).
//!
//! Sealing (compression, padding, the STREAM payload construction) and signatures
//! are not in this module: they need the collection key and device keys, and belong
//! to the replica's crypto layer. This module fixes the bytes those operations
//! cover: the associated data, the signed digest, the chain hash and object
//! addresses.

use crate::cbor::{self, Cbor, CborError};
use crate::common::{B16, B32, B64, Bytes, Hash, Uuid};
use crate::hash::{chain_hash, h, sha256};
use crate::schema::{SchemaError, Wire};
use crate::{wire_enum, wire_struct};

wire_enum! {
    /// Item kinds (sealed-envelope.md §2).
    pub enum ItemKind {
        /// A mutation and its results.
        Entry = 1,
        /// Control-plane policy.
        Policy = 2,
        /// A new key epoch.
        Rekey = 3,
        /// Existing epochs wrapped for a newly enrolled device.
        KeyGrant = 4,
        /// The adopted generation-0 snapshot.
        Base = 5,
        /// A device's approval of a grant (policy.md §5.1).
        GrantApproval = 6,
        /// Snapshot manifest object.
        Manifest = 16,
        /// Snapshot chunk object.
        Chunk = 17,
        /// Blob part object.
        BlobPart = 18,
        /// Snapshot ref-index object (clear, content-addressed; `crate::ref_index`).
        RefIndex = 19,
        /// Ephemeral stream message.
        Ephemeral = 32,
    }
}

impl ItemKind {
    /// Log items occupy a position.
    pub fn is_log_item(self) -> bool {
        matches!(
            self,
            ItemKind::Entry
                | ItemKind::Policy
                | ItemKind::Rekey
                | ItemKind::KeyGrant
                | ItemKind::Base
                | ItemKind::GrantApproval
        )
    }
    /// Control items are never compacted. `grant_approval` counts as one: it is
    /// authorization state every replica needs from position 1 (policy.md §5.1).
    pub fn is_control(self) -> bool {
        matches!(
            self,
            ItemKind::Policy
                | ItemKind::Rekey
                | ItemKind::KeyGrant
                | ItemKind::Base
                | ItemKind::GrantApproval
        )
    }
    /// The body is sealed with the collection key.
    pub fn is_sealed(self) -> bool {
        matches!(
            self,
            ItemKind::Entry
                | ItemKind::Base
                | ItemKind::GrantApproval
                | ItemKind::Manifest
                | ItemKind::Chunk
                | ItemKind::BlobPart
                | ItemKind::Ephemeral
        )
    }
}

wire_struct! {
    /// The envelope every log item, stored object and ephemeral message uses.
    pub struct Item [fmt = 1] {
        /// Kind.
        1 req kind: ItemKind,
        /// Collection.
        2 req collection: Uuid,
        /// Position (log items).
        3 opt seq: u64,
        /// Chain hash of item `seq - 1` (log items).
        4 opt prev: Hash,
        /// Key epoch (sealed kinds).
        5 opt epoch: u64,
        /// Device ID or control-plane key ID.
        6 opt signer: B16,
        /// Salt (sealed kinds).
        7 opt salt: B16,
        /// Idempotency token (entry).
        8 opt idem: B16,
        /// Object addresses referenced.
        9 opt1 refs: Vec<B32>,
        /// Ephemeral stream ID.
        10 opt stream: B16,
        /// Ciphertext, or the clear payload's canonical bytes.
        11 req body: Bytes,
        /// Signature.
        12 opt sig: B64,
    }
}

/// Presence rule of one header field for one kind (sealed-envelope.md §2 table).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Rule {
    Required,
    Optional,
    Absent,
}

impl Item {
    /// Check which fields are present for this kind (sealed-envelope.md §2 table).
    pub fn check_shape(&self) -> Result<(), SchemaError> {
        use ItemKind::*;
        use Rule::*;
        let ty = "Item";
        // seq+prev, epoch+salt, signer, idem, refs, stream, sig
        let rules: [Rule; 7] = match self.kind {
            Entry => [
                Required, Required, Required, Required, Optional, Absent, Required,
            ],
            Policy | Rekey | KeyGrant => {
                [Required, Absent, Required, Absent, Absent, Absent, Required]
            }
            Base => [
                Required, Required, Required, Absent, Required, Absent, Required,
            ],
            GrantApproval => [
                Required, Required, Required, Absent, Absent, Absent, Required,
            ],
            Manifest => [
                Absent, Required, Required, Absent, Required, Absent, Required,
            ],
            Chunk | BlobPart => [Absent, Required, Absent, Absent, Absent, Absent, Absent],
            RefIndex => [Absent, Absent, Absent, Absent, Absent, Absent, Absent],
            Ephemeral => [Absent, Required, Required, Absent, Absent, Required, Absent],
        };
        let present = [
            (self.seq.is_some(), self.prev.is_some()),
            (self.epoch.is_some(), self.salt.is_some()),
            (self.signer.is_some(), self.signer.is_some()),
            (self.idem.is_some(), self.idem.is_some()),
            (self.refs.is_some(), self.refs.is_some()),
            (self.stream.is_some(), self.stream.is_some()),
            (self.sig.is_some(), self.sig.is_some()),
        ];
        for (rule, (a, b)) in rules.iter().zip(present) {
            let ok = match rule {
                Required => a && b,
                Absent => !a && !b,
                Optional => a == b,
            };
            if !ok {
                return Err(SchemaError::Invalid {
                    ty,
                    reason: "header fields do not match the item kind",
                });
            }
        }
        if self.refs.as_ref().is_some_and(Vec::is_empty) {
            return Err(SchemaError::Invalid {
                ty,
                reason: "refs must be non-empty when present",
            });
        }
        Ok(())
    }

    fn without(&self, body: bool) -> Item {
        let mut i = self.clone();
        i.sig = None;
        if body {
            i.body = Bytes::default();
        }
        i
    }

    /// The AEAD associated data: the canonical encoding without keys 11 and 12.
    pub fn aad(&self) -> Result<Vec<u8>, CborError> {
        let mut c = self.without(true).to_cbor();
        if let Cbor::Map(m) = &mut c {
            m.retain(|(k, _)| *k != Cbor::Uint(11));
        }
        cbor::encode(&c)
    }

    /// The digest the signature covers: `H("mdbase/v1/item-sig", canonical(item without key 12))`.
    pub fn signed_digest(&self) -> Result<Hash, CborError> {
        Ok(h("mdbase/v1/item-sig", &self.without(false).to_bytes()?))
    }
}

/// Chain hash of a complete item's canonical bytes (sealed-envelope.md §2.3).
pub fn item_chain_hash(item_bytes: &[u8]) -> Hash {
    chain_hash(item_bytes)
}

/// Address of a snapshot object (`manifest`, `chunk`): SHA-256 of its bytes.
pub fn object_address(object_bytes: &[u8]) -> B32 {
    sha256(object_bytes)
}

wire_struct! {
    /// An epoch key wrapped for one device with HPKE (sealed-envelope.md §5.2).
    pub struct KeyWrap {
        /// Recipient device ID.
        0 req device: Uuid,
        /// HPKE encapsulated key.
        1 req enc: B32,
        /// HPKE ciphertext of the 32-byte epoch key.
        2 req ct: Bytes,
    }
}

wire_struct! {
    /// A small payload sealed with the §3 construction.
    pub struct SealedBox {
        /// Salt.
        0 req salt: B16,
        /// Ciphertext.
        1 req ct: Bytes,
    }
}

wire_enum! {
    /// Why a rekey happened.
    pub enum RekeyReason {
        /// The first epoch.
        Initial = 0,
        /// A device was revoked.
        DeviceRevoked = 1,
        /// A member was removed.
        MemberRemoved = 2,
        /// The cloud copy was turned off.
        CloudCopyOff = 3,
        /// Scheduled rotation.
        Scheduled = 4,
        /// Recovery.
        Recovery = 5,
    }
}

wire_struct! {
    /// Payload of a `rekey` item (in clear).
    pub struct RekeyPayload [fmt = 1] {
        /// The new epoch.
        1 req epoch: u64,
        /// The current epoch at this position (0 for the first).
        2 req from: u64,
        /// Key commitment.
        3 req commit: Hash,
        /// One wrap per recipient.
        4 req1 wraps: Vec<KeyWrap>,
        /// All previous epoch keys, sealed with the new key.
        5 req history: SealedBox,
        /// Reason.
        6 req reason: RekeyReason,
    }
}

wire_struct! {
    /// Payload of a `key_grant` item (in clear).
    pub struct KeyGrantPayload [fmt = 1] {
        /// Recipient device ID.
        1 req recipient: Uuid,
        /// The current epoch at this position.
        2 req epoch: u64,
        /// The current epoch key, wrapped for the recipient.
        3 req wrap: KeyWrap,
    }
}
