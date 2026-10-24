//! Verifying an app's Noise key before serving it.
//!
//!
//! The control plane delivers, per grant, the app's signed authorization binding
//! (`application_authorization`, Connect's v4/v5 binding) and the app's Noise
//! static key (`client_pk`) with an attestation (`client_key_signature`). The
//! daemon serves a key over Noise only if **both** signatures verify:
//! 1. the binding under its own `installation_signing_public_key` (ECDSA P-256,
//!    low-S), over Connect's binding transcript, ported byte for byte from
//!    `connect-protocol/src/application_authorization.rs` and checked against its
//!    fixture;
//! 2. the attestation under the binding's `grant_signing_public_key`, over
//!    `"mdbase-next client noise key v1\0" ‖ u32be(16) ‖ authorization_id ‖
//!    u32be(32) ‖ client_pk`;
//!
//! and the key itself is usable (32 bytes, not all-zero, not low order).
//!
//! A control plane that swaps `client_pk` cannot forge the attestation. Swapping
//! the whole binding is the trust-on-first-use limit the access list's
//! notifications surface this limitation. The fingerprint shown to the user is
//! always computed here from the verified key, never taken from the feed.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const INSTALLATION_ID_DOMAIN: &[u8] = b"mdbase-connect application installation id v2\0";
const PROOF_V4_DOMAIN: &[u8] = b"mdbase-connect application authorization proof v4\0";
const PROOF_V5_DOMAIN: &[u8] = b"mdbase-connect application authorization proof v5\0";
const NOISE_KEY_DOMAIN: &[u8] = b"mdbase-next client noise key v1\0";

/// Why a grant's key is not served.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AttestError {
    /// Binding malformed or of an unsupported version.
    Binding(&'static str),
    /// The binding's signature does not verify.
    BindingSignature,
    /// No `client_pk` or no attestation (old SDK: compatibility layer only).
    Unattested,
    /// The attestation does not verify.
    AttestationSignature,
    /// The key is malformed, all-zero or of low order.
    WeakKey,
}

impl AttestError {
    /// Stable reason.
    pub fn reason(&self) -> &'static str {
        match self {
            AttestError::Binding(_) => "binding_invalid",
            AttestError::BindingSignature => "binding_signature",
            AttestError::Unattested => "client_key_unattested",
            AttestError::AttestationSignature => "client_key_signature",
            AttestError::WeakKey => "client_key_weak",
        }
    }
}

/// Connect's contract requirements in a binding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Contracts {
    /// Operation transport version.
    pub operation_transport: u32,
    /// Recovery transport versions (v5).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub operation_transport_recovery: Vec<u32>,
    /// Binding version.
    pub authorization_binding: u32,
    /// Semantic capability contract.
    pub semantic_capabilities: u32,
    /// Durable mutation contract.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub durable_mutation: Option<u32>,
}

/// File scope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FileScope {
    /// Only these folders.
    SelectedFolders {
        /// Folders.
        folders: Vec<String>,
    },
    /// The whole collection.
    Collection,
}

/// Requested file access.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileRequest {
    /// Actions (`list`, `read`, `add`, `replace`, `move`, `delete`).
    pub actions: Vec<String>,
    /// Scope.
    pub scope: FileScope,
}

/// Connect's application authorization binding (v4/v5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Binding {
    /// 4 or 5.
    pub protocol_version: u32,
    /// Authorization ID (UUID).
    pub authorization_id: String,
    /// Application ID (UUID).
    pub application_id: String,
    /// Declaration ID.
    pub application_declaration_id: String,
    /// Manifest digest (64 hex).
    pub application_manifest_digest: String,
    /// Installation ID (UUID).
    pub application_installation_id: String,
    /// P-256 SEC1 uncompressed, base64url.
    pub installation_signing_public_key: String,
    /// P-256, base64url.
    pub grant_agreement_public_key: String,
    /// P-256, base64url: signs the Noise key attestation.
    pub grant_signing_public_key: String,
    /// `authorization_code` or `device_code`.
    pub flow: String,
    /// 32 bytes, base64url.
    pub authorization_nonce: String,
    /// Issue time.
    pub issued_at: String,
    /// Expiry time.
    pub expires_at: String,
    /// Redirect URI (authorization code).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redirect_uri: Option<String>,
    /// OAuth state (authorization code).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    /// PKCE challenge, 32 bytes base64url.
    pub code_challenge: String,
    /// Contracts.
    pub contracts: Contracts,
    /// Operations.
    pub requested_operations: Vec<String>,
    /// Files.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_files: Option<FileRequest>,
    /// Collection (UUID).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collection_id: Option<String>,
}

