//! Control-plane policy items (`docs/contracts/policy.md`).

use crate::common::{B16, B32, B64, Hash, Uuid};
use crate::hash::h;
use crate::schema::Wire;
use crate::{wire_enum, wire_struct, wire_union};

wire_enum! {
    /// Collection state.
    pub enum CState {
        /// Synced, end-to-end encrypted.
        E2e = 0,
        /// Synced with a cloud copy.
        CloudCopy = 1,
    }
}

wire_enum! {
    /// Device kinds (policy.md §4.2).
    pub enum DeviceKind {
        /// Desktop daemon.
        Desktop = 0,
        /// Mobile runtime.
        Mobile = 1,
        /// First-party app hosting a replica.
        AppRuntime = 2,
        /// Headless replica.
        Cli = 3,
        /// The hosted replica.
        Hosted = 4,
        /// The escrow service.
        Escrow = 5,
        /// An offline recovery key held by the user (sealed-envelope.md §5.4).
        Recovery = 6,
    }
}

wire_enum! {
    /// Member roles.
    pub enum Role {
        /// Read.
        Viewer = 0,
        /// Read and write.
        Editor = 1,
        /// Editor plus sharing and grants.
        Owner = 2,
    }
}

wire_struct! {
    /// `genesis`.
    pub struct Genesis {
        /// Owner account.
        1 req owner: Uuid,
        /// Root key ID governing the collection.
        2 req root: B16,
        /// Initial state.
        3 req state: CState,
    }
}

wire_struct! {
    /// `device-enrol`.
    pub struct DeviceEnrol {
        /// Device ID.
        1 req device: Uuid,
        /// Account (all-zero for mdbase service devices).
        2 req account: Uuid,
        /// Kind.
        3 req kind: DeviceKind,
        /// Ed25519 signing key.
        4 req sign_pk: B32,
        /// X25519 key for HPKE wraps.
        5 req kem_pk: B32,
        /// X25519 key for client sessions; 32 zero bytes for `recovery`.
        6 req noise_pk: B32,
        /// The new device's SAS commitment (sealed-envelope.md §5.3).
        7 opt sas_commit: Hash,
        /// The Ed25519 root key this device would govern a device-located log with (§2.1).
        8 opt local_root: B32,
    }
}

wire_struct! {
    /// `device-revoke`.
    pub struct DeviceRevoke {
        /// Device ID.
        1 req device: Uuid,
    }
}

wire_struct! {
    /// `member-set`.
    pub struct MemberSet {
        /// Account.
        1 req account: Uuid,
        /// Role.
        2 req role: Role,
    }
}

wire_struct! {
    /// `member-remove`.
    pub struct MemberRemove {
        /// Account.
        1 req account: Uuid,
    }
}

wire_struct! {
    /// `grant`.
    pub struct Grant {
        /// Grant ID.
        1 req grant: Uuid,
        /// App installation ID.
        2 req installation: Uuid,
        /// App ID (informational).
        3 req app_id: String,
        /// Granting member.
        4 req account: Uuid,
        /// Capability groups.
        5 req1 capabilities: Vec<String>,
        /// The installation's Noise static key.
        6 req client_pk: B32,
        /// Restrict file access to these folders (cloud-copy only; in e2e the scope
        /// travels sealed in the grant approval, §5.1).
        7 opt1 file_folders: Vec<String>,
        /// e2e only: the approval carries `file_folders`.
        8 opt folder_scoped: bool,
    }
}

wire_struct! {
    /// `grant-revoke`.
    pub struct GrantRevoke {
        /// Grant ID.
        1 req grant: Uuid,
    }
}

wire_struct! {
    /// `collection-state`.
    pub struct CollectionState {
        /// State.
        1 req state: CState,
        /// Compression (default true).
        2 opt compress: bool,
        /// Explicit semantics ratchet.
        3 opt min_sem_major: u64,
    }
}

wire_struct! {
    /// `cp-key-revoke`.
    pub struct CpKeyRevoke {
        /// Revoked policy key ID.
        1 req key_id: B16,
        /// Items issued at or after this are invalid.
        2 req revoked_from: i64,
        /// Root signature over `H("mdbase/v1/cp-key-revoke", canonical([key ID, revoked_from]))`.
        3 req root_sig: B64,
    }
}

impl CpKeyRevoke {
    /// The digest the root signs: `H("mdbase/v1/cp-key-revoke", canonical([key ID, revoked_from]))`.
    pub fn signed_digest(&self) -> Result<Hash, crate::cbor::CborError> {
        let c = crate::cbor::Cbor::Array(vec![
            self.key_id.to_cbor(),
            crate::cbor::Cbor::int(self.revoked_from),
        ]);
        Ok(h("mdbase/v1/cp-key-revoke", &crate::cbor::encode(&c)?))
    }
}

wire_struct! {
    /// `migration-cutover`.
    pub struct MigrationCutover {
        /// The Connect collection this one replaces.
        1 req legacy_collection: Uuid,
        /// Legacy mirror replica credentials revoked server-side.
        2 req revoked: Vec<Uuid>,
        /// Cutover time.
        3 req cutover_at: i64,
    }
}

wire_struct! {
    /// `freeze`.
    pub struct Freeze {
        /// Frozen.
        1 req frozen: bool,
        /// Reason.
        2 opt reason: String,
    }
}

wire_struct! {
    /// `approval-request`: replaces an enrolled device's SAS commitment.
    pub struct ApprovalRequest {
        /// Device ID.
        1 req device: Uuid,
        /// `sas_commit`.
        2 req sas_commit: Hash,
    }
}

