//! Adversarial corpus. Bounded fixtures, real public service paths.
//! Aggregate cases intentionally fail before request-wide budget threading.

use std::future::Future;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::task::{Context, Poll, Wake, Waker};

use mdbn_log_service::auth::{Principal, hello_digest, token_digest};
use mdbn_log_service::decode::{self, Budget, MAX_BYTES, MAX_NODES, MAX_WORK_BYTES, Usage};
use mdbn_log_service::hub::{Hub, Push};
use mdbn_log_service::mem::{MemBackend, MemObjects};
use mdbn_log_service::model::CommitNotice;
use mdbn_log_service::session::{HubHost, Session, handle_frame};
use mdbn_log_service::testkit::{ControlPlane, Device, id16, key, object, sign_digest};
use mdbn_log_service::{Code, Config, Service, ServiceError};
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::common::{B32, B64, Bytes, Uuid, Version};
use mdbn_wire::envelope::{Item, ItemKind, KeyGrantPayload, KeyWrap};
use mdbn_wire::hash::{chain_hash, sha256};
use mdbn_wire::log_service::{AppendParams, LsFrame, LsHelloParams, LsRequest, LsResponse};
use mdbn_wire::policy::{DeviceKind, Freeze, PolicyOp};
use mdbn_wire::schema::Wire;

const PAD: usize = 2200;
const NOW: i64 = 1000;
type Svc = Service<MemBackend, MemObjects>;