/// The signed binding as delivered (`application_authorization`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Proof {
    /// Binding.
    pub binding: Binding,
    /// ECDSA P-256 P1363, base64url.
    pub signature: String,
}

fn b64(s: &str, len: usize) -> Result<Vec<u8>, AttestError> {
    let d = URL_SAFE_NO_PAD
        .decode(s)
        .map_err(|_| AttestError::Binding("base64"))?;
    if s.is_empty() || URL_SAFE_NO_PAD.encode(&d) != s || d.len() != len {
        return Err(AttestError::Binding("base64"));
    }
    Ok(d)
}

fn p256_key(s: &str) -> Result<Vec<u8>, AttestError> {
    let d = URL_SAFE_NO_PAD
        .decode(s)
        .map_err(|_| AttestError::Binding("public key"))?;
    if URL_SAFE_NO_PAD.encode(&d) != s || d.len() != 65 || d[0] != 4 || !on_curve(&d) {
        return Err(AttestError::Binding("public key"));
    }
    Ok(d)
}

/// Parse a UUID in its text form into 16 bytes.
pub fn uuid_bytes(s: &str) -> Option<[u8; 16]> {
    let h: String = s.chars().filter(|c| *c != '-').collect();
    if h.len() != 32 || s.len() != 36 {
        return None;
    }
    let v = crate::secrets::hex_decode(&h).ok()?;
    v.try_into().ok()
}

fn field(out: &mut Vec<u8>, f: &[u8]) {
    out.extend_from_slice(&(f.len() as u32).to_be_bytes());
    out.extend_from_slice(f);
}

fn opt_str(out: &mut Vec<u8>, v: Option<&str>) {
    match v {
        Some(v) => {
            out.push(1);
            field(out, v.as_bytes());
        }
        None => out.push(0),
    }
}

