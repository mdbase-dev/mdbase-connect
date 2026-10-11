//! Initial native identity provenance only, not current CP/phase/serving proof.
//! Synthetic real signers; memory service/actual session and crypto APIs.
use mdbn_log_service::auth::{self, NonceCache, Principal};
use mdbn_log_service::decode::Budget;
use mdbn_log_service::hub::{Hub, Push};
use mdbn_log_service::mem::{MemBackend, MemObjects};
use mdbn_log_service::model::CommitNotice;
use mdbn_log_service::session::{HubHost, Session, handle_frame};
use mdbn_log_service::testkit::{ControlPlane, Device, id16, key, sign_digest};
use mdbn_log_service::{Config, Service};
use mdbn_wire::cbor::Cbor;
use mdbn_wire::common::{B32, Version};
use mdbn_wire::log_service::{LsFrame, LsHelloParams, LsRequest};
use mdbn_wire::render::hex;
use mdbn_wire::schema::Wire;
use std::future::Future;
use std::sync::Arc;
use std::task::{Context, Poll, Wake, Waker};
const NOW: i64 = 1000;
const SECRET: [u8; 32] = [0x51; 32];
fn hello(device: &Device, token: String, nonce: &[u8; 32]) -> LsHelloParams {
    LsHelloParams {
        version: Version { major: 1, minor: 0 },
        sig: device.hello_sig(nonce, &token),
        token,
        device: Some(device.id),
    }
}
fn cp_hello(cp: &ControlPlane, label: &str, nonce: &[u8; 32]) -> LsHelloParams {
    let token = cp.cp_token(NOW + 10000);
    let signer = key(format!("{label}/policy").as_bytes());
    LsHelloParams {
        version: Version { major: 1, minor: 0 },
        sig: sign_digest(&signer, &auth::hello_digest(nonce, &token)),
        token,
        device: None,
    }
}
fn http_fixture() -> (ControlPlane, Device, String, Vec<u8>, [u8; 32]) {
    let cp = ControlPlane::new("caller/http");
    let d = Device::new("caller/http-device", id16("caller/owner"));
    let c = id16("caller/collection");
    let token = cp.device_token_for(&d, NOW + 10000, Some(c));
    let body = LsFrame::Request(LsRequest {
        id: 1,
        method: "head".into(),
        params: Cbor::Map(vec![(Cbor::Uint(0), c.to_cbor())]),
    })
    .to_bytes()
    .unwrap();
    (cp, d, token, body, auth::http_nonce(&SECRET, NOW, [1; 8]))
}
#[test]
fn hello_retains_exact_original_device_scope_key_issuer_expiry_and_legacy_result() {
    let current = ControlPlane::new("caller/current");
    let next = ControlPlane::new("caller/next");
    let d = Device::new("caller/device", id16("caller/owner"));
    let c = id16("caller/collection");
    let nonce = [7; 32];
    let p = hello(&d, next.device_token_for(&d, NOW + 10000, Some(c)), &nonce);
    let issuers = [current.issuer_pk(), next.issuer_pk()];
    let caller =
        auth::verify_hello_caller_with_budget(&p, &nonce, &issuers, NOW, &Budget::default())
            .unwrap();
    assert_eq!(
        caller.principal(),
        Principal::Device {
            id: d.id,
            sign_pk: d.pk(),
            collection: Some(c)
        }
    );
    assert_eq!(caller.transport_key(), d.pk());
    assert_eq!(caller.issuer_key(), next.issuer_pk());
    assert_eq!(caller.token_collection(), Some(c));
    assert_eq!(caller.expires_at(), NOW + 10000);
    assert_eq!(
        auth::verify_hello(&p, &nonce, &issuers, NOW).unwrap(),
        caller.principal()
    );
    assert_eq!(format!("{caller:?}"), "VerifiedCaller { .. }");
}
#[test]
fn cp_unit_principal_retains_distinct_real_transport_and_issuer_without_device_coercion() {
    let label = "caller/cp";
    let cp = ControlPlane::new(label);
    let nonce = [9; 32];
    let mut p = cp_hello(&cp, label, &nonce);
    let caller = auth::verify_hello_caller_with_budget(
        &p,
        &nonce,
        &[cp.issuer_pk()],
        NOW,
        &Budget::default(),
    )
    .unwrap();
    assert_eq!(caller.principal(), Principal::ControlPlane);
    assert_eq!(
        caller.transport_key(),
        B32(key(b"caller/cp/policy").verifying_key().to_bytes())
    );
    assert_eq!(caller.issuer_key(), cp.issuer_pk());
    assert_ne!(caller.transport_key(), caller.issuer_key());
    assert_eq!(caller.token_collection(), None);
    p.device = Some(id16("caller/impostor"));
    assert!(
        auth::verify_hello_caller_with_budget(
            &p,
            &nonce,
            &[cp.issuer_pk()],
            NOW,
            &Budget::default()
        )
        .is_err()
    );
}
#[test]
fn cp_signed_scope_is_retained_even_when_legacy_principal_is_unit_cp() {
    let cp = ControlPlane::new("caller/scoped-cp");
    let transport = key(b"caller/scoped-cp/policy");
    let issuer = key(b"caller/scoped-cp/issuer");
    let scope = id16("caller/collection");
    let claims = auth::Claims {
        control_plane: true,
        device: None,
        sign_pk: B32(transport.verifying_key().to_bytes()),
        expires_at: NOW + 10000,
        collection: Some(scope),
    };
    let bytes = claims.encode();
    let token = format!(
        "{}.{}",
        hex(&bytes),
        hex(&sign_digest(&issuer, &auth::token_digest(&bytes)).0)
    );
    let nonce = [8; 32];
    let p = LsHelloParams {
        version: Version { major: 1, minor: 0 },
        device: None,
        sig: sign_digest(&transport, &auth::hello_digest(&nonce, &token)),
        token,
    };
    let caller = auth::verify_hello_caller_with_budget(
        &p,
        &nonce,
        &[cp.issuer_pk()],
        NOW,
        &Budget::default(),
    )
    .unwrap();
    assert_eq!(caller.principal(), Principal::ControlPlane);
    assert_eq!(caller.token_collection(), Some(scope));
}

