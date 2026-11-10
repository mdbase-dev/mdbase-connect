//! What the client API reads from `P`: effective grants, grant sources, key trust and receipt scope.

use super::*;

/// What a grant may actually do now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffectiveGrant {
    /// Granting member.
    pub account: Uuid,
    /// The member's role.
    pub role: Role,
    /// Capabilities in force.
    pub capabilities: BTreeSet<String>,
    /// Folder scope of the file namespace, if any.
    pub file_folders: Option<Vec<String>>,
    /// The client's Noise static key.
    pub client_pk: B32,
}

impl EffectiveGrant {
    /// Whether it holds `cap` now, bounded by its member's role.
    pub fn allows(&self, cap: &str) -> bool {
        (cap == capability::READ || self.role >= Role::Editor) && self.capabilities.contains(cap)
    }
}

/// Host-authenticated declaration-bound setup under one current consent.
/// This does not grant ordinary definition writes or replace signed policy.
/// The host verifies the original authorization, declaration and Noise binding;
/// Replica independently requires the current effective grant and keyed device.
#[derive(Debug, Clone, PartialEq)]
pub struct DeclaredSetupAuthorization {
    /// Independently authenticated consenting account.
    pub account: Uuid,
    /// Original installation Noise key, not a request-provided key.
    pub client_pk: B32,
    /// Durable consent generation; replacement/revoke/restore never reuses it.
    pub generation: u64,
    /// Durable authenticated account/source incarnation.
    pub authority_epoch: u64,
    /// Host-monotonic lease continuity; an expiry followed by renewal cannot
    /// revive a captured review. Ordinary uninterrupted renewal preserves this.
    pub lease_generation: u64,
    /// Exact trusted declaration lifted through Core's strict pack loader.
    pub setup: mdbn_core::setup::envelope::CollectionSetup,
}

/// Host authority, including local-only grants and separately verified declared
/// setup. Synced ordinary grants still come from the signed policy, not this host.
pub trait GrantSource {
    /// The grant as it stands now; refusals preserve their code and reason.
    /// Its account must come from authenticated grant metadata, not a default.
    fn grant(&self, grant: &Uuid) -> crate::api::ApiResult<EffectiveGrant>;

    /// Current declaration from the verified signed grant feed, under the live
    /// account, exact consent generation and monotonic lease. Missing evidence or
    /// producer support denies setup. Never parse a declaration supplied by an app.
    fn declared_setup(&self, _grant: &Uuid) -> Option<DeclaredSetupAuthorization> {
        None
    }

    /// Independently host-authenticated local ownership, loaded from trusted
    /// durable identity/registration metadata, never inferred from a grant,
    /// policy-free local log, device UUID or SERVICE_ACCOUNT/Owner fallback.
    /// Missing provenance fails closed. Re-read for every admission/use/commit.
    fn owner_identity(&self) -> Option<LocalOwnerIdentity> {
        None
    }

    /// The daemon's currently active paired account: authenticated login response,
    /// persisted under the account activation fence and cleared on logout.
    /// Never infer this from the grant or collection registration.
    fn active_account(&self) -> Option<Uuid> {
        None
    }

    /// Durable, monotonic authority incarnation of the currently valid source.
    /// Logout/re-pair/source replacement must never revive an old stamp (even
    /// same-account ABA). Never infer from a UUID or use a configured fallback.
    /// This is a lifecycle fence, NOT authorization, freshness or readiness.
    /// Missing provenance denies private device approval.
    fn authority_epoch(&self) -> Option<u64> {
        None
    }

    /// Public Noise key of the CURRENT HOST-held device identity, bound to this
    /// valid source's account epoch/device. Never infer from policy, client data
    /// or configured constants. Native hosts publish OS-keychain-loaded custody.
    /// Missing provenance denies private approval; not PoP or readiness by itself.
    fn device_noise_pk(&self) -> Option<B32> {
        None
    }
}

/// Trusted-host local ownership binding. Merely constructing these fields is
/// not authentication: the host must establish their provenance independently
/// of the app/grant and must not synthesize a permissive fallback.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalOwnerIdentity {
    /// Owner account recorded at LOCAL-ONLY collection registration.
    pub account: Uuid,
    /// Collection bound to that registration.
    pub collection: Uuid,
    /// Keychain device bound to that registration.
    pub device: Uuid,
}

/// Whether this device may use the collection key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyTrust {
    /// Use it.
    Trusted,
    /// This device is not keyed (yet).
    NotKeyed,
    /// The key reached this device through devices the user never approved here:
    /// `key_untrusted` incident; don't use the key.
    Untrusted {
        /// The device whose item delivered the current key.
        delivered_by: Option<Uuid>,
    },
}

/// How much of a receipt a session may see.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReceiptScope {
    /// Everything: state, position, status, record views, conflicts.
    Full,
    /// State, position and status only; no record views or conflict values.
    StateOnly,
    /// Not this session's mutation: answer `not_found`.
    Hidden,
}

impl PolicyState {
    // ------------------------------------------------------------ client API

    /// Whether grants need a device approval at this position (`policy.md` §5.1):
    /// always, except in a `cloud-copy` collection whose escrow
    /// device is active and keyed (proof that a user's device handed it the key)
    /// and whose log is not device-located (governed by a device's local root).
    pub fn grant_approval_required(&self) -> bool {
        let escrow_keyed = self
            .devices
            .values()
            .any(|d| d.kind == DeviceKind::Escrow && d.active && d.keyed);
        !(self.cstate == Some(CState::CloudCopy) && escrow_keyed && !self.device_located())
    }

