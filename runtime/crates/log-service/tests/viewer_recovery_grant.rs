//! Recovery viewer self-grant role checks through the public memory service.
//! Real envelope signatures; testkit wraps are opaque fixtures, not HPKE proof.
use std::future::Future;
use std::sync::Arc;
use std::task::{Context, Poll, Wake, Waker};

use mdbn_log_service::auth::Principal;
use mdbn_log_service::backend::{Backend, Mode, Txn, Write};
use mdbn_log_service::mem::{MemBackend, MemObjects};
use mdbn_log_service::testkit::{ControlPlane, Device, id16, sign_digest};
use mdbn_log_service::{Code, Config, Service, ServiceError};
use mdbn_wire::cbor::Cbor;
use mdbn_wire::common::{B16, B32, Bytes, Uuid};
use mdbn_wire::envelope::{Item, ItemKind, KeyGrantPayload, KeyWrap};
use mdbn_wire::log_service::{AppendParams, HeadResult};
use mdbn_wire::policy::{DeviceKind, MemberSet, PolicyOp, Role};
use mdbn_wire::schema::Wire;

struct NoWake;
impl Wake for NoWake {
    fn wake(self: Arc<Self>) {}
}
fn ready<F: Future>(future: F) -> F::Output {
    let waker = Waker::from(Arc::new(NoWake));
    let mut context = Context::from_waker(&waker);
    match std::pin::pin!(future).as_mut().poll(&mut context) {
        Poll::Ready(result) => result,
        Poll::Pending => panic!("uncontended memory fixture waited"),
    }
}

struct Fixture {
    service: Service<MemBackend, MemObjects>,
    cp: ControlPlane,
    collection: Uuid,
    owner: Device,
    user: Device,
    recovery: Device,
    other: Device,
}
impl Fixture {
    fn new() -> Self {
        let cp = ControlPlane::new("viewer-recovery");
        let owner = Device::new("recovery-owner", id16("owner-account"));
        let user = Device::new("recovery-user", id16("viewer-account"));
        let recovery = Device::new("recovery-offline", user.account);
        let other = Device::new("recovery-other", id16("other-account"));
        let collection = id16("viewer-recovery-collection");
        let service = Service::new(
            MemBackend::default(),
            MemObjects::default(),
            Config {
                roots: vec![cp.root_pk()],
                token_issuers: vec![cp.issuer_pk()],
                url_secret: vec![0x41; 32],
                public_base: "http://127.0.0.1".into(),
            },
        );
        ready(service.call(
            &Principal::ControlPlane,
            "create_log",
            &Cbor::Map(vec![
                (Cbor::Uint(0), collection.to_cbor()),
                (
                    Cbor::Uint(1),
                    Cbor::Bytes(cp.genesis(collection, owner.account)),
                ),
            ]),
            1000,
        ))
        .unwrap();
        let f = Self {
            service,
            cp,
            collection,
            owner,
            user,
            recovery,
            other,
        };
        let mut recovery_enrol = f.recovery.enrol(DeviceKind::Recovery);
        if let PolicyOp::DeviceEnrol(enrol) = &mut recovery_enrol {
            enrol.noise_pk = B32([0; 32]);
        }
        let head = f.head();
        let policy = f.cp.policy_item(
            collection,
            head.head + 1,
            head.head_chain,
            vec![
                PolicyOp::MemberSet(MemberSet {
                    account: f.user.account,
                    role: Role::Viewer,
                }),
                PolicyOp::MemberSet(MemberSet {
                    account: f.other.account,
                    role: Role::Viewer,
                }),
                f.owner.enrol(DeviceKind::Desktop),
                f.user.enrol(DeviceKind::Desktop),
                recovery_enrol,
                f.other.enrol(DeviceKind::Desktop),
            ],
            1,
        );
        f.append(&Principal::ControlPlane, policy).unwrap();
        let head = f.head();
        f.append(
            &f.principal(&f.owner),
            f.owner.rekey(
                collection,
                head.head + 1,
                head.head_chain,
                0,
                &[f.owner.id, f.user.id, f.recovery.id, f.other.id],
            ),
        )
        .unwrap();
        f
    }
    fn principal(&self, device: &Device) -> Principal {
        Principal::Device {
            id: device.id,
            sign_pk: device.pk(),
            collection: Some(self.collection),
        }
    }
    fn head(&self) -> HeadResult {
        ready(
            self.service
                .head(&Principal::ControlPlane, &self.collection),
        )
        .unwrap()
    }
    fn append(&self, principal: &Principal, bytes: Vec<u8>) -> Result<(), ServiceError> {
        let head = self.head();
        ready(self.service.append(
            principal,
            AppendParams {
                collection: self.collection,
                expect_seq: head.head + 1,
                expect_prev: head.head_chain,
                items: vec![Bytes(bytes)],
            },
            1000,
        ))
        .map(|_| ())
    }
    fn grant(&self, signer: &Device, recipient: Uuid, wrap_device: Uuid, epoch: u64) -> Vec<u8> {
        let head = self.head();
        let mut item = Item {
            kind: ItemKind::KeyGrant,
            collection: self.collection,
            seq: Some(head.head + 1),
            prev: Some(head.head_chain),
            epoch: None,
            signer: Some(signer.id),
            salt: None,
            idem: None,
            refs: None,
            stream: None,
            body: Bytes(
                KeyGrantPayload {
                    recipient,
                    epoch,
                    wrap: KeyWrap {
                        device: wrap_device,
                        enc: B32([5; 32]),
                        ct: Bytes(vec![7; 48]),
                    },
                }
                .to_bytes()
                .unwrap(),
            ),
            sig: None,
        };
        item.sig = Some(sign_digest(
            signer.signing_key(),
            &item.signed_digest().unwrap(),
        ));
        item.to_bytes().unwrap()
    }
    fn alter(&self, edit: impl FnOnce(&mut mdbn_log_service::model::CollectionState)) {
        let mut tx = ready(self.service.backend.begin(&self.collection, Mode::Write)).unwrap();
        let mut state = ready(tx.load()).unwrap().unwrap();
        edit(&mut state);
        for entry in state.acl.values() {
            tx.write(Write::UpsertAcl(entry.clone()));
        }
        tx.write(Write::PutMeta(state.meta));
        ready(tx.commit()).unwrap();
    }
    fn refused(&self, bytes: Vec<u8>, code: Code, reason: &str) {
        let before = self.head();
        let error = self.append(&self.principal(&self.user), bytes).unwrap_err();
        assert_eq!(error.code, code);
        assert_eq!(error.reason.as_deref(), Some(reason));
        assert_eq!(self.head(), before, "refusal changed head/chain/state");
    }
}