fn is_hex64(v: &str) -> bool {
    v.len() == 64
        && v.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn is_declaration_id(v: &str) -> bool {
    let mut sep = false;
    for (i, seg) in v
        .split(|c| {
            let s = matches!(c, '.' | '_' | '-');
            sep |= s;
            s
        })
        .enumerate()
    {
        if seg.is_empty()
            || (i == 0 && !seg.as_bytes()[0].is_ascii_lowercase())
            || !seg
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        {
            return false;
        }
    }
    sep
}

fn installation_id(signing: &[u8]) -> [u8; 16] {
    let mut d = Sha256::new();
    d.update(INSTALLATION_ID_DOMAIN);
    d.update((signing.len() as u32).to_be_bytes());
    d.update(signing);
    let d = d.finalize();
    let mut b = [0u8; 16];
    b.copy_from_slice(&d[..16]);
    b[6] = (b[6] & 0x0f) | 0x80;
    b[8] = (b[8] & 0x3f) | 0x80;
    b
}

const DURABLE_OPS: &[&str] = &[
    "batch",
    "create_view_source",
    "update_view_source",
    "delete_view_source",
    "create",
    "update",
    "delete",
    "rename",
    "create_type",
    "update_type",
    "apply_type_pack",
    "apply_collection_setup",
    "put_timer",
    "cancel_timer",
    "reconcile_timers",
    "sync",
];

fn requires_durable(b: &Binding) -> bool {
    b.requested_operations
        .iter()
        .any(|o| DURABLE_OPS.contains(&o.as_str()))
        || b.requested_files.as_ref().is_some_and(|f| {
            f.actions
                .iter()
                .any(|a| matches!(a.as_str(), "add" | "replace" | "move" | "delete"))
        })
}

fn contracts_valid(c: &Contracts, durable: bool) -> bool {
    let transports = [3u32, 2];
    [5u32, 4].contains(&c.authorization_binding)
        && transports.contains(&c.operation_transport)
        && [1u32, 2].contains(&c.semantic_capabilities)
        && (if durable {
            c.durable_mutation == Some(1)
        } else {
            c.durable_mutation.is_none()
        })
        && (c.authorization_binding != 5 || c.operation_transport == 3)
        && c.operation_transport_recovery
            .iter()
            .all(|v| *v != c.operation_transport && transports.contains(v))
        && c.operation_transport_recovery
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            == c.operation_transport_recovery.len()
        && (c.authorization_binding != 4 || c.operation_transport_recovery.is_empty())
        && (c.operation_transport_recovery.is_empty() || durable)
}

impl Binding {
    /// Connect's signing transcript (`signing_message`), with its validation.
    pub fn signing_message(&self) -> Result<Vec<u8>, AttestError> {
        if ![4, 5].contains(&self.protocol_version) {
            return Err(AttestError::Binding("version"));
        }
        let inst = p256_key(&self.installation_signing_public_key)?;
        let agree = p256_key(&self.grant_agreement_public_key)?;
        let sign = p256_key(&self.grant_signing_public_key)?;
        if inst == agree || inst == sign || agree == sign {
            return Err(AttestError::Binding("duplicate keys"));
        }
        let nonce = b64(&self.authorization_nonce, 32)?;
        b64(&self.code_challenge, 32)?;
        let bad_time = |t: &str| t.is_empty() || t.len() > 40 || t.as_bytes().contains(&0);
        let c = &self.contracts;
        let ops = &self.requested_operations;
        if bad_time(&self.issued_at)
            || bad_time(&self.expires_at)
            || !is_hex64(&self.application_manifest_digest)
            || !is_declaration_id(&self.application_declaration_id)
            || c.operation_transport == 0
            || c.authorization_binding == 0
            || c.semantic_capabilities == 0
            || c.durable_mutation == Some(0)
            || c.authorization_binding != self.protocol_version
            || !contracts_valid(c, requires_durable(self))
            || (ops.is_empty() && self.requested_files.is_none())
            || ops
                .iter()
                .any(|o| o.is_empty() || o.as_bytes().contains(&0))
            || ops.iter().collect::<std::collections::BTreeSet<_>>().len() != ops.len()
        {
            return Err(AttestError::Binding("fields"));
        }
        if let Some(f) = &self.requested_files {
            let known = ["list", "read", "add", "replace", "move", "delete"];
            if f.actions.is_empty()
                || f.actions.iter().any(|a| !known.contains(&a.as_str()))
                || f.actions
                    .iter()
                    .collect::<std::collections::BTreeSet<_>>()
                    .len()
                    != f.actions.len()
            {
                return Err(AttestError::Binding("files"));
            }
            if let FileScope::SelectedFolders { folders } = &f.scope
                && (folders.is_empty()
                    || folders
                        .iter()
                        .any(|x| x.is_empty() || x.as_bytes().contains(&0))
                    || folders
                        .iter()
                        .collect::<std::collections::BTreeSet<_>>()
                        .len()
                        != folders.len())
            {
                return Err(AttestError::Binding("files"));
            }
        }
        match self.flow.as_str() {
            "authorization_code" if self.redirect_uri.is_some() && self.state.is_some() => {}
            "device_code" if self.redirect_uri.is_none() && self.state.is_none() => {}
            _ => return Err(AttestError::Binding("flow")),
        }
        let uuid = |s: &str| uuid_bytes(s).ok_or(AttestError::Binding("uuid"));
        let inst_id = uuid(&self.application_installation_id)?;
        if installation_id(&inst) != inst_id {
            return Err(AttestError::Binding("installation id"));
        }

        let mut t = Vec::with_capacity(640);
        t.extend_from_slice(if self.protocol_version == 5 {
            PROOF_V5_DOMAIN
        } else {
            PROOF_V4_DOMAIN
        });
        t.extend_from_slice(&self.protocol_version.to_be_bytes());
        field(&mut t, &uuid(&self.application_id)?);
        field(&mut t, &uuid(&self.authorization_id)?);
        field(&mut t, self.application_declaration_id.as_bytes());
        field(
            &mut t,
            &crate::secrets::hex_decode(&self.application_manifest_digest)
                .map_err(|_| AttestError::Binding("digest"))?,
        );
        field(&mut t, &inst_id);
        field(&mut t, &inst);
        field(&mut t, &agree);
        field(&mut t, &sign);
        field(&mut t, self.flow.as_bytes());
        field(&mut t, &nonce);
        field(&mut t, self.issued_at.as_bytes());
        field(&mut t, self.expires_at.as_bytes());
        opt_str(&mut t, self.redirect_uri.as_deref());
        opt_str(&mut t, self.state.as_deref());
        field(&mut t, self.code_challenge.as_bytes());
        t.extend_from_slice(&c.operation_transport.to_be_bytes());
        if self.protocol_version == 5 {
            t.extend_from_slice(&(c.operation_transport_recovery.len() as u32).to_be_bytes());
            for v in &c.operation_transport_recovery {
                t.extend_from_slice(&v.to_be_bytes());
            }
        }
        t.extend_from_slice(&c.authorization_binding.to_be_bytes());
        t.extend_from_slice(&c.semantic_capabilities.to_be_bytes());
        match c.durable_mutation {
            Some(v) => {
                t.push(1);
                t.extend_from_slice(&v.to_be_bytes());
            }
            None => t.push(0),
        }
        t.extend_from_slice(&(ops.len() as u32).to_be_bytes());
        for o in ops {
            field(&mut t, o.as_bytes());
        }
        match &self.requested_files {
            None => t.push(0),
            Some(f) => {
                t.push(1);
                t.extend_from_slice(&(f.actions.len() as u32).to_be_bytes());
                for a in &f.actions {
                    field(&mut t, a.as_bytes());
                }
                match &f.scope {
                    FileScope::Collection => field(&mut t, b"collection"),
                    FileScope::SelectedFolders { folders } => {
                        field(&mut t, b"selected_folders");
                        t.extend_from_slice(&(folders.len() as u32).to_be_bytes());
                        for x in folders {
                            field(&mut t, x.as_bytes());
                        }
                    }
                }
            }
        }
        match &self.collection_id {
            Some(cid) => {
                t.push(1);
                field(&mut t, &uuid(cid)?);
            }
            None => t.push(0),
        }
        Ok(t)
    }
}

/// The P-256 group order.
const P256_N: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xbc, 0xe6, 0xfa, 0xad, 0xa7, 0x17, 0x9e, 0x84, 0xf3, 0xb9, 0xca, 0xc2, 0xfc, 0x63, 0x25, 0x51,
];

