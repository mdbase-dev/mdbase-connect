//! Policy items at the transport (`policy.md` §3, §6.3, §6.4;
//! `log-service-api.md` §4.3).
//!
//! The service parses each policy item it is asked to append (they are in clear),
//! checks that it is validly signed and that its ops are valid, and applies the
//! transport effects to the working state **in the same atomic step as the append**.
//! Replicas remain authoritative; this check stops garbage.

use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::common::{B16, B32, Uuid};
use mdbn_wire::envelope::{Item, RekeyPayload};
use mdbn_wire::hash::{h, sha256};
use mdbn_wire::policy::{PolicyOp, PolicyPayload};

use crate::auth::verify_sig;
use crate::error::{Result, ServiceError};
use crate::model::{AclEntry, CollectionState, device_kind};

/// Key ID of a public key: first 16 bytes of its SHA-256 (00-overview.md §5).
pub fn key_id(pk: &B32) -> B16 {
    let d = sha256(&pk.0);
    B16(d.0[..16].try_into().unwrap())
}

const ZERO_ACCOUNT: Uuid = B16([0; 16]);

fn bad_sig(m: &str) -> ServiceError {
    ServiceError::invalid("signature").msg(m.to_string())
}
fn bad_policy(m: &str) -> ServiceError {
    ServiceError::invalid("policy").msg(m.to_string())
}

/// Validate a policy item at position `seq` against `state` (policy at `seq − 1`)
/// and apply its transport effects. Returns the devices it revoked.
pub fn apply_policy(
    state: &mut CollectionState,
    item: &Item,
    seq: u64,
    roots: &[B32],
) -> Result<Vec<Uuid>> {
    apply_policy_with_budget(state, item, seq, roots, &crate::decode::Budget::default())
}