struct NoWake;
impl Wake for NoWake {
    fn wake(self: Arc<Self>) {}
}
fn ready<F: Future>(future: F) -> F::Output {
    let waker = Waker::from(Arc::new(NoWake));
    let mut cx = Context::from_waker(&waker);
    let mut future = std::pin::pin!(future);
    match future.as_mut().poll(&mut cx) {
        Poll::Ready(v) => v,
        Poll::Pending => panic!("uncontended memory fixture unexpectedly waited"),
    }
}
fn map(entries: Vec<(u64, Cbor)>) -> Cbor {
    Cbor::Map(
        entries
            .into_iter()
            .map(|(k, v)| (Cbor::Uint(k), v))
            .collect(),
    )
}
fn pad(raw: &[u8], n: usize) -> Vec<u8> {
    let Cbor::Map(mut fields) = cbor::decode(raw).unwrap() else {
        panic!("struct")
    };
    fields.push((Cbor::Uint(99), Cbor::Array(vec![Cbor::Uint(0); n])));
    cbor::encode(&Cbor::Map(fields)).unwrap()
}
fn individual(raw: &[u8]) {
    assert!(decode::preflight(raw).unwrap().nodes <= MAX_NODES);
}
fn signed_padding(
    raw: &[u8],
    signer: &ed25519_dalek::SigningKey,
    header: usize,
    body: usize,
) -> Vec<u8> {
    let mut item = Item::from_bytes(raw).unwrap();
    if body != 0 {
        item.body = Bytes(pad(&item.body.0, body));
    }
    item.sig = Some(sign_digest(signer, &item.signed_digest().unwrap()));
    let raw = item.to_bytes().unwrap();
    if header == 0 { raw } else { pad(&raw, header) }
}
fn rejected<T>(result: Result<T, ServiceError>) -> ServiceError {
    match result {
        Err(error) => error,
        Ok(_) => panic!("aggregate decode work unexpectedly accepted"),
    }
}
fn budget_error(error: ServiceError) {
    assert_eq!(error.code, Code::Invalid, "{error}");
    assert!(
        error
            .reason
            .as_deref()
            .is_some_and(|r| r.starts_with("cbor_"))
            || error
                .message
                .as_deref()
                .is_some_and(|m| m.contains("cbor_")),
        "wrong rejection: {error}"
    );
}
#[derive(Default)]
struct Host {
    notices: AtomicUsize,
}
impl HubHost for Host {
    fn with_hub<R>(&self, _: &Uuid, _: impl FnOnce(&mut Hub) -> R) -> R {
        panic!("no hub expected")
    }
    fn deliver(&self, _: Vec<Push>) {
        panic!("no push expected")
    }
    fn committed(&self, _: &CommitNotice, _: &[(u64, Vec<u8>)]) {
        self.notices.fetch_add(1, Ordering::SeqCst);
    }
}
struct Fixture {
    svc: Svc,
    cp: ControlPlane,
    dev: Device,
    c: Uuid,
}
impl Fixture {
    fn new(label: &str) -> Self {
        let cp = ControlPlane::new(label);
        let c = id16(label);
        let dev = Device::new(label, id16("sec061/owner"));
        let svc = Service::new(
            MemBackend::default(),
            MemObjects::default(),
            Config {
                roots: vec![cp.root_pk()],
                token_issuers: vec![cp.issuer_pk()],
                url_secret: vec![0x51; 32],
                public_base: "http://127.0.0.1".into(),
            },
        );
        Self { svc, cp, dev, c }
    }
    fn create(&self) {
        ready(self.svc.call(
            &Principal::ControlPlane,
            "create_log",
            &map(vec![
                (0, self.c.to_cbor()),
                (1, Cbor::Bytes(self.cp.genesis(self.c, self.dev.account))),
            ]),
            NOW,
        ))
        .unwrap();
    }
    fn head(&self) -> mdbn_wire::log_service::HeadResult {
        ready(self.svc.head(&Principal::ControlPlane, &self.c)).unwrap()
    }
    fn append(&self, principal: &Principal, raw: Vec<u8>) {
        let h = self.head();
        ready(self.svc.append(
            principal,
            AppendParams {
                collection: self.c,
                expect_seq: h.head + 1,
                expect_prev: h.head_chain,
                items: vec![Bytes(raw)],
            },
            NOW,
        ))
        .unwrap();
    }
    fn principal(&self) -> Principal {
        Principal::Device {
            id: self.dev.id,
            sign_pk: self.dev.pk(),
            collection: Some(self.c),
        }
    }
    fn enrol(&self) {
        self.create();
        let h = self.head();
        self.append(
            &Principal::ControlPlane,
            self.cp.policy_item(
                self.c,
                2,
                h.head_chain,
                vec![self.dev.enrol(DeviceKind::Desktop)],
                2,
            ),
        );
    }
}
fn frame(method: &str, params: Cbor, root_pad: usize) -> Vec<u8> {
    let raw = LsFrame::Request(LsRequest {
        id: 1,
        method: method.into(),
        params,
    })
    .to_bytes()
    .unwrap();
    if root_pad == 0 {
        raw
    } else {
        pad(&raw, root_pad)
    }
}
fn response(f: &Fixture, host: &Host, session: &mut Session, bytes: &[u8]) -> LsResponse {
    let result = ready(handle_frame(&f.svc, host, session, bytes, NOW, [0x62; 32])).unwrap();
    let LsFrame::Response(response) = LsFrame::from_bytes(&result).unwrap() else {
        panic!("response")
    };
    response
}

#[test]
fn budget_clones_share_nodes_and_failed_partial_scans_are_not_refunded() {
    let context = Budget::default();
    let retained = context
        .raw(&cbor::encode(&Cbor::Array(vec![Cbor::Uint(0); 2100])).unwrap())
        .unwrap();
    let alias = context.clone();
    assert_eq!(alias.usage().nodes, 2101);
    let rejected = alias
        .preflight(&cbor::encode(&Cbor::Array(vec![Cbor::Uint(0); 2100])).unwrap())
        .unwrap_err();
    assert_eq!(rejected.reason, "cbor_nodes");
    assert_eq!(
        context.usage().nodes,
        2102,
        "failed container head still charged"
    );
    assert!(matches!(retained, Cbor::Array(ref v) if v.len() == 2100));
    assert!(context.usage().nodes <= MAX_NODES);
    let malformed = [0x81, 0x81];
    assert_eq!(
        alias.preflight(&malformed).unwrap_err().reason,
        "cbor_shape"
    );
    assert!(context.usage().nodes > 2102);
}