/// `s > n/2` (big-endian): a high-S signature, which Connect rejects.
fn high_s(s: &[u8]) -> bool {
    // n/2, rounded down.
    let mut half = [0u8; 32];
    let mut carry = 0u8;
    for (i, b) in P256_N.iter().enumerate() {
        half[i] = (b >> 1) | (carry << 7);
        carry = b & 1;
    }
    s > &half[..]
}

/// Whether `sec1` (uncompressed) is a valid point, by verifying nothing: ring
/// rejects off-curve keys when parsing; a dummy verification distinguishes a
/// key parse error from a signature mismatch only through timing, so instead
/// use ring's public-key check on an ECDH agreement with a throwaway key.
fn on_curve(sec1: &[u8]) -> bool {
    use ring::agreement;
    let rng = ring::rand::SystemRandom::new();
    let Ok(eph) = agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng) else {
        return false;
    };
    let peer = agreement::UnparsedPublicKey::new(&agreement::ECDH_P256, sec1);
    agreement::agree_ephemeral(eph, &peer, |_| ()).is_ok()
}

/// ECDSA P-256 / SHA-256 verification of a 64-byte P1363 signature, low-S only
/// (as Connect's `normalize_s` check). Uses `ring`, so no `rand_core`-based
/// `signature` crate enters the workspace (portable crates' wasm32 tree stays free
/// of `getrandom`).
fn verify_p256(key_sec1: &[u8], msg: &[u8], sig: &[u8]) -> bool {
    if sig.len() != 64 || high_s(&sig[32..]) {
        return false;
    }
    ring::signature::UnparsedPublicKey::new(&ring::signature::ECDSA_P256_SHA256_FIXED, key_sec1)
        .verify(msg, sig)
        .is_ok()
}