/// Apply a nested policy payload using the enclosing request's budget.
pub fn apply_policy_with_budget(
    state: &mut CollectionState,
    item: &Item,
    seq: u64,
    roots: &[B32],
    budget: &crate::decode::Budget,
) -> Result<Vec<Uuid>> {
    let payload = budget.wire::<PolicyPayload>(&item.body.0)?;

    // The root governing this collection: from genesis at seq 1, else the stored one.
    let root = if seq == 1 {
        match payload.ops.first() {
            Some(PolicyOp::Genesis(g)) => g.root,
            _ => return Err(bad_policy("the item at position 1 must start with genesis")),
        }
    } else {
        state.meta.root
    };
    let root_pk = roots
        .iter()
        .find(|pk| key_id(pk) == root)
        .ok_or_else(|| bad_sig("root key not in the pinned set"))?;

    // policy.md §3, rules 1–5.
    let cert = &payload.cert;
    if cert.root != root {
        return Err(bad_sig("certificate root"));
    }
    let cert_digest = cert
        .signed_digest()
        .map_err(|_| ServiceError::invalid("shape"))?;
    if !verify_sig(&root_pk.0, &cert_digest.0, &cert.sig.0) {
        return Err(bad_sig("certificate signature"));
    }
    let kid = key_id(&cert.policy_pk);
    if item.signer != Some(kid) {
        return Err(bad_sig("signer is not the certified policy key"));
    }
    let digest = item
        .signed_digest()
        .map_err(|_| ServiceError::invalid("shape"))?;
    let Some(sig) = item.sig else {
        return Err(bad_sig("unsigned"));
    };
    if !verify_sig(&cert.policy_pk.0, &digest.0, &sig.0) {
        return Err(bad_sig("item signature"));
    }
    if !(cert.not_before <= payload.issued_at && payload.issued_at <= cert.not_after) {
        return Err(bad_sig("issued outside the certificate window"));
    }
    if payload.issued_at < state.meta.last_issued_at {
        return Err(bad_sig("issued_at is not monotonic"));
    }
    if let Some(from) = state.meta.revoked_cp_keys.get(&kid)
        && *from <= payload.issued_at
    {
        return Err(bad_sig("policy key revoked"));
    }

    let mut revoked = Vec::new();
    let mut check_e2e = false;
    for (i, op) in payload.ops.iter().enumerate() {
        match op {
            PolicyOp::Genesis(g) => {
                if seq != 1 || i != 0 {
                    return Err(bad_policy("genesis only at position 1"));
                }
                state.meta.root = g.root;
                state.meta.owner = g.owner;
                state.meta.cstate = g.state.value();
                state.meta.members.insert(g.owner, 2);
            }
            PolicyOp::DeviceEnrol(d) => {
                if state.acl.contains_key(&d.device) {
                    return Err(bad_policy("device already enrolled"));
                }
                let k = d.kind.value();
                let service = k == device_kind::HOSTED || k == device_kind::ESCROW;
                // `recovery` devices hold no Noise key (all zero) and never write
                // content; they enrol under a member account like any device.
                // Service devices belong to the all-zero account and nobody else
                // does.
                let ok = if d.account == ZERO_ACCOUNT {
                    service
                } else {
                    !service && state.meta.members.contains_key(&d.account)
                };
                if !ok {
                    return Err(bad_policy("device account is not a member"));
                }
                state.acl.insert(
                    d.device,
                    AclEntry {
                        device: d.device,
                        account: d.account,
                        kind: k,
                        sign_pk: d.sign_pk,
                        active: true,
                    },
                );
            }
            PolicyOp::DeviceRevoke(d) => {
                let e = state
                    .acl
                    .get_mut(&d.device)
                    .filter(|e| e.active)
                    .ok_or_else(|| bad_policy("device not active"))?;
                e.active = false;
                revoked.push(d.device);
                state.meta.rekey_required = true;
            }
            PolicyOp::MemberSet(m) => {
                let role = m.role.value();
                if role < 2 && is_only_owner(state, &m.account) {
                    return Err(bad_policy("cannot demote the only owner"));
                }
                state.meta.members.insert(m.account, role);
            }
            PolicyOp::MemberRemove(m) => {
                if !state.meta.members.contains_key(&m.account) {
                    return Err(bad_policy("not a member"));
                }
                if is_only_owner(state, &m.account) {
                    return Err(bad_policy("cannot remove the only owner"));
                }
                state.meta.members.remove(&m.account);
                for e in state.acl.values_mut() {
                    if e.account == m.account && e.active {
                        e.active = false;
                        revoked.push(e.device);
                    }
                }
                state.meta.rekey_required = true;
            }
            PolicyOp::Grant(_) | PolicyOp::GrantRevoke(_) => {
                // No transport effect: the service never sees thin clients.
            }
            PolicyOp::ApprovalRequest(_) => {
                // SAS commitment renewal has no ACL/epoch/transport effect.
                // Replica verification enforces its member/keyed-state rules.
            }
            PolicyOp::CollectionState(c) => {
                let to = c.state.value();
                if to == 1 {
                    let escrow = state
                        .acl
                        .values()
                        .any(|e| e.active && e.kind == device_kind::ESCROW);
                    if !escrow {
                        return Err(bad_policy("cloud-copy needs an enrolled escrow"));
                    }
                } else {
                    check_e2e = true;
                }
                state.meta.cstate = to;
            }
            PolicyOp::CpKeyRevoke(r) => {
                let msg = cbor::encode(&Cbor::Array(vec![
                    Cbor::Bytes(r.key_id.0.to_vec()),
                    Cbor::int(r.revoked_from),
                ]))
                .map_err(|_| ServiceError::invalid("shape"))?;
                if !verify_sig(&root_pk.0, &cp_key_revoke_digest_of(&msg).0, &r.root_sig.0) {
                    return Err(bad_sig("cp-key-revoke root signature"));
                }
                state.meta.revoked_cp_keys.insert(r.key_id, r.revoked_from);
            }
            PolicyOp::MigrationCutover(_) => {
                if state.meta.cutover {
                    return Err(bad_policy("migration-cutover at most once"));
                }
                state.meta.cutover = true;
            }
            PolicyOp::Freeze(f) => state.meta.frozen = f.frozen,
            PolicyOp::RootHandover(r) => {
                // policy.md §2.1. Rule 1 (signed under the current root) and rule 4
                // (key not revoked) were checked above. Rule 2: the owner consents.
                let dev = state
                    .acl
                    .get(&r.owner_device)
                    .filter(|e| e.active && state.meta.members.get(&e.account) == Some(&2))
                    .ok_or_else(|| {
                        bad_policy("root-handover: owner_device is not an active owner device")
                    })?;
                let d = r.consent_digest(&item.collection, seq);
                if !verify_sig(&dev.sign_pk.0, &d.0, &r.consent.0) {
                    return Err(bad_sig("root-handover consent"));
                }
                // Rule 3: allowed target. The hosted service only accepts a pinned
                // control-plane root; a handover to a device's local root moves the
                // log off this service, which goes through the log move (on hold).
                if !roots.contains(&r.new_root) {
                    return Err(bad_policy("root-handover: target is not a pinned root"));
                }
                state.meta.root = key_id(&r.new_root);
            }
        }
    }
    if seq == 1 && !matches!(payload.ops.first(), Some(PolicyOp::Genesis(_))) {
        return Err(bad_policy("position 1 must be genesis"));
    }
    if check_e2e
        && state
            .acl
            .values()
            .any(|e| e.active && (e.kind == device_kind::ESCROW || e.kind == device_kind::HOSTED))
    {
        return Err(bad_policy("e2e with active hosted or escrow devices"));
    }
    state.meta.last_issued_at = payload.issued_at;
    Ok(revoked)
}