#[test]
fn aggregate_encoded_work_is_inclusive_and_opaque_strings_are_not_recursed() {
    // One 16MiB allocation; preflight never materializes it.
    let mut opaque = vec![0x5a, 0, 0xff, 0xff, 0xfb]; // bstr MAX_BYTES-5
    opaque.resize(MAX_BYTES, 0x9f); // deliberately invalid CBOR inside ciphertext
    let context = Budget::default();
    for _ in 0..4 {
        assert_eq!(context.clone().preflight(&opaque).unwrap().nodes, 1);
    }
    assert_eq!(context.usage().work_bytes, MAX_WORK_BYTES);
    assert_eq!(context.preflight(&[0xf6]).unwrap_err().reason, "cbor_work");
    assert_eq!(context.usage().work_bytes, MAX_WORK_BYTES);
    assert_eq!(context.usage().nodes, 4);
}

#[test]
fn simultaneous_clones_retain_values_but_cannot_multiply_request_capacity() {
    let budget = Budget::default();
    let bytes = cbor::encode(&Cbor::Array(vec![Cbor::Uint(0); 1023])).unwrap();
    let retained = std::thread::scope(|scope| {
        let jobs: Vec<_> = (0..4)
            .map(|_| {
                let alias = budget.clone();
                let bytes = &bytes;
                scope.spawn(move || alias.raw(bytes).unwrap())
            })
            .collect();
        jobs.into_iter()
            .map(|job| job.join().unwrap())
            .collect::<Vec<_>>()
    });
    assert!(
        retained
            .iter()
            .all(|v| matches!(v, Cbor::Array(a) if a.len() == 1023))
    );
    assert_eq!(budget.usage().nodes, MAX_NODES);
    assert_eq!(budget.usage().work_bytes, 4 * bytes.len());
    // Typed decoding through another clone must use the exhausted counter,
    // rather than silently resetting it or reporting an unrelated schema error.
    budget_error(budget.clone().wire::<LsFrame>(&[0x00]).unwrap_err());
    assert_eq!(budget.usage().nodes, MAX_NODES);
    assert_eq!(budget.usage().work_bytes, 4 * bytes.len() + 1);
}

#[test]
fn schema_and_profile_failures_keep_admitted_work_charged() {
    let budget = Budget::default();
    // Structurally valid, but non-canonical: integer zero encoded as uint8.
    assert_eq!(budget.raw(&[0x18, 0x00]).unwrap_err().code, Code::Invalid);
    assert_eq!(budget.usage().nodes, 1);
    assert_eq!(budget.usage().work_bytes, 2);
    // Canonical scalar, wrong typed shape. Neither failure refunds its scan.
    assert_eq!(
        budget.clone().wire::<LsFrame>(&[0xf6]).unwrap_err().code,
        Code::Invalid
    );
    assert_eq!(budget.usage().nodes, 2);
    assert_eq!(budget.usage().work_bytes, 3);
    assert_eq!(budget.raw(&[0x00]).unwrap(), Cbor::Uint(0));
    assert_eq!(budget.usage().nodes, 3);
    assert_eq!(budget.usage().work_bytes, 4);
}

#[test]
fn boundary_byte_cap_and_depth_reject_before_materialization() {
    let budget = Budget::default();
    let oversized = vec![0u8; MAX_BYTES + 1];
    let rejected = budget.preflight(&oversized).unwrap_err();
    assert_eq!(rejected.reason, "cbor_bytes");
    assert_eq!(rejected.stats.nodes, 0);
    assert_eq!(budget.usage().nodes, 0);
    assert_eq!(budget.usage().work_bytes, 0);
    drop(oversized);
    let mut deep = vec![0x81; cbor::MAX_DEPTH + 1];
    deep.push(0x00);
    let rejected = budget.preflight(&deep).unwrap_err();
    assert_eq!(rejected.reason, "cbor_depth");
    assert_eq!(budget.usage().nodes, rejected.stats.nodes);
    assert_eq!(budget.usage().depth, cbor::MAX_DEPTH);
    assert_eq!(budget.usage().work_bytes, deep.len());
    assert!(rejected.stats.nodes <= MAX_NODES);
    assert_eq!(
        budget.raw(&[0x00]).unwrap(),
        Cbor::Uint(0),
        "fresh shallow boundary fits remaining resources"
    );
}

