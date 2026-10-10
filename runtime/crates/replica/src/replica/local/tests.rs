//! Synthetic trusted-host fixtures: NOT daemon pairing/persistence acceptance.
use super::*;
use crate::api::{ClientApi, SessionAuth, SessionId};
use crate::mem::MemStore;
use crate::policy::{EffectiveGrant, GrantSource, LocalOwnerIdentity, capability};
use crate::replica::{DeviceSecrets, Host, ReplicaConfig, UtcOnly};
use crate::seal::PlainSealer;
use mdbn_core::host::Clock;
use mdbn_wire::client::HelloParams;
use mdbn_wire::common::{B16, B32};
use mdbn_wire::intent::{Create, Source};
use mdbn_wire::policy::Role;
use std::cell::Cell;
use std::collections::BTreeMap;
use std::rc::Rc;

const COL: Uuid = B16([31; 16]);
const REP: Uuid = B16([32; 16]);
const DEV: Uuid = B16([33; 16]);
const ACCOUNT: Uuid = B16([34; 16]);
const GRANT: Uuid = B16([35; 16]);
const KEY: [u8; 32] = [36; 32];

#[derive(Clone)]
struct Access {
    owner: Rc<Cell<Option<LocalOwnerIdentity>>>,
    active: Rc<Cell<Option<Uuid>>>,
    grants: Rc<RefCell<BTreeMap<Uuid, EffectiveGrant>>>,
    now: Rc<Cell<i64>>,
    deadline: Rc<Cell<i64>>,
}
impl Access {
    fn valid() -> Self {
        Self {
            owner: Rc::new(Cell::new(Some(LocalOwnerIdentity {
                account: ACCOUNT,
                collection: COL,
                device: DEV,
            }))),
            active: Rc::new(Cell::new(Some(ACCOUNT))),
            grants: Rc::new(RefCell::new(BTreeMap::from([(
                GRANT,
                EffectiveGrant {
                    account: ACCOUNT,
                    role: Role::Editor,
                    capabilities: [capability::READ, capability::CREATE]
                        .into_iter()
                        .map(str::to_owned)
                        .collect(),
                    file_folders: None,
                    client_pk: B32(KEY),
                },
            )]))),
            now: Rc::new(Cell::new(100)),
            deadline: Rc::new(Cell::new(1000)),
        }
    }
}
impl GrantSource for Access {
    fn grant(&self, id: &Uuid) -> Option<EffectiveGrant> {
        if self.now.get() >= self.deadline.get() {
            return None;
        }
        self.grants.borrow().get(id).cloned()
    }
    fn owner_identity(&self) -> Option<LocalOwnerIdentity> {
        self.owner.get()
    }
    fn active_account(&self) -> Option<Uuid> {
        self.active.get()
    }
}
struct Now(Rc<Cell<i64>>);
impl Clock for Now {
    fn now_ms(&self) -> u64 {
        u64::try_from(self.0.get()).unwrap_or(0)
    }
}
fn config(mode: SyncMode) -> ReplicaConfig {
    ReplicaConfig {
        collection: COL,
        replica_id: REP,
        device_id: DEV,
        mode,
        log_endpoint: crate::log::EndpointId(1),
        verify: false,
        runtime_version: "test".into(),
        trusted_roots: vec![],
        trusted_signers: vec![],
        e2e: false,
        user_enabled_cloud_copy: false,
        chosen_state: None,
        key_grants_only: false,
        expected_genesis: None,
        policy_pins: None,
    }
}
fn open(store: MemStore, access: Option<Access>) -> Replica<MemStore> {
    let host = Host {
        clock: Box::new(Now(Rc::new(Cell::new(100)))),
        entropy: Box::new(crate::crypto::TestEntropy::new(9)),
        zones: Box::new(UtcOnly),
    };
    let cfg = config(SyncMode::LocalOnly);
    let secrets = DeviceSecrets {
        sign_sk: [1; 32],
        kem_sk: [2; 32],
    };
    match access {
        Some(access) => Replica::open_with_grant_source(
            cfg,
            store,
            Box::new(crate::plan::CorePlanner),
            Box::new(PlainSealer::for_device(DEV)),
            host,
            secrets,
            Box::new(access),
        ),
        None => Replica::open(
            cfg,
            store,
            Box::new(crate::plan::CorePlanner),
            Box::new(PlainSealer::for_device(DEV)),
            host,
            secrets,
        ),
    }
    .unwrap()
}
fn hello(r: &mut Replica<MemStore>, auth: SessionAuth) -> crate::api::ApiResult<SessionId> {
    r.hello(
        auth,
        HelloParams {
            versions: vec![Version { major: 1, minor: 0 }],
            client_name: "fixture".into(),
            client_version: "0".into(),
            features: None,
            timezone: None,
        },
    )
    .map(|(id, _)| id)
}
fn app(r: &mut Replica<MemStore>) -> crate::api::ApiResult<SessionId> {
    hello(
        r,
        SessionAuth::Grant {
            grant: GRANT,
            client_pk: KEY,
        },
    )
}
fn pending(r: &mut Replica<MemStore>, granted: bool) -> Uuid {
    let mut mutation = r.capture(
        vec![Op::Create(Create {
            id: B16([40; 16]),
            path: Some("new.md".into()),
            type_name: None,
            frontmatter: None,
            body: None,
            document: Some(Text::Inline("payload".into())),
        })],
        Source::Api,
    );
    mutation.on_behalf = granted.then_some(GRANT);
    let id = mutation.id;
    r.store_mut()
        .commit(Tx {
            pending_put: vec![PendingRow {
                order: 1,
                mutation: mutation.into(),
                effects: vec![],
                touches: vec![],
                grant: granted.then_some(GRANT),
                uploads: vec![],
                refs: Vec::new(),
            }],
            ..Tx::default()
        })
        .unwrap();
    id
}

