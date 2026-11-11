//! A session reaches hub state only for collections it was authorized for:
//! leave and send frames naming any other collection touch no hub.
use mdbn_log_service::hub::{Hub, Push};
use mdbn_log_service::mem::{MemBackend, MemObjects};
use mdbn_log_service::model::CommitNotice;
use mdbn_log_service::session::{HubHost, Session, handle_frame};
use mdbn_log_service::testkit::{ControlPlane, Device, id16};
use mdbn_log_service::{Config, Service};
use mdbn_wire::cbor::Cbor;
use mdbn_wire::common::{B16, Bytes, Uuid, Version};
use mdbn_wire::log_service::{
    LsFrame, LsHelloParams, LsRequest, LsResponse, StreamRef, StreamSendParams,
};
use mdbn_wire::schema::Wire;
use std::cell::RefCell;
use std::future::Future;
use std::sync::Arc;
use std::task::{Context, Poll, Wake, Waker};

const NOW: i64 = 1000;

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

/// Records every collection whose hub a session asked for.
#[derive(Default)]
struct Host {
    hubs: RefCell<Vec<Uuid>>,
}
impl HubHost for Host {
    fn with_hub<R>(&self, c: &Uuid, f: impl FnOnce(&mut Hub) -> R) -> R {
        self.hubs.borrow_mut().push(*c);
        f(&mut Hub::new(*c))
    }
    fn deliver(&self, _: Vec<Push>) {}
    fn committed(&self, _: &CommitNotice, _: &[(u64, Vec<u8>)]) {}
}

fn call(
    svc: &Service<MemBackend, MemObjects>,
    host: &Host,
    s: &mut Session,
    method: &str,
    params: Cbor,
) -> LsResponse {
    let frame = LsFrame::Request(LsRequest {
        id: 1,
        method: method.into(),
        params,
    })
    .to_bytes()
    .unwrap();
    let bytes = ready(handle_frame(svc, host, s, &frame, NOW, [2; 32])).unwrap();
    let LsFrame::Response(r) = LsFrame::from_bytes(&bytes).unwrap() else {
        panic!("response")
    };
    r
}

#[test]
fn leave_and_send_for_an_unjoined_collection_create_no_hub() {
    let cp = ControlPlane::new("hub-scope");
    let d = Device::new("hub-scope/device", id16("hub-scope/owner"));
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
    let host = Host::default();
    let nonce = [1; 32];
    let mut s = Session::new(1, nonce);
    let token = cp.device_token(&d, NOW + 10_000);
    let hello = LsHelloParams {
        version: Version { major: 1, minor: 0 },
        sig: d.hello_sig(&nonce, &token),
        token,
        device: Some(d.id),
    };
    assert!(
        call(&svc, &host, &mut s, "hello", hello.to_cbor())
            .error
            .is_none()
    );

    let stream = B16([3; 16]);
    for i in 0..4u8 {
        let c = id16(&format!("hub-scope/other-{i}"));
        let r = call(
            &svc,
            &host,
            &mut s,
            "unsubscribe",
            Cbor::Map(vec![(Cbor::Uint(0), c.to_cbor())]),
        );
        assert!(r.error.is_none(), "unsubscribe stays idempotent");
        let r = call(
            &svc,
            &host,
            &mut s,
            "stream_leave",
            StreamRef {
                collection: c,
                stream,
            }
            .to_cbor(),
        );
        assert!(r.error.is_none(), "leave stays idempotent");
        let r = call(
            &svc,
            &host,
            &mut s,
            "stream_send",
            StreamSendParams {
                collection: c,
                stream,
                message: Bytes(vec![0; 8]),
            }
            .to_cbor(),
        );
        let e = r.error.expect("send without a join is refused");
        assert_eq!(
            (e.code.as_str(), e.reason.as_deref()),
            ("forbidden", Some("not_joined"))
        );
    }
    assert!(host.hubs.borrow().is_empty(), "no hub was reached");
    assert!(s.collections.is_empty());
}