/// Test-only signer (`ring`), normalising to low-S like Connect's clients.
#[doc(hidden)]
pub mod test_signer {
    use super::*;
    use ring::signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair, KeyPair};

    /// A P-256 signing key.
    pub struct Signer(EcdsaKeyPair);

    impl Signer {
        /// From a raw scalar and its SEC1 public key (both base64url).
        pub fn from_scalar(scalar_b64: &str, public_b64: &str) -> Signer {
            let sk = URL_SAFE_NO_PAD.decode(scalar_b64).unwrap();
            let pk = URL_SAFE_NO_PAD.decode(public_b64).unwrap();
            Signer(
                EcdsaKeyPair::from_private_key_and_public_key(
                    &ECDSA_P256_SHA256_FIXED_SIGNING,
                    &sk,
                    &pk,
                    &ring::rand::SystemRandom::new(),
                )
                .unwrap(),
            )
        }

        /// A fresh random key.
        pub fn random() -> Signer {
            let rng = ring::rand::SystemRandom::new();
            let pkcs8 =
                EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).unwrap();
            Signer(
                EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref(), &rng)
                    .unwrap(),
            )
        }

        /// SEC1 public key, base64url.
        pub fn public_b64(&self) -> String {
            URL_SAFE_NO_PAD.encode(self.0.public_key().as_ref())
        }

        /// Sign; low-S P1363, base64url.
        pub fn sign(&self, msg: &[u8]) -> String {
            let sig = self.0.sign(&ring::rand::SystemRandom::new(), msg).unwrap();
            let mut b: [u8; 64] = sig.as_ref().try_into().unwrap();
            if high_s(&b[32..]) {
                // s = n - s
                let mut borrow = 0i16;
                for i in (0..32).rev() {
                    let v = P256_N[i] as i16 - b[32 + i] as i16 - borrow;
                    borrow = i16::from(v < 0);
                    b[32 + i] = (v + if v < 0 { 256 } else { 0 }) as u8;
                }
            }
            URL_SAFE_NO_PAD.encode(b)
        }
    }
}

impl Proof {
    /// Verify the binding's signature (step 1).
    pub fn verify(&self) -> Result<(), AttestError> {
        let msg = self.binding.signing_message()?;
        let key = p256_key(&self.binding.installation_signing_public_key)?;
        let sig = b64(&self.signature, 64).map_err(|_| AttestError::BindingSignature)?;
        if verify_p256(&key, &msg, &sig) {
            Ok(())
        } else {
            Err(AttestError::BindingSignature)
        }
    }
}

/// The attestation message for `client_pk`.
pub fn attestation_message(authorization_id: &[u8; 16], client_pk: &[u8; 32]) -> Vec<u8> {
    let mut m = Vec::with_capacity(NOISE_KEY_DOMAIN.len() + 56);
    m.extend_from_slice(NOISE_KEY_DOMAIN);
    field(&mut m, authorization_id);
    field(&mut m, client_pk);
    m
}

/// X25519 low-order points (and their non-canonical aliases): a peer static key
/// equal to one of these makes every DH output predictable.
fn low_order(k: &[u8; 32]) -> bool {
    const BAD: [[u8; 32]; 7] = [
        [0; 32],
        {
            let mut a = [0u8; 32];
            a[0] = 1;
            a
        },
        [
            0xe0, 0xeb, 0x7a, 0x7c, 0x3b, 0x41, 0xb8, 0xae, 0x16, 0x56, 0xe3, 0xfa, 0xf1, 0x9f,
            0xc4, 0x6a, 0xda, 0x09, 0x8d, 0xeb, 0x9c, 0x32, 0xb1, 0xfd, 0x86, 0x62, 0x05, 0x16,
            0x5f, 0x49, 0xb8, 0x00,
        ],
        [
            0x5f, 0x9c, 0x95, 0xbc, 0xa3, 0x50, 0x8c, 0x24, 0xb1, 0xd0, 0xb1, 0x55, 0x9c, 0x83,
            0xef, 0x5b, 0x04, 0x44, 0x5c, 0xc4, 0x58, 0x1c, 0x8e, 0x86, 0xd8, 0x22, 0x4e, 0xdd,
            0xd0, 0x9f, 0x11, 0x57,
        ],
        [
            0xec, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
            0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
            0xff, 0xff, 0xff, 0x7f,
        ],
        [
            0xed, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
            0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
            0xff, 0xff, 0xff, 0x7f,
        ],
        [
            0xee, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
            0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
            0xff, 0xff, 0xff, 0x7f,
        ],
    ];
    // Compare with the top bit cleared too (RFC 7748 ignores it).
    let mut masked = *k;
    masked[31] &= 0x7f;
    BAD.iter().any(|b| b == k || *b == masked)
        // A small-order check by multiplication: [8]P = identity for small order.
        || {
            let out = x25519_dalek::x25519([8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], *k);
            out == [0u8; 32]
        }
}