#[test]
fn hello_advertises_role_effective_caps_and_old_snapshot_cannot_authorize() {
    let access = Access::valid();
    let mut r = open(MemStore::new(), Some(access.clone()));
    let connect = |r: &mut Replica<MemStore>| {
        r.hello(
            SessionAuth::Grant {
                grant: GRANT,
                client_pk: KEY,
            },
            HelloParams {
                versions: vec![Version { major: 1, minor: 0 }],
                client_name: "fixture".into(),
                client_version: "0".into(),
                features: None,
                timezone: None,
            },
        )
        .unwrap()
    };
    let (old_session, editor) = connect(&mut r);
    assert!(
        editor
            .grant
            .capabilities
            .contains(&capability::CREATE.to_owned())
    );
    access.grants.borrow_mut().get_mut(&GRANT).unwrap().role = Role::Viewer;
    let (_, viewer) = connect(&mut r);
    assert_eq!(viewer.grant.role, Role::Viewer);
    assert_eq!(viewer.grant.capabilities, vec![capability::READ.to_owned()]);
    assert!(r.require(old_session, capability::READ).is_ok());
    assert!(r.require(old_session, capability::CREATE).is_err());
    assert!(
        editor
            .grant
            .capabilities
            .contains(&capability::CREATE.to_owned()),
        "the old hello is an immutable snapshot, not fresh authority"
    );
}

#[test]
fn hello_denies_a_viewer_with_only_declared_write_capabilities() {
    let access = Access::valid();
    {
        let mut grants = access.grants.borrow_mut();
        let grant = grants.get_mut(&GRANT).unwrap();
        grant.role = Role::Viewer;
        grant.capabilities.remove(capability::READ);
    }
    let mut r = open(MemStore::new(), Some(access));
    assert!(
        app(&mut r).is_err(),
        "the role-effective grant allows nothing"
    );
}

