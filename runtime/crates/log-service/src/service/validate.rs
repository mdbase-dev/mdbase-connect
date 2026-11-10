//! Object and log-item validation, and collection status guards.

use super::*;

/// Verify uploaded object bytes (§6 "Validation"): a `mdb-cbor/1`
/// envelope of this collection, of an object kind, at most 9 MiB, and for
/// manifests and chunks `address = SHA-256(bytes)`. Used by the actor, and by
/// upload hosts that verify as bytes arrive (the Worker in front of R2).
pub fn verify_upload(c: &Uuid, address: &B32, bytes: &[u8]) -> Result<Verified> {
    verify_upload_with_budget(c, address, bytes, &Budget::default())
}

/// Verify an upload with the enclosing request's shared decode budget.
pub fn verify_upload_with_budget(
    c: &Uuid,
    address: &B32,
    bytes: &[u8],
    budget: &Budget,
) -> Result<Verified> {
    if bytes.len() as u64 > MAX_OBJECT_BYTES {
        return Err(ServiceError::reason(Code::TooLarge, "object"));
    }
    let it = budget.wire::<Item>(bytes)?;
    let kind = it.kind.value();
    if !matches!(kind, 16..=19) {
        return Err(ServiceError::invalid("kind"));
    }
    let checksum = sha256(bytes);
    validate_object_bytes(
        c,
        address,
        kind,
        bytes.len() as u64,
        &checksum,
        bytes,
        budget,
    )?;
    Ok(Verified {
        kind,
        size: bytes.len() as u64,
        checksum,
    })
}

pub(super) fn validate_object_bytes(
    c: &Uuid,
    address: &B32,
    kind: u64,
    size: u64,
    checksum: &B32,
    bytes: &[u8],
    budget: &Budget,
) -> Result<()> {
    if bytes.len() as u64 != size {
        return Err(ServiceError::invalid("size"));
    }
    if sha256(bytes) != *checksum {
        return Err(ServiceError::invalid("checksum"));
    }
    let it = budget.wire::<Item>(bytes)?;
    it.check_shape()
        .map_err(|e| ServiceError::invalid("shape").msg(format!("object: {e}")))?;
    if it.collection != *c || it.kind.value() != kind {
        return Err(ServiceError::invalid("shape").msg("object collection or kind"));
    }
    if kind != ItemKind::BlobPart.value() && checksum != address {
        return Err(ServiceError::invalid("address"));
    }
    if kind == ItemKind::RefIndex.value() {
        ref_index_body(&it, budget)?;
    }
    Ok(())
}

/// The addresses a decoded ref-index item lists, charging its payload to the
/// request's decode budget (`sealed-envelope.md` §4.3).
fn ref_index_body(it: &Item, budget: &Budget) -> Result<Vec<B32>> {
    budget
        .preflight(&it.body.0)
        .map_err(|e| ServiceError::invalid(e.reason))?;
    ref_index_addresses(it).map_err(|e| ServiceError::invalid("ref_index").msg(e.to_string()))
}

/// The members of the stored ref-index object at `a`. Its bytes were verified
/// at upload; a mismatch now is an integrity incident and refuses the caller.
pub(super) fn stored_ref_index(
    c: &Uuid,
    a: &B32,
    bytes: &[u8],
    budget: &Budget,
) -> Result<Vec<B32>> {
    if sha256(bytes) != *a {
        return Err(ServiceError::backend(
            "ref-index bytes differ from their address: integrity incident",
        ));
    }
    let it = budget.wire::<Item>(bytes)?;
    if it.collection != *c {
        return Err(ServiceError::invalid("ref_index").msg("collection"));
    }
    ref_index_body(&it, budget)
}

pub(super) fn is_ref_index(m: &ObjectMeta) -> bool {
    m.kind == ItemKind::RefIndex.value()
}

pub(super) fn check_verified(address: &B32, v: &Verified) -> Result<()> {
    if !matches!(v.kind, 16..=19) || v.size > MAX_OBJECT_BYTES {
        return Err(ServiceError::invalid("kind"));
    }
    if v.kind != ItemKind::BlobPart.value() && v.checksum != *address {
        return Err(ServiceError::invalid("address"));
    }
    Ok(())
}

/// The transport state a failover that lost a tail leaves behind: rebuilt from
/// the surviving control items, keeping the collection's quotas and retention.
/// Failure-injection hooks use it so that a simulated lost tail also loses the
/// ACL, epoch and freeze effects of the lost items, as a lagging standby would.
pub fn rebuild_state(
    old: &CollectionMeta,
    control: &[(u64, Vec<u8>)],
    roots: &[B32],
) -> Result<CollectionState> {
    let mut st = CollectionState {
        meta: CollectionMeta::new(old.id, old.created_at),
        acl: BTreeMap::new(),
    };
    st.meta.quotas = old.quotas;
    st.meta.retained_from = old.retained_from;
    st.meta.used_bytes = old.used_bytes;
    st.meta.file_bytes = old.file_bytes;
    st.meta.file_quota = old.file_quota;
    st.meta.status = old.status;
    let budget = Budget::default();
    for (seq, b) in control {
        let it = budget.wire::<Item>(b)?;
        check_item(&mut st, &it, *seq, 0, roots, &budget)?;
    }
    Ok(st)
}

