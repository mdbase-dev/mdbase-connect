//! Registered-device prospective collection lifetime. Fixed private-create and
//! private-device-enrol domains only; no approval-request/Noise handshake, raw
//! SAS secret/state/reveal, generic signer, Core/SQL/LS or readiness authority.
use mdbn_replica::crypto::{
    CsprngEntropy,
    keys::{EnrolledKeys, SasCommitter},
    proof::{CollectionProof, collection_proof_digest},
    sign::DeviceSigner,
};
use mdbn_wire::common::Uuid;

pub(super) struct PrivateProofScope {
    pub(super) collection: Uuid,
    sas: Option<SasCommitter>,
    restored_commit: Option<[u8; 32]>,
    issued: bool,
}
impl PrivateProofScope {
    pub(super) fn new(
        collection: Uuid,
        enrolling: bool,
        me: &EnrolledKeys,
        entropy: &mut dyn CsprngEntropy,
    ) -> Self {
        Self {
            collection,
            sas: enrolling.then(|| SasCommitter::new(&collection, me, entropy)),
            restored_commit: None,
            issued: false,
        }
    }
    /// Authenticated host's PROTECTED exact-tuple marker, not a fresh JS commit.
    /// v1 default enrolment idempotency needs only the public commit; r is never
    /// restored/persisted and no strict reveal/handshake authority is created.
    pub(super) fn restore_enrol(collection: Uuid, commit: [u8; 32], acknowledged: bool) -> Self {
        Self {
            collection,
            sas: None,
            restored_commit: Some(commit),
            issued: acknowledged,
        }
    }
    pub(super) fn enrol_commitment(&self) -> Option<[u8; 32]> {
        self.sas
            .as_ref()
            .map(SasCommitter::commitment)
            .or(self.restored_commit)
    }
    pub(super) fn sign_create(
        &mut self,
        signer: &DeviceSigner,
        connector: Uuid,
        device: Uuid,
        challenge: &[u8],
    ) -> Option<Vec<u8>> {
        if self.enrol_commitment().is_some() || self.issued || challenge.len() != 32 {
            return None;
        }
        let digest = collection_proof_digest(
            CollectionProof::PrivateCreate,
            challenge.try_into().ok()?,
            &connector,
            &device,
            &self.collection,
            None,
        )?;
        self.issued = true;
        Some(signer.sign_digest(&digest.0).to_vec())
    }
    pub(super) fn sign_enrol(
        &mut self,
        signer: &DeviceSigner,
        connector: Uuid,
        device: Uuid,
        challenge: &[u8],
    ) -> Option<Vec<u8>> {
        if self.issued || challenge.len() != 32 {
            return None;
        }
        let commit = self.enrol_commitment()?;
        let digest = collection_proof_digest(
            CollectionProof::PrivateDeviceEnrol,
            challenge.try_into().ok()?,
            &connector,
            &device,
            &self.collection,
            Some(&commit),
        )?;
        self.issued = true;
        Some(signer.sign_digest(&digest.0).to_vec())
    }
}
