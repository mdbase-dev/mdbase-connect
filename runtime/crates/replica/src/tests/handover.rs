//! Handover witnesses bind committed state; historical comparisons never use asOf.

use super::engine::{COL, Node, node};
use crate::api::{ClientApi, ErrorCode, SessionAuth, SessionId};
use crate::crypto::sign::{DeviceSigner, verify_digest};
use crate::fake::FakeLogService;
use crate::mem::MemStore;
use crate::store::{Store, Tx};
use crate::testkit::{TEST_OWNER, TestControlPlane};
use mdbn_wire::client::{HelloParams, SyncMode};
use mdbn_wire::common::{B16, B32, Version};
use mdbn_wire::entry::HeadWitness;
use mdbn_wire::policy::{CState, MemberSet, PolicyOp, Role};
use mdbn_wire::schema::Wire;

pub(super) fn ready() -> (FakeLogService, TestControlPlane, Node) {
    let svc = FakeLogService::new();
    let mut cp = TestControlPlane::new(COL);
    cp.genesis_with_keys(&svc, CState::CloudCopy, B16([101; 16]), &[1; 32], &[1; 32]);
    cp.enrol(
        &svc,
        crate::testkit::TestDevice {
            device: B16([103; 16]),
            account: crate::policy::SERVICE_ACCOUNT,
            kind: mdbn_wire::policy::DeviceKind::Escrow,
        },
    );
    // A usable epoch is necessary for actual approved grants/resource entries,
    // not just metadata-only genesis witnesses.
    cp.append_item(
        &svc,
        mdbn_wire::envelope::ItemKind::Rekey,
        B16([101; 16]),
        mdbn_wire::envelope::RekeyPayload {
            epoch: 1,
            from: 0,
            commit: B32([0; 32]),
            wraps: [B16([101; 16]), B16([103; 16])]
                .into_iter()
                .map(|device| mdbn_wire::envelope::KeyWrap {
                    device,
                    enc: B32([0; 32]),
                    ct: mdbn_wire::common::Bytes(vec![0; 48]),
                })
                .collect(),
            history: mdbn_wire::envelope::SealedBox {
                salt: B16([0; 16]),
                ct: mdbn_wire::common::Bytes(vec![]),
            },
            reason: mdbn_wire::envelope::RekeyReason::Initial,
        }
        .to_bytes()
        .unwrap(),
    );
    let mut n = node(&svc, 1, MemStore::new());
    n.r.cfg.chosen_state = Some(CState::CloudCopy);
    n.r.cfg.user_enabled_cloud_copy = true;
    n.r.tick();
    n.pump();
    assert!(
        n.r.sync_status().confirmed_head.is_some(),
        "committed enrolled prefix is available"
    );
    (svc, cp, n)
}

#[test]
fn handover_hello_signs_the_same_confirmed_status_tuple() {
    let (_, _, mut n) = ready();
    let (_, hello) =
        n.r.hello(
            SessionAuth::Host,
            HelloParams {
                versions: vec![Version { major: 1, minor: 0 }],
                client_name: "test".into(),
                client_version: "0".into(),
                features: None,
                timezone: None,
            },
        )
        .unwrap();
    let head = hello.status.confirmed_head.unwrap();
    let witness = HeadWitness::from_bytes(&hello.head_witness.unwrap().0).unwrap();
    assert_eq!(witness.collection, COL);
    assert_eq!(witness.device, n.r.cfg.device_id);
    assert_eq!(witness.seq, head.seq);
    assert_eq!(witness.chain, head.chain);
    assert_eq!(witness.policy_generation, Some(head.policy_generation));
    assert_eq!(witness.catalog_generation, Some(head.catalog_generation));
    let pk = DeviceSigner::from_seed(&[1; 32]).public();
    assert!(verify_digest(
        &pk,
        &witness.signed_digest().unwrap().0,
        &witness.sig.0
    ));
    let mut changed = witness.clone();
    changed.catalog_generation = Some(B32([42; 32]));
    assert!(!verify_digest(
        &pk,
        &changed.signed_digest().unwrap().0,
        &changed.sig.0
    ));
    changed = witness.clone();
    changed.policy_generation = Some(B32([42; 32]));
    assert!(!verify_digest(
        &pk,
        &changed.signed_digest().unwrap().0,
        &changed.sig.0
    ));
}