#[test]
fn recovery_viewer_can_grant_each_own_active_user_device_kind() {
    for kind in 0..=3 {
        let f = Fixture::new();
        f.alter(|state| state.acl.get_mut(&f.user.id).unwrap().kind = kind);
        let before = f.head();
        f.append(
            &f.principal(&f.user),
            f.grant(&f.recovery, f.user.id, f.user.id, 1),
        )
        .unwrap();
        assert_eq!(f.head().head, before.head + 1);
        let mut tx = ready(f.service.backend.begin(&f.collection, Mode::Read)).unwrap();
        assert_eq!(ready(tx.load()).unwrap().unwrap().meta.epoch, 1);
    }
}

#[test]
fn recovery_viewer_refuses_other_account_missing_inactive_and_nonuser_recipients() {
    let f = Fixture::new();
    f.refused(
        f.grant(&f.recovery, f.other.id, f.other.id, 1),
        Code::Forbidden,
        "role",
    );
    f.refused(
        f.grant(&f.recovery, id16("missing"), id16("missing"), 1),
        Code::Forbidden,
        "role",
    );
    f.refused(
        f.grant(&f.recovery, f.recovery.id, f.recovery.id, 1),
        Code::Forbidden,
        "role",
    );
    for kind in [4, 5, 6, 7] {
        let f = Fixture::new();
        f.alter(|state| state.acl.get_mut(&f.user.id).unwrap().kind = kind);
        // Use owner as the transport uploader; signer remains the viewer recovery.
        let before = f.head();
        let error = f
            .append(
                &f.principal(&f.owner),
                f.grant(&f.recovery, f.user.id, f.user.id, 1),
            )
            .unwrap_err();
        assert_eq!(error.code, Code::Forbidden);
        assert_eq!(error.reason.as_deref(), Some("role"));
        assert_eq!(f.head(), before);
    }
    let f = Fixture::new();
    f.alter(|state| state.acl.get_mut(&f.other.id).unwrap().account = f.user.account);
    f.alter(|state| state.acl.get_mut(&f.other.id).unwrap().active = false);
    f.refused(
        f.grant(&f.recovery, f.other.id, f.other.id, 1),
        Code::Forbidden,
        "role",
    );
}