#[test]
fn missing_zero_cross_account_collection_device_and_key_deny() {
    let access = Access::valid();
    let mut r = open(MemStore::new(), None);
    assert!(app(&mut r).is_err());
    assert!(
        hello(&mut r, SessionAuth::Host).is_ok(),
        "Host is not an app fallback"
    );
    r.set_grant_source(Box::new(access.clone()));
    let owner = access.owner.get().unwrap();
    for invalid in [
        None,
        Some(LocalOwnerIdentity {
            account: B16([0; 16]),
            ..owner
        }),
        Some(LocalOwnerIdentity {
            account: B16([99; 16]),
            ..owner
        }),
        Some(LocalOwnerIdentity {
            collection: B16([99; 16]),
            ..owner
        }),
        Some(LocalOwnerIdentity {
            device: B16([99; 16]),
            ..owner
        }),
    ] {
        access.owner.set(invalid);
        assert!(app(&mut r).is_err(), "invalid identity {invalid:?}");
    }
    access.owner.set(Some(owner));
    access.active.set(None);
    assert!(app(&mut r).is_err());
    access.active.set(Some(B16([99; 16])));
    assert!(app(&mut r).is_err());
    access.active.set(Some(ACCOUNT));
    access.grants.borrow_mut().get_mut(&GRANT).unwrap().account = B16([0; 16]);
    assert!(
        app(&mut r).is_err(),
        "SERVICE_ACCOUNT never grants authority"
    );
    access.grants.borrow_mut().get_mut(&GRANT).unwrap().account = ACCOUNT;
    assert!(
        hello(
            &mut r,
            SessionAuth::Grant {
                grant: GRANT,
                client_pk: [99; 32]
            }
        )
        .is_err()
    );
    assert!(app(&mut r).is_ok());
}

#[test]
fn account_change_rechecks_calls_and_purges_already_queued_plaintext() {
    let access = Access::valid();
    let mut r = open(MemStore::new(), Some(access.clone()));
    let session = app(&mut r).unwrap();
    r.pushes.push((session, Push::Holds(vec![])));
    access.active.set(Some(B16([99; 16])));
    assert!(
        r.describe(session).is_err(),
        "every call rechecks without host notification"
    );
    let pushes = r.take_pushes();
    assert!(
        pushes
            .iter()
            .any(|(id, p)| *id == session && matches!(p, Push::Closed(_)))
    );
    assert!(pushes.iter().all(|(_, p)| matches!(p, Push::Closed(_))));
    assert!(!r.sessions.contains_key(&session));
}

#[test]
fn lease_expiry_rechecks_calls_and_live_output_without_notification() {
    let access = Access::valid();
    let mut r = open(MemStore::new(), Some(access.clone()));
    let session = app(&mut r).unwrap();
    r.pushes.push((session, Push::Conflicts(vec![])));
    access.now.set(access.deadline.get());
    assert!(r.describe(session).is_err());
    assert!(
        r.take_pushes()
            .iter()
            .all(|(_, p)| matches!(p, Push::Closed(_)))
    );
    assert!(!r.sessions.contains_key(&session));
}

#[test]
fn identity_replacement_closes_same_grant_id_and_local_role_caps() {
    let access = Access::valid();
    let mut r = open(MemStore::new(), Some(access.clone()));
    let session = app(&mut r).unwrap();
    let replacement = Access::valid();
    replacement.owner.set(None);
    r.set_grant_source(Box::new(replacement));
    assert!(!r.sessions.contains_key(&session));
    r.set_grant_source(Box::new(access.clone()));
    access.grants.borrow_mut().get_mut(&GRANT).unwrap().role = Role::Viewer;
    let mutation = pending(&mut r, true);
    r.pump();
    assert_eq!(
        r.store().local_receipt(&mutation).unwrap().unwrap().state,
        ReceiptState::Rejected
    );
    assert!(r.store().record(&B16([40; 16])).unwrap().is_none());
}

#[test]
fn source_state_is_consulted_only_in_local_mode() {
    let access = Access::valid();
    let mut r = open(MemStore::new(), Some(access.clone()));
    assert!(r.serving_account_matches(&ACCOUNT));
    assert_eq!(r.authorize(ACCOUNT, COL), Some(Role::Owner));
    assert_eq!(r.authorize(ACCOUNT, B16([99; 16])), None);
    r.cfg.mode = SyncMode::Synced;
    r.policy.members.insert(ACCOUNT, Role::Editor);
    r.policy.owner = Some(B16([99; 16]));
    assert_eq!(
        r.authorize(ACCOUNT, COL),
        Some(Role::Editor),
        "creator/owner is not special in synced authority"
    );
    r.policy.members.insert(ACCOUNT, Role::Viewer);
    assert_eq!(
        r.authorize(ACCOUNT, COL),
        Some(Role::Viewer),
        "current role downgrade is immediate"
    );
    assert!(
        r.grant_now(&GRANT).is_none(),
        "synced uses signed policy, not local grants"
    );
    assert!(
        !r.serving_account_matches(&ACCOUNT),
        "local ownership cannot invent policy membership"
    );
    access.owner.set(None);
    access.active.set(None);
    assert!(r.grant_now(&GRANT).is_none());
    assert!(!r.serving_account_matches(&ACCOUNT));
    assert_eq!(
        r.authorize(ACCOUNT, COL),
        Some(Role::Viewer),
        "synced ignores stale local identity metadata"
    );
    r.policy.members.remove(&ACCOUNT);
    assert_eq!(
        r.authorize(ACCOUNT, COL),
        None,
        "membership loss denies immediately"
    );
    // This is authority-selector separation, NOT a conversion-commit fixture.
}