wire_struct! {
    /// `root-handover` (policy.md §2.1).
    pub struct RootHandover {
        /// Ed25519 public key of the root governing items after this one.
        1 req new_root: B32,
        /// A keyed device of the owner, consenting to the move.
        2 req owner_device: Uuid,
        /// Move ID (control plane).
        3 req move_id: Uuid,
        /// `owner_device`'s signature over [`RootHandover::consent_digest`].
        4 req consent: B64,
    }
}

impl RootHandover {
    /// `H("mdbase/v1/root-handover", collection ‖ u64be(seq) ‖ new_root ‖ move ID)`, where
    /// `seq` is the position of the item carrying this op.
    pub fn consent_digest(&self, collection: &Uuid, seq: u64) -> Hash {
        let mut m = Vec::with_capacity(16 + 8 + 32 + 16);
        m.extend_from_slice(&collection.0);
        m.extend_from_slice(&seq.to_be_bytes());
        m.extend_from_slice(&self.new_root.0);
        m.extend_from_slice(&self.move_id.0);
        h("mdbase/v1/root-handover", &m)
    }
}

wire_union! {
    /// One policy operation (policy.md §1).
    pub enum PolicyOp {
        /// Collection genesis.
        1 => Genesis(Genesis),
        /// Enrol a device.
        2 => DeviceEnrol(DeviceEnrol),
        /// Revoke a device.
        3 => DeviceRevoke(DeviceRevoke),
        /// Add or change a member.
        4 => MemberSet(MemberSet),
        /// Remove a member.
        5 => MemberRemove(MemberRemove),
        /// Grant an app installation.
        6 => Grant(Grant),
        /// Revoke a grant.
        7 => GrantRevoke(GrantRevoke),
        /// Collection state.
        8 => CollectionState(CollectionState),
        /// Revoke a control-plane policy key.
        9 => CpKeyRevoke(CpKeyRevoke),
        /// Migration cutover.
        10 => MigrationCutover(MigrationCutover),
        /// Freeze or unfreeze.
        11 => Freeze(Freeze),
        /// Move the log's policy root (log moves).
        12 => RootHandover(RootHandover),
        /// A fresh SAS commitment for an enrolled device (sealed-envelope.md §5.3).
        13 => ApprovalRequest(ApprovalRequest),
    }
}

wire_struct! {
    /// Certificate of a policy key, signed by a root key (policy.md §3).
    pub struct CpCert {
        /// Policy public key.
        0 req policy_pk: B32,
        /// Validity start.
        1 req not_before: i64,
        /// Validity end.
        2 req not_after: i64,
        /// Certifying root key ID.
        3 req root: B16,
        /// Root signature.
        4 req sig: B64,
    }
}

impl CpCert {
    /// The digest the root signs: `H("mdbase/v1/cp-cert", canonical(cert without key 4))`.
    pub fn signed_digest(&self) -> Result<Hash, crate::cbor::CborError> {
        let mut c = self.to_cbor();
        if let crate::cbor::Cbor::Map(m) = &mut c {
            m.retain(|(k, _)| *k != crate::cbor::Cbor::Uint(4));
        }
        Ok(h("mdbase/v1/cp-cert", &crate::cbor::encode(&c)?))
    }

    /// Key ID of `policy_pk`: the first 16 bytes of its SHA-256.
    pub fn key_id(&self) -> B16 {
        let d = crate::hash::sha256(&self.policy_pk.0);
        let mut id = [0u8; 16];
        id.copy_from_slice(&d.0[..16]);
        B16(id)
    }
}

wire_struct! {
    /// Payload of a `policy` item (in clear).
    pub struct PolicyPayload [fmt = 1] {
        /// Certificate of the signing key.
        1 req cert: CpCert,
        /// Control-plane time, monotonic per collection.
        2 req issued_at: i64,
        /// Operations, applied atomically in order.
        3 req1 ops: Vec<PolicyOp>,
    }
}

wire_struct! {
    /// Payload of a `grant_approval` item (sealed; policy.md §5.1).
    pub struct GrantApprovalPayload [fmt = 1] {
        /// Grant ID.
        1 req grant: Uuid,
        /// Must equal the grant op's `client_pk`.
        2 req client_pk: B32,
        /// The effective capabilities: a subset of the grant op's.
        3 req1 capabilities: Vec<String>,
        /// The folder scope (sealed, so paths stay private).
        4 opt1 file_folders: Vec<String>,
    }
}

/// The client key fingerprint shown at grant approval: the first 8 bytes of
/// `H("mdbase/v1/client-fp", client_pk)` as 16 lowercase hex digits (policy.md §5.1).
pub fn client_fingerprint(client_pk: &B32) -> String {
    crate::render::hex(&h("mdbase/v1/client-fp", &client_pk.0).0[..8])
}

#[cfg(test)]
mod approval_request_tests {
    use super::*;
    use crate::common::{B16, B32};

    #[test]
    fn approval_request_round_trips_as_op_13() {
        let op = PolicyOp::ApprovalRequest(ApprovalRequest {
            device: B16([3; 16]),
            sas_commit: B32([4; 32]),
        });
        let b = op.to_bytes().unwrap();
        assert_eq!(b[1..3], [0x00, 0x0d], "discriminator 13 at key 0");
        assert_eq!(PolicyOp::from_bytes(&b).unwrap(), op);
    }
}
