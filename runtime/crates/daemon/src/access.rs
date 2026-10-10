//! The local access list: which apps may use this device's local collections.
//!
//! Local-only collections have no log, so no policy items. Apps reach them only
//! through the daemon, under **grants issued by the control plane and cached
//! here** (`docs/collection-states-and-pricing.md` §3, §11.1):
//!
//! - **Notify, don't block (default).** A grant the daemon has not seen before is
//!   served at once, and the user is notified on this device (a `new_access` event
//!   and an `app_access_added` notice until acknowledged), so a silent grant from a
//!   compromised server is visible.
//! - **Opt-in approval.** With `require_grant_approval` on, a new grant waits in
//!   `pending_approval` until the user approves it here.
//! - **Revocation is always honoured.** A grant the control plane no longer lists
//!   is removed at once. A grant the user revoked or denied locally stays refused,
//!   even if the control plane keeps listing it.
//! - **Exact match.** A session is served only if its grant ID, collection and
//!   authenticated Noise static key equal a cached `active` grant. A grant whose
//!   key, capabilities or folders change is treated as new.
//!
//! The list is device-local state in `<state>/access.json` (owner-only, atomic
//! writes). It is never in the collection folder and never synced.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::fsutil;

/// Current schema.
pub const SCHEMA_VERSION: u32 = 1;

/// A grant as the control plane issued it for a local collection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CachedGrant {
    /// Grant ID (UUID).
    pub grant: String,
    /// Authenticated consenting account from the negotiated raw grant feed.
    /// None is a legacy cache shape, never an account-serving fallback.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    /// Collection ID.
    pub collection: String,
    /// App ID.
    pub app_id: String,
    /// App name, for people.
    pub app_name: String,
    /// The app's Noise static public key (hex), as registered at consent.
    pub client_pk: String,
    /// Capabilities (the v2 group names).
    pub capabilities: Vec<String>,
    /// Folder scope, if narrower than the whole collection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folders: Option<Vec<String>>,
    /// No attested Noise key (an old SDK's grant): served only through the
    /// old-envelope compatibility layer, still through this list.
    #[serde(default)]
    pub legacy_only: bool,
}

impl CachedGrant {
    /// The short fingerprint shown to the user and on the app's consent screen
    /// (`policy.md` §5.1), in the one shared display form
    /// ([`mdbn_replica::crypto::proof::client_fingerprint_display`]).
    pub fn fingerprint(&self) -> String {
        match crate::secrets::hex_decode(&self.client_pk)
            .ok()
            .and_then(|raw| <[u8; 32]>::try_from(raw).ok())
        {
            Some(pk) => {
                mdbn_replica::crypto::proof::client_fingerprint_display(&mdbn_wire::common::B32(pk))
            }
            // Never a fingerprint of something that is not a client key.
            None => "invalid-client-key".into(),
        }
    }
}

/// What the device says about a grant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccessState {
    /// Served.
    Active,
    /// Waiting for the user's approval (opt-in setting).
    PendingApproval,
    /// The user declined it.
    Denied,
    /// The user revoked it on this device.
    RevokedLocally,
}

/// One entry of the access list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccessEntry {
    /// The grant.
    #[serde(flatten)]
    pub grant: CachedGrant,
    /// State on this device.
    pub state: AccessState,
    /// When this device first saw it (ms).
    pub first_seen_ms: u64,
    /// Durable generation of these consent terms (prevents replace-and-restore).
    #[serde(default)]
    pub generation: u64,
    /// Whether the user has acknowledged the new-access notification.
    pub acknowledged: bool,
    /// A refusal kept as a tombstone after the control plane stopped listing it.
    #[serde(default)]
    pub delisted: bool,
}

impl AccessEntry {
    /// Denied or revoked on this device.
    pub fn is_refused(&self) -> bool {
        matches!(
            self.state,
            AccessState::Denied | AccessState::RevokedLocally
        )
    }
}

/// Something the user should hear about (a desktop notification, a CLI line).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "event")]
pub enum AccessEvent {
    /// An app gained access (served now).
    NewAccess {
        /// The entry.
        entry: AccessEntry,
    },
    /// An app asks for access (approval required).
    ApprovalRequested {
        /// The entry.
        entry: AccessEntry,
    },
    /// The control plane revoked a grant.
    Revoked {
        /// Grant ID.
        grant: String,
        /// Collection ID.
        collection: String,
        /// App name.
        app_name: String,
    },
}

