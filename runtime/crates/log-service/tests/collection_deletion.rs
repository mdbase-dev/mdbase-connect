//! Strict native terminal protocol against independent in-memory reference floors.
//! These tests do not qualify a durable producer, HTTP authentication or erasure.
use mdbn_log_service::auth::Principal;
use mdbn_log_service::deletion::CollectionDeletionRecord;
use mdbn_log_service::mem::{MemBackend, MemObjects};
use mdbn_log_service::model::Status;
use mdbn_log_service::testkit::{ControlPlane, id16};
use mdbn_log_service::{Backend, Code, Config, Mode, Service, Txn, backend::Write};
use mdbn_wire::cbor::Cbor;
use mdbn_wire::common::{B16, B32, Uuid};
use mdbn_wire::schema::Wire;
use std::future::Future;
use std::task::{Context, Poll, Waker};
const NOW: i64 = 1_000;
fn ready<T>(f: impl Future<Output = T>) -> T {
    let mut f = std::pin::pin!(f);
    match f.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
        Poll::Ready(v) => v,
        Poll::Pending => panic!("reference operation waited"),
    }
}
fn map(fields: Vec<(u64, Cbor)>) -> Cbor {
    Cbor::Map(
        fields
            .into_iter()
            .map(|(k, v)| (Cbor::Uint(k), v))
            .collect(),
    )
}
fn field(value: &Cbor, key: u64) -> &Cbor {
    let Cbor::Map(fields) = value else {
        panic!("map expected")
    };
    &fields
        .iter()
        .find(|(k, _)| *k == Cbor::Uint(key))
        .unwrap()
        .1
}
struct Fixture {
    svc: Service<MemBackend, MemObjects>,
    c: Uuid,
}
impl Fixture {
    fn new(create: bool) -> Self {
        let cp = ControlPlane::new("terminal-receipt");
        let c = id16("terminal-receipt/collection");
        let svc = Service::new(
            MemBackend::default(),
            MemObjects::default(),
            Config {
                roots: vec![cp.root_pk()],
                token_issuers: vec![cp.issuer_pk()],
                url_secret: vec![71; 32],
                public_base: "https://fixture.test".into(),
            },
        );
        if create {
            ready(svc.call(
                &Principal::ControlPlane,
                "create_log",
                &map(vec![
                    (0, c.to_cbor()),
                    (
                        1,
                        Cbor::Bytes(cp.genesis(c, id16("terminal-receipt/owner"))),
                    ),
                ]),
                NOW,
            ))
            .unwrap();
        }
        Self { svc, c }
    }
    fn record(&self) -> CollectionDeletionRecord {
        CollectionDeletionRecord {
            collection: self.c,
            deletion_id: id16("terminal-receipt/deletion"),
            lifecycle_epoch: u64::MAX,
        }
    }
    fn request(&self) -> Cbor {
        let r = self.record();
        map(vec![
            (0, r.collection.to_cbor()),
            (1, r.deletion_id.to_cbor()),
            (2, Cbor::Uint(r.lifecycle_epoch)),
        ])
    }
    fn status(&self) -> Cbor {
        ready(self.svc.call(
            &Principal::ControlPlane,
            "log_terminal_status",
            &map(vec![(0, self.c.to_cbor())]),
            NOW,
        ))
        .unwrap()
        .result
    }
    fn seed(&self) {
        self.svc
            .backend
            .record_collection_deletion(self.record())
            .unwrap();
    }
    fn delete(&self) -> mdbn_log_service::Result<mdbn_log_service::service::Outcome> {
        ready(
            self.svc
                .call(&Principal::ControlPlane, "delete_log", &self.request(), NOW),
        )
    }
}
#[test]
fn typed_delete_is_durable_before_reply_and_exact_retry_has_same_receipt() {
    let f = Fixture::new(true);
    f.seed();
    let first = f.delete().unwrap();
    assert!(first.notice.unwrap().gone);
    assert_eq!(field(&first.result, 0), &Cbor::Bool(true));
    assert_eq!(field(&first.result, 1), &f.record().to_cbor());
    let status = f.status();
    assert_eq!(field(&status, 0), &Cbor::Uint(1));
    assert_eq!(field(&status, 1), &f.c.to_cbor());
    assert_eq!(field(&status, 2), &Cbor::Uint(3));
    assert_eq!(field(&status, 3), &f.record().to_cbor());
    let retry = f.delete().unwrap();
    assert_eq!(retry.result, first.result);
    assert!(retry.notice.is_none());
    ready(async {
        let mut tx = f.svc.backend.begin(&f.c, Mode::Read).await.unwrap();
        let m = tx.load().await.unwrap().unwrap().meta;
        assert_eq!(m.status, Status::Gone);
        assert_eq!(m.deletion, Some(f.record()));
    });
}
#[test]
fn floor_absence_never_authorizes_delete_and_missing_log_is_not_created() {
    let f = Fixture::new(true);
    assert_eq!(f.delete().unwrap_err().code, Code::Unavailable);
    assert_eq!(field(&f.status(), 2), &Cbor::Uint(1));
    let absent = Fixture::new(false);
    absent.seed();
    assert_eq!(field(&absent.status(), 2), &Cbor::Uint(0));
    assert_eq!(field(&absent.status(), 3), &Cbor::Null);
    assert_eq!(absent.delete().unwrap_err().code, Code::NotFound);
    assert_eq!(field(&absent.status(), 2), &Cbor::Uint(0));
}
#[test]
fn different_id_or_epoch_is_conflict_with_first_typed_record() {
    let f = Fixture::new(true);
    f.seed();
    for request in [
        map(vec![
            (0, f.c.to_cbor()),
            (1, id16("terminal-receipt/foreign-id").to_cbor()),
            (2, Cbor::Uint(u64::MAX)),
        ]),
        map(vec![
            (0, f.c.to_cbor()),
            (1, f.record().deletion_id.to_cbor()),
            (2, Cbor::Uint(1)),
        ]),
    ] {
        let error = ready(
            f.svc
                .call(&Principal::ControlPlane, "delete_log", &request, NOW),
        )
        .unwrap_err();
        assert_eq!(error.code, Code::Forbidden);
        assert_eq!(
            error.reason.as_deref(),
            Some("collection_deletion_conflict")
        );
        assert_eq!(error.details, Some(f.record().to_cbor()));
    }
    assert_eq!(field(&f.status(), 2), &Cbor::Uint(1));
}
#[test]
fn legacy_tupleless_gone_is_denial_not_an_invented_receipt() {
    let f = Fixture::new(true);
    f.seed();
    ready(async {
        let mut tx = f.svc.backend.begin(&f.c, Mode::Write).await.unwrap();
        let mut st = tx.load().await.unwrap().unwrap();
        st.meta.status = Status::Gone;
        tx.write(Write::PutMeta(st.meta));
        tx.commit().await.unwrap();
    });
    assert_eq!(field(&f.status(), 2), &Cbor::Uint(3));
    assert_eq!(field(&f.status(), 3), &Cbor::Null);
    let e = f.delete().unwrap_err();
    assert_eq!(e.code, Code::Gone);
    assert_eq!(
        e.reason.as_deref(),
        Some("collection_deletion_receipt_missing")
    );
    assert_eq!(field(&f.status(), 3), &Cbor::Null);
}
#[test]
fn terminal_maps_and_principal_are_strict_before_mutation() {
    let f = Fixture::new(true);
    f.seed();
    for request in [
        map(vec![(0, f.c.to_cbor())]),
        map(vec![
            (0, f.c.to_cbor()),
            (1, f.record().deletion_id.to_cbor()),
            (2, Cbor::Uint(0)),
        ]),
        map(vec![
            (0, f.c.to_cbor()),
            (1, B16([0; 16]).to_cbor()),
            (2, Cbor::Uint(1)),
        ]),
        map(vec![
            (0, B16([0; 16]).to_cbor()),
            (1, f.record().deletion_id.to_cbor()),
            (2, Cbor::Uint(1)),
        ]),
        map(vec![
            (0, f.c.to_cbor()),
            (1, f.record().deletion_id.to_cbor()),
            (2, Cbor::Uint(1)),
            (3, Cbor::Bool(true)),
        ]),
    ] {
        assert_eq!(
            ready(
                f.svc
                    .call(&Principal::ControlPlane, "delete_log", &request, NOW)
            )
            .unwrap_err()
            .code,
            Code::Invalid
        );
    }
    let device = Principal::Device {
        id: id16("terminal-receipt/device"),
        sign_pk: B32([3; 32]),
        collection: Some(f.c),
    };
    for (method, params) in [
        ("delete_log", f.request()),
        ("log_terminal_status", map(vec![(0, f.c.to_cbor())])),
    ] {
        assert_eq!(
            ready(f.svc.call(&device, method, &params, NOW))
                .unwrap_err()
                .code,
            Code::Forbidden
        );
    }
    assert_eq!(field(&f.status(), 2), &Cbor::Uint(1));
}
#[test]
fn foreign_collection_projection_refuses_before_gone_or_success_receipt() {
    let f = Fixture::new(true);
    f.seed();
    ready(async {
        let mut tx = f.svc.backend.begin(&f.c, Mode::Write).await.unwrap();
        let mut st = tx.load().await.unwrap().unwrap();
        st.meta.id = id16("terminal-receipt/foreign-collection");
        tx.write(Write::PutMeta(st.meta));
        tx.commit().await.unwrap();
    });
    assert_eq!(f.delete().unwrap_err().code, Code::Unavailable);
    ready(async {
        let mut tx = f.svc.backend.begin(&f.c, Mode::Read).await.unwrap();
        assert_eq!(tx.load().await.unwrap().unwrap().meta.status, Status::Live);
    });
}
