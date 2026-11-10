//! Runtime types: open config, views, the thread's commands, operations and the grant source.

use super::*;

/// What opening needs.
#[derive(Debug, Clone)]
pub struct RuntimeConfig {
    /// Collection ID.
    pub collection: [u8; 16],
    /// This device's replica ID for it.
    pub replica_id: [u8; 16],
    /// Device ID.
    pub device_id: [u8; 16],
    /// Folder.
    pub root: PathBuf,
    /// `<state>/collections/<id>/`.
    pub private_dir: PathBuf,
    /// The synced link, or `None` for a local-only collection.
    pub sync: Option<Synced>,
    /// Synced only: adopt the folder as generation 0 (the adopt journal's plan)
    /// before anything else is ingested.
    pub adopt: Option<mdbn_replica::AdoptRecords>,
    /// Record IDs a path's first ingest takes (the takeover's imported ID map).
    pub id_hints: Vec<([u8; 16], String)>,
    /// This computer's name, for `keep_both` copies; `None` keeps the device ID.
    pub computer_name: Option<String>,
}

/// One readiness observation: status, caught up, and the adopt state (if adopting).
pub type ReadinessView = (
    mdbn_wire::client::SyncStatus,
    bool,
    Option<mdbn_replica::AdoptStatus>,
);

/// A local collection's inventory: confirmed `(record ID, path)` in ID order and
/// resource paths.
pub type Inventory = (Vec<([u8; 16], String)>, Vec<String>);

/// A local collection's last state before adopt, taken by [`Runtime::freeze`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Frozen {
    /// Records and resources.
    pub inventory: Inventory,
    /// Held files and unresolved conflicts at the same instant.
    pub holds: u64,
    /// Unresolved conflicts.
    pub unresolved: u64,
}

/// A synced collection's log link and locally persisted trust anchors.
#[derive(Clone)]
pub struct Synced {
    /// The log service origin.
    pub log_url: String,
    /// The state the user chose (`e2e` private, or `cloud-copy`).
    pub chosen_state: mdbn_wire::policy::CState,
    /// Control-plane root keys this device trusts.
    pub trusted_roots: Vec<[u8; 32]>,
    /// Devices this user approved or created (device-local key trust roots).
    pub trusted_signers: Vec<[u8; 16]>,
    /// This device's user turned the cloud copy on.
    pub user_enabled_cloud_copy: bool,
    /// Log access tokens.
    pub tokens: Arc<dyn crate::logwire::TokenSource>,
    /// Where the epoch keyring lives (the OS credential store; never the index).
    pub secrets: Arc<dyn crate::secrets::SecretStore>,
    /// The chain hash of the collection's genesis, pinned at create/join from the
    /// verified Connect answer (never from the log). Required: a synced runtime never
    /// serves a log whose seq 1 differs.
    pub expected_genesis: [u8; 32],
    /// The published control-plane keys (from the authenticated trust payload).
    /// Required: every policy item must be certified by one of them.
    pub policy_pins: mdbn_replica::policy::PolicyPins,
}

impl std::fmt::Debug for Synced {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Synced")
            .field("log_url", &self.log_url)
            .field("chosen_state", &self.chosen_state)
            .field("trusted_roots", &self.trusted_roots.len())
            .field("trusted_signers", &self.trusted_signers.len())
            .field("user_enabled_cloud_copy", &self.user_enabled_cloud_copy)
            .finish_non_exhaustive()
    }
}

