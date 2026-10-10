//! Confirmed-prefix handover facts, separate from query/asOf and pending overlays.

use std::sync::Arc;

use mdbn_core::types::Catalog;
use mdbn_wire::client::{AppliedPrefix, ConfirmedHead, IncidentKind};
use mdbn_wire::common::{B32, B64, Hash, Sem, Uuid};
use mdbn_wire::entry::HeadWitness;
use mdbn_wire::policy::CState;
use mdbn_wire::schema::Wire;

use crate::api::{ApiResult, ErrorCode, SessionId};
use crate::crypto::sign::DeviceSigner;
use crate::store::Store;

use super::Replica;

pub(crate) struct CatalogIdentity {
    store_generation: u64,
    catalog: Arc<Catalog>,
    generation: Hash,
}

impl<S: Store> Replica<S> {
    /// Eligibility is deliberately stronger than being allowed to read cached
    /// data. Never certify an installing, repairing, key-waiting or faulted store.
    fn handover_eligible(&self) -> bool {
        !self.local_only()
            && self.cfg.verify
            && self.head.seq > 0
            && self.genesis.is_some()
            && self.policy.seq == self.head.seq
            && self.policy.cstate == Some(CState::CloudCopy)
            && self.serves_apps().is_ok()
            && !self.key_untrusted
            && !self.keyring_rebuilding()
            && !self.keyring_rebuild_failed()
            && !self.apply_fault
            && self.apply_blocked.is_none()
            && !self.is_apply_recovering()
            && self.install.is_none()
            && self.stalled.is_none()
            && self.resyncing().is_none()
            && self.held_unprovable().is_none()
            && self.hosted_serving()
            && !self.incidents.values().any(|i| {
                matches!(
                    i.kind,
                    IncidentKind::Integrity
                        | IncidentKind::UpgradeRequired
                        | IncidentKind::WaitingForKey
                        | IncidentKind::KeyInconsistent
                        | IncidentKind::AccessRevoked
                        | IncidentKind::Gone
                        | IncidentKind::VerificationMismatch
                        | IncidentKind::LostEntries
                )
            })
            && self
                .policy
                .devices
                .get(&self.cfg.device_id)
                .is_some_and(|d| {
                    d.active
                        && d.sign_pk.0 == DeviceSigner::from_seed(&self.secrets.sign_sk).public()
                })
    }

    /// One synchronous capture of the committed prefix. Resource enumeration is
    /// from Store, never Layer/StateView; memoization uses catalog/store lifetime,
    /// not a process-local counter exposed as a generation.
    pub(crate) fn confirmed_handover_head(&self) -> Option<ConfirmedHead> {
        if !self.handover_eligible() {
            return None;
        }
        let cached = self.handover_catalog.borrow();
        let generation = cached
            .as_ref()
            .filter(|c| {
                c.store_generation == self.store_generation
                    && Arc::ptr_eq(&c.catalog, &self.catalog)
            })
            .map(|c| c.generation);
        drop(cached);
        let catalog_generation = match generation {
            Some(g) => g,
            None => {
                let resources = self.store.resources().ok()?;
                let sem = mdbn_core::semantics::SEM;
                // No declared/profile fields: this is a neutral catalog identity,
                // distinct from describe_typing's integer catalogGeneration.
                let g = crate::plan::query_index_generation(
                    &resources,
                    Sem {
                        major: sem.major,
                        minor: sem.minor,
                    },
                    &[],
                    1024,
                )
                .ok()?;
                let generation = B32(g);
                *self.handover_catalog.borrow_mut() = Some(CatalogIdentity {
                    store_generation: self.store_generation,
                    catalog: self.catalog.clone(),
                    generation,
                });
                generation
            }
        };
        Some(ConfirmedHead {
            seq: self.head.seq,
            chain: self.head.chain,
            policy_generation: self.policy.ctl_chain,
            catalog_generation,
        })
    }

