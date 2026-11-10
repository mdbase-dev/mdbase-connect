//! Caller provenance, credential revocation, authorization and rate limits.

use super::*;

impl<B: Backend, O: ObjectStore> Service<B, O> {
    /// Read ONLY the two declared original clear policy records in one readonly
    /// transaction, reverify against configured trust and opaque initial caller.
    /// No ACL/projection/cache/journal identity, writes, ciphertext or key lookup.
    /// This is historical provenance, NOT current CP/phase/effect admission.
    /// Raw backend replies are still untrusted; caps checked after each read (not
    /// a transport cancellation/peak-allocation guarantee). Clock sampled after
    /// awaits; caller must separately prove pins' admission and actual context.
    pub async fn original_caller(
        &self,
        caller: &crate::auth::VerifiedCaller,
        pins: &crate::policy::OriginalPins,
        clock: impl Fn() -> i64,
        budget: &Budget,
    ) -> Result<crate::policy::OriginalCaller> {
        let refuse = || ServiceError::invalid("original_identity");
        if !self.config.roots.contains(&pins.root_pk)
            || !self.config.token_issuers.contains(&pins.issuer_pk)
            || caller.issuer_key() != pins.issuer_pk
            || caller.transport_key() != pins.transport_pk
            || pins.enrollment_sha256.is_some() != pins.enrollment_seq.is_some()
            || pins.enrollment_seq == Some(0)
        {
            return Err(refuse());
        }
        let mut tx = self
            .backend
            .begin_with_budget(&pins.collection, Mode::Read, budget)
            .await?;
        let first = tx.items(0, 1, 128 * 1024, true).await?;
        if first.len() != 1
            || first[0].seq != 1
            || first[0].kind != ItemKind::Policy.value()
            || first[0].bytes.len() > 128 * 1024
        {
            return Err(refuse());
        }
        let enrollment = if let Some(seq) = pins.enrollment_seq {
            if seq == 1 {
                Some(first[0].bytes.clone())
            } else {
                let found = tx
                    .items(seq - 1, 1, (128 * 1024 - first[0].bytes.len()) as u64, true)
                    .await?;
                if found.len() != 1
                    || found[0].seq != seq
                    || found[0].kind != ItemKind::Policy.value()
                    || found[0].bytes.len() > 128 * 1024 - first[0].bytes.len()
                {
                    return Err(refuse());
                }
                Some(found[0].bytes.clone())
            }
        } else {
            None
        };
        crate::policy::bind_original_caller(
            caller,
            pins,
            &first[0].bytes,
            enrollment.as_deref(),
            clock(),
            budget,
        )
    }

    /// §12 `revoke_device_credentials`: refuse a device on every collection at the
    /// transport, ahead of the policy items. `fresh` skips the cache (at `hello`).
    pub async fn check_credentials(&self, p: &Principal, now: i64, fresh: bool) -> Result<()> {
        let Principal::Device { id, .. } = p else {
            return Ok(());
        };
        let cached = self.creds.lock().unwrap().get(id).copied();
        let revoked = match cached {
            Some((true, _)) => true,
            Some((false, at)) if !fresh && now - at < CREDENTIAL_RECHECK_MS => false,
            _ => {
                let r = self.backend.credentials_revoked(id).await?;
                // Monotonic: a revocation recorded while this check was in
                // flight is never overwritten by its older answer.
                let mut creds = self.creds.lock().unwrap();
                let e = creds.entry(*id).or_insert((r, now));
                if !e.0 {
                    *e = (r, now);
                }
                e.0
            }
        };
        if revoked {
            return Err(ServiceError::reason(Code::Forbidden, "credentials_revoked"));
        }
        Ok(())
    }

    /// `revoke_device_credentials {0: device}` (control plane only).
    pub(super) async fn revoke_device_credentials(
        &self,
        p: &Principal,
        params: &Cbor,
        now: i64,
    ) -> Result<Outcome> {
        self.require_cp(p)?;
        let d = uuid_field(params, 0)?;
        self.backend.revoke_credentials(&d, now).await?;
        self.creds.lock().unwrap().insert(d, (true, now));
        Ok(Outcome {
            credentials_revoked: Some(d),
            ..Outcome::plain(map(vec![(0, Cbor::Bool(true))]))
        })
    }