fn is_only_owner(state: &CollectionState, account: &Uuid) -> bool {
    state.meta.members.get(account) == Some(&2)
        && state.meta.members.values().filter(|r| **r == 2).count() == 1
}

/// Apply a `rekey` item's transport effect: the epoch advances and rekey-required
/// clears (`sealed-envelope.md` §5.2: `from` is the current epoch, `epoch = from + 1`).
pub fn apply_rekey(state: &mut CollectionState, item: &Item) -> Result<()> {
    apply_rekey_with_budget(state, item, &crate::decode::Budget::default())
}

/// Apply a nested rekey payload using the enclosing request's budget.
pub fn apply_rekey_with_budget(
    state: &mut CollectionState,
    item: &Item,
    budget: &crate::decode::Budget,
) -> Result<()> {
    let p = budget.wire::<RekeyPayload>(&item.body.0)?;
    if p.from != state.meta.epoch || p.epoch != p.from + 1 {
        return Err(ServiceError::invalid("epoch").msg("rekey from/epoch"));
    }
    for w in &p.wraps {
        if !state.acl.get(&w.device).is_some_and(|e| e.active) {
            return Err(ServiceError::invalid("policy").msg("rekey wraps a non-active device"));
        }
    }
    state.meta.epoch = p.epoch;
    state.meta.rekey_required = false;
    Ok(())
}

fn cp_key_revoke_digest_of(canonical: &[u8]) -> B32 {
    h("mdbase/v1/cp-key-revoke", canonical)
}