#[test]
fn handover_ahead_uses_historical_chain_and_not_current_generations() {
    let (svc, mut cp, mut n) = ready();
    let fence = n.r.sync_status().confirmed_head.unwrap();
    cp.append(
        &svc,
        vec![PolicyOp::MemberSet(MemberSet {
            account: TEST_OWNER,
            role: Role::Editor,
        })],
    );
    n.r.tick();
    n.pump();
    let current = n.r.sync_status().confirmed_head.unwrap();
    assert!(current.seq > fence.seq);
    assert_ne!(current.chain, fence.chain);
    assert_ne!(current.policy_generation, fence.policy_generation);
    assert_eq!(current.catalog_generation, fence.catalog_generation);
    let proof = n.r.applied_prefix(n.s, fence.seq).unwrap();
    assert_eq!(proof.applied_through, current.seq);
    assert_eq!(proof.seq, fence.seq);
    assert_eq!(proof.chain, Some(fence.chain));
    assert!(
        n.r.applied_prefix(n.s, current.seq + 1)
            .unwrap()
            .chain
            .is_none()
    );
    assert!(n.r.applied_prefix(n.s, 0).unwrap().chain.is_none());
    n.r.store
        .commit(Tx {
            tail_drop_below: Some(current.seq),
            ..Tx::default()
        })
        .unwrap();
    assert!(
        n.r.applied_prefix(n.s, fence.seq).unwrap().chain.is_none(),
        "unretained history is never guessed"
    );
    assert_eq!(
        n.r.applied_prefix(n.s, current.seq).unwrap().chain,
        Some(current.chain)
    );
}

#[test]
fn handover_authorization_and_faults_fail_closed() {
    let (_, _, mut n) = ready();
    assert_eq!(
        n.r.applied_prefix(SessionId(999), 1).unwrap_err().code(),
        Some(ErrorCode::Unauthenticated)
    );
    n.r.policy.seq += 1;
    assert!(n.r.sync_status().confirmed_head.is_none());
    assert!(n.r.applied_prefix(n.s, 1).unwrap().chain.is_none());
    n.r.policy.seq -= 1;
    n.r.cfg.mode = SyncMode::LocalOnly;
    assert!(n.r.sync_status().confirmed_head.is_none());
    let proof = n.r.applied_prefix(n.s, 1).unwrap();
    assert_eq!(proof.applied_through, 0);
    assert!(proof.chain.is_none());
    n.r.cfg.mode = SyncMode::Synced;
    n.r.apply_fault = true;
    assert!(n.r.sync_status().confirmed_head.is_none());
    assert_eq!(
        n.r.applied_prefix(n.s, 1).unwrap_err().code(),
        Some(ErrorCode::Unavailable)
    );
}

#[test]
fn handover_requires_read_and_current_grant_authority() {
    let (svc, mut cp, mut n) = ready();
    let grant = B16([33; 16]);
    cp.approved_grant(
        &svc,
        grant,
        [33; 32],
        &["records.create"],
        None,
        n.r.cfg.device_id,
    );
    n.r.tick();
    n.pump();
    let (session, _) =
        n.r.hello(
            SessionAuth::Grant {
                grant,
                client_pk: [33; 32],
            },
            hello_params(),
        )
        .unwrap();
    assert_eq!(
        n.r.applied_prefix(session, 1).unwrap_err().code(),
        Some(ErrorCode::Forbidden)
    );
    n.r.close(session);
    assert_eq!(
        n.r.applied_prefix(session, 1).unwrap_err().code(),
        Some(ErrorCode::Unauthenticated)
    );
}

pub(super) fn hello_params() -> HelloParams {
    HelloParams {
        versions: vec![Version { major: 1, minor: 0 }],
        client_name: "test".into(),
        client_version: "0".into(),
        features: None,
        timezone: None,
    }
}