#[test]
fn hello_wrong_issuer_proof_nonce_version_and_expiry_cannot_create_observer() {
    let cp = ControlPlane::new("caller/reject");
    let d = Device::new("caller/reject-device", id16("caller/owner"));
    let nonce = [8; 32];
    let original = hello(&d, cp.device_token(&d, NOW + 10000), &nonce);
    let check = |p: &LsHelloParams, n: &[u8; 32], keys: &[B32], now| {
        auth::verify_hello_caller_with_budget(p, n, keys, now, &Budget::default()).is_err()
    };
    assert!(check(
        &original,
        &nonce,
        &[ControlPlane::new("caller/foreign").issuer_pk()],
        NOW
    ));
    assert!(check(&original, &[6; 32], &[cp.issuer_pk()], NOW));
    assert!(check(&original, &nonce, &[cp.issuer_pk()], NOW + 10000));
    let mut p = original.clone();
    p.sig.0[0] ^= 1;
    assert!(check(&p, &nonce, &[cp.issuer_pk()], NOW));
    p = original.clone();
    p.device = None;
    assert!(check(&p, &nonce, &[cp.issuer_pk()], NOW));
    p = original;
    p.version.major = 2;
    assert!(check(&p, &nonce, &[cp.issuer_pk()], NOW));
}
#[test]
fn http_opaque_preflight_preserves_budget_and_real_proof_replay_semantics() {
    let (cp, d, token, body, nonce) = http_fixture();
    let budget = Budget::default();
    let verified =
        auth::verify_issuer_token_with_budget(&token, &[cp.issuer_pk()], NOW, &budget).unwrap();
    let used = budget.usage();
    let seen = NonceCache::default();
    let c = auth::request_collection(&body);
    let sig = d.http_sig(&nonce, "/v1/rpc", &token, "head", &body);
    let finish = |sig: &str| {
        auth::verify_http_verified_token(
            &token,
            &hex(&nonce),
            sig,
            "/v1/rpc",
            "head",
            &body,
            &c,
            &verified,
            &SECRET,
            &seen,
            NOW,
        )
    };
    assert!(finish(&"00".repeat(64)).is_err());
    let caller = finish(&hex(&sig.0)).unwrap();
    assert_eq!(caller.issuer_key(), cp.issuer_pk());
    assert_eq!(caller.transport_key(), d.pk());
    assert_eq!(
        caller.principal(),
        auth::verify_http(
            &token,
            &hex(&nonce),
            &hex(&sig.0),
            "/v1/rpc",
            "head",
            &body,
            &[cp.issuer_pk()],
            &SECRET,
            &NonceCache::default(),
            NOW
        )
        .unwrap()
    );
    assert_eq!(
        budget.usage(),
        used,
        "finish must not decode token a second time or reset shared allowance"
    );
    assert!(
        finish(&hex(&sig.0)).is_err(),
        "replay after a successful proof still refuses"
    );
}
#[test]
fn exact_token_binding_survives_body_await_without_role_or_header_substitution() {
    let (cp, d, token, body, nonce) = http_fixture();
    let verified =
        auth::verify_issuer_token_with_budget(&token, &[cp.issuer_pk()], NOW, &Budget::default())
            .unwrap();
    let replacement = cp.device_token(&d, NOW + 20000);
    let sig = d.http_sig(&nonce, "/v1/rpc", &replacement, "head", &body);
    let seen = NonceCache::default();
    let c = auth::request_collection(&body);
    let error = auth::verify_http_verified_token(
        &replacement,
        &hex(&nonce),
        &hex(&sig.0),
        "/v1/rpc",
        "head",
        &body,
        &c,
        &verified,
        &SECRET,
        &seen,
        NOW,
    )
    .err()
    .unwrap();
    assert_eq!(error.reason.as_deref(), Some("token"));
    assert!(
        auth::verify_http_verified_token(
            &"x".repeat(16385),
            &hex(&nonce),
            &hex(&sig.0),
            "/v1/rpc",
            "head",
            &body,
            &c,
            &verified,
            &SECRET,
            &seen,
            NOW
        )
        .is_err()
    );
    let sig = d.http_sig(&nonce, "/v1/rpc", &token, "head", &body);
    assert!(
        auth::verify_http_verified_token(
            &token,
            &hex(&nonce),
            &hex(&sig.0),
            "/v1/rpc",
            "head",
            &body,
            &c,
            &verified,
            &SECRET,
            &seen,
            NOW
        )
        .is_ok(),
        "header refusal did not consume nonce"
    );
}
#[test]
fn bound_http_rechecks_expiry_and_all_signed_request_components() {
    let (cp, d, token, body, nonce) = http_fixture();
    let verified =
        auth::verify_issuer_token_with_budget(&token, &[cp.issuer_pk()], NOW, &Budget::default())
            .unwrap();
    let c = auth::request_collection(&body);
    let sig = d.http_sig(&nonce, "/v1/rpc", &token, "head", &body);
    for (path, method, data, collection, secret, now) in [
        ("/other", "head", body.as_slice(), c, SECRET, NOW),
        ("/v1/rpc", "read", body.as_slice(), c, SECRET, NOW),
        ("/v1/rpc", "head", b"changed".as_slice(), c, SECRET, NOW),
        ("/v1/rpc", "head", body.as_slice(), [8; 16], SECRET, NOW),
        ("/v1/rpc", "head", body.as_slice(), c, [1; 32], NOW),
        ("/v1/rpc", "head", body.as_slice(), c, SECRET, NOW + 10000),
    ] {
        assert!(
            auth::verify_http_verified_token(
                &token,
                &hex(&nonce),
                &hex(&sig.0),
                path,
                method,
                data,
                &collection,
                &verified,
                &secret,
                &NonceCache::default(),
                now
            )
            .is_err()
        );
    }
    assert!(
        auth::verify_http_caller_with_budget(
            &token,
            &hex(&nonce),
            &hex(&sig.0),
            "/v1/rpc",
            "head",
            &body,
            &c,
            &[cp.issuer_pk()],
            &SECRET,
            &NonceCache::default(),
            NOW,
            &Budget::default()
        )
        .is_ok()
    );
}
struct NoWake;
impl Wake for NoWake {
    fn wake(self: Arc<Self>) {}
}
fn ready<F: Future>(f: F) -> F::Output {
    let w = Waker::from(Arc::new(NoWake));
    let mut c = Context::from_waker(&w);
    let mut f = std::pin::pin!(f);
    match f.as_mut().poll(&mut c) {
        Poll::Ready(v) => v,
        Poll::Pending => panic!("uncontended memory fixture waited"),
    }
}
struct Host;
impl HubHost for Host {
    fn with_hub<R>(&self, _: &mdbn_wire::common::Uuid, _: impl FnOnce(&mut Hub) -> R) -> R {
        panic!("no hub")
    }
    fn deliver(&self, _: Vec<Push>) {
        panic!("no pushes")
    }
    fn committed(&self, _: &CommitNotice, _: &[(u64, Vec<u8>)]) {
        panic!("no commit")
    }
}
#[test]
fn actual_session_hello_records_ram_proof_and_failed_rehello_clears_only_observer() {
    let label = "caller/session";
    let cp = ControlPlane::new(label);
    let svc = Service::new(
        MemBackend::default(),
        MemObjects::default(),
        Config {
            roots: vec![cp.root_pk()],
            token_issuers: vec![cp.issuer_pk()],
            url_secret: SECRET.to_vec(),
            public_base: "http://127.0.0.1".into(),
        },
    );
    let nonce = [9; 32];
    let mut session = Session::new(1, nonce);
    assert!(session.verified_caller().is_none());
    let p = cp_hello(&cp, label, &nonce);
    let make = |p: &LsHelloParams| {
        LsFrame::Request(LsRequest {
            id: 1,
            method: "hello".into(),
            params: p.to_cbor(),
        })
        .to_bytes()
        .unwrap()
    };
    let bytes = ready(handle_frame(
        &svc,
        &Host,
        &mut session,
        &make(&p),
        NOW,
        [10; 32],
    ))
    .unwrap();
    let LsFrame::Response(r) = LsFrame::from_bytes(&bytes).unwrap() else {
        panic!("response")
    };
    assert!(r.error.is_none());
    assert_eq!(
        session.verified_caller().unwrap().issuer_key(),
        cp.issuer_pk()
    );
    assert_eq!(session.principal, Some(Principal::ControlPlane));
    let old = session.principal;
    let mut changed = session.clone();
    let device = Device::new("caller/session-device", id16("caller/owner"));
    changed.principal = Some(Principal::Device {
        id: device.id,
        sign_pk: device.pk(),
        collection: None,
    });
    assert!(
        changed.verified_caller().is_none(),
        "a bare host principal cannot replace the verified role"
    );
    let bytes = ready(handle_frame(
        &svc,
        &Host,
        &mut session,
        &make(&p),
        NOW,
        [11; 32],
    ))
    .unwrap();
    let LsFrame::Response(r) = LsFrame::from_bytes(&bytes).unwrap() else {
        panic!("response")
    };
    assert!(r.error.is_some());
    assert!(session.verified_caller().is_none());
    assert_eq!(
        session.principal, old,
        "ordinary failed-rehello principal semantics preserved"
    );
}
#[test]
fn bare_or_restored_public_principal_does_not_fabricate_session_proof() {
    let mut s = Session::new(1, [1; 32]);
    s.principal = Some(Principal::ControlPlane);
    assert!(s.verified_caller().is_none());
}