/// Why a session's grant is refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// No such grant for this collection.
    UnknownGrant,
    /// The session's key is not the grant's key.
    KeyMismatch,
    /// Waiting for approval on this device.
    PendingApproval,
    /// Revoked or denied on this device.
    RevokedLocally,
    /// The grant list for this collection is older than its lease.
    LeaseExpired,
}

impl Refusal {
    /// Stable reason string.
    pub fn reason(self) -> &'static str {
        match self {
            Refusal::UnknownGrant => "unknown_grant",
            Refusal::KeyMismatch => "grant_key_mismatch",
            Refusal::PendingApproval => "grant_pending_approval",
            Refusal::RevokedLocally => "grant_revoked_on_device",
            Refusal::LeaseExpired => "grant_lease_expired",
        }
    }
}

/// Replay cursor committed atomically with the grants it protects.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FeedCursor {
    /// Pinned connector.
    pub connector: String,
    /// Highest applied sequence.
    pub sequence: u64,
    /// Revision at that sequence.
    pub revision: String,
}

/// The access list document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccessList {
    /// Schema version.
    pub schema_version: u32,
    /// Opt-in: new grants wait for approval on this device.
    #[serde(default)]
    pub require_grant_approval: bool,
    /// Entries, in first-seen order.
    #[serde(default)]
    pub entries: Vec<AccessEntry>,
    /// Per collection: when the cached grant list stops being trusted (ms).
    #[serde(default)]
    pub leases: std::collections::BTreeMap<String, u64>,
    /// Collections that were ever end-to-end: new grants always wait for
    /// approval, whatever the setting.
    #[serde(default)]
    pub approval_forced: std::collections::BTreeSet<String>,
    /// Authorization cache and replay cursor have one persistence boundary.
    #[serde(default)]
    pub feed_cursor: Option<FeedCursor>,
    /// Last issued consent generation.
    #[serde(default)]
    pub generation: u64,
    /// Live leases use a monotonic clock. Never restored across process restart.
    #[serde(skip)]
    pub monotonic_leases: std::collections::BTreeMap<String, std::time::Instant>,
}

impl Default for AccessList {
    fn default() -> Self {
        AccessList {
            schema_version: SCHEMA_VERSION,
            require_grant_approval: false,
            entries: Vec::new(),
            leases: Default::default(),
            approval_forced: Default::default(),
            feed_cursor: None,
            generation: 0,
            monotonic_leases: Default::default(),
        }
    }
}

/// Access-list failures.
#[derive(Debug)]
pub enum AccessError {
    /// I/O.
    Io(std::io::Error),
    /// The file is malformed or newer; it is left in place.
    Malformed(String),
    /// No such grant.
    NotFound,
    /// The operation does not apply in the grant's state.
    WrongState(AccessState),
}

impl std::fmt::Display for AccessError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AccessError::Io(e) => write!(f, "access list I/O: {e}"),
            AccessError::Malformed(m) => write!(f, "access list is malformed: {m}"),
            AccessError::NotFound => f.write_str("no such grant on this device"),
            AccessError::WrongState(s) => write!(f, "the grant is {s:?}"),
        }
    }
}

impl std::error::Error for AccessError {}

impl From<std::io::Error> for AccessError {
    fn from(e: std::io::Error) -> Self {
        AccessError::Io(e)
    }
}

impl AccessList {
    /// Load; a missing file is an empty list. A malformed or newer file fails and
    /// is left in place (the daemon then serves no granted session).
    pub fn load(path: &Path) -> Result<AccessList, AccessError> {
        let Some(b) = fsutil::read_optional(path)? else {
            return Ok(AccessList::default());
        };
        let l: AccessList =
            serde_json::from_slice(&b).map_err(|e| AccessError::Malformed(e.to_string()))?;
        if l.schema_version > SCHEMA_VERSION {
            return Err(AccessError::Malformed(format!(
                "schema {} is newer than this daemon",
                l.schema_version
            )));
        }
        Ok(l)
    }

    /// Save durably.
    pub fn save(&self, path: &Path) -> Result<(), AccessError> {
        let mut b =
            serde_json::to_vec_pretty(self).map_err(|e| AccessError::Malformed(e.to_string()))?;
        b.push(b'\n');
        fsutil::write_atomic(path, &b)?;
        Ok(())
    }

