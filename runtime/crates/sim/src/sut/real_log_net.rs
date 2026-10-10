//! Exact-frame simulated stream adapter for the production memory service.
//!
//! Transport markers distinguish upgrade/challenge/frames ONLY. Authority comes
//! solely from caller-signed hello bytes decoded by production Session dispatch.
//! No caller credentials, signing keys or fabricated proofs live in this actor.
//! This RPC seam does not yet connect Replica/objects/final-state gate oracles.
use std::any::Any;
use std::collections::BTreeMap;
use std::rc::Rc;

use super::real_log::{RealLog, RealLogService};
use crate::world::{Actor, ActorId, Ev, Payload, World};

/// Stream transport metadata, not an authority-bearing typed RPC payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WireEvent {
    /// Upgrade; the service responds with its actual connection nonce bytes.
    Open,
    /// Upgrade response; bytes contain the server nonce.
    Challenge,
    /// Exact production LsFrame bytes, including refusal replies and pushes.
    Frame,
    /// A direct object transfer request (what the object endpoint receives over
    /// HTTPS): see [`direct::encode_request`]. Bearer-signed URL, no session.
    Direct,
    /// The object endpoint's answer: see [`direct::encode_reply`].
    DirectReply,
}

/// Direct object transfers over the simulated network: the exact bodies cross
/// the wire (the tap scans them); correlation uses the caller's call ID as
/// transport metadata only. The URL is the only authority, verified server side.
pub mod direct {
    /// A direct request as the trusted caller encodes it.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct Request {
        /// The caller's call ID (echoed back; not authority).
        pub call: u64,
        /// The signed URL from the service's reply.
        pub url: String,
        /// `Some(body)` for an upload, `None` for a download.
        pub body: Option<Vec<u8>>,
        /// Download span `(offset, len)`, or the whole object.
        pub range: Option<(u64, u64)>,
    }
    /// Reply status.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum Status {
        /// Stored or served.
        Ok = 0,
        /// The URL was refused (MAC, expiry, op, malformed).
        Refused = 1,
        /// No such committed object.
        NotFound = 2,
        /// Storage failure.
        Unavailable = 3,
    }
    /// `call u64 ‖ kind u8 (0 put, 1 get) ‖ url_len u32 ‖ url ‖ [put: body | get: has_range u8 ‖ offset u64 ‖ len u64]`.
    pub fn encode_request(r: &Request) -> Vec<u8> {
        let mut b = r.call.to_be_bytes().to_vec();
        b.push(u8::from(r.body.is_none()));
        b.extend((r.url.len() as u32).to_be_bytes());
        b.extend_from_slice(r.url.as_bytes());
        match &r.body {
            Some(body) => b.extend_from_slice(body),
            None => {
                b.push(u8::from(r.range.is_some()));
                let (o, l) = r.range.unwrap_or((0, 0));
                b.extend(o.to_be_bytes());
                b.extend(l.to_be_bytes());
            }
        }
        b
    }
    /// Decode a request; `None` when malformed.
    pub fn decode_request(b: &[u8]) -> Option<Request> {
        let call = u64::from_be_bytes(b.get(0..8)?.try_into().ok()?);
        let kind = *b.get(8)?;
        let n = u32::from_be_bytes(b.get(9..13)?.try_into().ok()?) as usize;
        let url = std::str::from_utf8(b.get(13..13 + n)?).ok()?.to_string();
        let rest = b.get(13 + n..)?;
        match kind {
            0 => Some(Request {
                call,
                url,
                body: Some(rest.to_vec()),
                range: None,
            }),
            1 => {
                let has = *rest.first()?;
                let o = u64::from_be_bytes(rest.get(1..9)?.try_into().ok()?);
                let l = u64::from_be_bytes(rest.get(9..17)?.try_into().ok()?);
                if rest.len() != 17 {
                    return None;
                }
                Some(Request {
                    call,
                    url,
                    body: None,
                    range: (has == 1).then_some((o, l)),
                })
            }
            _ => None,
        }
    }
    /// `call u64 ‖ status u8 ‖ body`.
    pub fn encode_reply(call: u64, status: Status, body: &[u8]) -> Vec<u8> {
        let mut b = call.to_be_bytes().to_vec();
        b.push(status as u8);
        b.extend_from_slice(body);
        b
    }
    /// Decode a reply; `None` when malformed.
    pub fn decode_reply(b: &[u8]) -> Option<(u64, Status, &[u8])> {
        let call = u64::from_be_bytes(b.get(0..8)?.try_into().ok()?);
        let status = match *b.get(8)? {
            0 => Status::Ok,
            1 => Status::Refused,
            2 => Status::NotFound,
            3 => Status::Unavailable,
            _ => return None,
        };
        Some((call, status, b.get(9..)?))
    }
}

