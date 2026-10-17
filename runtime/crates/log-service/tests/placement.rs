//! A collection's region: chosen once at creation, persisted with the collection,
//! and bound into its direct-transfer URLs (which pick the bucket). A collection
//! with no region keeps the original URL format. Hermetic Mem tests.
use std::future::Future;
use std::task::{Context, Poll, Waker};

use mdbn_log_service::auth::Principal;
use mdbn_log_service::mem::{MemBackend, MemObjects};
use mdbn_log_service::model::CollectionMeta;
use mdbn_log_service::placement::Region;
use mdbn_log_service::service::verify_direct;
use mdbn_log_service::testkit::{ControlPlane, Device, id16, object};
use mdbn_log_service::{Backend, Config, Mode, Service, Txn};
use mdbn_wire::cbor::Cbor;
use mdbn_wire::common::{Bytes, Uuid};
use mdbn_wire::envelope::ItemKind;
use mdbn_wire::hash::sha256;
use mdbn_wire::log_service::{AppendParams, PutObjectParams};
use mdbn_wire::policy::DeviceKind;
use mdbn_wire::schema::Wire;

type Svc = Service<MemBackend, MemObjects>;
const NOW: i64 = 1_000;
const SECRET: [u8; 32] = [0x5a; 32];

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
fn text(s: &str) -> Cbor {
    Cbor::Text(s.into())
}

struct Fixture {
    svc: Svc,
    cp: ControlPlane,
    dev: Device,
    c: Uuid,
}

impl Fixture {
    fn new(label: &str, default: Option<Region>) -> Self {
        let cp = ControlPlane::new(label);
        let svc = Service::new(
            MemBackend::default(),
            MemObjects::default(),
            Config {
                roots: vec![cp.root_pk()],
                token_issuers: vec![cp.issuer_pk()],
                url_secret: SECRET.to_vec(),
                public_base: "https://placement.invalid".into(),
            },
        )
        .with_default_region(default);
        let dev = Device::new(label, id16("placement/owner"));
        Fixture {
            svc,
            cp,
            dev,
            c: id16(label),
        }
    }
    fn create(&self, placement: Option<Cbor>) -> Result<(), mdbn_log_service::ServiceError> {
        self.create_reply(placement).map(|_| ())
    }
    /// `create_log`'s reply.
    fn create_reply(
        &self,
        placement: Option<Cbor>,
    ) -> Result<Cbor, mdbn_log_service::ServiceError> {
        let mut params = vec![
            (0, self.c.to_cbor()),
            (1, Cbor::Bytes(self.cp.genesis(self.c, self.dev.account))),
        ];
        params.extend(placement.map(|p| (2, p)));
        ready(
            self.svc
                .call(&Principal::ControlPlane, "create_log", &map(params), NOW),
        )
        .map(|o| o.result)
    }
    fn meta(&self) -> CollectionMeta {
        ready(async {
            let mut tx = self.svc.backend.begin(&self.c, Mode::Read).await.unwrap();
            tx.load().await.unwrap().unwrap().meta
        })
    }
    fn region(&self) -> Option<Region> {
        let meta = self.meta();
        // Persisted with the row: survives the backends' one-value encoding.
        assert_eq!(
            CollectionMeta::decode(&meta.encode()).unwrap().region,
            meta.region
        );
        meta.region
    }
    /// Enrol the device and ask for a direct upload URL.
    fn upload_url(&self) -> String {
        let h = ready(self.svc.head(&Principal::ControlPlane, &self.c)).unwrap();
        ready(self.svc.append(
            &Principal::ControlPlane,
            AppendParams {
                collection: self.c,
                expect_seq: h.head + 1,
                expect_prev: h.head_chain,
                items: vec![Bytes(self.cp.policy_item(
                    self.c,
                    2,
                    h.head_chain,
                    vec![self.dev.enrol(DeviceKind::Desktop)],
                    2,
                ))],
            },
            NOW,
        ))
        .unwrap();
        let bytes = object(self.c, ItemKind::BlobPart, 1, vec![9; 70_000]);
        let address = sha256(&bytes);
        let p = Principal::Device {
            id: self.dev.id,
            sign_pk: self.dev.pk(),
            collection: Some(self.c),
        };
        let put = ready(self.svc.put_object(
            &p,
            PutObjectParams {
                collection: self.c,
                address,
                kind: ItemKind::BlobPart,
                size: bytes.len() as u64,
                checksum: address,
                bytes: None,
            },
            NOW,
        ))
        .unwrap();
        put.direct.expect("large object goes direct").url
    }
}