#[test]
fn transported_usage_cannot_admit_out_of_range_or_overflowed_counters() {
    for usage in [
        Usage {
            nodes: MAX_NODES + 1,
            ..Usage::default()
        },
        Usage {
            work_bytes: MAX_WORK_BYTES + 1,
            ..Usage::default()
        },
        Usage {
            depth: cbor::MAX_DEPTH + 1,
            ..Usage::default()
        },
        Usage {
            nodes: usize::MAX,
            ..Usage::default()
        },
        Usage {
            work_bytes: usize::MAX,
            ..Usage::default()
        },
        Usage {
            depth: usize::MAX,
            ..Usage::default()
        },
    ] {
        let e = Budget::from_usage(usage).unwrap_err();
        assert_eq!(e.code, Code::Invalid);
        assert_eq!(e.reason.as_deref(), Some("cbor_budget"));
    }
}

#[test]
fn transported_usage_is_spent_not_fresh_and_clones_share_the_remainder() {
    let budget = Budget::from_usage(Usage {
        nodes: MAX_NODES - 1,
        work_bytes: MAX_WORK_BYTES - 1,
        depth: cbor::MAX_DEPTH,
    })
    .unwrap();
    assert_eq!(budget.clone().raw(&[0x00]).unwrap(), Cbor::Uint(0));
    assert_eq!(
        budget.usage(),
        Usage {
            nodes: MAX_NODES,
            work_bytes: MAX_WORK_BYTES,
            depth: cbor::MAX_DEPTH
        }
    );
    assert_eq!(budget.preflight(&[0x00]).unwrap_err().reason, "cbor_work");
    assert_eq!(budget.usage().work_bytes, MAX_WORK_BYTES);
    let node_only = Budget::from_usage(Usage {
        nodes: MAX_NODES,
        ..Usage::default()
    })
    .unwrap();
    assert_eq!(
        node_only.preflight(&[0x00]).unwrap_err().reason,
        "cbor_nodes"
    );
    assert_eq!(node_only.usage().nodes, MAX_NODES);
    assert_eq!(
        node_only.usage().work_bytes,
        1,
        "admitted failed work is not refunded"
    );
}

#[test]
fn security1_resource_refusal_keeps_valid_staged_upload_retryable() {
    use mdbn_log_service::ObjectStore;
    use mdbn_wire::log_service::{CommitObjectParams, PutObjectParams};
    let f = Fixture::new("sec061/s1-stage-refusal");
    f.enrol();
    let bytes = pad(&object(f.c, ItemKind::BlobPart, 1, vec![7; 32]), 1500);
    let address = sha256(&bytes);
    // Positive control: this complete object passes the new fresh upload verifier.
    mdbn_log_service::service::verify_upload(&f.c, &address, &bytes).unwrap();
    let p = f.principal();
    let put = ready(f.svc.put_object(
        &p,
        PutObjectParams {
            collection: f.c,
            address,
            kind: ItemKind::BlobPart,
            size: bytes.len() as u64,
            checksum: address,
            bytes: None,
        },
        NOW,
    ))
    .unwrap();
    assert!(put.direct.is_some());
    let staged = mdbn_log_service::service::staging_key(&f.c, &address, &f.dev.id);
    assert!(ready(f.svc.objects.put_new(&staged, bytes)).unwrap());
    let raw = frame(
        "commit_object",
        CommitObjectParams {
            collection: f.c,
            address,
        }
        .to_cbor(),
        1500,
    );
    individual(&raw);
    let mut session = Session::new(1, [0x61; 32]);
    session.principal = Some(p);
    let r = response(&f, &Host::default(), &mut session, &raw);
    budget_error(ServiceError::from_wire(
        &r.error.expect("aggregate budget must refuse"),
    ));
    let retained = ready(f.svc.objects.get(&staged, None)).unwrap().is_some();
    let retry = ready(f.svc.commit_object(
        &p,
        CommitObjectParams {
            collection: f.c,
            address,
        },
        NOW,
    ))
    .unwrap();
    assert!(
        retained && retry,
        "S1: valid staged object must survive resource refusal and fresh retry; retained={retained}, retry={retry}"
    );
}

