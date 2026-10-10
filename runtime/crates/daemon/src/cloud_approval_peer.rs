//! Approval-peer candidate transport. No queue/ACK receipt is approval or keying.
//! Callers must hold the native current applied-policy/custody context; ACK is
//! allowed only after required local secret-journal persistence. This port does
//! not implement or enable the private device RPCs.

use super::{Cloud, CloudError};
use crate::secrets::{self, DeviceIdentity};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use mdbn_replica::replica::{ApprovalPeerEnvelope, ApprovalPeerMessage};
use mdbn_wire::common::B16 as Uuid;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use zeroize::Zeroizing;

const MAX_PEERS: usize = 16;
const MAX_ENCODED: usize = 2731;

/// Untrusted routing receipt, never an applied-policy or approval witness.
pub struct ApprovalPeerQueued {
    /// Opaque CP metadata identity; not a grant or approval receipt.
    pub id: Uuid,
}
impl std::fmt::Debug for ApprovalPeerQueued {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ApprovalPeerQueued { <redacted candidate receipt> }")
    }
}

/// Exact bounded signed candidate bytes. Verify the envelope against the
/// independently current policy and lifecycle before actor ingress/persistence.
pub struct ApprovalPeerCandidate {
    id: Uuid,
    envelope: ApprovalPeerEnvelope,
    bytes: Zeroizing<Vec<u8>>,
}
impl ApprovalPeerCandidate {
    /// Opaque queue identity, for ACK only after required local persistence.
    pub fn id(&self) -> Uuid {
        self.id
    }
    /// Untrusted signed metadata, requiring independent current-policy checks.
    pub fn envelope(&self) -> &ApprovalPeerEnvelope {
        &self.envelope
    }
    /// Entire original canonical envelope, retained unchanged for journaling.
    pub fn signed_bytes(&self) -> &[u8] {
        &self.bytes
    }
}
impl std::fmt::Debug for ApprovalPeerCandidate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ApprovalPeerCandidate { <redacted untrusted metadata> }")
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Queued {
    id: String,
    outcome: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Inbox {
    messages: Vec<Row>,
    acknowledged: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Row {
    id: String,
    peer: String,
}

fn malformed() -> CloudError {
    CloudError::Server(200, "invalid_peer_metadata".into())
}
fn uuid(text: &str) -> Result<Uuid, CloudError> {
    let bytes = crate::attest::uuid_bytes(text).ok_or_else(malformed)?;
    if bytes == [0; 16] || secrets::uuid_string(&bytes) != text {
        return Err(malformed());
    }
    Ok(Uuid(bytes))
}
fn bound_collection(collection: &Uuid) -> Result<(), CloudError> {
    if collection.0 == [0; 16] {
        return Err(CloudError::Local("invalid_collection".into()));
    }
    Ok(())
}

// A separate typed profile, deliberately NOT proven_post's sas_commit slot.
#[derive(Clone, Copy)]
enum ReadProof<'a> {
    Inbox,
    Ack(&'a [Uuid]),
}
impl ReadProof<'_> {
    fn action(&self) -> &'static str {
        match self {
            Self::Inbox => "inbox",
            Self::Ack(_) => "ack",
        }
    }
    fn digest(
        &self,
        challenge: &[u8],
        connector: &[u8; 16],
        device: &[u8; 16],
        collection: &[u8; 16],
    ) -> Result<[u8; 32], CloudError> {
        let challenge: &[u8; 32] = challenge.try_into().map_err(|_| malformed())?;
        let read = match self {
            Self::Inbox => mdbn_replica::crypto::proof::ApprovalPeerRead::Inbox,
            Self::Ack(ids) => {
                validate_ids(ids)?;
                mdbn_replica::crypto::proof::ApprovalPeerRead::Ack(ids)
            }
        };
        Ok(mdbn_replica::crypto::proof::approval_peer_read_digest(
            read,
            challenge,
            &Uuid(*connector),
            &Uuid(*device),
            &Uuid(*collection),
        )
        .0)
    }
}
fn validate_ids(ids: &[Uuid]) -> Result<(), CloudError> {
    let unique: BTreeSet<_> = ids.iter().map(|id| id.0).collect();
    if ids.is_empty()
        || ids.len() > MAX_PEERS
        || unique.len() != ids.len()
        || unique.contains(&[0; 16])
    {
        return Err(CloudError::Local("invalid_peer_ids".into()));
    }
    Ok(())
}

fn candidates(
    value: Value,
    collection: Uuid,
    recipient: Uuid,
) -> Result<Vec<ApprovalPeerCandidate>, CloudError> {
    let inbox: Inbox = serde_json::from_value(value).map_err(|_| malformed())?;
    if inbox.acknowledged != 0 || inbox.messages.len() > MAX_PEERS {
        return Err(malformed());
    }
    let mut seen = BTreeSet::new();
    let mut result = Vec::with_capacity(inbox.messages.len());
    for row in inbox.messages {
        let id = uuid(&row.id)?;
        if !seen.insert(id.0) || row.peer.is_empty() || row.peer.len() > MAX_ENCODED {
            return Err(malformed());
        }
        let bytes = Zeroizing::new(URL_SAFE_NO_PAD.decode(&row.peer).map_err(|_| malformed())?);
        if bytes.len() > 2048 || URL_SAFE_NO_PAD.encode(&*bytes) != row.peer {
            return Err(malformed());
        }
        let envelope = ApprovalPeerEnvelope::from_bytes(&bytes).map_err(|_| malformed())?;
        let binding = &envelope.message.challenge().binding;
        let target = match &envelope.message {
            ApprovalPeerMessage::Challenge(_) => binding.requester.device,
            ApprovalPeerMessage::Reveal(_) => binding.approver.device,
        };
        if binding.collection != collection || target != recipient {
            return Err(malformed());
        }
        // Even a valid embedded-key signature is ONLY candidate metadata.
        if !envelope.verify_signature() {
            return Err(malformed());
        }
        result.push(ApprovalPeerCandidate {
            id,
            envelope,
            bytes,
        });
    }
    Ok(result)
}