fn verify(url: &str) -> Result<Option<Region>, mdbn_log_service::ServiceError> {
    let (path, query) = url.split_once('?').unwrap();
    let mut parts = path.rsplit('/');
    let (a, c) = (parts.next().unwrap(), parts.next().unwrap());
    verify_direct(&SECRET, c, a, query, NOW).map(|op| op.region)
}

#[test]
fn explicit_region_is_recorded_and_bound_into_direct_urls() {
    let f = Fixture::new("placement/explicit", Some(Region::Oc));
    f.create(Some(map(vec![(0, text("wnam")), (1, text("AU"))])))
        .unwrap();
    assert_eq!(f.region(), Some(Region::Wnam));
    let url = f.upload_url();
    assert!(url.contains("&r=wnam&"), "{url}");
    assert_eq!(verify(&url).unwrap(), Some(Region::Wnam));
    // The region is MAC-bound: pointing the URL at another bucket is refused,
    // and so is dropping it.
    assert!(verify(&url.replace("&r=wnam", "&r=weur")).is_err());
    assert!(verify(&url.replace("&r=wnam", "")).is_err());
}

#[test]
fn location_then_default_chooses_the_region() {
    let geo = Fixture::new("placement/geo", Some(Region::Oc));
    geo.create(Some(map(vec![(1, text("DE"))]))).unwrap();
    assert_eq!(geo.region(), Some(Region::Weur));
    let fallback = Fixture::new("placement/default", Some(Region::Oc));
    fallback.create(None).unwrap();
    assert_eq!(fallback.region(), Some(Region::Oc));
    let explicit_default = Fixture::new("placement/explicit-default", Some(Region::Apac));
    explicit_default
        .create(Some(map(vec![(0, text("default")), (1, text("US"))])))
        .unwrap();
    assert_eq!(explicit_default.region(), Some(Region::Apac));
}

#[test]
fn unknown_region_refuses_creation() {
    let f = Fixture::new("placement/unknown", Some(Region::Oc));
    assert!(f.create(Some(map(vec![(0, text("sam"))]))).is_err());
    assert!(ready(f.svc.head(&Principal::ControlPlane, &f.c)).is_err());
}

#[test]
fn regionless_collection_keeps_original_behaviour() {
    let f = Fixture::new("placement/legacy", None);
    f.create(None).unwrap();
    assert_eq!(f.region(), None);
    let url = f.upload_url();
    assert!(!url.contains("&r="), "{url}");
    assert_eq!(verify(&url).unwrap(), None);
}

/// `create_log` key 2 of a reply.
fn reply_region(reply: &Cbor) -> Option<&str> {
    let Cbor::Map(m) = reply else {
        panic!("reply {reply:?}")
    };
    m.iter()
        .find(|(k, _)| *k == Cbor::Uint(2))
        .map(|(_, v)| match v {
            Cbor::Text(t) => t.as_str(),
            _ => panic!("region {v:?}"),
        })
}

#[test]
fn create_log_reports_the_recorded_region_also_on_retry() {
    // Fallback to the default is reported, so a caller never has to guess.
    let f = Fixture::new("placement/reply", Some(Region::Oc));
    let first = f.create_reply(Some(map(vec![(1, text("DE"))]))).unwrap();
    assert_eq!(reply_region(&first), Some("weur"));
    // A retry with a different placement reports the stored region.
    let retry = f.create_reply(Some(map(vec![(0, text("apac"))]))).unwrap();
    assert_eq!(reply_region(&retry), Some("weur"));
    assert_eq!(f.region(), Some(Region::Weur));
    // A collection without a region keeps the original two-key reply.
    let legacy = Fixture::new("placement/reply-legacy", None);
    let reply = legacy.create_reply(None).unwrap();
    assert_eq!(reply_region(&reply), None);
    assert!(matches!(&reply, Cbor::Map(m) if m.len() == 2));
}
