//! One `policy` op applied to the state.

use super::*;

impl PolicyState {
    pub(super) fn policy_op(
        &mut self,
        seq: u64,
        collection: Uuid,
        op: &PolicyOp,
        env: &Env<'_>,
        events: &mut Vec<PolicyEvent>,
        stall: &mut Option<&'static str>,
    ) -> Verdict {
        match op {
            PolicyOp::Genesis(g) => {
                if seq != 1 || self.owner.is_some() {
                    return Err(void("genesis", "exactly one genesis, at position 1"));
                }
                self.owner = Some(g.owner);
                self.cstate = Some(g.state);
            }
            PolicyOp::DeviceEnrol(e) => {
                if self.devices.contains_key(&e.device) {
                    return Err(void("device-enrol", "device ID already enrolled"));
                }
                let service = matches!(e.kind, DeviceKind::Hosted | DeviceKind::Escrow);
                let ok = if service {
                    e.account == SERVICE_ACCOUNT
                } else {
                    self.members.contains_key(&e.account)
                };
                if !ok {
                    return Err(void("device-enrol", "account is not a member"));
                }
                // A `recovery` device has an all-zero `noise_pk`; no other kind may.
                let zero_noise = e.noise_pk.0.iter().all(|b| *b == 0);
                if zero_noise != (e.kind == DeviceKind::Recovery) {
                    return Err(void(
                        "device-enrol",
                        "noise_pk is all-zero exactly for recovery",
                    ));
                }
                self.devices.insert(
                    e.device,
                    DeviceState {
                        account: e.account,
                        kind: e.kind,
                        sign_pk: e.sign_pk,
                        kem_pk: e.kem_pk,
                        noise_pk: e.noise_pk,
                        active: true,
                        keyed: false,
                        introduced_by: None,
                        delivered_by: None,
                        local_root: e.local_root,
                        sas_commit: e.sas_commit,
                    },
                );
            }
            PolicyOp::DeviceRevoke(r) => {
                if self.active_device(&r.device).is_none() {
                    return Err(void("device-revoke", "device is not active"));
                }
                self.revoke_device(&r.device);
            }
            PolicyOp::MemberSet(m) => {
                if m.account == SERVICE_ACCOUNT {
                    return Err(void("member-set", "the service account is never a member"));
                }
                if m.role != Role::Owner && self.only_owner(&m.account) {
                    return Err(void("member-set", "would demote the only owner"));
                }
                self.members.insert(m.account, m.role);
            }
            PolicyOp::MemberRemove(m) => {
                if !self.members.contains_key(&m.account) || self.only_owner(&m.account) {
                    return Err(void("member-remove", "not a member, or the only owner"));
                }
                self.members.remove(&m.account);
                let devs: Vec<Uuid> = self
                    .devices
                    .iter()
                    .filter(|(_, d)| d.account == m.account)
                    .map(|(id, _)| *id)
                    .collect();
                for d in devs {
                    self.revoke_device(&d);
                }
                for g in self.grants.values_mut() {
                    if g.account == m.account {
                        g.active = false;
                    }
                }
                self.rekey_required = true;
            }
            PolicyOp::Grant(g) => {
                if self.grants.contains_key(&g.grant) {
                    return Err(void("grant", "grant ID already used"));
                }
                let read_only = g.capabilities.iter().all(|c| c == capability::READ);
                let ok = match self.members.get(&g.account) {
                    Some(r) if *r >= Role::Editor => true,
                    Some(Role::Viewer) => read_only,
                    _ => false,
                };
                if !ok {
                    return Err(void("grant", "granting account may not grant this"));
                }
                // In e2e the folder scope travels sealed in the approval.
                if self.grant_approval_required() && g.file_folders.is_some() {
                    return Err(void("grant", "file_folders in clear in an e2e collection"));
                }
                self.grants.insert(
                    g.grant,
                    GrantState {
                        installation: g.installation,
                        app_id: g.app_id.clone(),
                        account: g.account,
                        capabilities: g.capabilities.iter().cloned().collect(),
                        client_pk: g.client_pk,
                        file_folders: g.file_folders.clone(),
                        folder_scoped: g.folder_scoped.unwrap_or(false),
                        active: true,
                        approved: None,
                        approved_folders: None,
                        approved_seq: None,
                        approved_by: None,
                    },
                );
            }
            PolicyOp::GrantRevoke(r) => match self.grants.get_mut(&r.grant) {
                Some(g) if g.active => g.active = false,
                _ => return Err(void("grant-revoke", "grant is not active")),
            },
            PolicyOp::CollectionState(c) => {
                if c.state == CState::CloudCopy
                    && !self
                        .devices
                        .values()
                        .any(|d| d.active && d.kind == DeviceKind::Escrow)
                {
                    return Err(void(
                        "collection-state",
                        "cloud copy needs an escrow device",
                    ));
                }
                self.cstate = Some(c.state);
                if let Some(cmp) = c.compress {
                    self.compress = cmp;
                }
                if let Some(m) = c.min_sem_major {
                    self.min_sem_major = self.min_sem_major.max(m);
                    self.sem_ratchet = self.sem_ratchet.max(m);
                }
            }
            PolicyOp::CpKeyRevoke(r) => {
                if self.cp_roots.is_empty() && stall.is_none() {
                    return Err(void("cp-key-revoke", "no genesis"));
                }
                let msg = Cbor::Array(vec![r.key_id.to_cbor(), Cbor::int(r.revoked_from)]);
                let bytes = cbor::encode(&msg).map_err(|e| void("cp-key-revoke", e.to_string()))?;
                let d = h("mdbase/v1/cp-key-revoke", &bytes);
                if !self.cp_roots.is_empty()
                    && !self
                        .cp_roots
                        .iter()
                        .any(|pk| env.verifier.verify(&pk.0, &d.0, &r.root_sig.0))
                {
                    return Err(void("cp-key-revoke", "bad root signature"));
                }
                let positions: Vec<u64> = self
                    .signed_by_key
                    .get(&r.key_id)
                    .into_iter()
                    .flatten()
                    .filter(|(_, at)| *at >= r.revoked_from)
                    .map(|(p, _)| *p)
                    .collect();
                events.push(PolicyEvent::PolicyKeyCompromised {
                    key_id: r.key_id,
                    positions,
                });
                let e = self
                    .revoked_cp_keys
                    .entry(r.key_id)
                    .or_insert(r.revoked_from);
                *e = (*e).min(r.revoked_from);
            }
            PolicyOp::RootHandover(rh) => {
                let consent = rh.consent_digest(&collection, seq);
                let od = self
                    .active_device(&rh.owner_device)
                    .filter(|d| d.keyed && self.members.get(&d.account) == Some(&Role::Owner))
                    .ok_or_else(|| {
                        void("root-handover", "owner_device is not a keyed owner device")
                    })?;
                if !matches!(
                    od.kind,
                    DeviceKind::Desktop
                        | DeviceKind::Mobile
                        | DeviceKind::AppRuntime
                        | DeviceKind::Cli
                ) {
                    return Err(void(
                        "root-handover",
                        "owner_device is a service or recovery device",
                    ));
                }
                if !env
                    .verifier
                    .verify(&od.sign_pk.0, &consent.0, &rh.consent.0)
                {
                    return Err(void("root-handover", "bad owner consent"));
                }
                let to_cp = env.trusted_roots.contains(&rh.new_root.0);
                let to_local = od.local_root == Some(rh.new_root);
                if !(to_cp || to_local) {
                    stall.get_or_insert("root-handover target is not trusted by this build");
                }
                // In a cloud copy the control plane
                // (enrolling an owner-account device with its own sign key and
                // local root) plus escrow (keying it) must not reach a local root,
                // which would take the log out from under the pins. A local root
                // is reachable only from an owner device a user's device vouched
                // for (its `introduced_by` chain never passes a service device).
                if to_local
                    && self.cstate == Some(CState::CloudCopy)
                    && self.introduced_via_service(&rh.owner_device)
                {
                    return Err(void(
                        "root-handover",
                        "owner device keyed through a service device",
                    ));
                }
                self.root = Some(key_id(&rh.new_root.0));
                self.root_pk = Some(rh.new_root);
                if to_cp || !to_local {
                    self.cp_roots.insert(rh.new_root);
                } else {
                    self.handover_roots.insert(key_id(&rh.new_root.0));
                }
            }
            PolicyOp::MigrationCutover(_) => {
                if self.cutover.is_some() {
                    return Err(void("migration-cutover", "already cut over"));
                }
                self.cutover = Some(seq);
            }
            PolicyOp::Freeze(f) => self.frozen = f.frozen,
            PolicyOp::ApprovalRequest(r) => {
                let Some(d) = self.devices.get_mut(&r.device).filter(|d| d.active) else {
                    return Err(void("approval-request", "device is not active"));
                };
                if d.keyed {
                    return Err(void("approval-request", "device is already keyed"));
                }
                if !matches!(
                    d.kind,
                    DeviceKind::Desktop
                        | DeviceKind::Mobile
                        | DeviceKind::AppRuntime
                        | DeviceKind::Cli
                ) {
                    return Err(void("approval-request", "only member devices are approved"));
                }
                d.sas_commit = Some(r.sas_commit);
            }
        }
        Ok(())
    }