    pub(super) fn require_cp(&self, p: &Principal) -> Result<()> {
        match p {
            Principal::ControlPlane => Ok(()),
            _ => Err(ServiceError::reason(Code::Forbidden, "principal")),
        }
    }

    /// Step 1–2: authorize a principal on a loaded collection. Devices must be active
    /// in the ACL with the key their token is bound to.
    pub fn authorize<'s>(
        state: &'s CollectionState,
        p: &Principal,
    ) -> Result<Option<&'s AclEntry>> {
        match p {
            Principal::ControlPlane => Ok(None),
            Principal::Device {
                collection: Some(c),
                ..
            } if *c != state.meta.id => {
                Err(ServiceError::reason(Code::Forbidden, "token_collection"))
            }
            Principal::Device { id, sign_pk, .. } => match state.acl.get(id) {
                Some(e) if e.active && e.sign_pk == *sign_pk => Ok(Some(e)),
                Some(e) if !e.active => Err(ServiceError::reason(Code::Forbidden, "revoked")),
                _ => Err(ServiceError::reason(Code::Forbidden, "not_enrolled")),
            },
        }
    }

    pub(super) async fn load<T: Txn>(tx: &mut T) -> Result<CollectionState> {
        tx.load()
            .await?
            .ok_or_else(|| ServiceError::new(Code::NotFound))
    }

    /// Check that a device may use a collection (stream joins, subscriptions).
    pub async fn authorize_device(&self, p: &Principal, c: &Uuid) -> Result<Option<Uuid>> {
        let mut tx = self.backend.begin(c, Mode::Read).await?;
        let state = Self::load(&mut tx).await?;
        live(&state.meta)?;
        Ok(Self::authorize(&state, p)?.map(|e| e.device))
    }

    pub(super) fn rate_check(
        &self,
        c: &Uuid,
        q: &Quotas,
        items: u64,
        bytes: u64,
        now: i64,
    ) -> Result<()> {
        let mut b = self.buckets.lock().unwrap();
        let cap_items = q.burst_items.saturating_mul(1000);
        let cap_bytes = q.bytes_per_s.saturating_mul(4);
        let e = b.entry(*c).or_insert(Bucket {
            items_milli: cap_items,
            bytes: cap_bytes,
            at: now,
        });
        let dt = (now - e.at).clamp(0, 3_600_000) as u64;
        e.items_milli = e
            .items_milli
            .saturating_add(dt.saturating_mul(q.items_per_s))
            .min(cap_items);
        e.bytes = e
            .bytes
            .saturating_add(dt.saturating_mul(q.bytes_per_s) / 1000)
            .min(cap_bytes);
        e.at = now;
        let need_i = items * 1000;
        if e.items_milli < need_i || e.bytes < bytes {
            let wait_i = (need_i.saturating_sub(e.items_milli)) / q.items_per_s.max(1);
            let wait_b = bytes.saturating_sub(e.bytes).saturating_mul(1000) / q.bytes_per_s.max(1);
            return Err(ServiceError::new(Code::RateLimited).retry(wait_i.max(wait_b).max(1)));
        }
        e.items_milli -= need_i;
        e.bytes -= bytes;
        Ok(())
    }

    /// Repair appends are limited per uploader:
    /// [`REPAIR_ITEMS_PER_S`] sustained, [`REPAIR_BURST_ITEMS`] burst.
    pub(super) fn repair_rate_check(&self, uploader: &Uuid, items: u64, now: i64) -> Result<()> {
        let q = Quotas {
            storage_bytes: 0,
            items_per_s: REPAIR_ITEMS_PER_S,
            bytes_per_s: u64::MAX / 8,
            burst_items: REPAIR_BURST_ITEMS,
        };
        // Keyed apart from collections: a device ID never equals a collection ID's
        // bucket because it is mixed with a constant.
        let mut key = uploader.0;
        key[0] ^= 0xa5;
        self.rate_check(&B16(key), &q, items, 0, now)
            .map_err(|e| ServiceError {
                reason: Some("repair".into()),
                ..e
            })
    }
}