#[test]
fn reopen_validates_account_before_any_pending_replan_or_materialization() {
    let access = Access::valid();
    let mut r = open(MemStore::new(), Some(access.clone()));
    let mutation = pending(&mut r, true);
    let reopened = open(r.into_store(), Some(access));
    assert_eq!(
        reopened
            .store()
            .local_receipt(&mutation)
            .unwrap()
            .unwrap()
            .state,
        ReceiptState::Confirmed
    );
    assert_eq!(
        reopened
            .store()
            .record(&B16([40; 16]))
            .unwrap()
            .unwrap()
            .doc,
        "payload"
    );
    let mut r = open(MemStore::new(), Some(Access::valid()));
    let mutation = pending(&mut r, true);
    let reopened = open(r.into_store(), None);
    assert_eq!(
        reopened
            .store()
            .local_receipt(&mutation)
            .unwrap()
            .unwrap()
            .state,
        ReceiptState::Rejected
    );
    assert!(reopened.store().pending_get(&mutation).unwrap().is_none());
    assert!(reopened.store().record(&B16([40; 16])).unwrap().is_none());
}

#[test]
fn reopen_expired_revoked_or_changed_account_denies_persisted_app_rows() {
    for case in 0..3 {
        let access = Access::valid();
        let mut r = open(MemStore::new(), Some(access.clone()));
        let mutation = pending(&mut r, true);
        match case {
            0 => access.now.set(1000),
            1 => access.grants.borrow_mut().clear(),
            _ => access.active.set(Some(B16([99; 16]))),
        }
        let reopened = open(r.into_store(), Some(access));
        assert_eq!(
            reopened
                .store()
                .local_receipt(&mutation)
                .unwrap()
                .unwrap()
                .state,
            ReceiptState::Rejected
        );
        assert!(reopened.store().pending_get(&mutation).unwrap().is_none());
        assert!(reopened.store().record(&B16([40; 16])).unwrap().is_none());
    }
}

#[test]
fn grant_on_behalf_mismatch_is_rejected_not_host_authorized() {
    let access = Access::valid();
    let mut r = open(MemStore::new(), Some(access));
    let mutation = pending(&mut r, true);
    let mut row = r.store().pending_get(&mutation).unwrap().unwrap();
    row.grant = None;
    r.store_mut()
        .commit(Tx {
            pending_put: vec![row],
            ..Tx::default()
        })
        .unwrap();
    r.pump();
    assert_eq!(
        r.store().local_receipt(&mutation).unwrap().unwrap().state,
        ReceiptState::Rejected
    );
    assert!(r.store().record(&B16([40; 16])).unwrap().is_none());
}

#[test]
fn typed_abort_preserves_pending_and_retries_verified_local_commit() {
    let mut r = open(MemStore::new(), None);
    let session = hello(&mut r, SessionAuth::Host).unwrap();
    let mutation = pending(&mut r, false);
    let head = r.head();
    r.store().fail_commits(1);
    r.pump();
    assert!(!r.requires_reopen());
    assert!(r.is_apply_recovering());
    assert_eq!(r.head(), head);
    assert!(r.store().pending_get(&mutation).unwrap().is_some());
    assert!(r.store().record(&B16([40; 16])).unwrap().is_none());
    assert!(r.describe(session).is_err());
    assert!(r.observe(None).is_err());
    assert!(
        r.take_pushes()
            .iter()
            .all(|(_, p)| matches!(p, Push::Closed(_)))
    );
    r.tick();
    assert!(!r.requires_reopen());
    assert!(!r.is_apply_recovering());
    assert!(r.store().pending_get(&mutation).unwrap().is_none());
    assert_eq!(
        r.store().local_receipt(&mutation).unwrap().unwrap().state,
        ReceiptState::Confirmed
    );
    assert!(crate::log::LogPort::take_log_calls(&mut r).is_empty());
}

