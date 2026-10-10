//! Offline PG-fallback refusal, without a database, socket, or floor producer.
use super::*;
use mdbn_log_service::{Code, Config, Service, auth::Principal, mem::MemObjects};
use mdbn_wire::cbor::Cbor;

fn unconfigured() -> PgBackend {
    // Pool creation only validates config/allocates in-memory state. No get(),
    // connection, SQL, migrations or native floor producer is invoked.
    PgBackend {
        pool: Pool::new(tokio_postgres::Config::new(), 1).unwrap(),
        notify: NotifyMode::Local,
        independent_floor_reader: None,
    }
}
fn refusal_config() -> Config {
    // No accepted issuer/root and no signer, token, session or URL is used.
    Config {
        roots: vec![],
        token_issuers: vec![],
        url_secret: vec![],
        public_base: "http://127.0.0.1".into(),
    }
}
fn params(c: Uuid) -> Cbor {
    Cbor::Map(vec![(Cbor::Uint(0), Cbor::Bytes(c.0.to_vec()))])
}
#[tokio::test]
async fn pg_floor_default_unknown_is_unavailable_not_authoritative_none() {
    let backend = unconfigured();
    for c in [B16([0; 16]), B16([1; 16]), B16([255; 16])] {
        for _ in 0..2 {
            let error = backend.collection_deletion_floor(&c).await.unwrap_err();
            assert_eq!(error.code, Code::Unavailable);
            assert_eq!(
                error.reason.as_deref(),
                Some("collection_deletion_floor_unavailable")
            );
        }
    }
}
#[tokio::test]
async fn pg_import_and_final_live_requests_refuse_before_sql_or_objects() {
    let svc = Service::new(unconfigured(), MemObjects::default(), refusal_config());
    let c = B16([1; 16]);
    for method in ["create_log", "import", "import_object", "import_snapshot"] {
        let result = svc
            .call(&Principal::ControlPlane, method, &params(c), 1)
            .await;
        assert_eq!(result.unwrap_err().code, Code::Unavailable, "{method}");
    }
    let done = Cbor::Map(vec![
        (Cbor::Uint(0), Cbor::Bytes(c.0.to_vec())),
        (Cbor::Uint(1), Cbor::Array(vec![])),
        (
            Cbor::Uint(2),
            Cbor::Map(vec![(Cbor::Uint(0), Cbor::Uint(1))]),
        ),
    ]);
    assert_eq!(
        svc.call(&Principal::ControlPlane, "import", &done, 1)
            .await
            .unwrap_err()
            .code,
        Code::Unavailable
    );
}
#[tokio::test]
async fn pg_every_positive_transaction_refuses_before_buffered_sql() {
    let c = B16([1; 16]);
    let meta = CollectionMeta::new(c, 1);
    let mut importing = meta.clone();
    importing.status = mdbn_log_service::model::Status::Importing;
    let positive = vec![
        Write::CreateCollection(CollectionState {
            meta: meta.clone(),
            acl: BTreeMap::new(),
        }),
        Write::PutMeta(meta.clone()),
        Write::PutMeta(importing),
        Write::UpsertAcl(AclEntry {
            device: B16([2; 16]),
            account: B16([3; 16]),
            kind: 0,
            sign_pk: B32([4; 32]),
            active: true,
        }),
        Write::InsertItem(StoredItem {
            seq: 1,
            kind: 1,
            bytes: vec![],
            appended_at: 1,
            token: None,
            refs: vec![],
        }),
        Write::PutObject(ObjectMeta {
            address: B32([1; 32]),
            kind: 16,
            size: 1,
            checksum: B32([1; 32]),
            committed: true,
            created_at: 1,
        }),
        Write::InsertSnapshot(SnapshotRow {
            seq: 1,
            manifest: B32([1; 32]),
            author: B16([2; 16]),
            created_at: 1,
            endorsed: false,
            refs: vec![],
        }),
        Write::EndorseSnapshot(1),
        Write::Notify(mdbn_log_service::model::CommitNotice {
            collection: c,
            first: 1,
            head: 1,
            head_chain: B32([1; 32]),
            revoked: vec![],
            gone: false,
        }),
    ];
    for write in positive {
        assert!(publishes(std::slice::from_ref(&write)));
        // No SQL connection exists: reaching commit_writes would panic. This
        // exercises the actual commit guard, not a mocked floor implementation.
        let tx = PgTxn {
            notify: NotifyMode::Local,
            independent_floor_reader: None,
            client: None,
            id: c.0.to_vec(),
            state: None,
            writes: vec![write],
            done: false,
        };
        assert_eq!(tx.commit().await.unwrap_err().code, Code::Unavailable);
    }
}
#[test]
fn pg_denial_cleanup_cannot_hide_a_positive_write() {
    let mut gone = CollectionMeta::new(B16([1; 16]), 1);
    gone.status = mdbn_log_service::model::Status::Gone;
    assert!(!publishes(&[
        Write::PutMeta(gone.clone()),
        Write::DeleteObject(B32([1; 32]))
    ]));
    assert!(publishes(&[
        Write::PutMeta(gone),
        Write::PutMeta(CollectionMeta::new(B16([1; 16]), 1))
    ]));
}
#[tokio::test]
async fn pg_terminal_delete_never_fabricates_floor_from_sql_or_request() {
    let svc = Service::new(unconfigured(), MemObjects::default(), refusal_config());
    let request = Cbor::Map(vec![
        (Cbor::Uint(0), Cbor::Bytes(vec![1; 16])),
        (Cbor::Uint(1), Cbor::Bytes(vec![2; 16])),
        (Cbor::Uint(2), Cbor::Uint(u64::MAX)),
    ]);
    assert_eq!(
        svc.call(&Principal::ControlPlane, "delete_log", &request, 1)
            .await
            .unwrap_err()
            .code,
        Code::Unavailable
    );
}