    fn find(&self, grant: &str) -> Option<usize> {
        self.entries.iter().position(|e| e.grant.grant == grant)
    }

    /// Reconcile with the control plane's current grants for `collection`, valid
    /// until `lease_expires_ms` (the feed's lease; after it, nothing for this
    /// collection is served until the next successful fetch). Returns the events to
    /// show the user. The caller saves before serving.
    ///
    /// Local refusals are **tombstones**. A denied or locally revoked
    /// grant is kept when the control plane stops listing it, and a grant that
    /// reappears, or a new grant for the same app or the same key on this
    /// collection, waits for approval whatever the setting.
    pub fn sync_from_control_plane(
        &mut self,
        collection: &str,
        grants: &[CachedGrant],
        now_ms: u64,
        lease_expires_ms: u64,
    ) -> Vec<AccessEvent> {
        let mut events = Vec::new();
        self.leases.insert(collection.to_string(), lease_expires_ms);
        if let Some(deadline) = std::time::Instant::now().checked_add(
            std::time::Duration::from_millis(lease_expires_ms.saturating_sub(now_ms)),
        ) {
            self.monotonic_leases
                .insert(collection.to_string(), deadline);
        } else {
            self.monotonic_leases.remove(collection);
        }
        // Revocations first. Served or pending entries the control plane no longer
        // lists go at once; refusals stay as tombstones.
        self.entries.retain_mut(|e| {
            if e.grant.collection != collection {
                return true;
            }
            let listed = grants.iter().any(|g| g.grant == e.grant.grant);
            if listed {
                e.delisted = false;
                return true;
            }
            match e.state {
                AccessState::Denied | AccessState::RevokedLocally => {
                    e.delisted = true;
                    true
                }
                AccessState::Active => {
                    events.push(AccessEvent::Revoked {
                        grant: e.grant.grant.clone(),
                        collection: e.grant.collection.clone(),
                        app_name: e.grant.app_name.clone(),
                    });
                    false
                }
                AccessState::PendingApproval => false,
            }
        });
        for g in grants.iter().filter(|g| g.collection == collection) {
            match self.find(&g.grant) {
                Some(i) if self.entries[i].grant == *g => {}
                Some(i) if self.entries[i].is_refused() => {
                    // Stays refused; keep the latest terms for display.
                    self.entries[i].grant = g.clone();
                }
                existing => {
                    // New, or changed terms (key, capabilities, folders): new.
                    if let Some(i) = existing {
                        self.entries.remove(i);
                    }
                    let refused_before = self.entries.iter().any(|e| {
                        e.is_refused()
                            && e.grant.collection == collection
                            && (e.grant.app_id == g.app_id || e.grant.client_pk == g.client_pk)
                    });
                    let approval = self.require_grant_approval
                        || refused_before
                        || self.approval_forced.contains(collection);
                    self.generation = self
                        .generation
                        .checked_add(1)
                        .expect("consent generation exhausted");
                    let entry = AccessEntry {
                        grant: g.clone(),
                        state: if approval {
                            AccessState::PendingApproval
                        } else {
                            AccessState::Active
                        },
                        first_seen_ms: now_ms,
                        generation: self.generation,
                        acknowledged: false,
                        delisted: false,
                    };
                    events.push(if approval {
                        AccessEvent::ApprovalRequested {
                            entry: entry.clone(),
                        }
                    } else {
                        AccessEvent::NewAccess {
                            entry: entry.clone(),
                        }
                    });
                    self.entries.push(entry);
                }
            }
        }
        events
    }

    /// Check a session: grant ID, collection and authenticated key must match an
    /// active entry exactly.
    pub fn authorize(
        &self,
        collection: &str,
        grant: &str,
        client_pk: &[u8; 32],
        now_ms: u64,
    ) -> Result<&AccessEntry, Refusal> {
        // Fail closed without a live lease, including after a restart.
        if !self.lease_live(collection, now_ms) {
            return Err(Refusal::LeaseExpired);
        }
        let e = self
            .entries
            .iter()
            .find(|e| e.grant.grant == grant && e.grant.collection == collection)
            .ok_or(Refusal::UnknownGrant)?;
        if e.grant.legacy_only
            || crate::secrets::hex_decode(&e.grant.client_pk)
                .ok()
                .as_deref()
                != Some(&client_pk[..])
        {
            return Err(Refusal::KeyMismatch);
        }
        match e.state {
            AccessState::Active => Ok(e),
            AccessState::PendingApproval => Err(Refusal::PendingApproval),
            AccessState::Denied | AccessState::RevokedLocally => Err(Refusal::RevokedLocally),
        }
    }

