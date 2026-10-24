//! Synthetic live-feed authority with real signed policy, keyed sealer and Core
//! capture/session engine. Not a Native transport or durability qualification.
use super::capture::setup;
use super::*;
use crate::Store;
use crate::policy::{DeclaredSetupAuthorization, EffectiveGrant, GrantSource};
use std::{cell::RefCell, rc::Rc};

pub(super) const GRANT: B16 = B16([0x61; 16]);
pub(super) const CLIENT: B32 = B32([0x62; 32]);
const CAPS: [&str; 3] = ["collection.read", "records.create", "records.edit"];
struct Source(Rc<RefCell<Option<DeclaredSetupAuthorization>>>);
impl GrantSource for Source {
    fn grant(&self, _: &B16) -> Option<EffectiveGrant> {
        None
    }
    fn declared_setup(&self, grant: &B16) -> Option<DeclaredSetupAuthorization> {
        (*grant == GRANT).then(|| self.0.borrow().clone()).flatten()
    }
    fn active_account(&self) -> Option<B16> {
        Some(crate::testkit::TEST_OWNER)
    }
    fn authority_epoch(&self) -> Option<u64> {
        self.0.borrow().as_ref().map(|a| a.authority_epoch)
    }
    fn device_noise_pk(&self) -> Option<B32> {
        Some(B32([0; 32]))
    }
}
pub(super) fn declared_node() -> (
    FakeLogService,
    Node,
    Rc<RefCell<Option<DeclaredSetupAuthorization>>>,
) {
    declared_node_with_caps(&CAPS)
}
pub(super) fn declared_node_with_caps(
    caps: &[&str],
) -> (
    FakeLogService,
    Node,
    Rc<RefCell<Option<DeclaredSetupAuthorization>>>,
) {
    let svc = FakeLogService::new();
    let device = B16([101; 16]);
    let mut cp = crate::testkit::TestControlPlane::signed(COL);
    cp.genesis_with_keys(&svc, CState::E2e, device, &[0x31; 32], &[0x32; 32]);
    cp.append(
        &svc,
        vec![mdbn_wire::policy::PolicyOp::Grant(
            mdbn_wire::policy::Grant {
                grant: GRANT,
                installation: B16([0x63; 16]),
                app_id: "app.tasks".into(),
                account: crate::testkit::TEST_OWNER,
                capabilities: caps.iter().map(|c| (*c).into()).collect(),
                client_pk: CLIENT,
                file_folders: None,
                folder_scoped: None,
            },
        )],
    );
    let mut a = node_with(
        &svc,
        1,
        MemStore::new(),
        vec![],
        Some(Box::new(KeyringSealer::new(
            COL,
            device,
            &[0x31; 32],
            &[0x32; 32],
        ))),
    );
    a.r.secrets.sign_sk = [0x31; 32];
    a.r.planner = Box::new(crate::plan::CorePlanner);
    let source = Rc::new(RefCell::new(Some(DeclaredSetupAuthorization {
        account: crate::testkit::TEST_OWNER,
        client_pk: CLIENT,
        generation: 1,
        authority_epoch: 1,
        lease_generation: 1,
        setup: setup(),
    })));
    a.r.set_grant_source(Box::new(Source(source.clone())));
    settle(&mut [&mut a]);
    a.r.approve_grant(a.s, GRANT, caps.iter().map(|c| (*c).into()).collect(), None)
        .unwrap();
    settle(&mut [&mut a]);
    let effective =
        a.r.grant_now(&GRANT)
            .expect("fixture grant must actually be effective");
    assert!(!effective.capabilities.contains("definitions.manage"));
    (svc, a, source)
}
#[test]
fn declared_setup_narrow_grant_uses_keyed_device_without_broadening() {
    let (_, mut a, _) = declared_node();
    let mut session =
        a.r.begin_collection_setup_session(setup(), None, Some(GRANT))
            .unwrap();
    assert!(
        a.r.collection_setup_session_need(&mut session)
            .unwrap()
            .is_none()
    );
    let review = a.r.finish_collection_setup_session(session).unwrap();
    assert!(review.assessment().applicable);
    assert!(
        !a.r.grant_now(&GRANT)
            .unwrap()
            .capabilities
            .contains("definitions.manage")
    );
}
#[test]
fn declared_setup_caller_cannot_substitute_configuration_or_declaration_identity() {
    let (_, mut a, _) = declared_node();
    for change in [0, 1, 2] {
        let mut other = setup();
        match change {
            0 => other.configuration.provisions[0].value = mdbn_core::value::Value::string("txt"),
            1 => other.application_id = "another.application".into(),
            _ => other.declaration_digest = mdbn_core::ids::Hash::of(b"substitution"),
        }
        assert_eq!(
            a.r.begin_collection_setup_session(other, None, Some(GRANT))
                .err()
                .unwrap()
                .code(),
            Some(ErrorCode::Forbidden)
        );
    }
}
#[test]
fn declared_setup_generation_epoch_lease_and_policy_are_rechecked_before_use() {
    for change in 0..5 {
        let (_, mut a, source) = declared_node();
        let session =
            a.r.begin_collection_setup_session(setup(), None, Some(GRANT))
                .unwrap();
        match change {
            0 => source.borrow_mut().as_mut().unwrap().generation += 1,
            1 => source.borrow_mut().as_mut().unwrap().authority_epoch += 1,
            2 => *source.borrow_mut() = None,
            3 => source.borrow_mut().as_mut().unwrap().lease_generation += 1,
            _ => a.r.policy.grants.get_mut(&GRANT).unwrap().active = false,
        }
        assert!(a.r.finish_collection_setup_session(session).is_err());
    }
}
fn app_session(a: &mut Node) -> crate::api::SessionId {
    a.r.hello(
        crate::api::SessionAuth::Grant {
            grant: GRANT,
            client_pk: CLIENT.0,
        },
        HelloParams {
            versions: vec![mdbn_wire::common::Version { major: 1, minor: 1 }],
            client_name: "declared-setup-test".into(),
            client_version: "1".into(),
            features: None,
            timezone: None,
        },
    )
    .unwrap()
    .0
}
#[test]
fn declared_setup_client_cannot_relabel_old_connection_with_replacement_noise_key() {
    let (_, mut a, source) = declared_node();
    let client = app_session(&mut a);
    a.r.policy.grants.get_mut(&GRANT).unwrap().client_pk = B32([0x64; 32]);
    source.borrow_mut().as_mut().unwrap().client_pk = B32([0x64; 32]);
    assert!(
        a.r.begin_app_collection_setup_session(client, None)
            .is_err()
    );
}
#[test]
fn declared_setup_client_close_fences_source_work_and_prepared_review() {
    let (_, mut a, _) = declared_node();
    let client = app_session(&mut a);
    let session =
        a.r.begin_app_collection_setup_session(client, None)
            .unwrap();
    let review = a.r.finish_collection_setup_session(session).unwrap();
    let rev = review.assessment().collection_revision;
    let digest = review.assessment().assessment_digest;
    let plan =
        a.r.prepare_reviewed_collection_setup(review, rev, digest)
            .unwrap();
    assert_eq!(plan.initiating_client(), Some(client));
    assert_eq!(plan.initiating_grant(), Some(GRANT));
    a.r.close(client);
    assert!(a.r.recheck_prepared_collection_setup(&plan).is_err());
}
fn client_plan(
    a: &mut Node,
    client: crate::api::SessionId,
) -> crate::replica::PreparedCollectionSetupPlan {
    let session =
        a.r.begin_app_collection_setup_session(client, None)
            .unwrap();
    let review = a.r.finish_collection_setup_session(session).unwrap();
    let revision = review.assessment().collection_revision;
    let digest = review.assessment().assessment_digest;
    a.r.prepare_reviewed_collection_setup(review, revision, digest)
        .unwrap()
}
#[test]
fn declared_setup_publishes_complete_configuration_and_receipt_without_app_definition_capability() {
    let (_, mut a, _) = declared_node();
    let client = app_session(&mut a);
    let plan = client_plan(&mut a, client);
    let id = B16([0x65; 16]);
    a.r.capture_prepared_collection_setup(client, plan, id)
        .unwrap();
    settle(&mut [&mut a]);
    assert!(
        a.r.store
            .resource("mdbase.yaml")
            .unwrap()
            .unwrap()
            .contains("base")
    );
    assert!(
        a.r.store
            .resource("mdbase.provisions.yaml")
            .unwrap()
            .is_some()
    );
    assert_eq!(
        a.r.receipt(client, id).unwrap().state,
        mdbn_wire::client::ReceiptState::Confirmed
    );
    assert!(
        !a.r.grant_now(&GRANT)
            .unwrap()
            .capabilities
            .contains("definitions.manage")
    );
    assert!(a.r.declared_setup_pending.is_empty());
}
#[test]
fn declared_setup_composite_promotion_publishes_exact_authenticated_source_atomically() {
    let (svc, mut a, _) = declared_node();
    // A fresh log consumer of this fixture's keyed device, not an independent
    // physical profile: no pending row, source cache or mediated authority.
    let mut reader = node_with(
        &svc,
        1,
        MemStore::new(),
        vec![],
        Some(Box::new(KeyringSealer::new(
            COL,
            B16([101; 16]),
            &[0x31; 32],
            &[0x32; 32],
        ))),
    );
    reader.r.cfg.replica_id = B16([2; 16]);
    reader.r.secrets.sign_sk = [0x31; 32];
    reader.r.planner = Box::new(crate::plan::CorePlanner);
    let document = "views: []\r\n";
    super::capture::upload(&mut a, 7, "views/source.base", document.as_bytes());
    let client = app_session(&mut a);
    let mut session =
        a.r.begin_app_collection_setup_session(client, None)
            .unwrap();
    super::session::drive(&a, &mut session, &svc);
    let review = a.r.finish_collection_setup_session(session).unwrap();
    let revision = review.assessment().collection_revision;
    let digest = review.assessment().assessment_digest;
    let plan =
        a.r.prepare_reviewed_collection_setup(review, revision, digest)
            .unwrap();
    assert!(
        plan.operations()
            .iter()
            .any(|op| matches!(op, mdbn_core::intent::Op::OrdinaryFileToRecord(_)))
    );
    let id = B16([0x67; 16]);
    a.r.capture_prepared_collection_setup(client, plan, id)
        .unwrap();
    settle(&mut [&mut a]);
    assert!(
        a.r.store.record(&B16([7; 16])).unwrap().is_some(),
        "writer receipt={:?} status={:?}",
        a.r.receipt(client, id),
        a.r.sync_status()
    );
    assert_eq!(
        a.r.store.record(&B16([7; 16])).unwrap().unwrap().doc,
        document
    );
    settle(&mut [&mut reader]);
    assert!(
        reader.r.store.record(&B16([7; 16])).unwrap().is_some(),
        "reader head={:?} stalled={:?} fault={} status={:?}",
        reader.r.head,
        reader.r.stalled,
        reader.r.apply_fault,
        reader.r.sync_status()
    );
    assert_eq!(
        reader.r.store.record(&B16([7; 16])).unwrap().unwrap().doc,
        document
    );
    assert!(reader.r.store.file(&B16([7; 16])).unwrap().is_none());
    assert!(
        reader
            .r
            .store
            .resource("mdbase.provisions.yaml")
            .unwrap()
            .is_some()
    );
    assert_eq!(reader.r.head(), a.r.head());
    assert!(a.r.store.file(&B16([7; 16])).unwrap().is_none());
    assert!(
        a.r.store
            .resource("mdbase.provisions.yaml")
            .unwrap()
            .is_some()
    );
    assert_eq!(
        a.r.receipt(client, id).unwrap().state,
        mdbn_wire::client::ReceiptState::Confirmed
    );
}
#[test]
fn declared_setup_replay_waits_for_complete_source_without_applying_resource_prefix() {
    let (svc, mut a, _) = declared_node();
    let document = "views: []\r\n";
    super::capture::upload(&mut a, 7, "views/source.base", document.as_bytes());
    let client = app_session(&mut a);
    let mut session =
        a.r.begin_app_collection_setup_session(client, None)
            .unwrap();
    super::session::drive(&a, &mut session, &svc);
    let review = a.r.finish_collection_setup_session(session).unwrap();
    let revision = review.assessment().collection_revision;
    let digest = review.assessment().assessment_digest;
    let plan =
        a.r.prepare_reviewed_collection_setup(review, revision, digest)
            .unwrap();
    let missing = *plan.source_refs().last().unwrap();
    let (_, original) = svc
        .objects(&COL)
        .into_iter()
        .find(|(hash, _)| *hash == missing)
        .unwrap();
    svc.forget_object(&COL, &missing);
    let id = B16([0x68; 16]);
    a.r.capture_prepared_collection_setup(client, plan, id)
        .unwrap();
    settle(&mut [&mut a]);
    assert!(a.r.store.record(&B16([7; 16])).unwrap().is_none());
    assert!(a.r.store.file(&B16([7; 16])).unwrap().is_some());
    assert!(
        a.r.store
            .resource("mdbase.provisions.yaml")
            .unwrap()
            .is_none()
    );
    assert!(a.r.store.pending_get(&id).unwrap().is_some());
    // Repair only the immutable read object; never resubmit the mutation.
    svc.put_object(&COL, original);
    a.clock.set(a.clock.get() + 5_000);
    a.r.tick();
    settle(&mut [&mut a]);
    assert_eq!(
        a.r.store.record(&B16([7; 16])).unwrap().unwrap().doc,
        document
    );
    assert_eq!(
        a.r.receipt(client, id).unwrap().state,
        mdbn_wire::client::ReceiptState::Confirmed
    );
}
#[test]
fn declared_setup_queued_capture_rechecks_consent_before_sealing() {
    let (_, mut a, source) = declared_node();
    let client = app_session(&mut a);
    let plan = client_plan(&mut a, client);
    a.r.append = crate::replica::append::AppendState::WaitUntil(i64::MAX);
    let id = B16([0x66; 16]);
    a.r.capture_prepared_collection_setup(client, plan, id)
        .unwrap();
    source.borrow_mut().as_mut().unwrap().generation += 1;
    a.r.append = crate::replica::append::AppendState::Idle;
    settle(&mut [&mut a]);
    assert_eq!(
        a.r.receipt(client, id).unwrap().state,
        mdbn_wire::client::ReceiptState::Rejected
    );
    assert!(
        a.r.store
            .resource("mdbase.provisions.yaml")
            .unwrap()
            .is_none()
    );
}
#[test]
fn declared_setup_certified_capture_abort_publishes_nothing_and_does_not_fence_actor() {
    let (svc, mut a, _) = declared_node();
    let client = app_session(&mut a);
    let plan = client_plan(&mut a, client);
    let before = svc.head(&COL);
    a.r.store.fail_commits(1);
    let id = B16([0x69; 16]);
    assert!(
        a.r.capture_prepared_collection_setup(client, plan, id)
            .is_err()
    );
    assert!(!a.r.apply_fault);
    assert!(a.r.store.pending_get(&id).unwrap().is_none());
    assert!(a.r.declared_setup_pending.is_empty());
    assert_eq!(svc.head(&COL), before);
}
#[test]
fn declared_setup_uncertain_capture_fences_actor_and_never_replays_original_mutation() {
    for after_commit in [false, true] {
        let (svc, mut a, _) = declared_node();
        let client = app_session(&mut a);
        let plan = client_plan(&mut a, client);
        let before = svc.head(&COL);
        if after_commit {
            a.r.store.fail_after_commit(1);
        } else {
            a.r.store.fail_unknown_commits(1);
        }
        let id = B16([0x6a; 16]);
        let error =
            a.r.capture_prepared_collection_setup(client, plan, id)
                .unwrap_err();
        assert_eq!(error.problem().code, "outcome_unknown");
        assert!(a.r.apply_fault);
        a.r.tick();
        settle(&mut [&mut a]);
        assert_eq!(svc.head(&COL), before);
        assert!(
            a.r.store
                .resource("mdbase.provisions.yaml")
                .unwrap()
                .is_none()
        );
        assert!(a.r.declared_setup_pending.is_empty());
    }
}
#[test]
fn declared_setup_prepared_plan_does_not_survive_replace_and_restore() {
    let (_, mut a, source) = declared_node();
    let session =
        a.r.begin_collection_setup_session(setup(), None, Some(GRANT))
            .unwrap();
    let review = a.r.finish_collection_setup_session(session).unwrap();
    let rev = review.assessment().collection_revision;
    let digest = review.assessment().assessment_digest;
    let plan =
        a.r.prepare_reviewed_collection_setup(review, rev, digest)
            .unwrap();
    source.borrow_mut().as_mut().unwrap().generation += 1;
    assert!(a.r.recheck_prepared_collection_setup(&plan).is_err());
    // Restoring the old declaration does not restore the consent generation.
    source.borrow_mut().as_mut().unwrap().setup = setup();
    assert!(a.r.recheck_prepared_collection_setup(&plan).is_err());
}