/// Caller-owned hello material. This type belongs on the trusted Node side;
/// RealServiceActor never receives or retains it.
pub struct CallerHello {
    token: String,
    device: Option<mdbn_wire::common::Uuid>,
    signing: mdbn_replica::crypto::sign::DeviceSigner,
}
impl CallerHello {
    /// Construct from a caller's token and signing seed, not server configuration.
    pub fn new(token: String, device: Option<mdbn_wire::common::Uuid>, seed: &[u8; 32]) -> Self {
        Self {
            token,
            device,
            signing: mdbn_replica::crypto::sign::DeviceSigner::from_seed(seed),
        }
    }
    /// Register the actual caller key before opening its network transport.
    pub fn register(&self, w: &World) {
        w.shared.tap.borrow_mut().secret(
            "real network caller signing key",
            self.signing.seed().expose(),
        );
    }
    /// Register again (deduplicated) BEFORE producing a proof-bearing frame.
    /// The public nonce must be obtained from this connection's wire challenge.
    pub fn frame(&self, w: &World, nonce: &[u8; 32], call: u64) -> Vec<u8> {
        use mdbn_wire::log_service::{LsFrame, LsHelloParams, LsRequest};
        use mdbn_wire::schema::Wire;
        self.register(w);
        let digest = mdbn_log_service::auth::hello_digest(nonce, &self.token);
        let params = LsHelloParams {
            version: mdbn_wire::common::Version { major: 1, minor: 0 },
            token: self.token.clone(),
            device: self.device,
            sig: mdbn_wire::common::B64(self.signing.sign_digest(&digest.0)),
        };
        LsFrame::Request(LsRequest {
            id: call,
            method: "hello".into(),
            params: params.to_cbor(),
        })
        .to_bytes()
        .expect("caller hello encodes")
    }
}

/// Production session dispatcher behind the actual simulated stream network.
pub struct RealServiceActor {
    me: ActorId,
    service: RealLogService,
    connections: BTreeMap<ActorId, (u64, RealLog)>,
    nonce_serial: u64,
}
impl RealServiceActor {
    /// `me` must be the ID assigned by World::spawn. The service holds only
    /// configured public authority roots/issuers and its own URL MAC key.
    pub fn new(me: ActorId, service: RealLogService) -> Self {
        Self {
            me,
            service,
            connections: BTreeMap::new(),
            nonce_serial: 0,
        }
    }
    fn nonce(&mut self) -> [u8; 32] {
        self.nonce_serial = self.nonce_serial.checked_add(1).expect("test nonce serial");
        // Deterministic test-only live-actor schedule, NOT production entropy or
        // proof of freshness across a real daemon/service restart.
        mdbn_wire::hash::h(
            "mdbase/sim-only/network-nonce",
            &[
                self.me.to_be_bytes().as_slice(),
                self.nonce_serial.to_be_bytes().as_slice(),
            ]
            .concat(),
        )
        .0
    }
    fn scan_observed(&self, w: &World) {
        for (path, bytes) in self.service.take_observed() {
            w.log_path(&format!("real:{path}"), "exact frame", &bytes);
        }
    }
    fn send(&self, w: &mut World, to: ActorId, bytes: Vec<u8>, event: WireEvent) {
        w.log_path("real:outbound", "exact network bytes", &bytes);
        w.send_obj(self.me, to, bytes, Some(Payload(Rc::new(event))));
    }
}
impl RealServiceActor {
    /// Oracle: the service's stored head of `collection`, for settlement checks.
    pub fn head(&self, collection: &mdbn_wire::common::Uuid) -> Option<u64> {
        self.service.stored_head(collection)
    }
}