#[test]
fn staged_commit_work_refusal_preserves_bytes_but_corruption_still_cleans_up() {
    use mdbn_log_service::ObjectStore;
    use mdbn_log_service::service::{staging_key, verify_upload};
    use mdbn_wire::log_service::CommitObjectParams;
    let f = Fixture::new("sec061/stage-work-integrity");
    f.enrol();
    let p = f.principal();
    let bytes = object(f.c, ItemKind::BlobPart, 1, vec![7; 32]);
    let address = sha256(&bytes);
    verify_upload(&f.c, &address, &bytes).unwrap();
    let staged = staging_key(&f.c, &address, &f.dev.id);
    ready(f.svc.objects.put_new(&staged, bytes.clone())).unwrap();
    let budget = Budget::from_usage(Usage {
        work_bytes: MAX_WORK_BYTES,
        ..Usage::default()
    })
    .unwrap();
    let params = CommitObjectParams {
        collection: f.c,
        address,
    };
    let error = ready(
        f.svc
            .commit_object_with_budget(&p, params.clone(), NOW, &budget),
    )
    .unwrap_err();
    assert_eq!(error.reason.as_deref(), Some("cbor_work"));
    assert_eq!(
        ready(f.svc.objects.get(&staged, None)).unwrap().unwrap(),
        bytes
    );
    assert!(ready(f.svc.commit_object(&p, params, NOW)).unwrap());
    assert!(ready(f.svc.objects.get(&staged, None)).unwrap().is_none());

    // Preserve existing cleanup for genuinely invalid canonical/protocol bytes.
    let corrupt = vec![0xff];
    let address = sha256(&corrupt);
    assert!(verify_upload(&f.c, &address, &corrupt).is_err());
    let staged = staging_key(&f.c, &address, &f.dev.id);
    ready(f.svc.objects.put_new(&staged, corrupt)).unwrap();
    let params = CommitObjectParams {
        collection: f.c,
        address,
    };
    let error = ready(f.svc.commit_object(&p, params.clone(), NOW)).unwrap_err();
    assert_eq!(error.reason.as_deref(), Some("cbor_shape"));
    assert!(ready(f.svc.objects.get(&staged, None)).unwrap().is_none());
    assert!(!ready(f.svc.commit_object(&p, params, NOW)).unwrap());
}

#[test]
fn root_rejects_overbudget_extensions_before_public_dispatch() {
    let f = Fixture::new("sec061/root");
    let host = Host::default();
    let mut session = Session::new(1, [0x61; 32]);
    session.principal = Some(Principal::ControlPlane);
    let raw = frame("head", map(vec![(0, f.c.to_cbor())]), MAX_NODES);
    assert_eq!(decode::preflight(&raw).unwrap_err().reason, "cbor_nodes");
    let r = response(&f, &host, &mut session, &raw);
    assert_eq!(r.error.unwrap().code, "invalid");
    assert_eq!(host.notices.load(Ordering::SeqCst), 0);
    assert_eq!(
        ready(f.svc.head(&Principal::ControlPlane, &f.c))
            .unwrap_err()
            .code,
        Code::NotFound
    );
}

