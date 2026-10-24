//! Builders for signed items, tokens and objects, for tests, the conformance suite
//! and benchmarks. Bodies are opaque filler: the service never interprets them, and
//! neither does this module (no collection keys exist here).

use ed25519_dalek::{Signer, SigningKey};
use mdbn_wire::common::{B16, B32, B64, Bytes, Uuid};
use mdbn_wire::envelope::{Item, ItemKind, KeyWrap, RekeyPayload, RekeyReason, SealedBox};
use mdbn_wire::hash::{h, sha256};
use mdbn_wire::policy::{
    CState, CpCert, DeviceEnrol, DeviceKind, Genesis, PolicyOp, PolicyPayload,
};
use mdbn_wire::schema::Wire;

use crate::auth::{Claims, hello_digest, http_digest, token_digest};
use crate::policy::key_id;

/// A signing key from a seed (deterministic).
pub fn key(seed: &[u8]) -> SigningKey {
    SigningKey::from_bytes(&sha256(seed).0)
}

fn pk(k: &SigningKey) -> B32 {
    B32(k.verifying_key().to_bytes())
}

fn sign_item(k: &SigningKey, mut item: Item) -> Vec<u8> {
    let d = item.signed_digest().expect("digest");
    item.sig = Some(B64(k.sign(&d.0).to_bytes()));
    item.to_bytes().expect("item encodes")
}

/// A 16-byte ID from a label.
pub fn id16(label: &str) -> B16 {
    B16(sha256(label.as_bytes()).0[..16].try_into().unwrap())
}

/// The control plane: root key, one certified policy key, and the token issuer.
pub struct ControlPlane {
    root: SigningKey,
    policy: SigningKey,
    issuer: SigningKey,
    cert: CpCert,
}

impl ControlPlane {
    /// A control plane from a seed label.
    pub fn new(label: &str) -> Self {
        let root = key(format!("{label}/root").as_bytes());
        let policy = key(format!("{label}/policy").as_bytes());
        let issuer = key(format!("{label}/issuer").as_bytes());
        let mut cert = CpCert {
            policy_pk: pk(&policy),
            not_before: 0,
            not_after: i64::MAX,
            root: key_id(&pk(&root)),
            sig: B64([0; 64]),
        };
        let d = cert.signed_digest().unwrap();
        cert.sig = B64(root.sign(&d.0).to_bytes());
        ControlPlane {
            root,
            policy,
            issuer,
            cert,
        }
    }
    /// Root public key (pin it in the service config).
    pub fn root_pk(&self) -> B32 {
        pk(&self.root)
    }
    /// Token issuer public key.
    pub fn issuer_pk(&self) -> B32 {
        pk(&self.issuer)
    }
    /// Policy key ID.
    pub fn policy_key_id(&self) -> B16 {
        key_id(&pk(&self.policy))
    }
    /// The control plane's own transport key.
    pub fn transport_key(&self) -> &SigningKey {
        &self.policy
    }
    /// A policy item at `(seq, prev)`.
    pub fn policy_item(
        &self,
        c: Uuid,
        seq: u64,
        prev: B32,
        ops: Vec<PolicyOp>,
        issued_at: i64,
    ) -> Vec<u8> {
        let payload = PolicyPayload {
            cert: self.cert.clone(),
            issued_at,
            ops,
        };
        let item = Item {
            kind: ItemKind::Policy,
            collection: c,
            seq: Some(seq),
            prev: Some(prev),
            epoch: None,
            signer: Some(self.policy_key_id()),
            salt: None,
            idem: None,
            refs: None,
            stream: None,
            body: Bytes(payload.to_bytes().unwrap()),
            sig: None,
        };
        sign_item(&self.policy, item)
    }
    /// The genesis item (`seq` 1), owner as given, e2e.
    pub fn genesis(&self, c: Uuid, owner: Uuid) -> Vec<u8> {
        self.policy_item(
            c,
            1,
            B32([0; 32]),
            vec![PolicyOp::Genesis(Genesis {
                owner,
                root: key_id(&self.root_pk()),
                state: CState::E2e,
            })],
            1,
        )
    }
    fn token(&self, claims: &Claims) -> String {
        let c = claims.encode();
        let sig = self.issuer.sign(&token_digest(&c).0);
        format!(
            "{}.{}",
            mdbn_wire::render::hex(&c),
            mdbn_wire::render::hex(&sig.to_bytes())
        )
    }
    /// A control-plane access token.
    pub fn cp_token(&self, expires_at: i64) -> String {
        self.token(&Claims {
            control_plane: true,
            device: None,
            sign_pk: pk(&self.policy),
            expires_at,
            collection: None,
        })
    }
    /// A device access token bound to its signing key.
    pub fn device_token(&self, d: &Device, expires_at: i64) -> String {
        self.device_token_for(d, expires_at, None)
    }
    /// A device token, optionally scoped to one collection (claim 5).
    pub fn device_token_for(
        &self,
        d: &Device,
        expires_at: i64,
        collection: Option<Uuid>,
    ) -> String {
        self.token(&Claims {
            control_plane: false,
            device: Some(d.id),
            sign_pk: d.pk(),
            expires_at,
            collection,
        })
    }
}

/// An enrolled (or to-be-enrolled) device.
pub struct Device {
    /// Device ID.
    pub id: Uuid,
    /// Its account.
    pub account: Uuid,
    sk: SigningKey,
}

/// Sign a `hello` or HTTP digest with any key.
pub fn sign_digest(k: &SigningKey, d: &B32) -> B64 {
    B64(k.sign(&d.0).to_bytes())
}

