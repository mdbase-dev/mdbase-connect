//! Device-origin proofs for bounded SAS metadata (device-approval.cddl).
//! A signature proves the encoded sender key, NOT account/role authority. Compare
//! the whole tuple to the receiver's current independently verified policy.

use super::approval_runtime::{ApprovalBinding, ApprovalChallenge, ApprovalDevice, ApprovalReveal};
use crate::crypto::{
    CryptoError,
    sign::{DeviceSigner, Ed25519Verifier},
};
use crate::policy::PolicyState;
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::common::{B32, B64, Uuid};
use mdbn_wire::policy::{CState, DeviceKind, Role};
use mdbn_wire::schema::Wire;

/// Maximum complete encoded metadata envelope; reject BEFORE CBOR allocation.
pub const MAX_APPROVAL_PEER_BYTES: usize = 2048;
const DOMAIN: &str = "mdbase/v1/device-approval-peer";
const MAX_UTC_MS: i64 = 9_007_199_254_740_991;

/// Exact signed metadata kind. No expected code, credentials or key material.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApprovalPeerMessage {
    /// Originated by the current approving USER device.
    Challenge(ApprovalChallenge),
    /// Originated by the requester AFTER durable secret-state persistence.
    Reveal(ApprovalReveal),
}

/// Canonical metadata body and its device-origin signature. Nonces are redacted
/// by the message's Debug. Untrusted tuple fields alone are never authority.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalPeerEnvelope {
    /// Full exact body.
    pub message: ApprovalPeerMessage,
    /// Existing Ed25519 device signature of the domain-separated body digest.
    pub signature: B64,
}
fn map(values: Vec<Cbor>) -> Cbor {
    Cbor::Map(
        values
            .into_iter()
            .enumerate()
            .map(|(k, v)| (Cbor::Uint(k as u64), v))
            .collect(),
    )
}
fn closed(c: &Cbor, count: usize) -> Result<Vec<&Cbor>, CryptoError> {
    let Cbor::Map(m) = c else {
        return Err(CryptoError::Encoding);
    };
    if m.len() != count
        || m.iter()
            .enumerate()
            .any(|(i, (k, _))| *k != Cbor::Uint(i as u64))
    {
        return Err(CryptoError::Encoding);
    }
    Ok(m.iter().map(|(_, v)| v).collect())
}
fn field<T: Wire>(c: &Cbor) -> Result<T, CryptoError> {
    T::from_cbor(c).map_err(|_| CryptoError::Encoding)
}
fn user(kind: DeviceKind) -> bool {
    matches!(
        kind,
        DeviceKind::Desktop | DeviceKind::Mobile | DeviceKind::AppRuntime | DeviceKind::Cli
    )
}
fn device_cbor(d: &ApprovalDevice) -> Cbor {
    map(vec![
        d.device.to_cbor(),
        d.account.to_cbor(),
        d.kind.to_cbor(),
        d.sign_pk.to_cbor(),
        d.kem_pk.to_cbor(),
        d.noise_pk.to_cbor(),
    ])
}
fn device_from(c: &Cbor) -> Result<ApprovalDevice, CryptoError> {
    let v = closed(c, 6)?;
    Ok(ApprovalDevice {
        device: field(v[0])?,
        account: field(v[1])?,
        kind: field(v[2])?,
        sign_pk: field(v[3])?,
        kem_pk: field(v[4])?,
        noise_pk: field(v[5])?,
    })
}
fn binding_cbor(b: &ApprovalBinding) -> Cbor {
    map(vec![
        b.collection.to_cbor(),
        b.epoch.to_cbor(),
        device_cbor(&b.approver),
        device_cbor(&b.requester),
        b.commitment.to_cbor(),
    ])
}
fn binding_from(c: &Cbor) -> Result<ApprovalBinding, CryptoError> {
    let v = closed(c, 5)?;
    Ok(ApprovalBinding {
        collection: field(v[0])?,
        epoch: field(v[1])?,
        approver: device_from(v[2])?,
        requester: device_from(v[3])?,
        commitment: field(v[4])?,
    })
}
impl ApprovalPeerMessage {
    /// Exact challenge echoed by either kind; r_A is its fresh exchange generation.
    pub fn challenge(&self) -> &ApprovalChallenge {
        match self {
            Self::Challenge(c) => c,
            Self::Reveal(r) => &r.challenge,
        }
    }
    fn sender(&self) -> &ApprovalDevice {
        let b = &self.challenge().binding;
        match self {
            Self::Challenge(_) => &b.approver,
            Self::Reveal(_) => &b.requester,
        }
    }
    fn validate(&self) -> Result<(), CryptoError> {
        let c = self.challenge();
        let b = &c.binding;
        if b.epoch == 0
            || b.collection.0 == [0; 16]
            || b.approver.device == b.requester.device
            || [
                b.approver.device,
                b.approver.account,
                b.requester.device,
                b.requester.account,
            ]
            .iter()
            .any(|id| id.0 == [0; 16])
            || !user(b.approver.kind)
            || !user(b.requester.kind)
            || !(0..=MAX_UTC_MS).contains(&c.expires_at_ms)
        {
            return Err(CryptoError::Encoding);
        }
        Ok(())
    }
    fn body_cbor(&self) -> Result<Cbor, CryptoError> {
        self.validate()?;
        let c = self.challenge();
        let mut body = vec![
            Cbor::Uint(1),
            Cbor::Uint(match self {
                Self::Challenge(_) => 0,
                Self::Reveal(_) => 1,
            }),
            binding_cbor(&c.binding),
            c.r_a.to_cbor(),
            Cbor::int(c.expires_at_ms),
        ];
        if let Self::Reveal(r) = self {
            body.push(r.r_n.to_cbor());
        }
        Ok(map(body))
    }
    fn digest(&self) -> Result<B32, CryptoError> {
        let bytes = cbor::encode(&self.body_cbor()?).map_err(|_| CryptoError::Encode)?;
        Ok(mdbn_wire::hash::h(DOMAIN, &bytes))
    }
    /// Device-origin proof ONLY. Trusted controllers must enforce current account,
    /// full custody/context and requester persistence BEFORE calling this method.
    pub fn sign(self, signer: &DeviceSigner) -> Result<ApprovalPeerEnvelope, CryptoError> {
        if signer.public() != self.sender().sign_pk.0 {
            return Err(CryptoError::Signature);
        }
        let signature = B64(signer.sign_digest(&self.digest()?.0));
        Ok(ApprovalPeerEnvelope {
            message: self,
            signature,
        })
    }
}
impl ApprovalPeerEnvelope {
    /// Device-origin signature, not account/role/policy authority on its own.
    pub fn verify_signature(&self) -> bool {
        self.message.digest().is_ok_and(|digest| {
            Ed25519Verifier.verify(
                &self.message.sender().sign_pk.0,
                &digest.0,
                &self.signature.0,
            )
        })
    }
    /// Verify origin AND exact current USER enrolments/member roles/private epoch
    /// and commitment. `policy` MUST be independently verified, never peer metadata.
    /// `collection` MUST come from the independently bound receiver/route, never
    /// copied from the untrusted body. Own account/custody/lifecycle and wall
    /// lifetime checks remain required.
    pub fn verify_for_policy(&self, collection: Uuid, policy: &PolicyState) -> bool {
        let b = &self.message.challenge().binding;
        let matches = |t: &ApprovalDevice, keyed| {
            policy.devices.get(&t.device).is_some_and(|d| {
                d.active
                    && d.keyed == keyed
                    && d.account == t.account
                    && d.kind == t.kind
                    && d.sign_pk == t.sign_pk
                    && d.kem_pk == t.kem_pk
                    && d.noise_pk == t.noise_pk
                    && policy.members.contains_key(&d.account)
            })
        };
        self.verify_signature()
            && b.collection == collection
            && policy.cstate == Some(CState::E2e)
            && !policy.frozen
            && !policy.rekey_required
            && policy.epoch == b.epoch
            && matches(&b.approver, true)
            && matches(&b.requester, false)
            && policy
                .devices
                .get(&b.requester.device)
                .and_then(|d| d.sas_commit)
                == Some(b.commitment)
            && policy.members.get(&b.approver.account).is_some_and(|role| {
                *role >= Role::Editor
                    && (b.approver.account == b.requester.account || *role == Role::Owner)
            })
    }
    /// Strict canonical closed-map transport bytes, at most 2048 bytes.
    pub fn to_bytes(&self) -> Result<Vec<u8>, CryptoError> {
        let bytes = cbor::encode(&map(vec![
            self.message.body_cbor()?,
            self.signature.to_cbor(),
        ]))
        .map_err(|_| CryptoError::Encode)?;
        if bytes.len() > MAX_APPROVAL_PEER_BYTES {
            return Err(CryptoError::TooLarge);
        }
        Ok(bytes)
    }
    /// Decode a bounded strict mdb-cbor/1 body. This does NOT accept its tuple as
    /// authority: caller MUST verify against its own current policy/context.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, CryptoError> {
        if bytes.len() > MAX_APPROVAL_PEER_BYTES {
            return Err(CryptoError::TooLarge);
        }
        let c = cbor::decode(bytes).map_err(|_| CryptoError::Encoding)?;
        let envelope = closed(&c, 2)?;
        let Cbor::Map(m) = envelope[0] else {
            return Err(CryptoError::Encoding);
        };
        let body = closed(envelope[0], m.len())?;
        if body.len() < 2 || field::<u64>(body[0])? != 1 {
            return Err(CryptoError::Encoding);
        }
        let kind = field::<u64>(body[1])?;
        if !matches!((kind, body.len()), (0, 5) | (1, 6)) {
            return Err(CryptoError::Encoding);
        }
        let challenge = ApprovalChallenge {
            binding: binding_from(body[2])?,
            r_a: field(body[3])?,
            expires_at_ms: field(body[4])?,
        };
        let message = if kind == 0 {
            ApprovalPeerMessage::Challenge(challenge)
        } else {
            ApprovalPeerMessage::Reveal(ApprovalReveal {
                challenge,
                r_n: field(body[5])?,
            })
        };
        message.validate()?;
        let result = Self {
            message,
            signature: field(envelope[1])?,
        };
        if result.to_bytes()? != bytes {
            return Err(CryptoError::Encoding);
        }
        Ok(result)
    }
    /// Encoded sender ID; NOT authenticated until origin/current-policy checks.
    pub fn sender_device(&self) -> Uuid {
        self.message.sender().device
    }
}