    /// Whether `grant` is still active for `collection` under a live lease (open
    /// sessions and pipes are closed when this turns false).
    pub fn grant_live(&self, collection: &str, grant: &str, now_ms: u64) -> bool {
        self.lease_live(collection, now_ms)
            && self.entries.iter().any(|e| {
                e.grant.grant == grant
                    && e.grant.collection == collection
                    && e.state == AccessState::Active
            })
    }

    /// Lease deadline uses both clocks: a backward wall-clock step cannot extend
    /// access. Missing monotonic anchors after restart always fail closed.
    pub fn lease_live(&self, collection: &str, now_ms: u64) -> bool {
        self.leases.get(collection).is_some_and(|exp| now_ms < *exp)
            && self
                .monotonic_leases
                .get(collection)
                .is_some_and(|exp| std::time::Instant::now() < *exp)
    }

    /// Mark a collection as having been end-to-end: approval is
    /// required from now on for it.
    pub fn force_approval(&mut self, collection: &str) {
        self.approval_forced.insert(collection.to_string());
    }

    /// Revoke on this device (from any state but denied/revoked).
    pub fn revoke(&mut self, grant: &str) -> Result<&AccessEntry, AccessError> {
        let i = self.find(grant).ok_or(AccessError::NotFound)?;
        let e = &mut self.entries[i];
        match e.state {
            AccessState::Active | AccessState::PendingApproval => {
                e.state = AccessState::RevokedLocally;
                e.acknowledged = true;
                Ok(e)
            }
            s => Err(AccessError::WrongState(s)),
        }
    }

    /// Approve a pending grant.
    pub fn approve(&mut self, grant: &str) -> Result<&AccessEntry, AccessError> {
        let i = self.find(grant).ok_or(AccessError::NotFound)?;
        let e = &mut self.entries[i];
        if e.state != AccessState::PendingApproval {
            return Err(AccessError::WrongState(e.state));
        }
        e.state = AccessState::Active;
        e.acknowledged = true;
        Ok(e)
    }

    /// Decline a pending grant.
    pub fn deny(&mut self, grant: &str) -> Result<&AccessEntry, AccessError> {
        let i = self.find(grant).ok_or(AccessError::NotFound)?;
        let e = &mut self.entries[i];
        if e.state != AccessState::PendingApproval {
            return Err(AccessError::WrongState(e.state));
        }
        e.state = AccessState::Denied;
        e.acknowledged = true;
        Ok(e)
    }

    /// Acknowledge the new-access notification.
    pub fn acknowledge(&mut self, grant: &str) -> Result<&AccessEntry, AccessError> {
        let i = self.find(grant).ok_or(AccessError::NotFound)?;
        self.entries[i].acknowledged = true;
        Ok(&self.entries[i])
    }

    /// Entries for one collection (or all).
    pub fn list(&self, collection: Option<&str>) -> Vec<&AccessEntry> {
        self.entries
            .iter()
            .filter(|e| collection.is_none_or(|c| e.grant.collection == c))
            .collect()
    }