fn hello(f: &Fixture, root_pad: usize, claims_pad: usize, valid_proof: bool) -> Vec<u8> {
    let original = f.cp.cp_token(100_000);
    let (raw, _) = original.split_once('.').unwrap();
    let claims = mdbn_log_service::model::unhex(raw).unwrap();
    let claims = if claims_pad == 0 {
        claims
    } else {
        pad(&claims, claims_pad)
    };
    individual(&claims);
    let issuer = key(b"sec061/auth/issuer");
    let sig = sign_digest(&issuer, &token_digest(&claims));
    let token = format!("{}.{}", mdbn_wire::render::hex(&claims), sig.to_hex());
    let sig = if valid_proof {
        sign_digest(f.cp.transport_key(), &hello_digest(&[0x61; 32], &token))
    } else {
        B64([0; 64])
    };
    frame(
        "hello",
        LsHelloParams {
            version: Version { major: 1, minor: 0 },
            token,
            device: None,
            sig,
        }
        .to_cbor(),
        root_pad,
    )
}
#[test]
fn root_and_signed_auth_claims_cannot_reset_request_budget() {
    let f = Fixture::new("sec061/auth");
    let host = Host::default();
    let mut session = Session::new(1, [0x61; 32]);
    let raw = hello(&f, PAD, PAD, true);
    individual(&raw);
    let r = response(&f, &host, &mut session, &raw);
    budget_error(ServiceError::from_wire(
        &r.error.expect("aggregate root/auth must reject"),
    ));
    assert!(session.principal.is_none());
    assert_eq!(session.nonce, [0x61; 32]);
    assert_eq!(host.notices.load(Ordering::SeqCst), 0);
}
#[test]
fn valid_token_with_unproven_possession_never_admits_or_rotates_session() {
    let f = Fixture::new("sec061/auth");
    let host = Host::default();
    let mut session = Session::new(1, [0x61; 32]);
    let r = response(&f, &host, &mut session, &hello(&f, 0, PAD, false));
    assert_eq!(r.error.unwrap().code, "unauthenticated");
    assert!(session.principal.is_none());
    assert_eq!(session.nonce, [0x61; 32]);
    assert_eq!(host.notices.load(Ordering::SeqCst), 0);
    let r = response(&f, &host, &mut session, &hello(&f, 0, 0, true));
    assert!(r.error.is_none(), "honest authentication must still pass");
    assert!(session.principal.is_some());
}

#[test]
fn small_signed_item_and_policy_extensions_remain_accepted() {
    let f = Fixture::new("sec061/small-extensions");
    let raw = signed_padding(
        &f.cp.genesis(f.c, f.dev.account),
        f.cp.transport_key(),
        80,
        80,
    );
    individual(&raw);
    ready(f.svc.call(
        &Principal::ControlPlane,
        "create_log",
        &map(vec![(0, f.c.to_cbor()), (1, Cbor::Bytes(raw))]),
        NOW,
    ))
    .unwrap();
    let before = f.head();
    assert_eq!(before.head, 1);
    let raw = f.cp.policy_item(
        f.c,
        2,
        before.head_chain,
        vec![PolicyOp::Freeze(Freeze {
            frozen: false,
            reason: None,
        })],
        2,
    );
    let raw = signed_padding(&raw, f.cp.transport_key(), 80, 80);
    f.append(&Principal::ControlPlane, raw);
    assert_eq!(
        f.head().head,
        2,
        "unknown extensions are not categorically forbidden"
    );
}