    /// Sign the same tuple used in hello.status; no second state capture.
    pub(crate) fn signed_handover_head(&self, head: &ConfirmedHead) -> Option<Vec<u8>> {
        let mut witness = HeadWitness {
            collection: self.cfg.collection,
            device: self.cfg.device_id,
            seq: head.seq,
            chain: head.chain,
            epoch: self.policy.epoch,
            signed_at: self.now(),
            sig: B64([0; 64]),
            policy_generation: Some(head.policy_generation),
            catalog_generation: Some(head.catalog_generation),
        };
        let digest = witness.signed_digest().ok()?;
        witness.sig = B64(DeviceSigner::from_seed(&self.secrets.sign_sk).sign_digest(&digest.0));
        witness.to_bytes().ok()
    }

    /// Trusted host consumer seam. The caller pins `source` from the current
    /// authenticated hosted session, never from witness/hello self-claims. READ
    /// authority and local serving gates are rechecked on every invocation.
    /// Unknown signed extension fields are retained in the exact fixed-domain
    /// transcript; only signature key7 is removed. No key discovery/export.
    pub fn verify_handover_witness(
        &self,
        session: SessionId,
        source: Uuid,
        bytes: &[u8],
    ) -> ApiResult<Option<ConfirmedHead>> {
        self.require(session, crate::policy::capability::READ)?;
        if bytes.len() > 64 * 1024 || source.0 == [0; 16] || !self.handover_eligible() {
            return Ok(None);
        }
        let Some(head) = self.verify_handover_witness_inner(source, bytes) else {
            return Ok(None);
        };
        // Confirmed retained history, not current head/generations or hints. A
        // behind, unretained or mismatching prefix cannot establish handover.
        if head.seq > self.head.seq {
            return Ok(None);
        }
        let chain = self.own_chain_at(head.seq).map_err(|_| {
            ErrorCode::Unavailable
                .err_with_reason("prefix_unavailable", "confirmed prefix is not available")
        })?;
        Ok((chain == Some(head.chain)).then_some(head))
    }

    fn verify_handover_witness_inner(&self, source: Uuid, bytes: &[u8]) -> Option<ConfirmedHead> {
        let mut value = mdbn_wire::cbor::decode(bytes).ok()?;
        let witness = HeadWitness::from_cbor(&value).ok()?;
        if witness.device != source
            || witness.collection != self.cfg.collection
            || witness.seq == 0
            || witness.chain.0 == [0; 32]
        {
            return None;
        }
        let policy_generation = witness.policy_generation?;
        let catalog_generation = witness.catalog_generation?;
        if policy_generation.0 == [0; 32] || catalog_generation.0 == [0; 32] {
            return None;
        }
        // ONLY already verified, signed-policy enrolment; no bootstrap roots,
        // self-hello key, NoisePK, public CP metadata, or caller-supplied key.
        let device = self.policy.devices.get(&source)?;
        if !device.active {
            return None;
        }
        let mdbn_wire::cbor::Cbor::Map(fields) = &mut value else {
            return None;
        };
        fields.retain(|(key, _)| *key != mdbn_wire::cbor::Cbor::Uint(7));
        let exact = mdbn_wire::cbor::encode(&value).ok()?;
        let digest = mdbn_wire::hash::h("mdbase/v1/head-witness", &exact);
        if !crate::crypto::sign::verify_digest(&device.sign_pk.0, &digest.0, &witness.sig.0) {
            return None;
        }
        Some(ConfirmedHead {
            seq: witness.seq,
            chain: witness.chain,
            policy_generation,
            catalog_generation,
        })
    }

    pub(crate) fn handover_applied_prefix(
        &self,
        session: SessionId,
        seq: u64,
    ) -> ApiResult<AppliedPrefix> {
        self.require(session, crate::policy::capability::READ)?;
        let applied_through = if self.local_only() { 0 } else { self.head.seq };
        let chain = if seq == 0 || seq > applied_through || !self.handover_eligible() {
            None
        } else {
            self.own_chain_at(seq).map_err(|_| {
                ErrorCode::Unavailable
                    .err_with_reason("prefix_unavailable", "confirmed prefix is not available")
            })?
        };
        Ok(AppliedPrefix {
            applied_through,
            seq,
            chain,
        })
    }
}