    /// Drop every entry of an unregistered collection.
    pub fn forget_collection(&mut self, collection: &str) {
        self.entries.retain(|e| e.grant.collection != collection);
        self.leases.remove(collection);
        self.monotonic_leases.remove(collection);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn g(id: &str, pk: u8, caps: &[&str]) -> CachedGrant {
        CachedGrant {
            grant: id.into(),
            account_id: Some("11111111-1111-4111-8111-111111111111".into()),
            collection: "c".into(),
            app_id: "app".into(),
            app_name: "Reader".into(),
            client_pk: crate::secrets::hex(&[pk; 32]),
            capabilities: caps.iter().map(|s| s.to_string()).collect(),
            folders: None,
            legacy_only: false,
        }
    }

    #[test]
    fn forced_approval_and_legacy_only() {
        let mut l = AccessList::default();
        l.force_approval("c");
        let ev = l.sync_from_control_plane_t("c", &[g("g1", 1, &["read"])], 5);
        assert!(matches!(&ev[..], [AccessEvent::ApprovalRequested { .. }]));
        let mut old = g("g2", 2, &["read"]);
        old.app_id = "old".into();
        old.client_pk = String::new();
        old.legacy_only = true;
        let mut l = AccessList::default();
        l.sync_from_control_plane_t("c", &[old], 5);
        assert_eq!(
            l.authorize("c", "g2", &[0; 32], 10).unwrap_err(),
            Refusal::KeyMismatch
        );
        assert!(l.grant_live("c", "g2", 10));
        assert!(!l.grant_live("c", "g2", 1000));
    }

    impl AccessList {
        fn sync_from_control_plane_t(
            &mut self,
            c: &str,
            g: &[CachedGrant],
            now: u64,
        ) -> Vec<AccessEvent> {
            self.sync_from_control_plane(c, g, now, 1000)
        }
    }

    #[test]
    fn local_refusals_survive_delisting_and_new_grant_ids() {
        let mut l = AccessList::default();
        l.sync_from_control_plane_t("c", &[g("g1", 1, &["read"])], 5);
        l.revoke("g1").unwrap();
        l.sync_from_control_plane_t("c", &[], 6);
        assert!(l.entries[0].delisted, "kept as a tombstone");
        // Relisted: still refused.
        assert!(
            l.sync_from_control_plane_t("c", &[g("g1", 1, &["read"])], 7)
                .is_empty()
        );
        assert_eq!(
            l.authorize("c", "g1", &[1; 32], 10).unwrap_err(),
            Refusal::RevokedLocally
        );
        // A new grant ID for the same app (or key) waits for approval.
        let ev =
            l.sync_from_control_plane_t("c", &[g("g1", 1, &["read"]), g("g2", 1, &["read"])], 8);
        assert!(matches!(&ev[..], [AccessEvent::ApprovalRequested { .. }]));
        assert_eq!(
            l.authorize("c", "g2", &[1; 32], 10).unwrap_err(),
            Refusal::PendingApproval
        );
        let mut other = g("g3", 7, &["read"]);
        other.app_id = "other-app".into();
        let ev = l.sync_from_control_plane_t(
            "c",
            &[g("g1", 1, &["read"]), g("g2", 1, &["read"]), other],
            9,
        );
        assert!(
            matches!(&ev[..], [AccessEvent::NewAccess { .. }]),
            "unrelated apps unaffected"
        );
    }

    #[test]
    fn nothing_is_served_without_a_live_lease() {
        let mut l = AccessList::default();
        assert_eq!(
            l.authorize("c", "g1", &[1; 32], 0).unwrap_err(),
            Refusal::LeaseExpired
        );
        l.sync_from_control_plane("c", &[g("g1", 1, &["read"])], 5, 100);
        assert!(l.authorize("c", "g1", &[1; 32], 99).is_ok());
        assert_eq!(
            l.authorize("c", "g1", &[1; 32], 100).unwrap_err(),
            Refusal::LeaseExpired
        );
    }

    #[test]
    fn backwards_wall_clock_never_extends_monotonic_lease() {
        let mut l = AccessList::default();
        l.sync_from_control_plane("c", &[g("g1", 1, &["read"])], 10_000, 65_000);
        assert!(l.grant_live("c", "g1", 10_000));
        l.monotonic_leases.insert(
            "c".into(),
            std::time::Instant::now() - std::time::Duration::from_millis(1),
        );
        assert!(
            !l.grant_live("c", "g1", 0),
            "backwards wall clock cannot revive the lease"
        );
        assert_eq!(
            l.authorize("c", "g1", &[1; 32], 0).unwrap_err(),
            Refusal::LeaseExpired
        );
    }

    #[test]
    fn new_grants_are_served_and_announced() {
        let mut l = AccessList::default();
        let ev = l.sync_from_control_plane_t("c", &[g("g1", 1, &["read"])], 5);
        assert!(matches!(&ev[..], [AccessEvent::NewAccess { .. }]));
        assert!(l.authorize("c", "g1", &[1; 32], 10).is_ok());
        assert_eq!(
            l.authorize("c", "g1", &[2; 32], 10).unwrap_err(),
            Refusal::KeyMismatch
        );
        assert_eq!(
            l.authorize("c", "g9", &[1; 32], 10).unwrap_err(),
            Refusal::UnknownGrant
        );
        assert_eq!(
            l.authorize("other", "g1", &[1; 32], 10).unwrap_err(),
            Refusal::LeaseExpired
        );
        // Seen again unchanged: silent.
        assert!(
            l.sync_from_control_plane_t("c", &[g("g1", 1, &["read"])], 6)
                .is_empty()
        );
    }

    #[test]
    fn control_plane_revocation_is_always_honoured() {
        let mut l = AccessList::default();
        l.sync_from_control_plane_t("c", &[g("g1", 1, &["read"])], 5);
        let ev = l.sync_from_control_plane_t("c", &[], 6);
        assert!(matches!(&ev[..], [AccessEvent::Revoked { .. }]));
        assert_eq!(
            l.authorize("c", "g1", &[1; 32], 10).unwrap_err(),
            Refusal::UnknownGrant
        );
    }

    #[test]
    fn local_revocation_sticks_while_the_control_plane_lists_it() {
        let mut l = AccessList::default();
        l.sync_from_control_plane_t("c", &[g("g1", 1, &["read"])], 5);
        l.revoke("g1").unwrap();
        assert!(
            l.sync_from_control_plane_t("c", &[g("g1", 1, &["read", "write"])], 6)
                .is_empty()
        );
        assert_eq!(
            l.authorize("c", "g1", &[1; 32], 10).unwrap_err(),
            Refusal::RevokedLocally
        );
    }

    #[test]
    fn changed_terms_count_as_new() {
        let mut l = AccessList::default();
        l.sync_from_control_plane_t("c", &[g("g1", 1, &["read"])], 5);
        l.acknowledge("g1").unwrap();
        let ev = l.sync_from_control_plane_t("c", &[g("g1", 9, &["read"])], 6);
        assert!(matches!(&ev[..], [AccessEvent::NewAccess { entry }] if !entry.acknowledged));
        assert_eq!(
            l.authorize("c", "g1", &[1; 32], 10).unwrap_err(),
            Refusal::KeyMismatch
        );
        assert!(l.authorize("c", "g1", &[9; 32], 10).is_ok());
    }

    #[test]
    fn opt_in_approval_holds_new_grants() {
        let mut l = AccessList {
            require_grant_approval: true,
            ..Default::default()
        };
        let ev =
            l.sync_from_control_plane_t("c", &[g("g1", 1, &["read"]), g("g2", 2, &["read"])], 5);
        assert!(matches!(
            &ev[..],
            [
                AccessEvent::ApprovalRequested { .. },
                AccessEvent::ApprovalRequested { .. }
            ]
        ));
        assert_eq!(
            l.authorize("c", "g1", &[1; 32], 10).unwrap_err(),
            Refusal::PendingApproval
        );
        l.approve("g1").unwrap();
        l.deny("g2").unwrap();
        assert!(l.authorize("c", "g1", &[1; 32], 10).is_ok());
        assert_eq!(
            l.authorize("c", "g2", &[2; 32], 10).unwrap_err(),
            Refusal::RevokedLocally
        );
        assert!(matches!(
            l.approve("g2"),
            Err(AccessError::WrongState(AccessState::Denied))
        ));
    }

    #[test]
    fn persists_and_refuses_newer_schema() {
        let dir = crate::testutil::TestDir::new("access");
        let p = dir.path().join("access.json");
        let mut l = AccessList::default();
        l.sync_from_control_plane_t("c", &[g("g1", 1, &["read"])], 5);
        l.save(&p).unwrap();
        let loaded = AccessList::load(&p).unwrap();
        assert_eq!(
            serde_json::to_value(&loaded).unwrap(),
            serde_json::to_value(&l).unwrap()
        );
        assert_eq!(
            loaded.authorize("c", "g1", &[1; 32], 10).unwrap_err(),
            Refusal::LeaseExpired,
            "restart requires a fresh feed"
        );
        std::fs::write(&p, br#"{"schema_version": 7}"#).unwrap();
        assert!(matches!(
            AccessList::load(&p),
            Err(AccessError::Malformed(_))
        ));
    }

    #[test]
    fn fingerprint_is_grouped_hex() {
        let fp = g("g1", 1, &[]).fingerprint();
        assert_eq!(fp.len(), 19);
        assert_eq!(fp.matches('-').count(), 3);
        // The spec's H(client-fp, client_pk), not an unprefixed SHA-256.
        let g0 = CachedGrant {
            client_pk: "00".repeat(32),
            ..g("g0", 1, &[])
        };
        assert_eq!(g0.fingerprint(), "535b-c237-63ed-cd6a");
    }
}