/// Commands to the runtime thread.
pub(super) enum Cmd {
    #[cfg(test)]
    CaptureFixture(
        native_pending_fixture::Op,
        oneshot::Sender<Result<native_pending_fixture::Reply, String>>,
    ),
    Hello {
        auth: SessionAuth,
        frame: Vec<u8>,
        out: mpsc::UnboundedSender<Vec<u8>>,
        reply: oneshot::Sender<(Option<SessionId>, Vec<u8>)>,
    },
    Frame(SessionId, Vec<u8>),
    /// Re-check sessions; the sender (if any) is answered once that is done.
    GrantsChanged(Option<oneshot::Sender<()>>),
    Close(SessionId),
    Stop(bool, oneshot::Sender<()>),
    /// From the synced collection's log transport.
    Log(crate::logwire::Event),
    /// The replica's sync status.
    Status(oneshot::Sender<mdbn_wire::client::SyncStatus>),
    PrivateSwitch(
        PrivateSwitchOp,
        AccountKeyGuard,
        oneshot::Sender<Result<Option<B16>, String>>,
    ),
    PrivateSigners(AccountKeyGuard, oneshot::Sender<Vec<B16>>),
    ModeGeneration(
        AccountKeyGuard,
        oneshot::Sender<Option<mdbn_wire::common::B32>>,
    ),
    ModeSource {
        private: bool,
        receipt: bool,
        current: AccountKeyGuard,
        reply: oneshot::Sender<Option<(u64, mdbn_replica::store::Head, Vec<B16>)>>,
    },
    Readiness(oneshot::Sender<ReadinessView>),
    /// Rescan, then list the confirmed records and resources.
    Inventory(oneshot::Sender<Option<Inventory>>),
    /// Stop admitting writes, settle, take the inventory and hold counts, stop.
    Freeze(oneshot::Sender<Result<Frozen, Option<crate::sync_failure::Failure>>>),
    #[cfg(test)]
    TestSeedHold(
        Box<Option<mdbn_wire::client::Hold>>,
        oneshot::Sender<Option<TestHoldWitness>>,
    ),
    /// A content-free digest of the confirmed records.
    Digest(oneshot::Sender<Option<(u64, [u8; 32])>>),
    /// Counters and digests from ONE serialized actor observation.
    Telemetry(oneshot::Sender<(crate::control::SyncCounters, Vec<crate::control::Notice>)>),
    PendingIngestPaths(oneshot::Sender<Vec<String>>),
    /// Produce an applied strict witness on the serialized replica actor.
    StrictWitness {
        account: B16,
        recovery: B16,
        version: u64,
        revoked_at: u64,
        reply: oneshot::Sender<Option<mdbn_replica::replica::StrictWitness>>,
    },
    /// The folder watcher has a batch of events.
    FsWake,
    /// AK1: an account-key operation on this private collection.
    AccountKey(
        AccountKeyOp,
        Option<AccountKeyGuard>,
        oneshot::Sender<Result<bool, mdbn_replica::replica::AccountKeyRefusal>>,
    ),
    /// App grant approval on this collection (`policy.md` §5.1).
    GrantApproval(GrantApprovalOp, oneshot::Sender<GrantApprovalReply>),
    /// Second-computer approval on this private collection (§8.3).
    DeviceApproval(
        DeviceApprovalOp,
        oneshot::Sender<Result<DeviceApprovalReply, Box<mdbn_wire::client::Problem>>>,
    ),
}

/// A grant-approval operation for the runtime thread.
pub enum GrantApprovalOp {
    /// Grants waiting for this device's approval.
    Pending,
    /// Queue this device's approval with the terms the user kept.
    Approve {
        /// Log grant ID.
        grant: B16,
        /// Capability groups kept.
        capabilities: Vec<String>,
        /// Folder scope kept.
        folders: Option<Vec<String>>,
    },
    /// What the replica knows about one grant's approval.
    State(B16),
    /// Whether the grant currently authorizes sessions under log policy.
    Effective(B16),
}

/// A grant-approval operation's answer.
pub enum GrantApprovalReply {
    /// Pending grants.
    Pending(Vec<mdbn_replica::api::PendingGrant>),
    /// Queued, or the refusal reason.
    Approve(Result<(), String>),
    /// Approval state.
    State(Option<mdbn_replica::api::GrantApprovalState>),
    /// Effective under log policy.
    Effective(bool),
}

/// AK1 account-key operations (account-key bundle design).
/// Each carries the account secret `R`; the runtime derives this collection's
/// recovery device and drops the keys after use.
pub enum AccountKeyOp {
    /// Whether the account-key device is enrolled (exactly as derived) and keyed.
    Status(mdbn_replica::crypto::recovery::RecoveryKey),
    /// Setup: key the enrolled account-key device.
    Key(mdbn_replica::crypto::recovery::RecoveryKey),
    /// Unlock: key this device from the account key (installs locally; the
    /// self-grant is appended once caught up).
    Unlock(mdbn_replica::crypto::recovery::RecoveryKey),
    /// Whether this device is keyed in the applied policy and trusts its key.
    Unlocked,
    /// Whether this device may key the account-key device now (a keyed editor
    /// device with no rekey outstanding). Read-only.
    CanKey,
    /// Strict mode: whether this revoked account-key device is inactive and the
    /// revocation was rekeyed (false while not yet applied).
    RevokedAndRekeyed(B16),
}