#[test]
fn malformed_later_append_has_no_prefix_effects() {
    let f = Fixture::new("sec061/malformed-append");
    f.create();
    let before = f.head();
    let valid = f.cp.policy_item(
        f.c,
        2,
        before.head_chain,
        vec![PolicyOp::Freeze(Freeze {
            frozen: true,
            reason: None,
        })],
        2,
    );
    let result = ready(
        f.svc.call(
            &Principal::ControlPlane,
            "append",
            &AppendParams {
                collection: f.c,
                expect_seq: 2,
                expect_prev: before.head_chain,
                items: vec![Bytes(valid), Bytes(vec![0xf6])],
            }
            .to_cbor(),
            NOW,
        ),
    );
    assert_eq!(rejected(result).code, Code::Invalid);
    assert_eq!(
        f.head(),
        before,
        "invalid tail must not persist the valid prefix"
    );
    let valid = f.cp.policy_item(
        f.c,
        2,
        before.head_chain,
        vec![PolicyOp::Freeze(Freeze {
            frozen: false,
            reason: None,
        })],
        2,
    );
    f.append(&Principal::ControlPlane, valid);
}

#[test]
fn malformed_later_import_has_no_genesis_effects() {
    let f = Fixture::new("sec061/malformed-import");
    let params = map(vec![
        (0, f.c.to_cbor()),
        (
            1,
            Cbor::Array(vec![
                Cbor::Array(vec![
                    Cbor::Uint(1),
                    Cbor::Bytes(f.cp.genesis(f.c, f.dev.account)),
                ]),
                Cbor::Array(vec![Cbor::Uint(2), Cbor::Bytes(vec![0xf6])]),
            ]),
        ),
    ]);
    assert_eq!(
        rejected(ready(f.svc.call(
            &Principal::ControlPlane,
            "import",
            &params,
            NOW
        )))
        .code,
        Code::Invalid
    );
    assert_eq!(
        ready(f.svc.head(&Principal::ControlPlane, &f.c))
            .unwrap_err()
            .code,
        Code::NotFound
    );
    f.create();
    assert_eq!(f.head().head, 1);
}

#[test]
fn create_log_shares_item_and_policy_budget_without_creating_state() {
    let f = Fixture::new("sec061/create");
    let raw = signed_padding(
        &f.cp.genesis(f.c, f.dev.account),
        f.cp.transport_key(),
        PAD,
        PAD,
    );
    individual(&raw);
    individual(&Item::from_bytes(&raw).unwrap().body.0);
    let result = ready(f.svc.call(
        &Principal::ControlPlane,
        "create_log",
        &map(vec![(0, f.c.to_cbor()), (1, Cbor::Bytes(raw))]),
        NOW,
    ));
    budget_error(rejected(result));
    assert_eq!(
        ready(f.svc.head(&Principal::ControlPlane, &f.c))
            .unwrap_err()
            .code,
        Code::NotFound
    );
    f.create();
    assert_eq!(f.head().head, 1);
}

#[test]
fn append_batch_cannot_reset_between_individually_legal_items() {
    let f = Fixture::new("sec061/batch");
    f.create();
    let before = f.head();
    let mut prev = before.head_chain;
    let mut items = Vec::new();
    for seq in 2..=3 {
        let raw = f.cp.policy_item(
            f.c,
            seq,
            prev,
            vec![PolicyOp::Freeze(Freeze {
                frozen: false,
                reason: None,
            })],
            seq as i64,
        );
        let raw = signed_padding(&raw, f.cp.transport_key(), PAD, 0);
        individual(&raw);
        prev = chain_hash(&raw);
        items.push(Bytes(raw));
    }
    let params = AppendParams {
        collection: f.c,
        expect_seq: 2,
        expect_prev: before.head_chain,
        items,
    }
    .to_cbor();
    let host = Host::default();
    let mut session = Session::new(1, [0x61; 32]);
    session.principal = Some(Principal::ControlPlane);
    let raw = frame("append", params, 0);
    individual(&raw);
    let r = response(&f, &host, &mut session, &raw);
    budget_error(ServiceError::from_wire(
        &r.error.expect("append aggregate must reject"),
    ));
    assert_eq!(f.head(), before, "no partial append/head/chain effects");
    assert_eq!(host.notices.load(Ordering::SeqCst), 0);
}