/// Hub pushes are delivered as soon as the hub minted them, not only when the
/// next inbound message happens to arrive (a commit from another session, such
/// as the control plane's, must reach idle subscribers too).
const FLUSH_PUSHES: u64 = 1;
const FLUSH_EVERY_MS: u64 = 5;

impl RealServiceActor {
    fn flush_pushes(&mut self, w: &mut World) {
        let mut pushes = Vec::new();
        for (peer, (e, client)) in &mut self.connections {
            if *e == w.net.epoch(self.me, *peer) {
                for bytes in client.push_frames() {
                    pushes.push((*peer, bytes));
                }
            }
        }
        for (peer, bytes) in pushes {
            self.send(w, peer, bytes, WireEvent::Frame);
        }
        self.scan_observed(w);
    }
}

impl Actor for RealServiceActor {
    fn name(&self) -> &str {
        "real-logsvc"
    }
    fn handle(&mut self, w: &mut World, ev: Ev) {
        self.service.set_now(w.now() as i64);
        match ev {
            Ev::Start => {
                w.expect_log_service();
                w.timer(self.me, FLUSH_EVERY_MS, FLUSH_PUSHES);
            }
            Ev::Timer(FLUSH_PUSHES) => {
                self.flush_pushes(w);
                w.timer(self.me, FLUSH_EVERY_MS, FLUSH_PUSHES);
            }
            Ev::Msg { from, bytes, obj } => {
                w.log_ingress("real service network ingress", &bytes);
                let epoch = w.net.epoch(self.me, from);
                let event = obj.as_ref().and_then(|p| p.get::<WireEvent>()).copied();
                if event == Some(WireEvent::Direct) {
                    // The object endpoint: the signed URL is the only authority.
                    let reply = match direct::decode_request(&bytes) {
                        None => direct::encode_reply(0, direct::Status::Refused, &[]),
                        Some(r) => {
                            let outcome =
                                self.service.direct_op(&r.url).and_then(|op| match r.body {
                                    Some(body) => {
                                        self.service.direct_put(&op, body).map(|()| Vec::new())
                                    }
                                    None => self.service.direct_get(&op, r.range),
                                });
                            match outcome {
                                Ok(body) => direct::encode_reply(r.call, direct::Status::Ok, &body),
                                Err(mdbn_replica::log::LogError::Service { code, .. }) => {
                                    let status = match code {
                                        mdbn_replica::log::LogErrorCode::NotFound => {
                                            direct::Status::NotFound
                                        }
                                        mdbn_replica::log::LogErrorCode::Unavailable => {
                                            direct::Status::Unavailable
                                        }
                                        _ => direct::Status::Refused,
                                    };
                                    direct::encode_reply(r.call, status, &[])
                                }
                                Err(_) => {
                                    direct::encode_reply(r.call, direct::Status::Unavailable, &[])
                                }
                            }
                        }
                    };
                    self.send(w, from, reply, WireEvent::DirectReply);
                    self.scan_observed(w);
                    return;
                }
                if event == Some(WireEvent::Open) {
                    if self.connections.get(&from).is_none_or(|(e, _)| *e != epoch) {
                        let nonce = self.nonce();
                        self.connections
                            .insert(from, (epoch, self.service.connect(nonce)));
                    }
                    let nonce = self.connections[&from].1.server_nonce();
                    self.send(w, from, nonce.to_vec(), WireEvent::Challenge);
                } else {
                    // Raw bytes are authoritative: a forged typed payload can
                    // never substitute a decoded request or proof.
                    let fresh = self.nonce();
                    if let Some((e, client)) = self.connections.get_mut(&from)
                        && *e == epoch
                        && let Some(reply) = client.exchange(&bytes, fresh)
                    {
                        self.send(w, from, reply, WireEvent::Frame);
                    }
                    self.flush_pushes(w);
                }
            }
            Ev::Closed { peer } => {
                // A late close must not destroy an already renewed connection.
                if self
                    .connections
                    .get(&peer)
                    .is_some_and(|(e, _)| *e != w.net.epoch(self.me, peer))
                {
                    self.connections.remove(&peer);
                }
            }
            Ev::Crash | Ev::PowerLoss => {
                self.connections.clear();
            }
            _ => {}
        }
    }
    fn quiesce(&mut self, w: &mut World) {
        self.scan_observed(w);
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mdbn_log_service::{
        Config,
        testkit::{ControlPlane, Device, id16, key},
    };
    use mdbn_wire::{
        cbor::Cbor,
        common::Version,
        log_service::{LsFrame, LsHelloParams, LsRequest},
        schema::Wire,
    };

    struct AuthenticatingCaller {
        me: ActorId,
        server: ActorId,
        hello: CallerHello,
        sent: Vec<Vec<u8>>,
        admitted: u64,
    }
    impl Actor for AuthenticatingCaller {
        fn name(&self) -> &str {
            "authenticating-caller"
        }
        fn handle(&mut self, w: &mut World, ev: Ev) {
            match ev {
                Ev::Start | Ev::Closed { .. } => {
                    self.hello.register(w);
                    w.send_obj(
                        self.me,
                        self.server,
                        vec![],
                        Some(Payload(Rc::new(WireEvent::Open))),
                    );
                }
                Ev::Msg { from, bytes, obj } if from == self.server => {
                    if obj.as_ref().and_then(|p| p.get::<WireEvent>())
                        == Some(&WireEvent::Challenge)
                    {
                        let nonce: [u8; 32] = bytes.try_into().expect("wire nonce");
                        let proof = self.hello.frame(w, &nonce, 0);
                        self.sent.push(proof.clone());
                        w.send(self.me, self.server, proof);
                    } else {
                        let LsFrame::Response(r) = LsFrame::from_bytes(&bytes).unwrap() else {
                            panic!("hello response")
                        };
                        assert_eq!(r.id, 0);
                        assert!(r.error.is_none());
                        self.admitted += 1;
                    }
                }
                _ => {}
            }
        }
        fn as_any(&self) -> &dyn Any {
            self
        }
        fn as_any_mut(&mut self) -> &mut dyn Any {
            self
        }
    }
    #[test]
    fn trusted_caller_actor_owns_and_generates_fresh_proofs_on_network_challenges() {
        for seed in 0..20 {
            let cp = ControlPlane::new("sim-net-owned");
            let device = Device::new("sim-net-owned-device", id16("owner"));
            let mut w = World::new(seed, false);
            let service = RealLogService::new(Config {
                roots: vec![cp.root_pk()],
                token_issuers: vec![cp.issuer_pk()],
                url_secret: vec![0x5a; 32],
                public_base: "https://sim.invalid".into(),
            });
            let server = w.actor_count() as ActorId;
            w.spawn(Box::new(RealServiceActor::new(server, service)));
            let me = w.actor_count() as ActorId;
            let hello = CallerHello::new(
                cp.device_token_for(&device, i64::MAX, None),
                Some(device.id),
                &key(b"device/sim-net-owned-device").to_bytes(),
            );
            assert_eq!(
                w.spawn(Box::new(AuthenticatingCaller {
                    me,
                    server,
                    hello,
                    sent: vec![],
                    admitted: 0
                })),
                me
            );
            run(&mut w);
            assert_eq!(w.actor::<AuthenticatingCaller>(me).unwrap().admitted, 1);
            w.net.reset(me, server);
            w.at(me, 0, Ev::Closed { peer: server });
            run(&mut w);
            let client = w.actor::<AuthenticatingCaller>(me).unwrap();
            assert_eq!(client.admitted, 2);
            assert_eq!(client.sent.len(), 2);
            assert_ne!(
                client.sent[0], client.sent[1],
                "new connection gets caller's fresh nonce-bound proof"
            );
            assert!(!w.shared.tap.borrow().secrets.is_empty());
            assert!(w.shared.tap.borrow().hits.is_empty());
            assert!(w.net.stats.sent >= 8);
        }
    }

    #[test]
    fn deliberate_caller_key_leak_is_detected_at_actual_network_service_ingress() {
        let cp = ControlPlane::new("sim-net-leak");
        let mut w = World::new(3, false);
        let service = RealLogService::new(Config {
            roots: vec![cp.root_pk()],
            token_issuers: vec![cp.issuer_pk()],
            url_secret: vec![0x5a; 32],
            public_base: "https://sim.invalid".into(),
        });
        let server = w.actor_count() as ActorId;
        w.spawn(Box::new(RealServiceActor::new(server, service)));
        let caller = w.spawn(Box::<Caller>::default());
        let signing_seed = key(b"deliberate caller leak").to_bytes();
        w.shared
            .tap
            .borrow_mut()
            .secret("caller secret", &signing_seed);
        open(&mut w, caller, server);
        w.send(caller, server, signing_seed.to_vec());
        run(&mut w);
        assert!(
            w.shared
                .tap
                .borrow()
                .hits
                .iter()
                .any(|h| h.kind == crate::oracle::Kind::KeyExposure)
        );
        assert!(
            w.shared
                .tap
                .borrow()
                .per_path
                .get("request")
                .copied()
                .unwrap_or_default()
                > 0
        );
    }

    #[test]
    fn signed_control_commit_and_production_hub_push_cross_the_actual_network() {
        use mdbn_wire::common::Bytes;
        use mdbn_wire::hash::chain_hash;
        use mdbn_wire::log_service::{AppendParams, ItemsPush, SubscribeParams};
        use mdbn_wire::policy::{DeviceKind, Freeze, PolicyOp};
        let cp = ControlPlane::new("sim-net-push");
        let owner = id16("owner");
        let device = Device::new("sim-net-push-device", owner);
        let collection = id16("sim-net-push-collection");
        let mut w = World::new(7, false);
        let service = RealLogService::new(Config {
            roots: vec![cp.root_pk()],
            token_issuers: vec![cp.issuer_pk()],
            url_secret: vec![0x5a; 32],
            public_base: "https://sim.invalid".into(),
        });
        let server = w.actor_count() as ActorId;
        w.spawn(Box::new(RealServiceActor::new(server, service)));
        let control = w.spawn(Box::<Caller>::default());
        let observer = w.spawn(Box::<Caller>::default());
        let control_hello =
            CallerHello::new(cp.cp_token(i64::MAX), None, &cp.transport_key().to_bytes());
        control_hello.register(&w);
        let nonce = open(&mut w, control, server);
        w.send(control, server, control_hello.frame(&w, &nonce, 1));
        run(&mut w);
        assert!(last(&w, control).error.is_none());
        let genesis = cp.genesis(collection, owner);
        w.send(
            control,
            server,
            frame(
                2,
                "create_log",
                Cbor::Map(vec![
                    (Cbor::Uint(0), collection.to_cbor()),
                    (Cbor::Uint(1), Cbor::Bytes(genesis.clone())),
                ]),
            ),
        );
        run(&mut w);
        assert!(last(&w, control).error.is_none());
        let enrol = cp.policy_item(
            collection,
            2,
            chain_hash(&genesis),
            vec![device.enrol(DeviceKind::Desktop)],
            2,
        );
        w.send(
            control,
            server,
            frame(
                3,
                "append",
                AppendParams {
                    collection,
                    expect_seq: 2,
                    expect_prev: chain_hash(&genesis),
                    items: vec![Bytes(enrol.clone())],
                }
                .to_cbor(),
            ),
        );
        run(&mut w);
        assert!(last(&w, control).error.is_none());
        let device_hello = CallerHello::new(
            cp.device_token_for(&device, i64::MAX, Some(collection)),
            Some(device.id),
            &key(b"device/sim-net-push-device").to_bytes(),
        );
        device_hello.register(&w);
        let nonce = open(&mut w, observer, server);
        w.send(observer, server, device_hello.frame(&w, &nonce, 1));
        run(&mut w);
        assert!(last(&w, observer).error.is_none());
        w.send(
            observer,
            server,
            frame(
                2,
                "subscribe",
                SubscribeParams {
                    collection,
                    after: 2,
                    inline_bytes: Some(4096),
                }
                .to_cbor(),
            ),
        );
        run(&mut w);
        assert!(last(&w, observer).error.is_none());
        let freeze = cp.policy_item(
            collection,
            3,
            chain_hash(&enrol),
            vec![PolicyOp::Freeze(Freeze {
                frozen: true,
                reason: None,
            })],
            3,
        );
        w.send(
            control,
            server,
            frame(
                4,
                "append",
                AppendParams {
                    collection,
                    expect_seq: 3,
                    expect_prev: chain_hash(&enrol),
                    items: vec![Bytes(freeze.clone())],
                }
                .to_cbor(),
            ),
        );
        run(&mut w);
        assert!(last(&w, control).error.is_none());
        let observer = w.actor::<Caller>(observer).unwrap();
        let pushes: Vec<_> = observer
            .frames
            .iter()
            .filter_map(|b| match LsFrame::from_bytes(b).unwrap() {
                LsFrame::Push(p) => Some(p),
                _ => None,
            })
            .collect();
        assert_eq!(pushes.len(), 1);
        assert_eq!(pushes[0].kind, "items");
        let push = ItemsPush::from_cbor(&pushes[0].payload).unwrap();
        assert_eq!(push.head, 3);
        assert_eq!(push.head_chain, chain_hash(&freeze));
        assert_eq!(push.items.len(), 1);
        assert_eq!(push.items[0].seq, 3);
        assert_eq!(push.items[0].item.0, freeze);
        assert!(
            w.shared
                .tap
                .borrow()
                .per_path
                .get("real:push")
                .copied()
                .unwrap_or_default()
                > 0
        );
        assert!(w.shared.tap.borrow().hits.is_empty());
    }

    #[derive(Default)]
    struct Caller {
        frames: Vec<Vec<u8>>,
        challenges: Vec<[u8; 32]>,
    }
    impl Actor for Caller {
        fn name(&self) -> &str {
            "caller"
        }
        fn handle(&mut self, _w: &mut World, ev: Ev) {
            if let Ev::Msg { bytes, obj, .. } = ev {
                if obj.as_ref().and_then(|p| p.get::<WireEvent>()) == Some(&WireEvent::Challenge) {
                    self.challenges.push(bytes.try_into().expect("exact nonce"));
                } else {
                    self.frames.push(bytes);
                }
            }
        }
        fn as_any(&self) -> &dyn Any {
            self
        }
        fn as_any_mut(&mut self) -> &mut dyn Any {
            self
        }
    }
    fn run(w: &mut World) {
        w.run_until(w.now() + 100);
    }
    fn open(w: &mut World, caller: ActorId, server: ActorId) -> [u8; 32] {
        w.send_obj(
            caller,
            server,
            vec![],
            Some(Payload(Rc::new(WireEvent::Open))),
        );
        run(w);
        *w.actor::<Caller>(caller)
            .unwrap()
            .challenges
            .last()
            .unwrap()
    }
    fn last(w: &World, caller: ActorId) -> mdbn_wire::log_service::LsResponse {
        let LsFrame::Response(r) =
            LsFrame::from_bytes(w.actor::<Caller>(caller).unwrap().frames.last().unwrap()).unwrap()
        else {
            panic!("real response")
        };
        r
    }
    fn frame(id: u64, method: &str, params: Cbor) -> Vec<u8> {
        LsFrame::Request(LsRequest {
            id,
            method: method.into(),
            params,
        })
        .to_bytes()
        .unwrap()
    }
    #[test]
    fn caller_proof_crosses_network_and_cannot_admit_a_different_connection() {
        for seed in 0..20 {
            let cp = ControlPlane::new("sim-net");
            let device = Device::new("sim-net-device", id16("owner"));
            let mut w = World::new(seed, false);
            w.shared.tap.borrow_mut().secret(
                "caller signing seed",
                &key(b"device/sim-net-device").to_bytes(),
            );
            w.expect_untrusted_party(crate::tap::Party::LogService);
            for path in ["request", "real:request", "real:response"] {
                w.shared.tap.borrow_mut().require(path);
            }
            let svc = RealLogService::new(Config {
                roots: vec![cp.root_pk()],
                token_issuers: vec![cp.issuer_pk()],
                url_secret: vec![0x5a; 32],
                public_base: "https://sim.invalid".into(),
            });
            let server = w.actor_count() as ActorId;
            assert_eq!(
                w.spawn(Box::new(RealServiceActor::new(server, svc))),
                server
            );
            let a = w.spawn(Box::<Caller>::default());
            let b = w.spawn(Box::<Caller>::default());
            let na = open(&mut w, a, server);
            let nb = open(&mut w, b, server);
            assert_ne!(na, nb);
            let token = cp.device_token_for(&device, i64::MAX, None);
            // Proof is produced by the caller, outside the untrusted actor.
            let hello = frame(
                1,
                "hello",
                LsHelloParams {
                    version: Version { major: 1, minor: 0 },
                    token: token.clone(),
                    device: Some(device.id),
                    sig: device.hello_sig(&na, &token),
                }
                .to_cbor(),
            );
            w.send(a, server, hello.clone());
            run(&mut w);
            assert!(last(&w, a).error.is_none());
            assert_eq!(last(&w, a).id, 1);
            // Exact proof bytes replayed on another stream have the wrong nonce.
            w.send(b, server, hello.clone());
            run(&mut w);
            assert_eq!(
                last(&w, b).error.unwrap().reason.as_deref(),
                Some("possession")
            );
            let call = super::super::real_log::request_frame(
                &mdbn_replica::log::LogRequest::Head {
                    collection: id16("missing"),
                },
                2,
            )
            .unwrap();
            w.send(b, server, call.clone());
            run(&mut w);
            assert_eq!(last(&w, b).error.unwrap().code, "unauthenticated");
            // Wrong proof and unauthenticated calls cannot consume B's nonce;
            // its own caller-generated proof still admits the same connection.
            let bhello = frame(
                3,
                "hello",
                LsHelloParams {
                    version: Version { major: 1, minor: 0 },
                    token: token.clone(),
                    device: Some(device.id),
                    sig: device.hello_sig(&nb, &token),
                }
                .to_cbor(),
            );
            w.send(b, server, bhello);
            run(&mut w);
            assert!(last(&w, b).error.is_none());
            // Deliberately inconsistent typed metadata cannot substitute a
            // different method/collection: the actor dispatches exact bytes.
            w.send_obj(
                a,
                server,
                call,
                Some(Payload(Rc::new(crate::sut::LogReq {
                    device: id16("impostor"),
                    call: 999,
                    req: mdbn_replica::log::LogRequest::Subscribe {
                        collection: id16("other"),
                        after: 0,
                        inline_bytes: None,
                    },
                }))),
            );
            run(&mut w);
            assert_eq!(last(&w, a).id, 2);
            assert_eq!(last(&w, a).error.unwrap().code, "not_found");
            // A late close for the already current stream must not deauthenticate it.
            w.at(server, 0, Ev::Closed { peer: a });
            run(&mut w);
            w.send(
                a,
                server,
                frame(
                    4,
                    "head",
                    Cbor::Map(vec![(Cbor::Uint(0), id16("missing").to_cbor())]),
                ),
            );
            run(&mut w);
            assert_eq!(last(&w, a).error.unwrap().code, "not_found");
            // A reset invalidates the admitted session and old proof.
            w.net.reset(a, server);
            let renewed = open(&mut w, a, server);
            assert_ne!(renewed, na);
            w.send(a, server, hello);
            run(&mut w);
            assert_eq!(
                last(&w, a).error.unwrap().reason.as_deref(),
                Some("possession")
            );
            let fresh = frame(
                3,
                "hello",
                LsHelloParams {
                    version: Version { major: 1, minor: 0 },
                    token: token.clone(),
                    device: Some(device.id),
                    sig: device.hello_sig(&renewed, &token),
                }
                .to_cbor(),
            );
            w.send(a, server, fresh);
            run(&mut w);
            assert!(last(&w, a).error.is_none());
            assert!(
                w.shared.tap.borrow().hits.is_empty(),
                "no registered caller key exposure"
            );
            assert!(w.shared.tap.borrow().unscanned().is_empty());
            assert!(w.shared.tap.borrow().unscanned_parties().is_empty());
            assert!(
                w.net.stats.sent >= 20,
                "actual network trajectory must not be vacuous"
            );
        }
    }
}
