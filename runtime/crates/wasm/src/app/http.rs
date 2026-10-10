//! Fixed ls-http and CP log-token proof purposes; no generic signer/key API.
//! HTTP signs captured originals/same-address commits; CP signs pinned identity.
use super::{MAX_CALLS, Reader};
use mdbn_replica::{
    crypto::sign::DeviceSigner,
    log::{CallId, EndpointId},
};
use mdbn_wire::{
    common::{B32, Uuid},
    hash::sha256,
    log_service::{CommitObjectParams, LsFrame, PutObjectParams},
    schema::Wire,
};
use std::collections::BTreeMap;

pub(super) const MAX_FRAME: usize = 16 * 1024 * 1024;
pub(super) const MAX_TOKEN: usize = 16 * 1024;
pub(super) const MAX_ENVELOPE: usize = MAX_FRAME + MAX_TOKEN + 128;
const DOMAIN: &[u8] = b"mdbase/v1/ls-http";
const PATH: &[u8] = b"/v1/rpc";
struct Original {
    hash: B32,
    method: String,
    put: Option<B32>,
}
pub(super) struct HttpSigner {
    key: Option<DeviceSigner>,
    collection: Uuid,
    device: Uuid,
    connector: Option<Uuid>,
    connector_claim: bool,
    endpoint: EndpointId,
    generation: u64,
    retired: bool,
    originals: BTreeMap<CallId, Original>,
}
impl HttpSigner {
    pub(super) fn new(
        seed: &[u8; 32],
        collection: Uuid,
        endpoint: EndpointId,
        device: Uuid,
    ) -> Self {
        Self {
            key: Some(DeviceSigner::from_seed(seed)),
            collection,
            device,
            connector: None,
            connector_claim: false,
            endpoint,
            generation: 0,
            retired: false,
            originals: BTreeMap::new(),
        }
    }
    /// Move the ORIGINAL protected signer and connector from the device phase.
    /// One matching host claim establishes the collection session reference; it
    /// cannot set or replace the already immutable native connector.
    pub(super) fn adopt(
        signer: DeviceSigner,
        collection: Uuid,
        endpoint: EndpointId,
        device: Uuid,
        connector: Uuid,
    ) -> Self {
        Self {
            key: Some(signer),
            collection,
            device,
            connector: Some(connector),
            connector_claim: true,
            endpoint,
            generation: 0,
            retired: false,
            originals: BTreeMap::new(),
        }
    }
    pub(super) fn bind_connector(&mut self, connector: Uuid) -> bool {
        if self.retired
            || self.generation != 0
            || self.key.is_none()
            || connector.0 == [0; 16]
            || self.device.0 == [0; 16]
            || self.collection.0 == [0; 16]
        {
            return false;
        }
        if let Some(pinned) = self.connector {
            if !self.connector_claim || pinned != connector {
                return false;
            }
            self.connector_claim = false;
        } else {
            self.connector = Some(connector);
        }
        true
    }
    /// Different protocol domain, fixed identity tuple. Available before LS bind
    /// to break the token bootstrap cycle; still cleared on terminal retirement.
    pub(super) fn sign_cp_log_token(&self, challenge: &[u8]) -> Option<[u8; 64]> {
        if self.retired || challenge.len() != 32 {
            return None;
        }
        let connector = self.connector?;
        let digest = mdbn_replica::crypto::proof::collection_log_token_digest(
            challenge.try_into().ok()?,
            &connector,
            &self.device,
            &self.collection,
        );
        Some(self.key.as_ref()?.sign_digest(&digest.0))
    }
    pub(super) fn bind(&mut self) -> bool {
        if self.retired || self.generation != 0 || self.key.is_none() {
            return false;
        }
        self.generation = 1;
        true
    }
    /// HOST authenticated reconnect, SAME native signer/connector/collection.
    /// Old captured calls cannot sign in the replacement generation.
    pub(super) fn reconnect(&mut self) -> bool {
        if self.retired || self.key.is_none() || self.connector.is_none() || self.generation == 0 {
            return false;
        }
        let Some(next) = self.generation.checked_add(1) else {
            return false;
        };
        self.originals.clear();
        self.generation = next;
        true
    }
    pub(super) fn generation(&self) -> u64 {
        if self.retired { 0 } else { self.generation }
    }
    pub(super) fn retire(&mut self) {
        self.retired = true;
        self.originals.clear();
        self.connector = None;
        self.key = None;
    }
    pub(super) fn forget(&mut self, id: CallId) {
        self.originals.remove(&id);
    }
    pub(super) fn capture(&mut self, id: CallId, frame: &[u8]) -> bool {
        if self.generation() == 0
            || self.originals.len() >= MAX_CALLS
            || self.originals.contains_key(&id)
            || frame.len() > MAX_FRAME
        {
            return false;
        }
        let Ok(LsFrame::Request(request)) = LsFrame::from_bytes(frame) else {
            return false;
        };
        if request.id != id.0
            || !matches!(
                request.method.as_str(),
                "append"
                    | "read"
                    | "head"
                    | "subscribe"
                    | "unsubscribe"
                    | "put_object"
                    | "get_object"
                    | "has_objects"
                    | "put_snapshot"
                    | "get_snapshot"
                    | "endorse_snapshot"
                    | "stream_join"
                    | "stream_leave"
                    | "stream_send"
            )
        {
            return false;
        }
        let mdbn_wire::cbor::Cbor::Map(params) = &request.params else {
            return false;
        };
        if !params
            .iter()
            .any(|(k, v)| *k == mdbn_wire::cbor::Cbor::Uint(0) && *v == self.collection.to_cbor())
        {
            return false;
        }
        let put = if request.method == "put_object" {
            let Ok(params) = PutObjectParams::from_cbor(&request.params) else {
                return false;
            };
            if params.collection != self.collection {
                return false;
            }
            Some(params.address)
        } else {
            None
        };
        self.originals.insert(
            id,
            Original {
                hash: sha256(frame),
                method: request.method,
                put,
            },
        );
        true
    }
    pub(super) fn sign(
        &self,
        endpoint: EndpointId,
        generation: u64,
        original: CallId,
        envelope: &[u8],
    ) -> Option<[u8; 64]> {
        if endpoint != self.endpoint
            || generation == 0
            || generation != self.generation()
            || envelope.len() > MAX_ENVELOPE
        {
            return None;
        }
        let original_id = original.0;
        let original = self.originals.get(&original)?;
        let proof = Proof::parse(envelope)?;
        let body_hash = sha256(proof.frame);
        let method = if body_hash == original.hash {
            original.method.as_str()
        } else {
            // A host-owned commit frame may differ from the original put ONLY
            // in this fixed method. Authority is that outstanding put's address.
            if proof.frame.len() > 512 {
                return None;
            }
            let Ok(LsFrame::Request(commit)) = LsFrame::from_bytes(proof.frame) else {
                return None;
            };
            if commit.method != "commit_object" || commit.id == original_id {
                return None;
            }
            let Ok(params) = CommitObjectParams::from_cbor(&commit.params) else {
                return None;
            };
            if params.collection != self.collection || Some(params.address) != original.put {
                return None;
            }
            "commit_object"
        };
        let mut pre =
            Vec::with_capacity(1 + DOMAIN.len() + method.len() + PATH.len() + 2 + 16 + 96);
        pre.push(DOMAIN.len() as u8);
        pre.extend_from_slice(DOMAIN);
        pre.extend_from_slice(method.as_bytes());
        pre.push(0);
        pre.extend_from_slice(PATH);
        pre.push(0);
        pre.extend_from_slice(&self.collection.0);
        pre.extend_from_slice(&sha256(proof.token.as_bytes()).0);
        pre.extend_from_slice(&body_hash.0);
        pre.extend_from_slice(proof.nonce);
        let digest = sha256(&pre);
        super::wipe(&mut pre);
        Some(self.key.as_ref()?.sign_digest(&digest.0))
    }
}
struct Proof<'a> {
    frame: &'a [u8],
    token: &'a str,
    nonce: &'a [u8],
}
impl<'a> Proof<'a> {
    fn parse(envelope: &'a [u8]) -> Option<Self> {
        let mut r = Reader {
            bytes: envelope,
            pos: 0,
        };
        if r.arg(5).ok()? != 3 {
            return None;
        }
        r.field(0).ok()?;
        let len = usize::try_from(r.arg(2).ok()?).ok()?;
        if len == 0 || len > MAX_FRAME {
            return None;
        }
        let frame = r.take(len).ok()?;
        r.field(1).ok()?;
        let len = usize::try_from(r.arg(3).ok()?).ok()?;
        if len == 0 || len > MAX_TOKEN {
            return None;
        }
        let token = std::str::from_utf8(r.take(len).ok()?).ok()?;
        if token.bytes().any(|b| b <= 0x20 || b >= 0x7f) {
            return None;
        }
        r.field(2).ok()?;
        if r.arg(2).ok()? != 32 {
            return None;
        }
        let nonce = r.take(32).ok()?;
        if r.pos != envelope.len() {
            return None;
        }
        Some(Self {
            frame,
            token,
            nonce,
        })
    }
}