    fn only_owner(&self, account: &Uuid) -> bool {
        self.members.get(account) == Some(&Role::Owner)
            && self.members.values().filter(|r| **r == Role::Owner).count() == 1
    }

    fn revoke_device(&mut self, id: &Uuid) {
        if let Some(d) = self.devices.get_mut(id)
            && d.active
        {
            d.active = false;
            d.keyed = false;
            self.rekey_required = true;
        }
    }

    /// Whether `device`'s keying chain (`introduced_by`) fails to reach a
    /// self-introduced device (the creator's initial rekey) through user devices
    /// only. Fails closed: a service device on the chain, a missing link
    /// (`introduced_by` unset or an unknown device) and a cycle all count as
    /// "via service". Bounded by the number of devices.
    fn introduced_via_service(&self, device: &Uuid) -> bool {
        let mut cur = *device;
        let mut seen = BTreeSet::new();
        loop {
            if !seen.insert(cur) {
                return true; // cycle
            }
            let Some(d) = self.devices.get(&cur) else {
                return true; // unknown device
            };
            if matches!(d.kind, DeviceKind::Escrow | DeviceKind::Hosted) {
                return true;
            }
            match d.introduced_by {
                Some(next) if next == cur => return false, // self-introduced
                Some(next) => cur = next,
                None => return true, // missing link: unproven
            }
        }
    }
}