impl Cloud {
    /// Send only already signed metadata; caller enforces full current native
    /// context and requester journal ordering. Never retries an uncertain send.
    pub async fn send_approval_peer(
        &self,
        collection: Uuid,
        envelope: &ApprovalPeerEnvelope,
        identity: &DeviceIdentity,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<ApprovalPeerQueued, CloudError> {
        current().map_err(CloudError::Local)?;
        bound_collection(&collection)?;
        if envelope.message.challenge().binding.collection != collection
            || envelope.sender_device().0 != identity.device_id
            || !envelope.verify_signature()
        {
            return Err(CloudError::Local("invalid_peer_sender".into()));
        }
        // Verify the origin is the actual held device signing key, not an
        // embedded replacement key with the same device ID.
        let sender = match &envelope.message {
            ApprovalPeerMessage::Challenge(c) => &c.binding.approver,
            ApprovalPeerMessage::Reveal(r) => &r.challenge.binding.requester,
        };
        let held_public = identity.public();
        if secrets::hex(&sender.sign_pk.0) != held_public.sign_pk
            || secrets::hex(&sender.kem_pk.0) != held_public.kem_pk
            || secrets::hex(&sender.noise_pk.0) != held_public.noise_pk
        {
            return Err(CloudError::Local("invalid_peer_sender".into()));
        }
        let bytes = Zeroizing::new(envelope.to_bytes().map_err(|_| malformed())?);
        let path = format!(
            "/v1/next/collections/{}/device-approval/peer",
            secrets::uuid_string(&collection.0)
        );
        let value = self
            .post_current(
                &path,
                &json!({"peer": URL_SAFE_NO_PAD.encode(&*bytes)}),
                current,
            )
            .await;
        current().map_err(CloudError::Local)?;
        let queued: Queued = serde_json::from_value(value?).map_err(|_| malformed())?;
        if queued.outcome != "queued" {
            return Err(malformed());
        }
        let receipt = ApprovalPeerQueued {
            id: uuid(&queued.id)?,
        };
        current().map_err(CloudError::Local)?;
        Ok(receipt)
    }

    async fn peer_read_post(
        &self,
        collection: Uuid,
        connector_id: &str,
        identity: &DeviceIdentity,
        proof: ReadProof<'_>,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<Value, CloudError> {
        current().map_err(CloudError::Local)?;
        bound_collection(&collection)?;
        let connector = crate::attest::uuid_bytes(connector_id)
            .filter(|id| *id != [0; 16])
            .ok_or_else(|| CloudError::Local("invalid_connector".into()))?;
        if let ReadProof::Ack(ids) = proof {
            validate_ids(ids)?;
        }
        let challenge = self.challenge(current).await?;
        current().map_err(CloudError::Local)?;
        let digest = proof.digest(&challenge, &connector, &identity.device_id, &collection.0)?;
        let mut body = json!({"device_id": identity.public().device, "challenge": secrets::hex(&challenge), "sig": secrets::hex(&identity.sign_digest(&digest))});
        if let ReadProof::Ack(ids) = proof {
            body["ids"] = json!(
                ids.iter()
                    .map(|id| secrets::uuid_string(&id.0))
                    .collect::<Vec<_>>()
            );
        }
        current().map_err(CloudError::Local)?;
        let path = format!(
            "/v1/next/collections/{}/device-approval/{}",
            secrets::uuid_string(&collection.0),
            proof.action()
        );
        let answer = self.post_current(&path, &body, current).await;
        current().map_err(CloudError::Local)?;
        answer
    }

    /// Bounded inbox candidates, not applied authority. The trusted actor must
    /// verify whole tuples/private epoch/latest commitment/lifetime again.
    pub async fn approval_peer_inbox(
        &self,
        collection: Uuid,
        connector_id: &str,
        identity: &DeviceIdentity,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<Vec<ApprovalPeerCandidate>, CloudError> {
        let value = self
            .peer_read_post(
                collection,
                connector_id,
                identity,
                ReadProof::Inbox,
                current,
            )
            .await?;
        current().map_err(CloudError::Local)?;
        let result = candidates(value, collection, Uuid(identity.device_id));
        current().map_err(CloudError::Local)?;
        result
    }

    /// Trusted-host-only ordering contract: call ONLY after required journal
    /// persistence and current-context verification. Count is newly hidden
    /// metadata (zero is valid after a lost ACK response), never approval success.
    pub async fn acknowledge_approval_peers(
        &self,
        collection: Uuid,
        connector_id: &str,
        identity: &DeviceIdentity,
        ids: &[Uuid],
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<u64, CloudError> {
        let value = self
            .peer_read_post(
                collection,
                connector_id,
                identity,
                ReadProof::Ack(ids),
                current,
            )
            .await?;
        current().map_err(CloudError::Local)?;
        let inbox: Inbox = serde_json::from_value(value).map_err(|_| malformed())?;
        if !inbox.messages.is_empty() || inbox.acknowledged > ids.len() as u64 {
            return Err(malformed());
        }
        current().map_err(CloudError::Local)?;
        Ok(inbox.acknowledged)
    }
}

#[cfg(test)]
#[path = "cloud_approval_peer_tests.rs"]
mod tests;