#[test]
fn unknown_local_outcome_is_terminal_no_tick_observe_or_new_store_commit() {
    for after in [false, true] {
        let mut r = open(MemStore::new(), None);
        let session = hello(&mut r, SessionAuth::Host).unwrap();
        let mutation = pending(&mut r, false);
        if after {
            r.store().fail_after_commit(1);
        } else {
            r.store().fail_unknown_commits(1);
        }
        r.pump();
        assert!(r.requires_reopen());
        let commits = r.store().data().borrow().commits;
        assert!(r.describe(session).is_err());
        assert!(r.observe(None).is_err());
        r.tick();
        r.pump();
        assert_eq!(r.store().data().borrow().commits, commits);
        assert!(
            r.take_pushes()
                .iter()
                .all(|(_, p)| matches!(p, Push::Closed(_)))
        );
        assert!(crate::log::LogPort::take_log_calls(&mut r).is_empty());
        let reopened = open(r.into_store(), None);
        assert!(!reopened.requires_reopen());
        assert!(reopened.store().pending_get(&mutation).unwrap().is_none());
        assert_eq!(
            reopened
                .store()
                .record(&B16([40; 16]))
                .unwrap()
                .unwrap()
                .doc,
            "payload"
        );
    }
}

#[test]
fn void_rejection_is_atomic_with_pending_removal_and_never_confirmed() {
    let mut r = open(MemStore::new(), None);
    let mutation = pending(&mut r, false);
    let row = r.store().pending_get(&mutation).unwrap().unwrap();
    let payload = EntryPayload {
        resurrect: None,
        mutation: crate::replica::attachment_runtime::legacy_mutation(row.mutation).unwrap(),
        sem: Version { major: 1, minor: 0 },
        status: mdbn_wire::entry::Status::Applied,
        effects: vec![],
        conflicts: None,
        aliases: None,
        texts: None,
    };
    let head = Head {
        seq: 1,
        chain: mdbn_wire::hash::CHAIN_ZERO,
    };
    r.store().fail_commits(1);
    assert!(
        r.commit_local_void(head, &payload.clone().into(), "fixture V7")
            .is_err()
    );
    assert!(r.store().pending_get(&mutation).unwrap().is_some());
    assert!(r.store().local_receipt(&mutation).unwrap().is_none());
    r.commit_local_void(head, &payload.clone().into(), "fixture V7")
        .unwrap();
    assert!(r.store().pending_get(&mutation).unwrap().is_none());
    assert_eq!(
        r.store().local_receipt(&mutation).unwrap().unwrap().state,
        ReceiptState::Rejected
    );
    assert_eq!(r.store().head().unwrap(), head);
}

#[test]
fn existing_local_backlog_drains_all_pages_in_one_pump() {
    let mut r = open(MemStore::new(), None);
    let mut rows = Vec::new();
    for i in 0..193u64 {
        let mut bytes = [0; 16];
        bytes[..8].copy_from_slice(&i.to_be_bytes());
        let mutation = r.capture(
            vec![Op::Create(Create {
                id: B16(bytes),
                path: Some(format!("pending-{i}.md")),
                type_name: None,
                frontmatter: None,
                body: None,
                document: Some(Text::Inline("old pending".into())),
            })],
            Source::Api,
        );
        rows.push(PendingRow {
            order: i + 1,
            mutation: mutation.into(),
            effects: vec![],
            touches: vec![],
            grant: None,
            uploads: vec![],
            refs: Vec::new(),
        });
    }
    r.store_mut()
        .commit(Tx {
            pending_put: rows,
            ..Tx::default()
        })
        .unwrap();
    r.pump();
    assert_eq!(r.store().pending_count().unwrap(), 0);
    assert_eq!(r.store().record_count().unwrap(), 193);
    assert_eq!(r.head().seq, 193);
    assert!(!r.requires_reopen());
}