/// Native-only switch operations; no app frame or caller-selected trust facts.
#[derive(Clone, Copy)]
pub enum PrivateSwitchOp {
    /// Persist the owner's intent before its control-plane request.
    Request,
    /// Cancel only before the switch policy has committed.
    Cancel,
    /// Read owner eligibility before persisting the host's Cloud choice.
    CloudCandidate,
    /// Persist the user's explicit Cloud copy choice before publication.
    ChooseCloud,
    /// Resume explicit source choice only in its original Private generation.
    ChooseCloudAt(mdbn_wire::common::B32),
    /// Cancel source permission only while native policy still proves Private.
    CancelCloud,
    /// Read a committed receiver-only Cloud selection; never source consent.
    CloudRead,
    /// Read-only current selection, never source consent.
    CloudSelected,
    /// Read a verified, durably applied private-mode choice.
    Accepted,
    /// Host link and registration durably contain the verified choice.
    Acknowledge,
}

/// Native custody authority, re-evaluated on the serialized actor before use.
/// Constructed from the real account incarnation/keychain, never a wire claim.
pub(crate) type AccountKeyGuard = Arc<dyn Fn() -> bool + Send + Sync>;

pub(super) fn account_key_allowed(op: &AccountKeyOp, guard: Option<&AccountKeyGuard>) -> bool {
    match guard {
        Some(current) => current(),
        // Keying a recovery device always requires current native custody.
        None => !matches!(op, AccountKeyOp::Key(_)),
    }
}

/// The lease a runtime's local grants run under, published by the daemon from
/// its access list. The runtime only uses it to wake and close sessions on time;
/// whether a grant is live is decided by its [`AuthoritySource`].
pub type LocalGrants = Arc<std::sync::RwLock<LocalGrantSet>>;

/// One collection's lease, wall-clock and monotonic.
#[derive(Debug, Clone, Default)]
pub struct LocalGrantSet {
    /// Lease expiry (ms).
    pub lease_expires_ms: u64,
    /// Monotonic lease deadline.
    pub lease_deadline: Option<std::time::Instant>,
}

/// The replica's [`mdbn_replica::policy::GrantSource`] for one collection: the
/// daemon's [`crate::authority::CollectionAuthority`], pinned to the account epoch
/// it was made under (it denies everything once that epoch ends).
pub struct AuthoritySource(pub crate::authority::CollectionAuthority);

impl mdbn_replica::policy::GrantSource for AuthoritySource {
    fn grant(
        &self,
        grant: &B16,
    ) -> mdbn_replica::api::ApiResult<mdbn_replica::policy::EffectiveGrant> {
        self.0.grant(grant)
    }

    fn declared_setup(
        &self,
        grant: &B16,
    ) -> Option<mdbn_replica::policy::DeclaredSetupAuthorization> {
        self.0.declared_setup(grant)
    }

    fn owner_identity(&self) -> Option<mdbn_replica::policy::LocalOwnerIdentity> {
        let o = self.0.owner_identity()?;
        Some(mdbn_replica::policy::LocalOwnerIdentity {
            account: o.account,
            collection: o.collection,
            device: o.device,
        })
    }

    fn active_account(&self) -> Option<B16> {
        self.0.active_account()
    }

    fn authority_epoch(&self) -> Option<u64> {
        self.0.authority_epoch()
    }

    fn device_noise_pk(&self) -> Option<mdbn_wire::common::B32> {
        self.0.device_noise_pk()
    }
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn account_key_effect_requires_live_guard_not_a_queued_authorization() {
        use std::sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        };
        let live = Arc::new(AtomicBool::new(true));
        let current = live.clone();
        let guard: super::AccountKeyGuard = Arc::new(move || current.load(Ordering::SeqCst));
        let key = super::AccountKeyOp::Key(
            mdbn_replica::crypto::recovery::RecoveryKey::from_bytes([61; 32]),
        );
        assert!(!super::account_key_allowed(&key, None));
        assert!(super::account_key_allowed(&key, Some(&guard)));
        tokio::task::yield_now().await;
        live.store(false, Ordering::SeqCst);
        assert!(!super::account_key_allowed(&key, Some(&guard)));
        assert!(!super::account_key_allowed(
            &super::AccountKeyOp::CanKey,
            Some(&guard)
        ));
        assert!(super::account_key_allowed(
            &super::AccountKeyOp::CanKey,
            None
        ));
    }
}
