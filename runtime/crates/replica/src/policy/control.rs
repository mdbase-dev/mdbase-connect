//! Control items: dispatch, grant approvals and the control-plane certificate.

use super::*;

/// Something a replica must surface after applying a control item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyEvent {
    /// A `cp-key-revoke` was applied (`policy.md` §3, "Revocation is not
    /// retroactive"): earlier items signed by the key with `issued_at ≥
    /// revoked_from` stay applied. Record a `policy_key_compromised` incident with
    /// their positions so an operator can check the compensating ops.
    PolicyKeyCompromised {
        /// The revoked key.
        key_id: B16,
        /// Earlier positions it signed at or after `revoked_from`.
        positions: Vec<u64>,
    },
    /// The collection state changed. Every device alerts unless its own user
    /// requested the change (`policy.md` §4.4).
    CollectionStateChanged {
        /// Before.
        from: Option<CState>,
        /// After.
        to: CState,
    },
}

impl PolicyState {
    // ------------------------------------------------------------ control items

    /// Apply a control item (`policy`, `rekey`, `key_grant`) at position `seq`,
    /// whose complete item bytes hash to `chain` (`chain(seq)`).
    ///
    /// - **Valid:** applied atomically; returns events to surface.
    /// - **Void:** only the position, the void count and the control chain change.
    /// - **Stall** ([`Rejected::Stall`]): nothing changes at all; the replica stops
    ///   before `seq` and reports `upgrade_required`.
    pub fn apply_control(
        &mut self,
        seq: u64,
        chain: &B32,
        item: &Item,
        env: &Env<'_>,
    ) -> Result<Vec<PolicyEvent>, Rejected> {
        let mut next = self.clone();
        let mut events = Vec::new();
        let r = match item.kind {
            ItemKind::Policy => next.policy_item(seq, item, env, &mut events),
            ItemKind::Rekey => next.rekey_item(item, env),
            ItemKind::KeyGrant => next.key_grant_item(item, env),
            _ => Err(void("kind", "not a control item")),
        };
        match r {
            Ok(()) => {
                next.advance_ctl(seq, chain);
                next.seq = seq;
                *self = next;
                Ok(events)
            }
            Err(Rejected::Stall(s)) => Err(Rejected::Stall(s)),
            Err(v) => {
                self.note_void(seq, Some(chain));
                Err(v)
            }
        }
    }

    /// Apply a `grant_approval` item (kind 6, `policy.md` §5.1) at `seq`. The item
    /// is sealed, so the replica opens it first and passes the decoded payload, or
    /// the decode error (unknown → stall, malformed → void; an AEAD failure is the
    /// caller's V3 void via [`PolicyState::note_void`]). Void and valid items
    /// advance the control chain.
    pub fn apply_grant_approval(
        &mut self,
        seq: u64,
        chain: &B32,
        item: &Item,
        approval: Result<&GrantApprovalPayload, SchemaError>,
        env: &Env<'_>,
    ) -> Verdict {
        let r = approval.map_err(decode_err).and_then(|a| {
            self.check_grant_approval(item, a, env)
                .map(|signer| (a, signer))
        });
        match r {
            Ok((a, signer)) => {
                if let Some(g) = self.grants.get_mut(&a.grant) {
                    g.approved = Some(a.capabilities.iter().cloned().collect());
                    g.approved_folders = a.file_folders.clone();
                    g.approved_seq = Some(seq);
                    g.approved_by = Some(signer);
                }
                self.advance_ctl(seq, chain);
                self.seq = seq;
                Ok(())
            }
            Err(Rejected::Stall(s)) => Err(Rejected::Stall(s)),
            Err(v) => {
                self.note_void(seq, Some(chain));
                Err(v)
            }
        }
    }

    fn check_grant_approval(
        &self,
        item: &Item,
        a: &GrantApprovalPayload,
        env: &Env<'_>,
    ) -> Result<Uuid, Rejected> {
        if item.kind != ItemKind::GrantApproval {
            return Err(void("kind", "not a grant_approval"));
        }
        let signer = self.check_device_signature(item, env)?;
        let d = &self.devices[&signer];
        if !d.keyed || self.role_of_device(d).is_none() {
            return Err(void(
                "grant_approval",
                "signer is not a keyed member device",
            ));
        }
        if !matches!(
            d.kind,
            DeviceKind::Desktop | DeviceKind::Mobile | DeviceKind::AppRuntime | DeviceKind::Cli
        ) {
            return Err(void(
                "grant_approval",
                "service devices never approve grants",
            ));
        }
        if self.rekey_required || item.epoch != Some(self.epoch) || self.epoch == 0 {
            return Err(void("V2", "rekey required, or epoch is not current"));
        }
        let g = self
            .grants
            .get(&a.grant)
            .filter(|g| g.active)
            .ok_or_else(|| void("grant_approval", "grant is not active"))?;
        if g.account != d.account || !self.members.contains_key(&g.account) {
            return Err(void(
                "grant_approval",
                "signer is not a device of the granting member",
            ));
        }
        if g.approved.is_some() {
            return Err(void("grant_approval", "already approved"));
        }
        if g.client_pk != a.client_pk {
            return Err(void("grant_approval", "client_pk differs from the grant"));
        }
        if a.capabilities.is_empty() || !a.capabilities.iter().all(|c| g.capabilities.contains(c)) {
            return Err(void(
                "grant_approval",
                "capabilities are not a non-empty subset",
            ));
        }
        Ok(signer)
    }

