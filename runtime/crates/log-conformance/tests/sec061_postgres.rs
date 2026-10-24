//! Actual Postgres regression: budget rejection during BEGIN must roll back
//! before a single pooled connection can be reused. Run the pulled test against
//! an isolated database with MDBN_LOGSVC_PG_URL; never a production database.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use mdbn_log_server::{pg::PgBackend, testkit_config};
use mdbn_log_service::auth::Principal;
use mdbn_log_service::backend::{Backend, Mode};
use mdbn_log_service::decode::{Budget, MAX_NODES};
use mdbn_log_service::mem::MemObjects;
use mdbn_log_service::testkit::{ControlPlane, id16};
use mdbn_log_service::{Code, Service};
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::common::Bytes;
use mdbn_wire::log_service::AppendParams;
use mdbn_wire::policy::{Freeze, PolicyOp};
use mdbn_wire::schema::Wire;

#[tokio::test]
async fn rejected_projection_decode_releases_clean_single_connection() {
    let Ok(url) =
        std::env::var("MDBN_LOGSVC_PG_URL").or_else(|_| std::env::var("MDBN_TEST_PG_URL"))
    else {
        eprintln!("MDBN_LOGSVC_PG_URL/MDBN_TEST_PG_URL not set: skipping isolated Postgres run");
        return;
    };
    let cp = ControlPlane::new("sec061/pg");
    let c = id16("sec061/pg/collection");
    let owner = id16("sec061/pg/owner");
    let svc = Service::new(
        PgBackend::connect(&url, 1)
            .await
            .unwrap()
            .with_independent_floor_reader(std::sync::Arc::new(
                mdbn_log_server::test_support::TestDeletionFloors::default(),
            )),
        MemObjects::default(),
        testkit_config("sec061/pg", "http://127.0.0.1"),
    );
    let params = Cbor::Map(vec![
        (Cbor::Uint(0), c.to_cbor()),
        (Cbor::Uint(1), Cbor::Bytes(cp.genesis(c, owner))),
    ]);
    svc.call(&Principal::ControlPlane, "create_log", &params, 1000)
        .await
        .unwrap();
    let before = svc.head(&Principal::ControlPlane, &c).await.unwrap();

    let budget = Budget::default();
    budget
        .preflight(&cbor::encode(&Cbor::Array(vec![Cbor::Null; MAX_NODES - 1])).unwrap())
        .unwrap();
    let error = match svc.backend.begin_with_budget(&c, Mode::Read, &budget).await {
        Err(e) => e,
        Ok(_) => panic!("projection decoder reset the exhausted request budget"),
    };
    assert_eq!(error.code, Code::Invalid);
    assert_eq!(error.reason.as_deref(), Some("cbor_nodes"));
    // The failed transaction was READ ONLY. Reusing it without rollback would
    // make this next WRITE fail; losing the pool permit would time out instead.
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        svc.append(
            &Principal::ControlPlane,
            AppendParams {
                collection: c,
                expect_seq: before.head + 1,
                expect_prev: before.head_chain,
                items: vec![Bytes(cp.policy_item(
                    c,
                    before.head + 1,
                    before.head_chain,
                    vec![PolicyOp::Freeze(Freeze {
                        frozen: false,
                        reason: None,
                    })],
                    1001,
                ))],
            },
            1001,
        ),
    )
    .await
    .expect("budget rejection leaked the single pool permit");
    result.expect("budget rejection returned an open READ ONLY transaction");
    assert_eq!(
        svc.head(&Principal::ControlPlane, &c).await.unwrap().head,
        before.head + 1
    );
}