    /// The root in force is an enrolled device's `local_root` and not a control-plane
    /// root (the only way there is a root handover to it).
    pub(super) fn local_root_in_force(&self) -> bool {
        let Some(root_pk) = self.root_pk else {
            return false;
        };
        // The root ID and key are one identity, as for a published pin.
        self.root == Some(key_id(&root_pk.0))
            && !self.cp_roots.contains(&root_pk)
            && self.device_located()
    }

    /// The root in force is some enrolled device's `local_root` (`policy.md` §2.1).
    pub fn device_located(&self) -> bool {
        let Some(root) = self.root_pk else {
            return false;
        };
        self.devices.values().any(|d| d.local_root == Some(root))
    }

    /// Active grants still waiting for a device approval where one is required
    /// (`policy.md` §5.1), in grant order.
    pub fn pending_grants(&self) -> Vec<(Uuid, &GrantState)> {
        if !self.grant_approval_required() {
            return Vec::new();
        }
        self.grants
            .iter()
            .filter(|(_, g)| g.active && g.approved.is_none())
            .map(|(id, g)| (*id, g))
            .collect()
    }

    /// What a grant may do now (`policy.md` §5.1, §7): active, its member still a
    /// member. Where approval is required ([`PolicyState::grant_approval_required`])
    /// only with a valid approval, and then the approved capabilities and folders;
    /// an unapproved grant authorizes nothing. Otherwise the grant op as
    /// written.
    pub fn effective_grant(&self, grant: &Uuid) -> Option<EffectiveGrant> {
        let g = self.grants.get(grant).filter(|g| g.active)?;
        let role = *self.members.get(&g.account)?;
        let (capabilities, file_folders) = if !self.grant_approval_required() {
            (g.capabilities.clone(), g.file_folders.clone())
        } else {
            let approved = g.approved.as_ref()?;
            (
                g.capabilities.intersection(approved).cloned().collect(),
                g.approved_folders.clone(),
            )
        };
        Some(EffectiveGrant {
            account: g.account,
            role,
            capabilities,
            file_folders,
            client_pk: g.client_pk,
        })
    }

    /// Whether a grant holds a capability now, bounded by its member's role.
    pub fn grant_allows(&self, grant: &Uuid, cap: &str) -> bool {
        self.effective_grant(grant).is_some_and(|g| g.allows(cap))
    }

    /// An active device serves grants of its own account, or any member
    /// account only when it is the hosted device of a cloud-copy collection.
    pub fn writer_serves_account(&self, device: &Uuid, account: &Uuid) -> bool {
        self.devices.get(device).is_some_and(|d| {
            d.active
                && (d.account == *account
                    || (d.kind == DeviceKind::Hosted && self.cstate == Some(CState::CloudCopy)))
        })
    }

    /// The effective grant for a session whose Noise static key is `client_pk`
    /// (`replica-client-api.md` §12.3). `None`: refuse the session.
    pub fn grant_for_client(&self, grant: &Uuid, client_pk: &[u8; 32]) -> Option<EffectiveGrant> {
        self.effective_grant(grant)
            .filter(|g| g.client_pk.0 == *client_pk)
    }

    /// Device-local key trust (`sealed-envelope.md` §5.2 local acceptance rule).
    /// This device uses the current key only if the chain of devices
    /// that delivered it (the current key's deliverer, then each device's
    /// introducer) reaches this device itself or a device in `trusted_signers`:
    /// devices approved through SAS here in either direction, and a recovery device
    /// whose keys this device derived. All of that is replica-local, never part of
    /// `P`.
    ///
    /// `user_enabled_cloud_copy` is a **device-local** flag: this device's user
    /// turned cloud copy on here. Only then is the escrow trusted by choice. The
    /// log's `cstate` is never enough: the control plane writes it.
    pub fn key_trust(
        &self,
        me: &Uuid,
        trusted_signers: &BTreeSet<Uuid>,
        user_enabled_cloud_copy: bool,
    ) -> KeyTrust {
        let Some(d) = self.devices.get(me).filter(|d| d.active && d.keyed) else {
            return KeyTrust::NotKeyed;
        };
        if user_enabled_cloud_copy && self.cstate == Some(CState::CloudCopy) {
            return KeyTrust::Trusted;
        }
        let mut seen = BTreeSet::new();
        let mut cur = d.delivered_by;
        while let Some(x) = cur {
            // Services are trusted only by the local Cloud copy choice above.
            // Introducing a service does not let it mint Private trust outside S.
            if !matches!(d.kind, DeviceKind::Hosted | DeviceKind::Escrow)
                && self
                    .devices
                    .get(&x)
                    .is_some_and(|d| matches!(d.kind, DeviceKind::Hosted | DeviceKind::Escrow))
            {
                break;
            }
            if x == *me || trusted_signers.contains(&x) {
                return KeyTrust::Trusted;
            }
            if !seen.insert(x) {
                break;
            }
            cur = self.devices.get(&x).and_then(|d| d.introduced_by);
        }
        KeyTrust::Untrusted {
            delivered_by: d.delivered_by,
        }
    }

    /// What a session may see of a mutation's receipt. The hosting app
    /// (`session_grant = None`) sees every receipt in full. A granted session sees
    /// only receipts of mutations submitted under its own grant, and without record
    /// views or conflict values unless the grant can read the collection.
    pub fn receipt_scope(
        &self,
        session_grant: Option<&Uuid>,
        mutation_grant: Option<&Uuid>,
    ) -> ReceiptScope {
        match session_grant {
            None => ReceiptScope::Full,
            Some(g) if mutation_grant == Some(g) => {
                if self.grant_allows(g, capability::READ) {
                    ReceiptScope::Full
                } else {
                    ReceiptScope::StateOnly
                }
            }
            Some(_) => ReceiptScope::Hidden,
        }
    }
}