struct ExpiringPlanner(Access);
impl crate::plan::Planner for ExpiringPlanner {
    fn plan(
        &self,
        mutation: &mdbn_core::intent::Mutation,
        state: &dyn mdbn_core::state::StateView,
        options: &PlanOptions,
    ) -> Result<mdbn_core::plan::Planned, mdbn_core::plan::Rejection> {
        let result = mdbn_core::plan(mutation, state, options);
        self.0.now.set(self.0.deadline.get());
        result
    }
}

#[test]
fn lease_expiring_during_planning_is_rechecked_at_commit_boundary() {
    let access = Access::valid();
    let mut r = open(MemStore::new(), Some(access.clone()));
    let mutation = pending(&mut r, true);
    r.planner = Box::new(ExpiringPlanner(access));
    r.pump();
    assert_eq!(
        r.store().local_receipt(&mutation).unwrap().unwrap().state,
        ReceiptState::Rejected
    );
    assert!(r.store().record(&B16([40; 16])).unwrap().is_none());
    assert!(r.store().pending_get(&mutation).unwrap().is_none());
}

struct VoidPlanner;
impl crate::plan::Planner for VoidPlanner {
    fn plan(
        &self,
        mutation: &mdbn_core::intent::Mutation,
        state: &dyn mdbn_core::state::StateView,
        options: &PlanOptions,
    ) -> Result<mdbn_core::plan::Planned, mdbn_core::plan::Rejection> {
        let mut plan = mdbn_core::plan(mutation, state, options)?;
        plan.status = mdbn_core::plan::Status::Conflicted;
        plan.conflicts.clear(); // Deliberate V7-invalid planner fixture.
        Ok(plan)
    }
}

#[test]
fn invalid_local_payload_full_path_rejects_atomically_after_verified_retry() {
    let mut r = open(MemStore::new(), None);
    r.planner = Box::new(VoidPlanner);
    let mutation = pending(&mut r, false);
    let head = r.head();
    let policy = r.policy.clone();
    r.store().fail_commits(1);
    r.pump();
    assert!(!r.requires_reopen());
    assert!(r.is_apply_recovering());
    assert_eq!(r.policy, policy);
    assert_eq!(r.head(), head);
    assert!(r.store().pending_get(&mutation).unwrap().is_some());
    assert!(r.store().local_receipt(&mutation).unwrap().is_none());
    r.tick();
    assert!(!r.is_apply_recovering());
    assert!(r.store().pending_get(&mutation).unwrap().is_none());
    assert_eq!(
        r.store().local_receipt(&mutation).unwrap().unwrap().state,
        ReceiptState::Rejected
    );
    assert!(r.store().record(&B16([40; 16])).unwrap().is_none());
    assert!(r.take_pushes().iter().all(
        |(_, p)| !matches!(p, Push::Receipt(receipt) if receipt.state == ReceiptState::Confirmed)
    ));
}

