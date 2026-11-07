//! A row written before the file-bytes counter derives it from committed objects.
use std::future::Future;
use std::task::{Context, Poll, Waker};

use mdbn_log_service::auth::Principal;
use mdbn_log_service::mem::{MemBackend, MemObjects};
use mdbn_log_service::testkit::{ControlPlane, Device, id16, object};
use mdbn_log_service::{Backend, Config, Mode, Service, Txn, Write};
use mdbn_wire::cbor::Cbor;
use mdbn_wire::common::{Bytes, Uuid};
use mdbn_wire::envelope::ItemKind;
use mdbn_wire::hash::sha256;
use mdbn_wire::log_service::{AppendParams, PutObjectParams};
use mdbn_wire::policy::DeviceKind;
use mdbn_wire::schema::Wire;

const NOW: i64 = 1_000;

fn ready<T>(f: impl Future<Output = T>) -> T {
    let mut f = std::pin::pin!(f);
    match f.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
        Poll::Ready(v) => v,
        Poll::Pending => panic!("uncontended operation waited"),
    }
}

struct Fixture {
    svc: Service<MemBackend, MemObjects>,
    collection: Uuid,
    device: Principal,
}

impl Fixture {
    fn new() -> Self {
        let cp = ControlPlane::new("file-bytes");
        let collection = id16("file-bytes/collection");
        let owner = id16("file-bytes/owner");
        let dev = Device::new("file-bytes/device", owner);
        let svc = Service::new(
            MemBackend::default(),
            MemObjects::default(),
            Config {
                roots: vec![cp.root_pk()],
                token_issuers: vec![cp.issuer_pk()],
                url_secret: vec![0x51; 32],
                public_base: "https://fixture.test".into(),
            },
        );
        ready(svc.call(
            &Principal::ControlPlane,
            "create_log",
            &Cbor::Map(vec![
                (Cbor::Uint(0), collection.to_cbor()),
                (Cbor::Uint(1), Cbor::Bytes(cp.genesis(collection, owner))),
            ]),
            NOW,
        ))
        .unwrap();
        let head = ready(svc.head(&Principal::ControlPlane, &collection)).unwrap();
        ready(svc.append(
            &Principal::ControlPlane,
            AppendParams {
                collection,
                expect_seq: head.head + 1,
                expect_prev: head.head_chain,
                items: vec![Bytes(cp.policy_item(
                    collection,
                    head.head + 1,
                    head.head_chain,
                    vec![dev.enrol(DeviceKind::Desktop)],
                    2,
                ))],
            },
            NOW,
        ))
        .unwrap();
        let device = Principal::Device {
            id: dev.id,
            sign_pk: dev.pk(),
            collection: None,
        };
        Self {
            svc,
            collection,
            device,
        }
    }

    fn put(&self, kind: ItemKind, body: &[u8]) -> u64 {
        let bytes = object(self.collection, kind, 0, body.to_vec());
        let address = sha256(&bytes);
        ready(self.svc.put_object(
            &self.device,
            PutObjectParams {
                collection: self.collection,
                address,
                kind,
                size: bytes.len() as u64,
                checksum: address,
                bytes: Some(Bytes(bytes.clone())),
            },
            NOW,
        ))
        .unwrap();
        bytes.len() as u64
    }

    fn reported(&self) -> u64 {
        let out = ready(self.svc.call(
            &Principal::ControlPlane,
            "storage_status",
            &Cbor::Map(vec![(Cbor::Uint(0), self.collection.to_cbor())]),
            NOW,
        ))
        .unwrap();
        let Cbor::Map(fields) = out.result else {
            panic!("storage_status map");
        };
        fields
            .iter()
            .find_map(|(k, v)| match (k, v) {
                (Cbor::Uint(2), Cbor::Uint(n)) => Some(*n),
                _ => None,
            })
            .expect("file bytes")
    }

    fn stored(&self) -> Option<u64> {
        ready(async {
            let mut tx = self
                .svc
                .backend
                .begin(&self.collection, Mode::Read)
                .await
                .unwrap();
            tx.load().await.unwrap().unwrap().meta.file_bytes
        })
    }

    fn forget_counter(&self) {
        ready(async {
            let mut tx = self
                .svc
                .backend
                .begin(&self.collection, Mode::Write)
                .await
                .unwrap();
            let mut meta = tx.load().await.unwrap().unwrap().meta;
            meta.file_bytes = None;
            tx.write(Write::PutMeta(meta));
            tx.commit().await.unwrap();
        });
    }
}

#[test]
fn only_blob_parts_count() {
    let f = Fixture::new();
    let blob = f.put(ItemKind::BlobPart, b"attachment");
    f.put(ItemKind::Chunk, b"snapshot chunk");
    assert_eq!(f.reported(), blob);
    assert_eq!(f.stored(), Some(blob));
}

#[test]
fn a_row_without_the_counter_derives_it_then_keeps_it() {
    let f = Fixture::new();
    let first = f.put(ItemKind::BlobPart, b"before the counter");
    f.put(ItemKind::Chunk, b"snapshot chunk");
    f.forget_counter();

    assert_eq!(f.reported(), first);
    assert_eq!(f.stored(), None, "a read never writes");

    f.put(ItemKind::Chunk, b"another snapshot chunk");
    assert_eq!(f.stored(), None, "only a blob commit settles the counter");

    let second = f.put(ItemKind::BlobPart, b"after the counter");
    assert_eq!(f.stored(), Some(first + second));
    assert_eq!(f.reported(), first + second);
}