#[test]
fn append_rekey_payload_shares_item_budget() {
    nested_control(false);
}
#[test]
fn append_keygrant_payload_shares_item_budget() {
    nested_control(true);
}
fn nested_control(grant: bool) {
    let f = Fixture::new(if grant {
        "sec061/grant"
    } else {
        "sec061/rekey"
    });
    f.enrol();
    if grant {
        let h = f.head();
        f.append(
            &f.principal(),
            f.dev.rekey(f.c, 3, h.head_chain, 0, &[f.dev.id]),
        );
    }
    let before = f.head();
    let raw = if grant {
        Item {
            kind: ItemKind::KeyGrant,
            collection: f.c,
            seq: Some(4),
            prev: Some(before.head_chain),
            epoch: None,
            signer: Some(f.dev.id),
            salt: None,
            idem: None,
            refs: None,
            stream: None,
            body: Bytes(
                KeyGrantPayload {
                    recipient: f.dev.id,
                    epoch: 1,
                    wrap: KeyWrap {
                        device: f.dev.id,
                        enc: B32([5; 32]),
                        ct: Bytes(vec![7; 48]),
                    },
                }
                .to_bytes()
                .unwrap(),
            ),
            sig: None,
        }
        .to_bytes()
        .unwrap()
    } else {
        f.dev.rekey(f.c, 3, before.head_chain, 0, &[f.dev.id])
    };
    let raw = signed_padding(&raw, f.dev.signing_key(), PAD, PAD);
    individual(&raw);
    individual(&Item::from_bytes(&raw).unwrap().body.0);
    let params = AppendParams {
        collection: f.c,
        expect_seq: before.head + 1,
        expect_prev: before.head_chain,
        items: vec![Bytes(raw)],
    };
    let result = ready(f.svc.call(&f.principal(), "append", &params.to_cbor(), NOW));
    budget_error(rejected(result));
    assert_eq!(
        f.head(),
        before,
        "failed nested control leaves epoch/head unchanged"
    );
}

#[test]
fn import_aggregate_failure_never_persists_genesis_or_prefix() {
    let f = Fixture::new("sec061/import");
    let first = signed_padding(
        &f.cp.genesis(f.c, f.dev.account),
        f.cp.transport_key(),
        PAD,
        0,
    );
    let second = f.cp.policy_item(
        f.c,
        2,
        chain_hash(&first),
        vec![PolicyOp::Freeze(Freeze {
            frozen: false,
            reason: None,
        })],
        2,
    );
    let second = signed_padding(&second, f.cp.transport_key(), PAD, 0);
    individual(&first);
    individual(&second);
    let params = map(vec![
        (0, f.c.to_cbor()),
        (
            1,
            Cbor::Array(vec![
                Cbor::Array(vec![Cbor::Uint(1), Cbor::Bytes(first)]),
                Cbor::Array(vec![Cbor::Uint(2), Cbor::Bytes(second)]),
            ]),
        ),
    ]);
    individual(&cbor::encode(&params).unwrap());
    let result = ready(f.svc.call(&Principal::ControlPlane, "import", &params, NOW));
    budget_error(rejected(result));
    assert_eq!(
        ready(f.svc.head(&Principal::ControlPlane, &f.c))
            .unwrap_err()
            .code,
        Code::NotFound
    );
    f.create();
}

#[test]
fn verify_upload_rejects_aggregate_metadata_but_never_decodes_ciphertext() {
    let c = id16("sec061/upload");
    let opaque = cbor::encode(&Cbor::Array(vec![Cbor::Uint(0); MAX_NODES + 1])).unwrap();
    assert!(decode::preflight(&opaque).is_err());
    let honest = object(c, ItemKind::Chunk, 1, opaque);
    let address = sha256(&honest);
    assert!(
        mdbn_log_service::service::verify_upload(&c, &address, &honest).is_ok(),
        "ciphertext remains opaque"
    );
    let aggregate = pad(&honest, PAD);
    individual(&aggregate);
    budget_error(rejected(mdbn_log_service::service::verify_upload(
        &c,
        &sha256(&aggregate),
        &aggregate,
    )));
}