#[test]
fn recovery_viewer_preserves_epoch_rekey_required_and_exact_recipient_guards() {
    let f = Fixture::new();
    f.refused(
        f.grant(&f.recovery, f.user.id, f.other.id, 1),
        Code::Forbidden,
        "role",
    );
    f.refused(
        f.grant(&f.recovery, f.user.id, f.user.id, 0),
        Code::Invalid,
        "epoch",
    );
    f.alter(|state| state.meta.rekey_required = true);
    f.refused(
        f.grant(&f.recovery, f.user.id, f.user.id, 1),
        Code::Frozen,
        "rekey_required",
    );
}

#[test]
fn ordinary_viewer_and_nonmember_or_revoked_recovery_do_not_gain_role_authority() {
    let f = Fixture::new();
    f.refused(
        f.grant(&f.user, f.user.id, f.user.id, 1),
        Code::Forbidden,
        "role",
    );
    f.alter(|state| {
        state.meta.members.remove(&f.user.account);
    });
    f.refused(
        f.grant(&f.recovery, f.user.id, f.user.id, 1),
        Code::Forbidden,
        "role",
    );
    let f = Fixture::new();
    f.alter(|state| state.acl.get_mut(&f.recovery.id).unwrap().active = false);
    f.refused(
        f.grant(&f.recovery, f.user.id, f.user.id, 1),
        Code::Forbidden,
        "revoked",
    );
}

#[test]
fn recovery_viewer_still_cannot_append_ordinary_entry() {
    let f = Fixture::new();
    let head = f.head();
    f.refused(
        f.recovery.entry(
            f.collection,
            head.head + 1,
            head.head_chain,
            1,
            B16([1; 16]),
            None,
            vec![1],
        ),
        Code::Forbidden,
        "role",
    );
}

#[test]
fn transport_rekey_existing_active_signer_requirements_are_unchanged() {
    // This transport predicate historically checks active signer/signature,
    // from/epoch and active wraps, not writer role. Preserve it in this narrow
    // key-grant change; Replica's cryptographic rekey legality is separate.
    let f = Fixture::new();
    let head = f.head();
    f.append(
        &f.principal(&f.user),
        f.recovery.rekey(
            f.collection,
            head.head + 1,
            head.head_chain,
            1,
            &[f.owner.id, f.user.id, f.recovery.id, f.other.id],
        ),
    )
    .unwrap();
    assert_eq!(f.head().head, head.head + 1);
}

#[test]
fn rejected_recovery_grant_keeps_an_entire_mixed_append_atomic() {
    let f = Fixture::new();
    let head = f.head();
    let idem = B16([0x71; 16]);
    let first = f.owner.entry(
        f.collection,
        head.head + 1,
        head.head_chain,
        1,
        idem,
        None,
        vec![1],
    );
    let mut second = Item::from_bytes(&f.grant(&f.recovery, f.other.id, f.other.id, 1)).unwrap();
    second.seq = Some(head.head + 2);
    second.prev = Some(mdbn_wire::hash::chain_hash(&first));
    second.sig = Some(sign_digest(
        f.recovery.signing_key(),
        &second.signed_digest().unwrap(),
    ));
    let mut tx = ready(f.service.backend.begin(&f.collection, Mode::Read)).unwrap();
    let before = ready(tx.load()).unwrap().unwrap();
    drop(tx);
    let error = ready(f.service.append(
        &f.principal(&f.owner),
        AppendParams {
            collection: f.collection,
            expect_seq: head.head + 1,
            expect_prev: head.head_chain,
            items: vec![Bytes(first), Bytes(second.to_bytes().unwrap())],
        },
        1000,
    ))
    .unwrap_err();
    assert_eq!(error.code, Code::Forbidden);
    assert_eq!(error.reason.as_deref(), Some("role"));
    let mut tx = ready(f.service.backend.begin(&f.collection, Mode::Read)).unwrap();
    assert_eq!(ready(tx.load()).unwrap().unwrap(), before);
    assert!(
        ready(tx.items(head.head, 10, 1024 * 1024, false))
            .unwrap()
            .is_empty()
    );
    assert_eq!(ready(tx.tokens(&[idem], 1000)).unwrap(), vec![None]);
}

#[test]
fn existing_writer_key_grant_is_unchanged() {
    let f = Fixture::new();
    f.append(
        &f.principal(&f.owner),
        f.grant(&f.owner, f.other.id, f.other.id, 1),
    )
    .unwrap();
}