/// Verify a grant's Noise key: binding, then attestation, then the key. Returns
/// the verified key.
pub fn verify_client_key(
    proof: &Proof,
    client_pk_hex: Option<&str>,
    signature_b64: Option<&str>,
) -> Result<[u8; 32], AttestError> {
    proof.verify()?;
    let (Some(pk_hex), Some(sig)) = (client_pk_hex, signature_b64) else {
        return Err(AttestError::Unattested);
    };
    let pk: [u8; 32] = crate::secrets::hex_decode(pk_hex)
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or(AttestError::WeakKey)?;
    if low_order(&pk) {
        return Err(AttestError::WeakKey);
    }
    let sig = b64(sig, 64).map_err(|_| AttestError::AttestationSignature)?;
    let auth_id =
        uuid_bytes(&proof.binding.authorization_id).ok_or(AttestError::Binding("uuid"))?;
    let grant_key = p256_key(&proof.binding.grant_signing_public_key)?;
    if !verify_p256(&grant_key, &attestation_message(&auth_id, &pk), &sig) {
        return Err(AttestError::AttestationSignature);
    }
    Ok(pk)
}

#[cfg(test)]
mod tests {
    use super::test_signer::Signer;
    use super::*;

    fn fixture() -> (Proof, Signer, serde_json::Value) {
        let v: serde_json::Value = serde_json::from_str(include_str!(
            "../tests/fixtures/application-authorization-v4.json"
        ))
        .unwrap();
        let binding: Binding = serde_json::from_value(v["binding"].clone()).unwrap();
        let sk = Signer::from_scalar(
            v["installation_signing_private_key"].as_str().unwrap(),
            v["binding"]["installation_signing_public_key"]
                .as_str()
                .unwrap(),
        );
        let proof = Proof {
            binding,
            signature: v["signature"].as_str().unwrap_or_default().to_string(),
        };
        (proof, sk, v)
    }

    fn sign(sk: &Signer, msg: &[u8]) -> String {
        sk.sign(msg)
    }

    #[test]
    fn transcript_matches_connects_fixture() {
        let (proof, sk, v) = fixture();
        let msg = proof.binding.signing_message().unwrap();
        assert_eq!(
            crate::secrets::hex(&Sha256::digest(&msg)),
            v["signing_message_sha256"].as_str().unwrap()
        );
        let mut p = proof.clone();
        p.signature = sign(&sk, &msg);
        p.verify().unwrap();
        let mut tampered = p.clone();
        tampered.binding.requested_operations.push("delete".into());
        assert!(tampered.verify().is_err());
    }

    #[test]
    fn attestation_chain() {
        let (mut proof, sk, _) = fixture();
        proof.signature = sign(&sk, &proof.binding.signing_message().unwrap());
        // The fixture's grant signing key's private half isn't published, so use a
        // fresh binding key pair for the attestation path.
        let grant_sk = Signer::random();
        let grant_pk = grant_sk.public_b64();
        proof.binding.grant_signing_public_key = grant_pk;
        proof.signature = sign(&sk, &proof.binding.signing_message().unwrap());

        let client_pk = crate::noise::public_key(&[9u8; 32]);
        let auth = uuid_bytes(&proof.binding.authorization_id).unwrap();
        let att = sign(&grant_sk, &attestation_message(&auth, &client_pk));
        let hex = crate::secrets::hex(&client_pk);
        assert_eq!(
            verify_client_key(&proof, Some(&hex), Some(&att)).unwrap(),
            client_pk
        );

        // Substituted key: the attestation no longer verifies.
        let other = crate::secrets::hex(&crate::noise::public_key(&[10u8; 32]));
        assert_eq!(
            verify_client_key(&proof, Some(&other), Some(&att)),
            Err(AttestError::AttestationSignature)
        );
        // No attestation: compatibility layer only.
        assert_eq!(
            verify_client_key(&proof, Some(&hex), None),
            Err(AttestError::Unattested)
        );
        // Low-order key, even if "attested".
        let zero = [0u8; 32];
        let att0 = sign(&grant_sk, &attestation_message(&auth, &zero));
        assert_eq!(
            verify_client_key(&proof, Some(&crate::secrets::hex(&zero)), Some(&att0)),
            Err(AttestError::WeakKey)
        );
        // A broken binding signature stops everything.
        let mut bad = proof.clone();
        bad.signature = sign(&grant_sk, b"x");
        assert_eq!(
            verify_client_key(&bad, Some(&hex), Some(&att)),
            Err(AttestError::BindingSignature)
        );
    }
}