/// Refuse requests on a deleted (`gone`) or restoring (`unavailable`) collection.
/// Bytes outside files, which the storage quota caps. `used_bytes` includes the
/// file bytes.
pub(super) fn log_bytes(m: &CollectionMeta, file_bytes: u64) -> u64 {
    m.used_bytes.saturating_sub(file_bytes)
}

pub(super) fn live(m: &CollectionMeta) -> Result<()> {
    match m.status {
        Status::Live => Ok(()),
        Status::Gone => Err(ServiceError::new(Code::Gone)),
        Status::Importing => Err(ServiceError::new(Code::Unavailable)
            .msg("collection is being restored")
            .retry(5_000)),
    }
}

/// Refuse every read of a deleted (`gone`) collection (§4.1 step 2), while a
/// restoring (`importing`) collection's object reads stay open for the import.
pub(super) fn not_gone(m: &CollectionMeta) -> Result<()> {
    match m.status {
        Status::Gone => Err(ServiceError::new(Code::Gone)),
        Status::Live | Status::Importing => Ok(()),
    }
}

/// Steps 7–8 for one log item at `seq`, judged by policy at `seq − 1` (`ws`), which
/// it then advances. Returns the devices a policy item revoked.
pub(super) fn check_item(
    ws: &mut CollectionState,
    it: &Item,
    seq: u64,
    i: usize,
    roots: &[B32],
    budget: &Budget,
) -> Result<Vec<Uuid>> {
    if it.kind == ItemKind::Policy {
        return apply_policy_with_budget(ws, it, seq, roots, budget);
    }
    let signer = it.signer.unwrap();
    let e = ws
        .acl
        .get(&signer)
        .filter(|e| e.active)
        .cloned()
        .ok_or_else(|| ServiceError::reason(Code::Forbidden, "revoked"))?;
    let digest = it
        .signed_digest()
        .map_err(|_| ServiceError::invalid("shape"))?;
    if !verify_sig(&e.sign_pk.0, &digest.0, &it.sig.unwrap().0) {
        return Err(ServiceError::invalid("signature").msg(format!("item {i}")));
    }
    // Escrow devices sign only key items, whoever uploads them.
    if e.kind == device_kind::ESCROW && !matches!(it.kind, ItemKind::Rekey | ItemKind::KeyGrant) {
        return Err(ServiceError::reason(Code::Forbidden, "kind"));
    }
    let role = ws.meta.members.get(&e.account).copied();
    let writer = role.is_some_and(|r| r >= 1);
    match it.kind {
        ItemKind::Entry | ItemKind::Base => {
            let hosted_ok = e.kind == device_kind::HOSTED && ws.meta.cstate == 1;
            if !(writer || hosted_ok) {
                return Err(ServiceError::reason(Code::Forbidden, "role"));
            }
            if ws.meta.frozen {
                return Err(ServiceError::reason(Code::Frozen, "frozen"));
            }
            if ws.meta.rekey_required {
                return Err(ServiceError::reason(Code::Frozen, "rekey_required"));
            }
            if it.epoch != Some(ws.meta.epoch) {
                return Err(ServiceError::invalid("epoch").msg(format!("item {i}")));
            }
        }
        ItemKind::Rekey => apply_rekey_with_budget(ws, it, budget)?,
        ItemKind::KeyGrant => {
            // policy.md §6.2: hosted delivers approved account-device keys in
            // cloud-copy; escrow retains its unavailable-hosted fallback.
            let cloud_service =
                matches!(e.kind, device_kind::HOSTED | device_kind::ESCROW) && ws.meta.cstate == 1;
            let ordinary = writer || cloud_service;
            // A viewer's recovery key may unlock its own newly enrolled user
            // device. Eligibility is not sufficient: check the parsed recipient
            // below. All other signer/item role requirements remain unchanged.
            let recovery_member = e.kind == device_kind::RECOVERY && role.is_some();
            if !(ordinary || recovery_member) {
                return Err(ServiceError::reason(Code::Forbidden, "role"));
            }
            // A grant during rekey-required would key a device under an
            // epoch a revoked device holds.
            if ws.meta.rekey_required {
                return Err(ServiceError::reason(Code::Frozen, "rekey_required"));
            }
            let g = budget.wire::<KeyGrantPayload>(&it.body.0)?;
            if g.epoch != ws.meta.epoch {
                return Err(ServiceError::invalid("epoch").msg(format!("item {i}")));
            }
            if !ordinary {
                let self_user = ws.acl.get(&g.recipient).is_some_and(|recipient| {
                    recipient.active
                        && recipient.account == e.account
                        && recipient.kind <= 3
                        && g.wrap.device == recipient.device
                });
                if !self_user {
                    return Err(ServiceError::reason(Code::Forbidden, "role"));
                }
            }
        }
        ItemKind::GrantApproval => {
            // policy.md §5.1: sealed, device-signed. The service sees only the
            // envelope: an active member device, current epoch, not
            // rekey-required (V2). Replicas check the payload.
            if role.is_none() || e.kind == device_kind::ESCROW || e.kind == device_kind::HOSTED {
                return Err(ServiceError::reason(Code::Forbidden, "role"));
            }
            if ws.meta.rekey_required {
                return Err(ServiceError::reason(Code::Frozen, "rekey_required"));
            }
            if it.epoch != Some(ws.meta.epoch) {
                return Err(ServiceError::invalid("epoch").msg(format!("item {i}")));
            }
        }
        _ => unreachable!("log kinds checked above"),
    }
    Ok(Vec::new())
}