/// The digest a root signs to revoke a policy key (`policy.md` §1):
/// `H("mdbase/v1/cp-key-revoke", canonical([key ID, revoked_from]))`.
pub fn cp_key_revoke_digest(key_id: &B16, revoked_from: i64) -> B32 {
    let msg = cbor::encode(&Cbor::Array(vec![
        Cbor::Bytes(key_id.0.to_vec()),
        Cbor::int(revoked_from),
    ]))
    .expect("encodes");
    cp_key_revoke_digest_of(&msg)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mdbn_wire::schema::Wire;

    #[test]
    fn sas_renewal_advances_head_without_transport_authority_changes() {
        use crate::auth::Principal;
        use crate::backend::{Backend, Mode, Txn};
        use crate::mem::{MemBackend, MemObjects};
        use crate::service::{Config, Service};
        use crate::testkit::{ControlPlane, Device, id16};
        use mdbn_wire::common::Bytes;
        use mdbn_wire::log_service::AppendParams;
        use mdbn_wire::policy::{ApprovalRequest, DeviceKind};
        use std::future::Future;
        use std::task::{Context, Poll, Waker};

        // Fresh uncontended MemBackend operations complete in one poll; no OS
        // runtime, clock, entropy or new dependencies are needed for this test.
        fn ready<T>(f: impl Future<Output = T>) -> T {
            let mut f = std::pin::pin!(f);
            match f.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
                Poll::Ready(v) => v,
                Poll::Pending => panic!("unexpected contention in isolated memory backend"),
            }
        }
        let cp = ControlPlane::new("sas-renewal");
        let collection = id16("sas-collection");
        let owner = id16("sas-owner");
        let dev = Device::new("new-device", owner);
        let svc = Service::new(
            MemBackend::default(),
            MemObjects::default(),
            Config {
                roots: vec![cp.root_pk()],
                token_issuers: vec![cp.issuer_pk()],
                url_secret: vec![7; 32],
                public_base: "https://logs.example".into(),
            },
        );
        let genesis = cp.genesis(collection, owner);
        let enrol = cp.policy_item(
            collection,
            2,
            mdbn_wire::hash::chain_hash(&genesis),
            vec![dev.enrol(DeviceKind::Desktop)],
            2,
        );
        ready(svc.call(
            &Principal::ControlPlane,
            "create_log",
            &Cbor::Map(vec![
                (Cbor::Uint(0), collection.to_cbor()),
                (Cbor::Uint(1), Cbor::Bytes(genesis.clone())),
            ]),
            1000,
        ))
        .unwrap();
        ready(
            svc.call(
                &Principal::ControlPlane,
                "append",
                &AppendParams {
                    collection,
                    expect_seq: 2,
                    expect_prev: mdbn_wire::hash::chain_hash(&genesis),
                    items: vec![Bytes(enrol)],
                }
                .to_cbor(),
                1000,
            ),
        )
        .unwrap();
        let load = || {
            ready(async {
                svc.backend
                    .begin(&collection, Mode::Read)
                    .await
                    .unwrap()
                    .load()
                    .await
                    .unwrap()
                    .unwrap()
            })
        };
        let before = load();
        let ops = || {
            vec![PolicyOp::ApprovalRequest(ApprovalRequest {
                device: dev.id,
                sas_commit: B32([42; 32]),
            })]
        };
        let item = cp.policy_item(collection, 3, before.meta.head_chain, ops(), 3);
        let out = ready(
            svc.call(
                &Principal::ControlPlane,
                "append",
                &AppendParams {
                    collection,
                    expect_seq: 3,
                    expect_prev: before.meta.head_chain,
                    items: vec![Bytes(item.clone())],
                }
                .to_cbor(),
                1001,
            ),
        )
        .unwrap();
        assert!(out.notice.is_some());
        let after = load();
        assert_eq!(after.meta.head, 3);
        assert_eq!(after.meta.head_chain, mdbn_wire::hash::chain_hash(&item));
        assert_eq!(after.meta.last_issued_at, 3);
        assert_eq!(after.acl, before.acl);
        assert_eq!(after.meta.epoch, before.meta.epoch);
        assert_eq!(after.meta.rekey_required, before.meta.rekey_required);
        assert_eq!(after.meta.frozen, before.meta.frozen);
        assert_eq!(after.meta.cstate, before.meta.cstate);
        assert_eq!(after.meta.members, before.meta.members);
        // The explicit no-op never bypasses signature or issued_at verification.
        let mut forged =
            Item::from_bytes(&cp.policy_item(collection, 4, after.meta.head_chain, ops(), 4))
                .unwrap();
        forged.sig = Some(mdbn_wire::common::B64([0; 64]));
        for bytes in [
            forged.to_bytes().unwrap(),
            cp.policy_item(collection, 4, after.meta.head_chain, ops(), 2),
        ] {
            assert!(
                ready(
                    svc.call(
                        &Principal::ControlPlane,
                        "append",
                        &AppendParams {
                            collection,
                            expect_seq: 4,
                            expect_prev: after.meta.head_chain,
                            items: vec![Bytes(bytes)],
                        }
                        .to_cbor(),
                        1002
                    )
                )
                .is_err()
            );
            assert_eq!(load(), after, "invalid renewal changes no durable state");
        }
    }

    /// Golden vector shared with Connect's `keyRevocationDigest`.
    #[test]
    fn cp_key_revoke_digest_vector() {
        let d = cp_key_revoke_digest(&B16([0x11; 16]), 1_800_000_000_000);
        // canonical([h'11'*16, 1800000000000]) = 82 50 11.. 1b 00 00 01 a3 18 5c 50 00
        assert_eq!(
            d,
            h(
                "mdbase/v1/cp-key-revoke",
                &[
                    &[0x82, 0x50][..],
                    &[0x11; 16],
                    &[0x1b, 0x00, 0x00, 0x01, 0xa3, 0x18, 0x5c, 0x50, 0x00],
                ]
                .concat()
            )
        );
        assert_eq!(
            d.to_hex(),
            "82164a8e22e8e138dd881c36cddfbfcd43f001a64fcdb6eee0c24682cf62b0f4"
        );
    }
}
