//! Key epochs: `rekey` and `key_grant` items.

use super::*;

impl PolicyState {
    /// Devices a non-initial rekey must wrap for: enrolled, active and keyed.
    pub fn rekey_recipients(&self) -> BTreeSet<Uuid> {
        self.devices
            .iter()
            .filter(|(_, d)| d.active && d.keyed)
            .map(|(id, _)| *id)
            .collect()
    }

    pub(super) fn rekey_item(&mut self, item: &Item, env: &Env<'_>) -> Verdict {
        let p = RekeyPayload::from_bytes(&item.body.0).map_err(decode_err)?;
        let signer = self.check_device_signature(item, env)?;
        if self.root.is_none() {
            return Err(void("rekey", "no genesis"));
        }
        if p.from != self.epoch || p.epoch != p.from + 1 {
            return Err(void(
                "rekey",
                "from is not the current epoch, or epoch != from + 1",
            ));
        }
        let recipients: BTreeSet<Uuid> = p.wraps.iter().map(|w| w.device).collect();
        if recipients.len() != p.wraps.len() {
            return Err(void("rekey", "more than one wrap per recipient"));
        }
        let d = &self.devices[&signer];
        let cloud = self.cstate == Some(CState::CloudCopy);
        let service = |kind: DeviceKind| matches!(kind, DeviceKind::Hosted | DeviceKind::Escrow);
        // Private (e2e) mode: no hosted or escrow signer or recipient for any rekey
        // Inactive service rows stay as history.
        if !cloud
            && (service(d.kind)
                || recipients
                    .iter()
                    .any(|r| self.devices.get(r).is_some_and(|x| service(x.kind))))
        {
            return Err(void(
                "rekey",
                "no hosted or escrow signer or recipient in e2e",
            ));
        }
        if p.from == 0 {
            if p.reason != RekeyReason::Initial {
                return Err(void("rekey", "the first rekey must be initial"));
            }
            // An owner/editor user device, or in cloud copy hosted as the first keyed
            // replica of a service-created collection (sealed-envelope.md §5.2, §7.1).
            if !(self.editor_device(d) || (cloud && d.kind == DeviceKind::Hosted)) {
                return Err(void(
                    "rekey",
                    "initial rekey signer must be an editor device, or hosted in cloud copy",
                ));
            }
            if !recipients.iter().all(|r| self.active_device(r).is_some()) {
                return Err(void("rekey", "initial recipients must be active devices"));
            }
            if !recipients.contains(&signer) {
                return Err(void("rekey", "initial rekey must include the signer"));
            }
            // Cloud copy: the initial epoch reaches the escrow and every active hosted.
            if cloud
                && (!self.devices.iter().any(|(id, d)| {
                    d.active && d.kind == DeviceKind::Escrow && recipients.contains(id)
                }) || self.devices.iter().any(|(id, d)| {
                    d.active && d.kind == DeviceKind::Hosted && !recipients.contains(id)
                }))
            {
                return Err(void(
                    "rekey",
                    "initial rekey in cloud copy must include the escrow and hosted",
                ));
            }
        } else {
            if !d.keyed {
                return Err(void("rekey", "signer is not keyed"));
            }
            // The account key is a rekey recipient only; it
            // never signs one. A user device of the account rekeys after recovery.
            if d.kind == DeviceKind::Recovery {
                return Err(void("rekey", "a recovery device does not sign rekeys"));
            }
            if recipients != self.rekey_recipients() {
                return Err(void(
                    "rekey",
                    "recipients are not exactly the keyed active devices",
                ));
            }
        }
        for dev in self.devices.values_mut() {
            dev.keyed = false;
        }
        for r in &recipients {
            if let Some(dev) = self.devices.get_mut(r) {
                dev.keyed = true;
                dev.introduced_by.get_or_insert(signer);
                dev.delivered_by = Some(signer);
            }
        }
        self.epoch = p.epoch;
        self.rekey_required = false;
        Ok(())
    }

    pub(super) fn key_grant_item(&mut self, item: &Item, env: &Env<'_>) -> Verdict {
        let p = KeyGrantPayload::from_bytes(&item.body.0).map_err(decode_err)?;
        let signer = self.check_device_signature(item, env)?;
        let d = &self.devices[&signer];
        if !d.keyed {
            return Err(void("key_grant", "signer is not keyed"));
        }
        let cloud = self.cstate == Some(CState::CloudCopy);
        let editor = self.editor_device(d);
        // Cloud copy only: hosted, or escrow if hosted is
        // unavailable, keys control-approved account devices (enrolled for a member
        // account), never service or recovery devices.
        let service = cloud && matches!(d.kind, DeviceKind::Hosted | DeviceKind::Escrow);
        // The account key (AK1, private-account-key.md §4): a member account's
        // recovery device keys only that account's own user devices, and only in
        // private (e2e) mode. The user's password or recovery key is the approval.
        // Any member role: a viewer's own devices need the epoch
        // key to read, and the recipient is always the signer's own account.
        let recovery = d.kind == DeviceKind::Recovery && self.members.contains_key(&d.account);
        if !(editor || service || recovery) {
            return Err(void("key_grant", "signer may not grant keys"));
        }
        if recovery {
            if cloud {
                return Err(void("key_grant", "recovery devices grant keys only in e2e"));
            }
            let same_account_user_device = self.devices.get(&p.recipient).is_some_and(|r| {
                matches!(
                    r.kind,
                    DeviceKind::Desktop
                        | DeviceKind::Mobile
                        | DeviceKind::AppRuntime
                        | DeviceKind::Cli
                ) && r.account == d.account
            });
            if !same_account_user_device {
                return Err(void(
                    "key_grant",
                    "a recovery device keys only its own account's user devices",
                ));
            }
        }
        // Private (e2e) mode: never to a hosted or escrow device.
        if !cloud
            && self
                .devices
                .get(&p.recipient)
                .is_some_and(|r| matches!(r.kind, DeviceKind::Hosted | DeviceKind::Escrow))
        {
            return Err(void("key_grant", "no hosted or escrow recipient in e2e"));
        }
        if service
            && !self.devices.get(&p.recipient).is_some_and(|r| {
                matches!(
                    r.kind,
                    DeviceKind::Desktop
                        | DeviceKind::Mobile
                        | DeviceKind::AppRuntime
                        | DeviceKind::Cli
                ) && self.members.contains_key(&r.account)
            })
        {
            return Err(void(
                "key_grant",
                "hosted and escrow grant keys only to a member account's device",
            ));
        }
        if p.epoch != self.epoch || self.epoch == 0 {
            return Err(void("key_grant", "epoch is not current"));
        }
        if p.wrap.device != p.recipient {
            return Err(void("key_grant", "wrap is for another device"));
        }
        let Some(r) = self.devices.get_mut(&p.recipient).filter(|r| r.active) else {
            return Err(void("key_grant", "recipient is not an active device"));
        };
        r.keyed = true;
        r.introduced_by.get_or_insert(signer);
        r.delivered_by = Some(signer);
        Ok(())
    }
}
