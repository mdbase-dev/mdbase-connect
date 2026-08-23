//! Hosted-only collaboration storage primitives. Transport and authorization
//! deliberately remain outside this module.

use mdbase_connect_collaboration::MARKDOWN_BODY_YJS_V13_PROFILE;
use uuid::Uuid;

use crate::{ApiResult, ProviderCrypto};

pub const COLLABORATION_PROFILE: &str = MARKDOWN_BODY_YJS_V13_PROFILE;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CollaborationMode {
    ReadOnly,
    ReadWrite,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CollaborationState {
    Active,
    Closed,
    Rebuilding,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct RoomIdentity {
    pub collection_id: Uuid,
    pub record_id: Uuid,
    pub epoch: u64,
    pub profile: &'static str,
}

impl RoomIdentity {
    pub fn new(collection_id: Uuid, record_id: Uuid, epoch: u64, profile: &str) -> Option<Self> {
        (epoch > 0 && profile == COLLABORATION_PROFILE).then_some(Self {
            collection_id,
            record_id,
            epoch,
            profile: COLLABORATION_PROFILE,
        })
    }

    pub(crate) fn aad(&self, kind: AadKind, sequence: u64, mutation_id: Option<Uuid>) -> Vec<u8> {
        let mut aad = Vec::with_capacity(96);
        aad.extend_from_slice(b"mdbase/hosted-collaboration/v1\0");
        aad.extend_from_slice(self.collection_id.as_bytes());
        aad.extend_from_slice(self.record_id.as_bytes());
        aad.extend_from_slice(&self.epoch.to_be_bytes());
        aad.extend_from_slice(self.profile.as_bytes());
        aad.push(0);
        aad.extend_from_slice(kind.as_str().as_bytes());
        aad.push(0);
        aad.extend_from_slice(&sequence.to_be_bytes());
        if let Some(mutation_id) = mutation_id {
            aad.extend_from_slice(mutation_id.as_bytes());
        }
        aad
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AadKind {
    Snapshot,
    StateVector,
    Update,
    Receipt,
}

impl AadKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Snapshot => "snapshot",
            Self::StateVector => "state-vector",
            Self::Update => "update",
            Self::Receipt => "receipt",
        }
    }
}

pub(crate) fn encrypt_room_bytes(
    crypto: &ProviderCrypto,
    data_key: &[u8; 32],
    room: &RoomIdentity,
    kind: AadKind,
    sequence: u64,
    mutation_id: Option<Uuid>,
    plaintext: &[u8],
) -> ApiResult<Vec<u8>> {
    crypto.encrypt_bytes(data_key, plaintext, &room.aad(kind, sequence, mutation_id))
}

pub(crate) fn decrypt_room_bytes(
    crypto: &ProviderCrypto,
    data_key: &[u8; 32],
    room: &RoomIdentity,
    kind: AadKind,
    sequence: u64,
    mutation_id: Option<Uuid>,
    ciphertext: &[u8],
) -> ApiResult<Vec<u8>> {
    crypto.decrypt_bytes(data_key, ciphertext, &room.aad(kind, sequence, mutation_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_rejects_unknown_profile_and_zero_epoch() {
        let collection = Uuid::nil();
        let record = Uuid::new_v4();
        assert!(RoomIdentity::new(collection, record, 0, COLLABORATION_PROFILE).is_none());
        assert!(RoomIdentity::new(collection, record, 1, "other").is_none());
        assert!(RoomIdentity::new(collection, record, 1, COLLABORATION_PROFILE).is_some());
    }

    #[test]
    fn aad_binds_room_kind_sequence_and_mutation() {
        let room =
            RoomIdentity::new(Uuid::new_v4(), Uuid::new_v4(), 1, COLLABORATION_PROFILE).unwrap();
        let mutation = Uuid::new_v4();
        let base = room.aad(AadKind::Update, 1, Some(mutation));
        assert_ne!(base, room.aad(AadKind::Snapshot, 1, Some(mutation)));
        assert_ne!(base, room.aad(AadKind::Update, 2, Some(mutation)));
        assert_ne!(base, room.aad(AadKind::Update, 1, Some(Uuid::new_v4())));
        assert_ne!(
            base,
            RoomIdentity::new(room.collection_id, Uuid::new_v4(), 1, COLLABORATION_PROFILE)
                .unwrap()
                .aad(AadKind::Update, 1, Some(mutation))
        );
    }

    #[test]
    fn encrypted_bytes_reject_room_swaps_and_replays() {
        let crypto =
            ProviderCrypto::from_base64("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").unwrap();
        let key = crypto.generate_data_key();
        let room =
            RoomIdentity::new(Uuid::new_v4(), Uuid::new_v4(), 3, COLLABORATION_PROFILE).unwrap();
        let mutation = Uuid::new_v4();
        let ciphertext = encrypt_room_bytes(
            &crypto,
            &key,
            &room,
            AadKind::Update,
            7,
            Some(mutation),
            b"opaque-update",
        )
        .unwrap();
        assert_eq!(
            decrypt_room_bytes(
                &crypto,
                &key,
                &room,
                AadKind::Update,
                7,
                Some(mutation),
                &ciphertext,
            )
            .unwrap(),
            b"opaque-update"
        );
        assert!(decrypt_room_bytes(
            &crypto,
            &key,
            &room,
            AadKind::Update,
            8,
            Some(mutation),
            &ciphertext,
        )
        .is_err());
        let swapped =
            RoomIdentity::new(room.collection_id, Uuid::new_v4(), 3, COLLABORATION_PROFILE)
                .unwrap();
        assert!(decrypt_room_bytes(
            &crypto,
            &key,
            &swapped,
            AadKind::Update,
            7,
            Some(mutation),
            &ciphertext,
        )
        .is_err());
    }
}
