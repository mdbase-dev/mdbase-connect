//! Public real service regression: signed cloud-copy policy/service devices.
//! Memory transport only; wraps are opaque and no LAB/provider data is used.
use mdbn_log_service::{
    Code, Config, Service, ServiceError,
    auth::Principal,
    backend::{Backend, Mode, Txn, Write},
    mem::{MemBackend, MemObjects},
    testkit::{ControlPlane, Device, id16, sign_digest},
};
use mdbn_wire::{
    cbor::Cbor,
    common::{B16, B32, Bytes},
    envelope::{Item, ItemKind, KeyGrantPayload, KeyWrap},
    log_service::{AppendParams, HeadResult},
    policy::{CState, DeviceKind, Genesis, PolicyOp},
    schema::Wire,
};
use std::{
    future::Future,
    sync::Arc,
    task::{Context, Poll, Wake, Waker},
};
struct NoWake;
impl Wake for NoWake {
    fn wake(self: Arc<Self>) {}
}
fn ready<F: Future>(f: F) -> F::Output {
    let w = Waker::from(Arc::new(NoWake));
    match std::pin::pin!(f)
        .as_mut()
        .poll(&mut Context::from_waker(&w))
    {
        Poll::Ready(r) => r,
        Poll::Pending => panic!("uncontended fixture waited"),
    }
}
struct Fixture {
    service: Service<MemBackend, MemObjects>,
    cp: ControlPlane,
    col: B16,
    hosted: Device,
    escrow: Device,
    user: Device,
}
impl Fixture {
    fn new() -> Self {
        let cp = ControlPlane::new("hosted-cloud-grant");
        let hosted = Device::new("hosted-grant-service", B16([0; 16]));
        let escrow = Device::new("escrow-grant-service", B16([0; 16]));
        let user = Device::new("approved-user-device", id16("cloud-owner"));
        let col = id16("cloud-grant-collection");
        let service = Service::new(
            MemBackend::default(),
            MemObjects::default(),
            Config {
                roots: vec![cp.root_pk()],
                token_issuers: vec![cp.issuer_pk()],
                url_secret: vec![65; 32],
                public_base: "http://127.0.0.1".into(),
            },
        );
        let genesis = cp.policy_item(
            col,
            1,
            B32([0; 32]),
            vec![
                PolicyOp::Genesis(Genesis {
                    owner: user.account,
                    root: mdbn_log_service::policy::key_id(&cp.root_pk()),
                    state: CState::CloudCopy,
                }),
                hosted.enrol(DeviceKind::Hosted),
                escrow.enrol(DeviceKind::Escrow),
            ],
            1,
        );
        ready(service.call(
            &Principal::ControlPlane,
            "create_log",
            &Cbor::Map(vec![
                (Cbor::Uint(0), col.to_cbor()),
                (Cbor::Uint(1), Cbor::Bytes(genesis)),
            ]),
            1000,
        ))
        .unwrap();
        let f = Self {
            service,
            cp,
            col,
            hosted,
            escrow,
            user,
        };
        let head = f.head();
        f.append(
            &f.principal(&f.hosted),
            f.hosted.rekey(
                col,
                head.head + 1,
                head.head_chain,
                0,
                &[f.hosted.id, f.escrow.id],
            ),
        )
        .unwrap();
        let head = f.head();
        f.append(
            &Principal::ControlPlane,
            f.cp.policy_item(
                col,
                head.head + 1,
                head.head_chain,
                vec![f.user.enrol(DeviceKind::Desktop)],
                2,
            ),
        )
        .unwrap();
        f
    }
    fn head(&self) -> HeadResult {
        ready(self.service.head(&Principal::ControlPlane, &self.col)).unwrap()
    }
    fn principal(&self, d: &Device) -> Principal {
        Principal::Device {
            id: d.id,
            sign_pk: d.pk(),
            collection: Some(self.col),
        }
    }
    fn append(&self, p: &Principal, bytes: Vec<u8>) -> Result<(), ServiceError> {
        let h = self.head();
        ready(self.service.append(
            p,
            AppendParams {
                collection: self.col,
                expect_seq: h.head + 1,
                expect_prev: h.head_chain,
                items: vec![Bytes(bytes)],
            },
            1000,
        ))
        .map(|_| ())
    }
    fn grant(&self, d: &Device, epoch: u64) -> Vec<u8> {
        let h = self.head();
        let mut i = Item {
            kind: ItemKind::KeyGrant,
            collection: self.col,
            seq: Some(h.head + 1),
            prev: Some(h.head_chain),
            epoch: None,
            signer: Some(d.id),
            salt: None,
            idem: None,
            refs: None,
            stream: None,
            body: Bytes(
                KeyGrantPayload {
                    recipient: self.user.id,
                    epoch,
                    wrap: KeyWrap {
                        device: self.user.id,
                        enc: B32([5; 32]),
                        ct: Bytes(vec![7; 48]),
                    },
                }
                .to_bytes()
                .unwrap(),
            ),
            sig: None,
        };
        i.sig = Some(sign_digest(d.signing_key(), &i.signed_digest().unwrap()));
        i.to_bytes().unwrap()
    }
    fn alter(&self, edit: impl FnOnce(&mut mdbn_log_service::model::CollectionState)) {
        let mut tx = ready(self.service.backend.begin(&self.col, Mode::Write)).unwrap();
        let mut state = ready(tx.load()).unwrap().unwrap();
        edit(&mut state);
        for entry in state.acl.values() {
            tx.write(Write::UpsertAcl(entry.clone()));
        }
        tx.write(Write::PutMeta(state.meta));
        ready(tx.commit()).unwrap();
    }
}
#[test]
fn hosted_service_account_grants_approved_cloud_copy_user() {
    let f = Fixture::new();
    let before = f.head().head;
    f.append(&f.principal(&f.hosted), f.grant(&f.hosted, 1))
        .unwrap();
    assert_eq!(f.head().head, before + 1);
}
#[test]
fn escrow_fallback_remains_authorized() {
    let f = Fixture::new();
    f.append(&f.principal(&f.escrow), f.grant(&f.escrow, 1))
        .unwrap();
}
#[test]
fn hosted_cloud_grant_keeps_epoch_signature_and_rekey_guards() {
    let f = Fixture::new();
    let error = f
        .append(&f.principal(&f.hosted), f.grant(&f.hosted, 2))
        .unwrap_err();
    assert_eq!(error.code, Code::Invalid);
    assert_eq!(error.reason.as_deref(), Some("epoch"));
    let mut item = Item::from_bytes(&f.grant(&f.hosted, 1)).unwrap();
    item.sig.as_mut().unwrap().0[0] ^= 1;
    let error = f
        .append(&f.principal(&f.hosted), item.to_bytes().unwrap())
        .unwrap_err();
    assert_eq!(error.reason.as_deref(), Some("signature"));
    f.alter(|s| s.meta.rekey_required = true);
    let error = f
        .append(&f.principal(&f.hosted), f.grant(&f.hosted, 1))
        .unwrap_err();
    assert_eq!(error.code, Code::Frozen);
    assert_eq!(error.reason.as_deref(), Some("rekey_required"));
}
#[test]
fn hosted_cloud_grant_keeps_active_device_and_mode_guards() {
    let f = Fixture::new();
    f.alter(|s| s.meta.cstate = 0);
    let error = f
        .append(&f.principal(&f.hosted), f.grant(&f.hosted, 1))
        .unwrap_err();
    assert_eq!(error.code, Code::Forbidden);
    assert_eq!(error.reason.as_deref(), Some("role"));
    f.alter(|s| {
        s.meta.cstate = 1;
        s.acl.get_mut(&f.hosted.id).unwrap().active = false;
    });
    assert_eq!(
        f.append(&f.principal(&f.hosted), f.grant(&f.hosted, 1))
            .unwrap_err()
            .code,
        Code::Forbidden
    );
}