    fn policy_item(
        &mut self,
        seq: u64,
        item: &Item,
        env: &Env<'_>,
        events: &mut Vec<PolicyEvent>,
    ) -> Verdict {
        let p = PolicyPayload::from_bytes(&item.body.0).map_err(decode_err)?;
        let mut stall = None;
        let is_genesis_item = p.ops.iter().any(|o| matches!(o, PolicyOp::Genesis(_)));
        if seq == 1 {
            let Some(PolicyOp::Genesis(g)) = p.ops.first() else {
                return Err(void("genesis", "the first item must be a genesis policy"));
            };
            let pk = env.trusted_roots.iter().find(|pk| key_id(pk) == g.root);
            self.root = Some(g.root);
            if let Some(pk) = pk {
                self.root_pk = Some(B32(*pk));
                self.cp_roots.insert(B32(*pk));
            } else {
                stall = Some("genesis root is not trusted by this build");
            }
        } else if is_genesis_item {
            return Err(void("genesis", "genesis only at position 1"));
        }
        self.check_cert(&p, item, env, &mut stall)?;
        let cstate_before = self.cstate;
        for op in &p.ops {
            self.policy_op(seq, item.collection, op, env, events, &mut stall)?;
        }
        // Service devices are allowed only in cloud copy: an escrow or hosted device
        // enrolled while the collection stays e2e is void.
        if self.cstate != Some(CState::CloudCopy)
            && p.ops.iter().any(|o| {
                matches!(o, PolicyOp::DeviceEnrol(e) if matches!(e.kind, DeviceKind::Escrow | DeviceKind::Hosted))
            })
        {
            return Err(void("device-enrol", "service device in an e2e collection"));
        }
        if let Some(to) = self.cstate
            && cstate_before.is_some()
            && cstate_before != Some(to)
        {
            events.push(PolicyEvent::CollectionStateChanged {
                from: cstate_before,
                to,
            });
        }
        let kid = p.cert.key_id();
        self.signed_by_key
            .entry(kid)
            .or_default()
            .push((seq, p.issued_at));
        if let Some(w) = self.cert_roots.as_mut() {
            w.insert((kid, p.cert.root));
        }
        // Switching to e2e: no escrow/hosted may remain active after the item.
        if p.ops
            .iter()
            .any(|o| matches!(o, PolicyOp::CollectionState(c) if c.state == CState::E2e))
            && self
                .devices
                .values()
                .any(|d| d.active && matches!(d.kind, DeviceKind::Escrow | DeviceKind::Hosted))
        {
            return Err(void(
                "collection-state",
                "escrow or hosted device still active",
            ));
        }
        self.last_issued_at = Some(p.issued_at);
        match stall {
            Some(reason) => Err(Rejected::Stall(reason.into())),
            None => Ok(()),
        }
    }

    pub(super) fn check_cert(
        &self,
        p: &PolicyPayload,
        item: &Item,
        env: &Env<'_>,
        stall: &mut Option<&'static str>,
    ) -> Verdict {
        let Some(root) = self.root else {
            return Err(void("cp-cert", "no genesis"));
        };
        let c: &CpCert = &p.cert;
        if c.root != root {
            return Err(void(
                "cp-cert",
                "certificate root differs from genesis root",
            ));
        }
        // Pins publish the control plane's roots and keys. Under an owner device's
        // local root (after a root handover verified under the pinned root) the
        // local root certifies its own keys, so pins do not apply (`policy.md` §2.1).
        if let Some(pins) = env.policy_pins
            && !self.local_root_in_force()
        {
            if self.root_pk.is_some_and(|pk| !pins.root(&root, &pk)) {
                stall.get_or_insert("root is not a published pin in this build");
            }
            if !pins.policy_key(&c.key_id(), &c.policy_pk, &root) {
                stall.get_or_insert("policy key is not a published pin in this build");
            }
        }
        let digest = c
            .signed_digest()
            .map_err(|e| void("cp-cert", e.to_string()))?;
        if let Some(root_pk) = self.root_pk {
            if !env.verifier.verify(&root_pk.0, &digest.0, &c.sig.0) {
                return Err(void("cp-cert", "bad root signature on certificate"));
            }
        } else {
            stall.get_or_insert("genesis root is not trusted by this build");
        }
        if item.signer != Some(c.key_id()) {
            return Err(void("cp-cert", "signer is not the certified key"));
        }
        if !self.verify_item_sig(item, &c.policy_pk, env) {
            return Err(void("cp-cert", "bad item signature"));
        }
        if p.issued_at < c.not_before || p.issued_at > c.not_after {
            return Err(void("cp-cert", "issued outside the certificate window"));
        }
        if self.last_issued_at.is_some_and(|t| p.issued_at < t) {
            return Err(void("cp-cert", "issued_at goes backwards"));
        }
        if self
            .revoked_cp_keys
            .get(&c.key_id())
            .is_some_and(|from| *from <= p.issued_at)
        {
            return Err(void("cp-cert", "policy key revoked"));
        }
        Ok(())
    }
}