struct FaultSealer {
    inner: PlainSealer,
    opaque: bool,
    bad_import: bool,
}
impl crate::seal::Sealer for FaultSealer {
    fn set_epoch(&mut self, e: u64) {
        self.inner.set_epoch(e);
    }
    fn current_epoch(&self) -> Option<u64> {
        self.inner.current_epoch()
    }
    fn idem_token(&self, m: &Uuid) -> Option<B16> {
        self.inner.idem_token(m)
    }
    fn seal(
        &mut self,
        item: &mut mdbn_wire::envelope::Item,
        plain: &[u8],
        compress: bool,
        entropy: &mut dyn crate::crypto::CsprngEntropy,
    ) -> Result<(), crate::seal::SealError> {
        self.inner.seal(item, plain, compress, entropy)
    }
    fn seal_object(
        &mut self,
        item: &mut mdbn_wire::envelope::Item,
        plain: &[u8],
        compress: bool,
        sign: bool,
        entropy: &mut dyn crate::crypto::CsprngEntropy,
    ) -> Result<(), crate::seal::SealError> {
        self.inner.seal_object(item, plain, compress, sign, entropy)
    }
    fn blob_part_addresses(&self, blob: &mdbn_wire::intent::BlobRef) -> Option<Vec<B32>> {
        self.inner.blob_part_addresses(blob)
    }
    fn sign(&self, item: &mut mdbn_wire::envelope::Item) -> Result<(), crate::seal::SealError> {
        self.inner.sign(item)
    }
    fn open(
        &self,
        item: &mdbn_wire::envelope::Item,
        raw: &[u8],
    ) -> Result<Vec<u8>, crate::seal::OpenError> {
        self.inner.open(item, raw)
    }
    fn verifier(&self) -> &dyn crate::policy::SigVerifier {
        self.inner.verifier()
    }
    fn accept_rekey(&mut self, p: &mdbn_wire::envelope::RekeyPayload) -> crate::seal::KeyEvent {
        self.inner.accept_rekey(p)
    }
    fn accept_key_grant(
        &mut self,
        p: &mdbn_wire::envelope::KeyGrantPayload,
    ) -> crate::seal::KeyEvent {
        self.inner.accept_key_grant(p)
    }
    fn build_rekey(
        &mut self,
        from: u64,
        recipients: &[crate::crypto::keys::Recipient],
        reason: mdbn_wire::envelope::RekeyReason,
        entropy: &mut dyn crate::crypto::CsprngEntropy,
    ) -> Result<mdbn_wire::envelope::RekeyPayload, crate::seal::SealError> {
        self.inner.build_rekey(from, recipients, reason, entropy)
    }
    fn export(&self) -> Option<zeroize::Zeroizing<Vec<u8>>> {
        if self.opaque {
            None
        } else {
            self.inner.export()
        }
    }
    fn import(&mut self, bytes: &[u8]) -> Result<(), crate::seal::SealError> {
        if self.bad_import {
            Err(crate::seal::SealError::Failed(
                "injected import failure".into(),
            ))
        } else {
            self.inner.import(bytes)
        }
    }
}

#[test]
fn opaque_export_or_failed_import_turns_known_abort_into_terminal_local_fault() {
    for opaque in [true, false] {
        let mut r = open(MemStore::new(), None);
        let mutation = pending(&mut r, false);
        r.sealer = Box::new(FaultSealer {
            inner: PlainSealer::for_device(DEV),
            opaque,
            bad_import: !opaque,
        });
        r.store().fail_commits(1);
        r.pump();
        assert!(r.requires_reopen());
        let commits = r.store().data().borrow().commits;
        r.tick();
        assert!(r.observe(None).is_err());
        assert_eq!(r.store().data().borrow().commits, commits);
        assert!(r.store().pending_get(&mutation).unwrap().is_some());
        assert!(r.store().record(&B16([40; 16])).unwrap().is_none());
        assert!(
            r.take_pushes()
                .iter()
                .all(|(_, p)| matches!(p, Push::Closed(_)))
        );
        let reopened = open(r.into_store(), None);
        assert!(!reopened.requires_reopen());
        assert!(reopened.store().record(&B16([40; 16])).unwrap().is_some());
    }
}

/// Local-only ignores the genesis pin: there is no log, and a local store opens,
/// commits and reopens as before.
#[test]
fn local_only_is_unchanged_by_a_genesis_pin() {
    let pinned = || {
        let mut cfg = config(SyncMode::LocalOnly);
        cfg.expected_genesis = Some(mdbn_wire::common::B32([7; 32]));
        cfg
    };
    let open_pinned = |store: MemStore| {
        Replica::open(
            pinned(),
            store,
            Box::new(crate::plan::CorePlanner),
            Box::new(PlainSealer::for_device(DEV)),
            Host {
                clock: Box::new(Now(Rc::new(Cell::new(100)))),
                entropy: Box::new(crate::crypto::TestEntropy::new(9)),
                zones: Box::new(UtcOnly),
            },
            DeviceSecrets {
                sign_sk: [1; 32],
                kem_sk: [2; 32],
            },
        )
        .unwrap()
    };
    let mut r = open_pinned(MemStore::new());
    pending(&mut r, false);
    r.pump();
    assert_eq!(r.store().record_count().unwrap(), 1);
    assert!(!r.requires_reopen());
    let mut r = open_pinned(r.into_store());
    assert!(hello(&mut r, SessionAuth::Host).is_ok());
    assert_eq!(r.store().record_count().unwrap(), 1);
}