#[test]
fn handover_ineligible_states_never_emit_witness_or_prefix() {
    use mdbn_wire::client::{Incident, IncidentKind};
    for case in 0..8 {
        let (_, _, mut n) = ready();
        match case {
            0 => n.r.key_untrusted = true,
            1 => n.r.apply_blocked = Some(n.r.head.seq + 1),
            2 => n.r.genesis = None,
            3 => n.r.secrets.sign_sk = [77; 32],
            4 => {
                n.r.policy
                    .devices
                    .get_mut(&n.r.cfg.device_id)
                    .unwrap()
                    .active = false
            }
            5 => n.r.cfg.chosen_state = Some(CState::E2e),
            6 => {
                n.r.incidents.insert(
                    IncidentKind::Integrity as u64,
                    Incident {
                        kind: IncidentKind::Integrity,
                        details: None,
                    },
                );
            }
            7 => n.r.stalled = Some((IncidentKind::WaitingForKey, n.r.head.seq + 1)),
            _ => unreachable!(),
        }
        assert!(n.r.sync_status().confirmed_head.is_none(), "case {case}");
        let proof = n.r.applied_prefix(n.s, 1);
        if case == 1 {
            assert_eq!(proof.unwrap_err().code(), Some(ErrorCode::Unavailable));
        } else {
            assert!(proof.unwrap().chain.is_none(), "case {case}");
        }
        let hello = n.r.hello(SessionAuth::Host, hello_params());
        if case == 1 {
            assert_eq!(hello.unwrap_err().code(), Some(ErrorCode::Unavailable));
        } else {
            assert!(hello.unwrap().1.head_witness.is_none(), "case {case}");
        }
    }
    let (_, _, mut n) = ready();
    n.r.install = Some(crate::replica::TestInstall::Control);
    assert!(n.r.sync_status().confirmed_head.is_none());
    assert!(n.r.applied_prefix(n.s, 1).unwrap().chain.is_none());
}

#[test]
fn handover_catalog_is_confirmed_only_and_profile_neutral() {
    use mdbn_wire::client::{ReceiptState, SubmitParams};
    use mdbn_wire::common::Text;
    use mdbn_wire::intent::{Op, ResourcePut};
    let (_, _, mut n) = ready();
    n.r.planner = Box::new(crate::plan::CorePlanner);
    let before = n.r.sync_status().confirmed_head.unwrap();
    let params = SubmitParams {
        ops: vec![Op::ResourcePut(ResourcePut {
            path: "_types/task.md".into(),
            doc: Text::Inline("---\nkind: mdbase.type\nname: task\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object}\n---\n".into()),
            base_revision: None,
            must_not_exist: None,
        })],
        mutation_id: None,
        conflict_mode: None,
        timezone: None,
        allow_partial: None,
        mutation_ids: None,
        dry_run: None,
        include: None,
        wait: None,
    };
    let receipts = n.r.submit(n.s, params).unwrap();
    assert_eq!(
        receipts[0].state,
        ReceiptState::Pending,
        "{:?}",
        receipts[0].problem
    );
    assert!(n.r.store.resources().unwrap().is_empty());
    assert_eq!(
        n.r.sync_status().confirmed_head.unwrap(),
        before,
        "pending resource does not become confirmed catalog"
    );
    n.r.set_query_execution_profile(crate::QueryExecutionProfile::Desktop);
    assert_eq!(n.r.sync_status().confirmed_head.unwrap(), before);
    n.r.tick();
    n.pump();
    let after = n.r.sync_status().confirmed_head.unwrap();
    assert!(after.seq > before.seq);
    assert_ne!(after.catalog_generation, before.catalog_generation);
    let sem = mdbn_core::semantics::SEM;
    let expected = crate::plan::query_index_generation(
        &n.r.store.resources().unwrap(),
        mdbn_wire::common::Sem {
            major: sem.major,
            minor: sem.minor,
        },
        &[],
        1024,
    )
    .unwrap();
    assert_eq!(after.catalog_generation, B32(expected));
    n.r.store_generation += 1;
    assert_eq!(
        n.r.sync_status().confirmed_head.unwrap(),
        after,
        "lifetime counter is not a wire generation"
    );
}
