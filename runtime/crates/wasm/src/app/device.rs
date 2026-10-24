//! Protected DEVICE-only lifetime before registration/collection bootstrap.
//! No Store, Core session, LS, RPC, arbitrary signing or seed export.
use super::{
    AppRuntime, Bootstrap, Reader, http::HttpSigner, invalid, noise_custody::NoiseCustody,
    private_proof::PrivateProofScope,
};
use crate::{
    app_index::AppSqlHost,
    runtime::{OpenFailure, wipe},
};
use mdbn_replica::{
    DeviceSecrets, Host,
    crypto::{CsprngEntropy, keys::EnrolledKeys, sign::DeviceSigner},
};
use mdbn_wire::{
    cbor::{self, Cbor},
    common::{B16, Uuid},
    schema::Wire,
};

/// Exact fixed device bootstrap cap, including an opaque existing envelope.
pub const MAX_DEVICE_BOOTSTRAP: usize = 2048;
/// Single protected identity; consuming adoption moves these SAME owners.
pub struct DeviceIdentity {
    secrets: Option<DeviceSecrets>,
    signer: Option<DeviceSigner>,
    noise: Option<NoiseCustody>,
    connector: Uuid,
    device: Uuid,
    installation: Uuid,
    proof_issued: bool,
    restored: bool,
    registered: bool,
    private: Option<PrivateProofScope>,
    // Original collection, create-vs-join and once-issued flag. No JS domain,
    // digest or commitment override and no private SAS/recovery state.
    cloud: Option<(Uuid, bool, bool)>,
}
impl std::fmt::Debug for DeviceIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AppDeviceIdentity(..)")
    }
}
impl DeviceIdentity {
    /// HOST ONLY after authenticated dedicated connector selection and async
    /// platform unwrap. Fixed8-field envelope, borrowed secret grammar:
    /// 0version1/1connector16/2device16/3installation16/4mode/5sign32/6KEM32/
    /// 7opaque inner envelope. Mode0 FIRST INSTALL requires empty envelope;
    /// mode1 EXISTING requires valid ciphertext. Never fallback/retry/regenerate.
    pub fn open_consuming(
        bytes: &mut [u8],
        entropy: &mut dyn CsprngEntropy,
    ) -> Result<(Self, Vec<u8>), OpenFailure> {
        let out = if bytes.len() > MAX_DEVICE_BOOTSTRAP {
            Err(invalid())
        } else {
            Self::parse(bytes, entropy)
        };
        wipe(bytes);
        out
    }
    fn parse(
        bytes: &[u8],
        entropy: &mut dyn CsprngEntropy,
    ) -> Result<(Self, Vec<u8>), OpenFailure> {
        let mut r = Reader { bytes, pos: 0 };
        if r.arg(5)? != 8 {
            return Err(invalid());
        }
        r.field(0)?;
        if r.arg(0)? != 1 {
            return Err(invalid());
        }
        r.field(1)?;
        let connector = B16(r.fixed()?);
        r.field(2)?;
        let device = B16(r.fixed()?);
        r.field(3)?;
        let installation = B16(r.fixed()?);
        if [connector, device, installation]
            .iter()
            .any(|id| id.0 == [0; 16])
        {
            return Err(invalid());
        }
        r.field(4)?;
        let mode = r.arg(0)?;
        let mut secrets = DeviceSecrets {
            sign_sk: [0; 32],
            kem_sk: [0; 32],
        };
        r.field(5)?;
        secrets.sign_sk = r.fixed()?;
        r.field(6)?;
        secrets.kem_sk = r.fixed()?;
        if secrets.sign_sk == [0; 32] || secrets.kem_sk == [0; 32] {
            return Err(invalid());
        }
        r.field(7)?;
        let envelope = r.blob(1024)?;
        if r.pos != bytes.len() || !matches!((mode, envelope.is_empty()), (0, true) | (1, false)) {
            return Err(invalid());
        }
        let signer = DeviceSigner::from_seed(&secrets.sign_sk);
        let mut noise = NoiseCustody::new(&secrets.sign_sk, &secrets.kem_sk, device);
        let initialization = cbor::encode(&Cbor::Map(vec![
            (Cbor::Uint(0), installation.to_cbor()),
            (Cbor::Uint(1), Cbor::Uint(mode)),
            (Cbor::Uint(2), Cbor::Bytes(envelope.to_vec())),
        ]))
        .map_err(|_| invalid())?;
        let result = noise
            .init(connector, &initialization, entropy)
            .ok_or_else(invalid)?;
        Ok((
            Self {
                secrets: Some(secrets),
                signer: Some(signer),
                noise: Some(noise),
                connector,
                device,
                installation,
                proof_issued: false,
                restored: mode == 1,
                registered: false,
                private: None,
                cloud: None,
            },
            result,
        ))
    }
    /// Separate fixed cp-enrol purpose. ONLY native protected public tuple.
    pub fn sign_cp_enrol_consuming(&mut self, bytes: &mut [u8]) -> Vec<u8> {
        let out = self.sign_cp_enrol(bytes).unwrap_or_default();
        wipe(bytes);
        if !out.is_empty() {
            self.proof_issued = true;
        } else {
            self.retire();
        }
        out
    }
    fn sign_cp_enrol(&self, challenge: &[u8]) -> Option<Vec<u8>> {
        if challenge.len() != 32 {
            return None;
        }
        let signer = self.signer.as_ref()?;
        let (sign, kem, noise) =
            self.noise
                .as_ref()?
                .public_tuple(self.connector, self.device, &signer.public())?;
        let digest = mdbn_replica::crypto::proof::cp_enrol_digest(
            challenge.try_into().ok()?,
            &self.connector,
            &self.device,
            &sign,
            &kem,
            &noise,
        );
        let signature = signer.sign_digest(&digest.0);
        cbor::encode(&Cbor::Map(vec![
            (Cbor::Uint(0), Cbor::Bytes(sign.to_vec())),
            (Cbor::Uint(1), Cbor::Bytes(kem.to_vec())),
            (Cbor::Uint(2), Cbor::Bytes(noise.to_vec())),
            (Cbor::Uint(3), Cbor::Bytes(signature.to_vec())),
        ]))
        .ok()
    }
    /// HOST ONLY actual authenticated registration response, or its protected
    /// stored receipt on offline reopen. Exact scope + native public tuple;
    /// possession of ciphertext alone NEVER implies registration completion.
    /// No collection enrolment, policy acknowledgement or readiness grant.
    pub fn acknowledge_registration_consuming(&mut self, bytes: &mut [u8]) -> bool {
        let accepted = self.registration_receipt(bytes).unwrap_or(false);
        wipe(bytes);
        if accepted {
            self.registered = true;
        } else {
            self.retire();
        }
        accepted
    }
    fn registration_receipt(&self, bytes: &[u8]) -> Option<bool> {
        if bytes.len() > 512 || self.registered || !(self.proof_issued || self.restored) {
            return None;
        }
        let signer = self.signer.as_ref()?;
        let (sign, kem, noise) =
            self.noise
                .as_ref()?
                .public_tuple(self.connector, self.device, &signer.public())?;
        let expected = Cbor::Map(vec![
            (Cbor::Uint(0), self.connector.to_cbor()),
            (Cbor::Uint(1), self.device.to_cbor()),
            (Cbor::Uint(2), self.installation.to_cbor()),
            (Cbor::Uint(3), Cbor::Bytes(sign.to_vec())),
            (Cbor::Uint(4), Cbor::Bytes(kem.to_vec())),
            (Cbor::Uint(5), Cbor::Bytes(noise.to_vec())),
        ]);
        Some(cbor::decode(bytes).ok()? == expected)
    }
    /// HOST ONLY prospective collection pin, ONCE after actual registration.
    /// Fixed {0:collection16,1:purpose0-create/1-default-enrol}; strict approval
    /// is unsupported in v1. No roots, SQL or completion inference.
    pub fn pin_private_collection_consuming(
        &mut self,
        bytes: &mut [u8],
        entropy: &mut dyn CsprngEntropy,
    ) -> bool {
        let accepted = self.pin_private_collection(bytes, entropy).is_some();
        wipe(bytes);
        if !accepted {
            self.retire();
        }
        accepted
    }
    fn pin_private_collection(
        &mut self,
        bytes: &[u8],
        entropy: &mut dyn CsprngEntropy,
    ) -> Option<()> {
        if !self.registered || self.cloud.is_some() || self.private.is_some() || bytes.len() > 64 {
            return None;
        }
        let mut r = Reader { bytes, pos: 0 };
        if r.arg(5).ok()? != 2 {
            return None;
        }
        r.field(0).ok()?;
        let collection = B16(r.fixed().ok()?);
        r.field(1).ok()?;
        let purpose = r.arg(0).ok()?;
        if collection.0 == [0; 16] || purpose > 1 || r.pos != bytes.len() {
            return None;
        }
        let signer = self.signer.as_ref()?;
        let (sign_pk, kem_pk, noise_pk) =
            self.noise
                .as_ref()?
                .public_tuple(self.connector, self.device, &signer.public())?;
        let me = EnrolledKeys {
            device: self.device,
            sign_pk,
            kem_pk,
            noise_pk,
        };
        self.private = Some(PrivateProofScope::new(
            collection,
            purpose == 1,
            &me,
            entropy,
        ));
        Some(())
    }
    /// HOST ONLY public marker restored through authenticated platform unwrap.
    /// Fixed10 fields: version1/collection/connector/device/installation/signPK/
    /// KEMPK/NoisePK/public commit/acknowledged. Exact native identity, ONCE, default enrol
    /// ONLY. No r/state restoration, new commit generation or strict authority.
    pub fn restore_private_enrol_consuming(&mut self, bytes: &mut [u8]) -> bool {
        let accepted = self.restore_private_enrol(bytes).is_some();
        wipe(bytes);
        if !accepted {
            self.retire();
        }
        accepted
    }
    fn restore_private_enrol(&mut self, bytes: &[u8]) -> Option<()> {
        if !self.registered || self.cloud.is_some() || self.private.is_some() || bytes.len() > 512 {
            return None;
        }
        let mut r = Reader { bytes, pos: 0 };
        if r.arg(5).ok()? != 10 {
            return None;
        }
        r.field(0).ok()?;
        if r.arg(0).ok()? != 1 {
            return None;
        }
        r.field(1).ok()?;
        let collection = B16(r.fixed().ok()?);
        r.field(2).ok()?;
        if B16(r.fixed().ok()?) != self.connector {
            return None;
        }
        r.field(3).ok()?;
        if B16(r.fixed().ok()?) != self.device {
            return None;
        }
        r.field(4).ok()?;
        if B16(r.fixed().ok()?) != self.installation {
            return None;
        }
        let signer = self.signer.as_ref()?;
        let tuple =
            self.noise
                .as_ref()?
                .public_tuple(self.connector, self.device, &signer.public())?;
        r.field(5).ok()?;
        if r.fixed::<32>().ok()? != tuple.0 {
            return None;
        }
        r.field(6).ok()?;
        if r.fixed::<32>().ok()? != tuple.1 {
            return None;
        }
        r.field(7).ok()?;
        if r.fixed::<32>().ok()? != tuple.2 {
            return None;
        }
        r.field(8).ok()?;
        let commit = r.fixed::<32>().ok()?;
        r.field(9).ok()?;
        let acknowledged = r.boolean().ok()?;
        if collection.0 == [0; 16] || commit == [0; 32] || r.pos != bytes.len() {
            return None;
        }
        self.private = Some(PrivateProofScope::restore_enrol(
            collection,
            commit,
            acknowledged,
        ));
        Some(())
    }
    /// PUBLIC commitment only, generated with native CSPRNG using the existing
    /// identity/collection-bound SAS domain. No r/state/reveal or JS commit.
    pub fn private_enrol_commitment(&self) -> Vec<u8> {
        self.private
            .as_ref()
            .and_then(PrivateProofScope::enrol_commitment)
            .map(|c| c.to_vec())
            .unwrap_or_default()
    }
    /// HOST ONLY once after actual registration; exact public two-field pin.
    pub fn pin_cloud_copy_consuming(&mut self, bytes: &mut [u8]) -> bool {
        let accepted = (|| {
            if !self.registered
                || self.private.is_some()
                || self.cloud.is_some()
                || bytes.len() > 64
            {
                return None;
            }
            let mut r = Reader { bytes, pos: 0 };
            if r.arg(5).ok()? != 2 {
                return None;
            }
            r.field(0).ok()?;
            let collection = B16(r.fixed().ok()?);
            r.field(1).ok()?;
            let purpose = r.arg(0).ok()?;
            if collection.0 == [0; 16] || purpose > 1 || r.pos != bytes.len() {
                return None;
            }
            self.cloud = Some((collection, purpose == 0, false));
            Some(())
        })()
        .is_some();
        wipe(bytes);
        if !accepted {
            self.retire();
        }
        accepted
    }
    /// Fixed cloud-copy-create purpose, original native tuple only.
    pub fn sign_cloud_copy_create_consuming(&mut self, bytes: &mut [u8]) -> Vec<u8> {
        self.sign_cloud_copy_consuming(bytes, true)
    }
    /// Fixed cloud-copy-join purpose, original native tuple only.
    pub fn sign_cloud_copy_join_consuming(&mut self, bytes: &mut [u8]) -> Vec<u8> {
        self.sign_cloud_copy_consuming(bytes, false)
    }
    fn sign_cloud_copy_consuming(&mut self, bytes: &mut [u8], create: bool) -> Vec<u8> {
        let out = (|| {
            let (collection, pinned_create, issued) = self.cloud.as_mut()?;
            if *issued || *pinned_create != create || bytes.len() != 32 {
                return None;
            }
            *issued = true;
            let kind = if create {
                mdbn_replica::crypto::proof::CollectionProof::CloudCopyCreate
            } else {
                mdbn_replica::crypto::proof::CollectionProof::CloudCopyJoin
            };
            let digest = mdbn_replica::crypto::proof::collection_proof_digest(
                kind,
                (&*bytes).try_into().ok()?,
                &self.connector,
                &self.device,
                collection,
                None,
            )?;
            Some(self.signer.as_ref()?.sign_digest(&digest.0).to_vec())
        })()
        .unwrap_or_default();
        wipe(bytes);
        if out.is_empty() {
            self.retire();
        }
        out
    }
    /// Fixed private-create proof, challenge consumed/wiped, signature only.
    /// Refuses enrol/strict/second-use; failure retires the protected lifetime.
    pub fn sign_private_create_consuming(&mut self, bytes: &mut [u8]) -> Vec<u8> {
        let out = self
            .private
            .as_mut()
            .zip(self.signer.as_ref())
            .and_then(|(scope, signer)| {
                scope.sign_create(signer, self.connector, self.device, bytes)
            })
            .unwrap_or_default();
        wipe(bytes);
        if out.is_empty() {
            self.retire();
        }
        out
    }
    /// Fixed default private-device-enrol proof using the native commitment.
    /// No caller commit/r/domain override; challenge consumed and failure retires.
    pub fn sign_private_device_enrol_consuming(&mut self, bytes: &mut [u8]) -> Vec<u8> {
        let out = self
            .private
            .as_mut()
            .zip(self.signer.as_ref())
            .and_then(|(scope, signer)| {
                scope.sign_enrol(signer, self.connector, self.device, bytes)
            })
            .unwrap_or_default();
        wipe(bytes);
        if out.is_empty() {
            self.retire();
        }
        out
    }
    /// Consuming phase2. Metadata v2 retains v1 fields0–13, but keys10/11 MUST
    /// be null, adds14connector/15installation and requires version2. Old v1
    /// remains unchanged. Exact immutable pins checked BEFORE any SQL effect.
    pub fn adopt_consuming(
        mut self,
        bytes: &mut [u8],
        sql: Box<dyn AppSqlHost>,
        host: Host,
    ) -> Result<AppRuntime, OpenFailure> {
        let b = if bytes.len() > super::MAX_BOOTSTRAP || !self.registered {
            Err(invalid())
        } else {
            self.secrets.take().ok_or_else(invalid).and_then(|keys| {
                Bootstrap::parse_with_owner(
                    bytes,
                    Some((keys, self.connector, self.installation, self.device)),
                )
            })
        };
        wipe(bytes);
        let b = b?;
        if self
            .private
            .as_ref()
            .is_some_and(|scope| scope.collection != b.cfg.collection)
        {
            return Err(invalid());
        }
        if self.cloud.as_ref().is_some_and(|(collection, _, _)| {
            *collection != b.cfg.collection
                || b.cfg.chosen_state != Some(mdbn_wire::policy::CState::CloudCopy)
                || !b.cfg.user_enabled_cloud_copy
        }) {
            return Err(invalid());
        }
        let signer = self.signer.take().ok_or_else(invalid)?;
        let noise = self.noise.take().ok_or_else(invalid)?;
        let http = HttpSigner::adopt(
            signer,
            b.cfg.collection,
            b.cfg.log_endpoint,
            self.device,
            self.connector,
        );
        AppRuntime::compose_bootstrap(b, sql, host, http, Some(noise), self.private.take())
    }
    /// Terminal retirement. No SQL effects or wipe of uncertain platform state.
    pub fn retire(&mut self) {
        self.secrets = None;
        self.signer = None;
        self.private = None;
        self.cloud = None;
        if let Some(mut noise) = self.noise.take() {
            noise.retire();
        }
        self.proof_issued = false;
        self.registered = false;
    }
}
