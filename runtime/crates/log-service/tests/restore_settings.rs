//! Logical Layer-1 restore settings: an empty target receives the source quota
//! before any object commits, never a raw ACL/key projection. Hermetic Mem tests.
use std::future::Future;
use std::task::{Context, Poll, Waker};

use mdbn_log_service::auth::Principal;
use mdbn_log_service::mem::{MemBackend, MemObjects};
use mdbn_log_service::model::{
    CollectionMeta, ObjectMeta, Quotas, RetentionTier, Status, object_key,
};
use mdbn_log_service::testkit::{ControlPlane, id16, object};
use mdbn_log_service::{Backend, Code, Config, Mode, ObjectStore, Service, Txn, Write};
use mdbn_wire::cbor::Cbor;
use mdbn_wire::common::{B32, Uuid};
use mdbn_wire::envelope::ItemKind;
use mdbn_wire::hash::sha256;
use mdbn_wire::log_service::GetObjectParams;
use mdbn_wire::schema::Wire;

type Svc = Service<MemBackend, MemObjects>;
const NOW: i64 = 1_000;
fn ready<T>(f: impl Future<Output = T>) -> T {
    let mut f = std::pin::pin!(f);
    match f.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
        Poll::Ready(v) => v,
        Poll::Pending => panic!("uncontended memory operation waited"),
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
fn field(value: &Cbor, key: u64) -> Cbor {
    let Cbor::Map(fields) = value else {
        panic!("map")
    };
    fields
        .iter()
        .find(|(k, _)| *k == Cbor::Uint(key))
        .unwrap()
        .1
        .clone()
}
fn svc(cp: &ControlPlane) -> Svc {
    Service::new(
        MemBackend::default(),
        MemObjects::default(),
        Config {
            roots: vec![cp.root_pk()],
            token_issuers: vec![cp.issuer_pk()],
            url_secret: vec![7; 32],
            public_base: "https://restore.invalid".into(),
        },
    )
}
fn meta(svc: &Svc, c: &Uuid) -> CollectionMeta {
    ready(async {
        let mut tx = svc.backend.begin(c, Mode::Read).await.unwrap();
        tx.load().await.unwrap().unwrap().meta
    })
}
fn source() -> (ControlPlane, Svc, Uuid, Cbor) {
    let cp = ControlPlane::new("restore-settings");
    let src = svc(&cp);
    let c = id16("restore-settings/collection");
    ready(src.call(
        &Principal::ControlPlane,
        "create_log",
        &map(vec![
            (0, c.to_cbor()),
            (
                1,
                Cbor::Bytes(cp.genesis(c, id16("restore-settings/owner"))),
            ),
        ]),
        NOW,
    ))
    .unwrap();
    let page = ready(src.call(
        &Principal::ControlPlane,
        "export",
        &map(vec![(0, c.to_cbor())]),
        NOW,
    ))
    .unwrap()
    .result;
    (cp, src, c, page)
}
fn start(
    dst: &Svc,
    c: Uuid,
    page: &Cbor,
    settings: Cbor,
) -> mdbn_log_service::Result<mdbn_log_service::service::Outcome> {
    ready(dst.call(
        &Principal::ControlPlane,
        "import",
        &map(vec![(0, c.to_cbor()), (1, field(page, 0)), (3, settings)]),
        NOW + 50,
    ))
}
fn complete(
    dst: &Svc,
    c: Uuid,
    page: &Cbor,
    head: Cbor,
    chain: Cbor,
) -> mdbn_log_service::Result<mdbn_log_service::service::Outcome> {
    ready(dst.call(
        &Principal::ControlPlane,
        "import",
        &map(vec![
            (0, c.to_cbor()),
            (1, Cbor::Array(vec![])),
            (2, map(vec![(0, field(page, 5)), (1, head), (2, chain)])),
        ]),
        NOW + 100,
    ))
}

#[test]
fn restores_operational_settings_and_readable_object_without_changing_policy() {
    for storage_bytes in [10_000, Quotas::default().storage_bytes + 1] {
        let (cp, src, c, _) = source();
        let bytes = object(c, ItemKind::BlobPart, 0, vec![42; 64]);
        let address = sha256(&bytes);
        ready(async {
            let mut tx = src.backend.begin(&c, Mode::Write).await.unwrap();
            let mut m = tx.load().await.unwrap().unwrap().meta;
            m.quotas = Quotas {
                storage_bytes,
                items_per_s: 17,
                bytes_per_s: 8192,
                burst_items: 29,
            };
            m.retention_tier = RetentionTier::Days365;
            m.created_at = -123;
            m.used_bytes += bytes.len() as u64;
            tx.write(Write::PutMeta(m));
            tx.write(Write::PutObject(ObjectMeta {
                address,
                kind: 18,
                size: bytes.len() as u64,
                checksum: address,
                committed: true,
                created_at: NOW,
            }));
            tx.commit().await.unwrap();
            src.objects
                .put_new(&object_key(&c, &address), bytes.clone())
                .await
                .unwrap();
        });
        let page = ready(src.call(
            &Principal::ControlPlane,
            "export",
            &map(vec![(0, c.to_cbor())]),
            NOW,
        ))
        .unwrap()
        .result;
        let dst = svc(&cp);
        start(&dst, c, &page, field(&page, 7)).unwrap();
        let m = meta(&dst, &c);
        let original = meta(&src, &c);
        assert_eq!(m.status, Status::Importing);
        assert_eq!(m.quotas, original.quotas);
        assert_eq!(m.retention_tier, original.retention_tier);
        assert_eq!(m.created_at, original.created_at);
        assert_eq!(m.root, original.root);
        assert_eq!(m.owner, original.owner);
        assert_eq!(
            ready(dst.head(&Principal::ControlPlane, &c))
                .unwrap_err()
                .code,
            Code::Unavailable
        );
        ready(dst.call(
            &Principal::ControlPlane,
            "import_object",
            &map(vec![
                (0, c.to_cbor()),
                (1, address.to_cbor()),
                (2, Cbor::Uint(18)),
                (3, Cbor::Bytes(bytes.clone())),
            ]),
            NOW + 60,
        ))
        .unwrap();
        complete(&dst, c, &page, field(&page, 3), field(&page, 4)).unwrap();
        assert_eq!(
            ready(src.head(&Principal::ControlPlane, &c)).unwrap(),
            ready(dst.head(&Principal::ControlPlane, &c)).unwrap()
        );
        assert_eq!(meta(&dst, &c).used_bytes, original.used_bytes);
        assert_eq!(
            ready(dst.get_object(
                &Principal::ControlPlane,
                GetObjectParams {
                    collection: c,
                    address,
                    range: None,
                },
                NOW + 100
            ))
            .unwrap()
            .bytes
            .unwrap()
            .0,
            bytes
        );
    }
}

#[test]
fn wrong_final_head_or_chain_cannot_activate_or_partially_commit() {
    let (cp, _, c, page) = source();
    let dst = svc(&cp);
    start(&dst, c, &page, field(&page, 7)).unwrap();
    let before = meta(&dst, &c);
    for (head, chain) in [
        (Cbor::Uint(2), field(&page, 4)),
        (field(&page, 3), B32([0; 32]).to_cbor()),
    ] {
        let err = complete(&dst, c, &page, head, chain).unwrap_err();
        assert_eq!(err.reason.as_deref(), Some("restore_head"));
        assert_eq!(meta(&dst, &c), before);
    }
    complete(&dst, c, &page, field(&page, 3), field(&page, 4)).unwrap();
}

#[test]
fn settings_are_strict_empty_target_only_and_control_plane_only() {
    let (cp, _, c, page) = source();
    for settings in [
        Cbor::Null,
        Cbor::Array(vec![]),
        Cbor::Array(vec![
            Cbor::Uint(2),
            Cbor::Array(vec![Cbor::Uint(1); 4]),
            Cbor::Uint(30),
            Cbor::Uint(0),
        ]),
        Cbor::Array(vec![
            Cbor::Uint(1),
            Cbor::Array(vec![Cbor::Uint(1); 4]),
            Cbor::Uint(7),
            Cbor::Uint(0),
        ]),
        Cbor::Array(vec![
            Cbor::Uint(1),
            Cbor::Array(vec![Cbor::Uint(1); 4]),
            Cbor::Uint(30),
            Cbor::Uint(u64::MAX),
        ]),
    ] {
        let dst = svc(&cp);
        assert_eq!(
            start(&dst, c, &page, settings).unwrap_err().code,
            Code::Invalid
        );
        let mut tx = ready(dst.backend.begin(&c, Mode::Read)).unwrap();
        assert!(ready(tx.load()).unwrap().is_none());
    }
    let dst = svc(&cp);
    let device = Principal::Device {
        id: id16("intruder"),
        sign_pk: B32([7; 32]),
        collection: Some(c),
    };
    assert_eq!(
        ready(dst.call(
            &device,
            "import",
            &map(vec![
                (0, c.to_cbor()),
                (1, field(&page, 0)),
                (3, field(&page, 7)),
            ]),
            NOW
        ))
        .unwrap_err()
        .code,
        Code::Forbidden
    );
    start(&dst, c, &page, field(&page, 7)).unwrap();
    let before = meta(&dst, &c);
    assert_eq!(
        start(&dst, c, &page, field(&page, 7))
            .unwrap_err()
            .reason
            .as_deref(),
        Some("restore_settings")
    );
    assert_eq!(meta(&dst, &c), before);
}

#[test]
fn source_quota_is_enforced_at_final_object_commit() {
    let (cp, _, c, page) = source();
    let dst = svc(&cp);
    let Cbor::Array(mut settings) = field(&page, 7) else {
        panic!()
    };
    let Cbor::Array(ref mut quota) = settings[1] else {
        panic!()
    };
    quota[0] = Cbor::Uint(0);
    start(&dst, c, &page, Cbor::Array(settings)).unwrap();
    let before = meta(&dst, &c);
    let bytes = object(c, ItemKind::BlobPart, 0, vec![42; 64]);
    let address = sha256(&bytes);
    let err = ready(dst.call(
        &Principal::ControlPlane,
        "import_object",
        &map(vec![
            (0, c.to_cbor()),
            (1, address.to_cbor()),
            (2, Cbor::Uint(18)),
            (3, Cbor::Bytes(bytes)),
        ]),
        NOW,
    ))
    .unwrap_err();
    assert_eq!(err.code, Code::QuotaExceeded);
    assert_eq!(meta(&dst, &c), before);
    let mut tx = ready(dst.backend.begin(&c, Mode::Read)).unwrap();
    assert_eq!(ready(tx.objects(&[address])).unwrap(), vec![None]);
}

#[test]
fn legacy_import_without_settings_still_uses_default_quota() {
    let (cp, _, c, page) = source();
    let dst = svc(&cp);
    ready(dst.call(
        &Principal::ControlPlane,
        "import",
        &map(vec![(0, c.to_cbor()), (1, field(&page, 0))]),
        NOW,
    ))
    .unwrap();
    assert_eq!(meta(&dst, &c).quotas, Quotas::default());
    ready(dst.call(
        &Principal::ControlPlane,
        "import",
        &map(vec![
            (0, c.to_cbor()),
            (1, Cbor::Array(vec![])),
            (2, map(vec![(0, field(&page, 5))])),
        ]),
        NOW,
    ))
    .unwrap();
    assert_eq!(meta(&dst, &c).status, Status::Live);
}
