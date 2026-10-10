use std::collections::{BTreeMap, BTreeSet};

use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{Channel, Keyset, Manifest, UpdateError};

pub(super) const MANIFEST_DOMAIN: &str = "mdbase-next/desktop-manifest/v1";
pub(super) const KEYSET_DOMAIN: &str = "mdbase-next/desktop-keyset/v1";
const MAX_DOCUMENT_BYTES: usize = 64 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DetachedSignature {
    key_id: String,
    signature: String,
}

/// Public keys provisioned out of band. This API deliberately has no production
/// defaults; the offline ceremony and actual KMS public keys are release blockers.
pub struct PinnedKeys {
    ci: BTreeMap<String, VerifyingKey>,
    recovery: VerifyingKey,
}

/// Complete original provisioned trust family, before additions/revocations.
/// IDs, roles and exact public bytes are inseparable; a recovery pin alone is
/// insufficient because two configurations can share it but pin different CI keys.
pub(super) type PinIdentity = BTreeMap<String, PinBinding>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PinBinding {
    role: PinRole,
    public_key: [u8; 32],
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum PinRole {
    Ci,
    Recovery,
}

/// Constructible only by successful recovery signature verification.
pub struct VerifiedKeyset {
    pub(super) document: Keyset,
    pub(super) digest: [u8; 32],
    pub(super) pins: PinIdentity,
    ci: BTreeMap<String, VerifyingKey>,
}

/// Constructible only by successful CI signature and schema/freshness verification.
pub struct VerifiedManifest {
    pub(super) document: Manifest,
    pub(super) key_id: String,
    pub(super) keyset_digest: [u8; 32],
    pub(super) verified_at: i64,
    pub(super) pins: PinIdentity,
}

impl VerifiedManifest {
    /// Read the signed, validated release fields.
    pub fn document(&self) -> &Manifest {
        &self.document
    }
}

impl VerifiedKeyset {
    /// Read the recovery-signed key statement.
    pub fn document(&self) -> &Keyset {
        &self.document
    }
}

impl PinnedKeys {
    /// Provision distinct, non-weak current/next CI keys and a recovery key.
    pub fn new(ci: BTreeMap<String, [u8; 32]>, recovery: [u8; 32]) -> Result<Self, UpdateError> {
        if ci.len() != 2 || !ci.contains_key("ci-current") || !ci.contains_key("ci-next") {
            return Err(UpdateError("exactly ci-current and ci-next must be pinned"));
        }
        let recovery = key(recovery)?;
        let ci = ci
            .into_iter()
            .map(|(id, bytes)| Ok((id, key(bytes)?)))
            .collect::<Result<BTreeMap<_, _>, UpdateError>>()?;
        if ci.values().any(|k| k == &recovery) || ci["ci-current"] == ci["ci-next"] {
            return Err(UpdateError("key roles must use distinct public keys"));
        }
        Ok(Self { ci, recovery })
    }

    pub(super) fn identity(&self) -> PinIdentity {
        let mut identity: PinIdentity = self
            .ci
            .iter()
            .map(|(id, public)| {
                (
                    id.clone(),
                    PinBinding {
                        role: PinRole::Ci,
                        public_key: public.to_bytes(),
                    },
                )
            })
            .collect();
        identity.insert(
            "recovery".into(),
            PinBinding {
                role: PinRole::Recovery,
                public_key: self.recovery.to_bytes(),
            },
        );
        identity
    }

    /// Verify exact bytes under the recovery domain and construct the CI trust set.
    pub fn verify_keyset(
        &self,
        bytes: &[u8],
        signature: &[u8],
    ) -> Result<VerifiedKeyset, UpdateError> {
        limit(bytes)?;
        let detached = detached(signature)?;
        if detached.key_id != "recovery" {
            return Err(UpdateError("keyset requires the recovery key"));
        }
        verify(&self.recovery, KEYSET_DOMAIN, bytes, &detached.signature)?;
        let document: Keyset =
            serde_json::from_slice(bytes).map_err(|_| UpdateError("invalid keyset JSON"))?;
        if document.sequence == 0 || document.added.len() > 32 || document.revoked.len() > 128 {
            return Err(UpdateError("invalid keyset sequence or size"));
        }
        let mut revoked = BTreeSet::new();
        for id in &document.revoked {
            if !valid_id(id) || !revoked.insert(id) {
                return Err(UpdateError("invalid or duplicate revoked key id"));
            }
        }
        let mut ci = self.ci.clone();
        for addition in &document.added {
            if !valid_id(&addition.id) || ci.contains_key(&addition.id) {
                return Err(UpdateError("invalid or reused added key id"));
            }
            let public = key(hex(&addition.public_key)?)?;
            if public == self.recovery || ci.values().any(|k| k == &public) {
                return Err(UpdateError("added key reuses an existing key"));
            }
            ci.insert(addition.id.clone(), public);
        }
        for id in &document.revoked {
            ci.remove(id);
        }
        Ok(VerifiedKeyset {
            document,
            digest: digest(KEYSET_DOMAIN, bytes),
            pins: self.identity(),
            ci,
        })
    }

    /// Verify exact bytes under a non-revoked CI key, then validate release fields.
    pub fn verify_manifest(
        &self,
        bytes: &[u8],
        signature: &[u8],
        channel: Channel,
        now: i64,
        keys: &VerifiedKeyset,
    ) -> Result<VerifiedManifest, UpdateError> {
        limit(bytes)?;
        if keys.pins != self.identity() {
            return Err(UpdateError(
                "proof belongs to different original pin family",
            ));
        }
        let detached = detached(signature)?;
        let public = keys
            .ci
            .get(&detached.key_id)
            .ok_or(UpdateError("unknown or revoked manifest key"))?;
        verify(public, MANIFEST_DOMAIN, bytes, &detached.signature)?;
        let document: Manifest =
            serde_json::from_slice(bytes).map_err(|_| UpdateError("invalid manifest JSON"))?;
        document.validate(channel, now)?;
        Ok(VerifiedManifest {
            document,
            key_id: detached.key_id,
            keyset_digest: keys.digest,
            verified_at: now,
            pins: keys.pins.clone(),
        })
    }
}

fn limit(bytes: &[u8]) -> Result<(), UpdateError> {
    if bytes.len() > MAX_DOCUMENT_BYTES {
        Err(UpdateError("signed document too large"))
    } else {
        Ok(())
    }
}

fn detached(bytes: &[u8]) -> Result<DetachedSignature, UpdateError> {
    if bytes.len() > 1024 {
        return Err(UpdateError("signature envelope too large"));
    }
    serde_json::from_slice(bytes).map_err(|_| UpdateError("invalid detached signature envelope"))
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id != "recovery"
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn key(bytes: [u8; 32]) -> Result<VerifyingKey, UpdateError> {
    let key = VerifyingKey::from_bytes(&bytes).map_err(|_| UpdateError("invalid public key"))?;
    if key.is_weak() {
        return Err(UpdateError("weak public key"));
    }
    Ok(key)
}

pub(super) fn digest(tag: &str, bytes: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update([u8::try_from(tag.len()).expect("fixed domain length")]);
    h.update(tag.as_bytes());
    h.update(bytes);
    h.finalize().into()
}

fn verify(key: &VerifyingKey, tag: &str, bytes: &[u8], signature: &str) -> Result<(), UpdateError> {
    key.verify_strict(
        &digest(tag, bytes),
        &Signature::from_bytes(&hex(signature)?),
    )
    .map_err(|_| UpdateError("invalid signature"))
}

pub(super) fn hex<const N: usize>(text: &str) -> Result<[u8; N], UpdateError> {
    if text.len() != N * 2 {
        return Err(UpdateError("invalid lowercase hex length"));
    }
    let mut bytes = [0; N];
    for (pair, out) in text.as_bytes().chunks_exact(2).zip(&mut bytes) {
        let nibble = |b| match b {
            b'0'..=b'9' => Ok(b - b'0'),
            b'a'..=b'f' => Ok(b - b'a' + 10),
            _ => Err(UpdateError("invalid lowercase hex")),
        };
        *out = nibble(pair[0])? * 16 + nibble(pair[1])?;
    }
    Ok(bytes)
}