impl Device {
    /// A device from a label.
    pub fn new(label: &str, account: Uuid) -> Self {
        Device {
            id: id16(&format!("device/{label}")),
            account,
            sk: key(format!("device/{label}").as_bytes()),
        }
    }
    /// A device with a chosen ID and its own key (for impostor tests).
    pub fn with_id(label: &str, id: Uuid, account: Uuid) -> Self {
        Device {
            id,
            account,
            sk: key(format!("device/{label}").as_bytes()),
        }
    }
    /// Signing public key.
    pub fn pk(&self) -> B32 {
        pk(&self.sk)
    }
    /// Its signing key.
    pub fn signing_key(&self) -> &SigningKey {
        &self.sk
    }
    /// The `device-enrol` op.
    pub fn enrol(&self, kind: DeviceKind) -> PolicyOp {
        PolicyOp::DeviceEnrol(DeviceEnrol {
            device: self.id,
            account: self.account,
            kind,
            sign_pk: self.pk(),
            kem_pk: B32(h("kem", &self.id.0).0),
            noise_pk: B32(h("noise", &self.id.0).0),
            sas_commit: None,
            local_root: None,
        })
    }
    /// The `hello` proof of possession.
    pub fn hello_sig(&self, nonce: &[u8; 32], token: &str) -> B64 {
        sign_digest(&self.sk, &hello_digest(nonce, token))
    }
    /// A plain-HTTPS request signature.
    pub fn http_sig(
        &self,
        nonce: &[u8; 32],
        path: &str,
        token: &str,
        method: &str,
        body: &[u8],
    ) -> B64 {
        let c = crate::auth::request_collection(body);
        sign_digest(&self.sk, &http_digest(nonce, path, &c, token, method, body))
    }
    /// An `entry` item at `(seq, prev)` with an opaque body.
    pub fn entry(
        &self,
        c: Uuid,
        seq: u64,
        prev: B32,
        epoch: u64,
        idem: B16,
        refs: Option<Vec<B32>>,
        body: Vec<u8>,
    ) -> Vec<u8> {
        let item = Item {
            kind: ItemKind::Entry,
            collection: c,
            seq: Some(seq),
            prev: Some(prev),
            epoch: Some(epoch),
            signer: Some(self.id),
            salt: Some(B16(sha256(&body).0[..16].try_into().unwrap())),
            idem: Some(idem),
            refs,
            stream: None,
            body: Bytes(body),
            sig: None,
        };
        sign_item(&self.sk, item)
    }
    /// A `rekey` item from `from` to `from + 1`, wrapping for `recipients`.
    pub fn rekey(&self, c: Uuid, seq: u64, prev: B32, from: u64, recipients: &[Uuid]) -> Vec<u8> {
        let payload = RekeyPayload {
            epoch: from + 1,
            from,
            commit: h("commit", &seq.to_be_bytes()),
            wraps: recipients
                .iter()
                .map(|d| KeyWrap {
                    device: *d,
                    enc: B32(h("enc", &d.0).0),
                    ct: Bytes(vec![7; 48]),
                })
                .collect(),
            history: SealedBox {
                salt: B16([1; 16]),
                ct: Bytes(vec![2; 32]),
            },
            reason: if from == 0 {
                RekeyReason::Initial
            } else {
                RekeyReason::DeviceRevoked
            },
        };
        let item = Item {
            kind: ItemKind::Rekey,
            collection: c,
            seq: Some(seq),
            prev: Some(prev),
            epoch: None,
            signer: Some(self.id),
            salt: None,
            idem: None,
            refs: None,
            stream: None,
            body: Bytes(payload.to_bytes().unwrap()),
            sig: None,
        };
        sign_item(&self.sk, item)
    }
    /// An ephemeral stream message.
    pub fn ephemeral(&self, c: Uuid, stream: B16, epoch: u64, body: Vec<u8>) -> Vec<u8> {
        Item {
            kind: ItemKind::Ephemeral,
            collection: c,
            seq: None,
            prev: None,
            epoch: Some(epoch),
            signer: Some(self.id),
            salt: Some(B16([3; 16])),
            idem: None,
            refs: None,
            stream: Some(stream),
            body: Bytes(body),
            sig: None,
        }
        .to_bytes()
        .unwrap()
    }
    /// A snapshot manifest object (signed, refs required).
    pub fn manifest(&self, c: Uuid, epoch: u64, refs: Vec<B32>, body: Vec<u8>) -> Vec<u8> {
        let item = Item {
            kind: ItemKind::Manifest,
            collection: c,
            seq: None,
            prev: None,
            epoch: Some(epoch),
            signer: Some(self.id),
            salt: Some(B16(sha256(&body).0[..16].try_into().unwrap())),
            idem: None,
            refs: Some(refs),
            stream: None,
            body: Bytes(body),
            sig: None,
        };
        sign_item(&self.sk, item)
    }
}

/// An unsigned object envelope (`chunk` or `blob-part`) with an opaque body.
pub fn object(c: Uuid, kind: ItemKind, epoch: u64, body: Vec<u8>) -> Vec<u8> {
    Item {
        kind,
        collection: c,
        seq: None,
        prev: None,
        epoch: Some(epoch),
        signer: None,
        salt: Some(B16(sha256(&body).0[..16].try_into().unwrap())),
        idem: None,
        refs: None,
        stream: None,
        body: Bytes(body),
        sig: None,
    }
    .to_bytes()
    .unwrap()
}

/// Deterministic filler bytes.
pub fn filler(label: &str, len: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(len + 32);
    let mut block = sha256(label.as_bytes());
    while out.len() < len {
        out.extend_from_slice(&block.0);
        block = sha256(&block.0);
    }
    out.truncate(len);
    out
}
