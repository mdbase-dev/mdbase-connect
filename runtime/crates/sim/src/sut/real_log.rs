//! In-process binding to the real blind service, memory backend and session hub.
//!
//! Calls are serialized by the simulator actor. Memory futures must complete on
//! their first poll: pending is an invariant error, never a real-clock wait.
//! `connect` starts unauthenticated and sends real `hello` token/possession
//! frames through production session dispatch. The service token format remains
//! its documented evaluation stand-in, not deployed control-plane credentials.
//! Connections cannot be created with an injected principal.

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::future::Future;
use std::rc::Rc;
use std::task::{Context, Poll, Waker};

use mdbn_log_service::hub::{Hub, Push};
use mdbn_log_service::mem::{MemBackend, MemObjects};
use mdbn_log_service::model::{CommitNotice, object_key};
use mdbn_log_service::session::{HubHost, Session, close, handle_frame};
use mdbn_log_service::{Config, ObjectStore, Service};
use mdbn_replica::log::{
    LogClient, LogError, LogErrorCode, LogPush, LogReply, LogRequest, LogResponse,
};
use mdbn_wire::cbor::Cbor;
use mdbn_wire::common::{Bytes, Uuid};
use mdbn_wire::hash::sha256;
use mdbn_wire::log_service::*;
use mdbn_wire::schema::Wire;

/// Evaluate an uncontended in-memory operation without an executor or clock.
fn ready<T>(future: impl Future<Output = T>) -> T {
    let mut future = std::pin::pin!(future);
    match future
        .as_mut()
        .poll(&mut Context::from_waker(Waker::noop()))
    {
        Poll::Ready(value) => value,
        Poll::Pending => panic!("serialized memory service operation unexpectedly pending"),
    }
}

#[derive(Default)]
struct Host {
    hubs: RefCell<BTreeMap<Uuid, Hub>>,
    pushes: RefCell<BTreeMap<u64, Vec<LsPush>>>,
    observed: RefCell<Vec<(String, Vec<u8>)>>,
}

impl HubHost for Host {
    fn with_hub<R>(&self, c: &Uuid, f: impl FnOnce(&mut Hub) -> R) -> R {
        f(self
            .hubs
            .borrow_mut()
            .entry(*c)
            .or_insert_with(|| Hub::new(*c)))
    }
    fn deliver(&self, pushes: Vec<Push>) {
        let mut queues = self.pushes.borrow_mut();
        for p in pushes {
            self.observed.borrow_mut().push((
                "push".into(),
                LsFrame::Push(p.push.clone())
                    .to_bytes()
                    .expect("real hub push encodes"),
            ));
            queues.entry(p.to).or_default().push(p.push);
        }
    }
    fn committed(&self, notice: &CommitNotice, items: &[(u64, Vec<u8>)]) {
        let pushes = self.with_hub(&notice.collection, |hub| hub.on_commit(notice, items));
        self.deliver(pushes);
    }
}

/// Shared durable service state; cloning shares the same collection actors.
#[derive(Clone)]
pub struct RealLogService(Rc<State>);

struct State {
    service: Service<MemBackend, MemObjects>,
    host: Host,
    now: Cell<i64>,
    next_session: Cell<u64>,
}

impl RealLogService {
    /// Construct the real service with explicit roots and URL signing secret.
    pub fn new(config: Config) -> Self {
        Self(Rc::new(State {
            service: Service::new(MemBackend::default(), MemObjects::default(), config),
            host: Host::default(),
            now: Cell::new(0),
            next_session: Cell::new(1),
        }))
    }

    /// Set simulated time (milliseconds).
    pub fn set_now(&self, now: i64) {
        self.0.now.set(now);
    }

    /// Open an unauthenticated connection with the caller's simulated nonce.
    /// The client must send `hello`; this does not bypass production admission.
    pub fn connect(&self, server_nonce: [u8; 32]) -> RealLog {
        let id = self.0.next_session.get();
        self.0.next_session.set(id + 1);
        RealLog {
            service: self.clone(),
            session: Session::new(id, server_nonce),
            next_call: 1,
        }
    }

    /// Drain exact bytes received or emitted by the untrusted service, including
    /// errors and pushes even if their connection closes before polling them.
    /// The network actor must pass these through its tap, plus final stored state.
    pub fn take_observed(&self) -> Vec<(String, Vec<u8>)> {
        std::mem::take(&mut *self.0.host.observed.borrow_mut())
    }

    /// Oracle: the service's stored head of `collection` (not a network call;
    /// control-plane authority, read only).
    pub fn stored_head(&self, collection: &Uuid) -> Option<u64> {
        ready(
            self.0
                .service
                .head(&mdbn_log_service::auth::Principal::ControlPlane, collection),
        )
        .ok()
        .map(|r| r.head)
    }

    /// Oracle: every stored item of `collection` as `(seq, bytes)`, read through
    /// the service with control-plane authority (not a network call).
    pub fn stored_items(&self, collection: &Uuid) -> Vec<(u64, Vec<u8>)> {
        let p = mdbn_log_service::auth::Principal::ControlPlane;
        let mut out = Vec::new();
        let mut after = 0;
        loop {
            let Ok(r) = ready(self.0.service.read(
                &p,
                ReadParams {
                    collection: *collection,
                    after,
                    limit: 256,
                    kinds: None,
                    max_bytes: None,
                },
                self.0.now.get(),
            )) else {
                break;
            };
            if r.items.is_empty() {
                // Behind retention: entries start at `retained_from`; control
                // items below it are still served, so restart there once.
                if r.behind && after + 1 < r.retained_from {
                    after = r.retained_from - 1;
                    continue;
                }
                break;
            }
            after = r.items.last().map_or(after, |i| i.seq);
            out.extend(r.items.into_iter().map(|i| (i.seq, i.item.0)));
        }
        out
    }

    /// Resolve and verify a signed direct-transfer URL as the object endpoint
    /// would (MAC, expiry, op, collection, address): shared by the synchronous
    /// binding and the network actor. Never trusts anything but the URL.
    pub fn direct_op(&self, url: &str) -> Result<mdbn_log_service::service::DirectOp, LogError> {
        let config = &self.0.service.config;
        let path = url.strip_prefix(&config.public_base).ok_or_else(invalid)?;
        let (path, query) = path.split_once('?').ok_or_else(invalid)?;
        let mut parts = path.rsplit('/');
        let address = parts.next().ok_or_else(invalid)?;
        let collection = parts.next().ok_or_else(invalid)?;
        mdbn_log_service::service::verify_direct(
            &config.url_secret,
            collection,
            address,
            query,
            self.0.now.get(),
        )
        .map_err(|e| LogError::Service {
            code: LogErrorCode::parse(e.code.as_str()).unwrap_or(LogErrorCode::Unavailable),
            reason: e.reason,
            retry_after_ms: e.retry_after_ms,
            missing: vec![],
        })
    }

    /// Record bytes the untrusted service received or stored on a direct path,
    /// for the tap (as the synchronous binding does for its own transfers).
    pub fn observe(&self, path: &str, bytes: &[u8]) {
        self.0
            .host
            .observed
            .borrow_mut()
            .push((path.to_string(), bytes.to_vec()));
    }

    /// Stage an uploaded object body for `op` (a verified direct PUT), as the
    /// object endpoint does before `commit_object`.
    pub fn direct_put(
        &self,
        op: &mdbn_log_service::service::DirectOp,
        body: Vec<u8>,
    ) -> Result<(), LogError> {
        if !op.put {
            return Err(invalid());
        }
        if op.expect != Some((body.len() as u64, sha256(&body))) {
            return Err(invalid());
        }
        let device = op.device.ok_or_else(invalid)?;
        let key = mdbn_log_service::service::staging_key(&op.collection, &op.address, &device);
        self.observe("direct:upload", &body);
        ready(self.0.service.objects.put(&key, body))
            .map_err(|_| LogError::code(LogErrorCode::Unavailable))
    }

    /// Serve a verified direct GET: the committed object's bytes (or span).
    pub fn direct_get(
        &self,
        op: &mdbn_log_service::service::DirectOp,
        range: Option<(u64, u64)>,
    ) -> Result<Vec<u8>, LogError> {
        if op.put {
            return Err(invalid());
        }
        let bytes = ready(
            self.0
                .service
                .objects
                .get(&object_key(&op.collection, &op.address), range),
        )
        .map_err(|_| LogError::code(LogErrorCode::Unavailable))?
        .ok_or_else(|| LogError::code(LogErrorCode::NotFound))?;
        self.observe("object:download", &bytes);
        Ok(bytes)
    }

    /// Oracle: the service's stored head and chain of `collection`.
    pub fn stored_head_chain(&self, collection: &Uuid) -> Option<(u64, mdbn_wire::common::B32)> {
        ready(
            self.0
                .service
                .head(&mdbn_log_service::auth::Principal::ControlPlane, collection),
        )
        .ok()
        .map(|r| (r.head, r.head_chain))
    }

    /// Oracle: positions of the service's stored snapshot pointers.
    pub fn stored_snapshots(&self, collection: &Uuid) -> Vec<u64> {
        ready(
            self.0
                .service
                .get_snapshot(&mdbn_log_service::auth::Principal::ControlPlane, collection),
        )
        .map(|r| r.snapshots.iter().map(|s| s.seq).collect())
        .unwrap_or_default()
    }

    /// Test hook: compact entries through `upto` (grace and age bypassed), as a
    /// retention run would once C is known. Returns the new `retained_from`.
    pub fn compact_through(&self, collection: &Uuid, upto: u64) -> Option<u64> {
        ready(self.0.service.backend.compact_through(collection, upto))
            .ok()
            .flatten()
    }

    /// Exercise the real failover hook, without replacing service append logic.
    pub fn lose_tail(&self, collection: &Uuid, n: u64) {
        ready(
            self.0
                .service
                .backend
                .lose_tail(collection, n, &self.0.service.config.roots),
        );
    }
}

/// A synchronous replica log client backed by the real service/session code.
pub struct RealLog {
    service: RealLogService,
    session: Session,
    next_call: u64,
}

fn invalid() -> LogError {
    LogError::code(LogErrorCode::Invalid)
}

fn field(c: &Cbor, key: u64) -> Option<&Cbor> {
    let Cbor::Map(fields) = c else { return None };
    fields
        .iter()
        .find(|(k, _)| *k == Cbor::Uint(key))
        .map(|(_, v)| v)
}

fn one<T: Wire>(c: &Cbor) -> Result<T, LogError> {
    T::from_cbor(c).map_err(|_| invalid())
}

fn bool_result(c: &Cbor) -> Result<bool, LogError> {
    match field(c, 0) {
        Some(Cbor::Bool(value)) => Ok(*value),
        _ => Err(invalid()),
    }
}

impl RealLog {
    /// The upgrade/most recent successful hello nonce visible to this client.
    pub fn server_nonce(&self) -> [u8; 32] {
        self.session.nonce
    }

    /// Server-side frame boundary for the eventual simulated network adapter.
    /// The caller supplies the host's next nonce; only production session
    /// dispatch may install authority. All bytes, including malformed frames
    /// and refusal replies, are retained verbatim for the untrusted tap.
    pub fn exchange(&mut self, frame: &[u8], fresh_nonce: [u8; 32]) -> Option<Vec<u8>> {
        let state = &self.service.0;
        state
            .host
            .observed
            .borrow_mut()
            .push(("request".into(), frame.to_vec()));
        let reply = ready(handle_frame(
            &state.service,
            &state.host,
            &mut self.session,
            frame,
            state.now.get(),
            fresh_nonce,
        ));
        if let Some(bytes) = &reply {
            state
                .host
                .observed
                .borrow_mut()
                .push(("response".into(), bytes.clone()));
        }
        reply
    }

    /// Drain actual production hub push frames without decoding them into typed
    /// replica replies; the simulated wire adapter sends these exact bytes.
    pub(crate) fn push_frames(&mut self) -> Vec<Vec<u8>> {
        self.service
            .0
            .host
            .pushes
            .borrow_mut()
            .remove(&self.session.id)
            .unwrap_or_default()
            .into_iter()
            .map(|p| LsFrame::Push(p).to_bytes().expect("real hub push encodes"))
            .collect()
    }

    /// Raw dispatch, including administrative methods used by the test control
    /// plane. Device clients cannot call these: real service authorization runs.
    pub fn request(&mut self, method: &str, params: Cbor) -> Result<Cbor, LogError> {
        let id = self.next_call;
        self.next_call += 1;
        let bytes = LsFrame::Request(LsRequest {
            id,
            method: method.into(),
            params,
        })
        .to_bytes()
        .map_err(|_| invalid())?;
        // Pure TEST-HOST schedule, not production entropy or a nonce API.
        // IDs distinguish reconnects within this live instance only. This is
        // NOT evidence of production nonce freshness across a service restart.
        let fresh_nonce = mdbn_wire::hash::h(
            "mdbase/sim-only/ls-nonce",
            &[self.session.id.to_be_bytes(), id.to_be_bytes()].concat(),
        )
        .0;
        let bytes = self.exchange(&bytes, fresh_nonce).ok_or_else(invalid)?;
        let LsFrame::Response(response) = LsFrame::from_bytes(&bytes).map_err(|_| invalid())?
        else {
            return Err(invalid());
        };
        if response.id != id {
            return Err(invalid());
        }
        if let Some(error) = response.error {
            let missing = error
                .details
                .as_ref()
                .and_then(|d| Vec::<mdbn_wire::common::B32>::from_cbor(d).ok())
                .unwrap_or_default();
            return Err(LogError::Service {
                code: LogErrorCode::parse(&error.code).unwrap_or(LogErrorCode::Unavailable),
                reason: error.reason,
                retry_after_ms: error.retry_after_ms,
                missing,
            });
        }
        response.result.ok_or_else(invalid)
    }

    fn direct(&self, url: &str) -> Result<mdbn_log_service::service::DirectOp, LogError> {
        self.service.direct_op(url)
    }
}

/// Canonical parameters for a replica call, shared by the synchronous binding
/// and the forthcoming trusted Node's exact-frame network transport.
pub fn request_params(request: &LogRequest) -> Cbor {
    use LogRequest as R;
    match request {
        R::Append(p) => p.to_cbor(),
        R::Read(p) => p.to_cbor(),
        R::Head { collection } => HeadParams {
            collection: *collection,
        }
        .to_cbor(),
        R::Subscribe {
            collection,
            after,
            inline_bytes,
        } => SubscribeParams {
            collection: *collection,
            after: *after,
            inline_bytes: *inline_bytes,
        }
        .to_cbor(),
        R::Unsubscribe { collection } | R::GetSnapshot { collection } => HeadParams {
            collection: *collection,
        }
        .to_cbor(),
        R::PutObject {
            collection,
            address,
            kind,
            bytes,
        } => PutObjectParams {
            collection: *collection,
            address: *address,
            kind: *kind,
            size: bytes.len() as u64,
            checksum: sha256(bytes),
            bytes: (bytes.len() <= 1 << 20).then(|| Bytes(bytes.clone())),
        }
        .to_cbor(),
        R::GetObject {
            collection,
            address,
            range,
        } => GetObjectParams {
            collection: *collection,
            address: *address,
            range: range.map(|(offset, len)| ByteRange { offset, len }),
        }
        .to_cbor(),
        R::HasObjects {
            collection,
            addresses,
        } => HasObjectsParams {
            collection: *collection,
            addresses: addresses.clone(),
        }
        .to_cbor(),
        R::PutSnapshot(p) => p.to_cbor(),
        R::EndorseSnapshot(p) => p.to_cbor(),
        R::StreamJoin { collection, stream } | R::StreamLeave { collection, stream } => StreamRef {
            collection: *collection,
            stream: *stream,
        }
        .to_cbor(),
        R::StreamSend {
            collection,
            stream,
            message,
        } => StreamSendParams {
            collection: *collection,
            stream: *stream,
            message: Bytes(message.clone()),
        }
        .to_cbor(),
    }
}

/// Encode the real RPC frame at the trusted caller boundary. Typed payloads do
/// not travel to the untrusted actor, and byte counts use the wire's u64 widths.
pub fn request_frame(request: &LogRequest, call: u64) -> Result<Vec<u8>, LogError> {
    LsFrame::Request(LsRequest {
        id: call,
        method: request.method().into(),
        params: request_params(request),
    })
    .to_bytes()
    .map_err(|_| invalid())
}

/// A real RPC reply either completes a replica call or requires direct transfer.
/// Upload acceptance is NEVER converted into an acknowledged PutObject here.
pub enum RpcStep {
    /// Terminal production reply.
    Complete(LogResponse),
    /// Upload bytes, then require a successful commit_object reply.
    Upload(DirectTransfer),
    /// Download bytes and validate the advertised whole-object metadata.
    Download {
        /// Signed URL and required HTTP headers.
        direct: DirectTransfer,
        /// Whole encoded object size (not the partial span).
        size: u64,
        /// Whole encoded object checksum (not the partial span).
        checksum: mdbn_wire::common::B32,
    },
}

/// Decode exact production response bytes at the trusted caller boundary.
/// Pending direct transfers are explicit so Node cannot acknowledge them early.
pub fn response_frame(request: &LogRequest, call: u64, bytes: &[u8]) -> Result<RpcStep, LogError> {
    use LogRequest as R;
    use LogResponse as S;
    let LsFrame::Response(response) = LsFrame::from_bytes(bytes).map_err(|_| invalid())? else {
        return Err(invalid());
    };
    if response.id != call {
        return Err(invalid());
    }
    if let Some(error) = response.error {
        return Err(LogError::Service {
            code: LogErrorCode::parse(&error.code).unwrap_or(LogErrorCode::Unavailable),
            reason: error.reason,
            retry_after_ms: error.retry_after_ms,
            missing: error
                .details
                .as_ref()
                .and_then(|d| Vec::<mdbn_wire::common::B32>::from_cbor(d).ok())
                .unwrap_or_default(),
        });
    }
    let result = response.result.ok_or_else(invalid)?;
    let reply = match request {
        R::Append(_) => S::Append(one(&result)?),
        R::Read(_) => S::Read(one(&result)?),
        R::Head { .. } => S::Head(one(&result)?),
        R::Subscribe { .. } => S::Subscribed {
            head: one(field(&result, 0).ok_or_else(invalid)?)?,
            head_chain: one(field(&result, 1).ok_or_else(invalid)?)?,
        },
        R::PutObject { .. } => {
            let p: PutObjectResult = one(&result)?;
            if p.status == PutStatus::Upload {
                return Ok(RpcStep::Upload(p.direct.ok_or_else(invalid)?));
            }
            if p.direct.is_some() {
                return Err(invalid());
            }
            S::PutObject {
                existed: p.status == PutStatus::Exists,
            }
        }
        R::GetObject { range, .. } => {
            let p: GetObjectResult = one(&result)?;
            if p.size > mdbn_log_service::limits::MAX_OBJECT_BYTES {
                return Err(LogError::code(LogErrorCode::TooLarge));
            }
            if range
                .is_some_and(|(offset, len)| offset.checked_add(len).is_none_or(|end| end > p.size))
            {
                return Err(invalid());
            }
            if let Some(bytes) = p.bytes {
                if p.direct.is_some()
                    || range.is_some_and(|(_, len)| bytes.0.len() as u64 != len)
                    || (range.is_none()
                        && (bytes.0.len() as u64 != p.size || sha256(&bytes.0) != p.checksum))
                {
                    return Err(invalid());
                }
                S::GetObject {
                    bytes: bytes.0,
                    size: p.size,
                    checksum: p.checksum,
                }
            } else {
                return Ok(RpcStep::Download {
                    direct: p.direct.ok_or_else(invalid)?,
                    size: p.size,
                    checksum: p.checksum,
                });
            }
        }
        R::HasObjects { .. } => S::HasObjects(one::<HasObjectsResult>(&result)?.present),
        R::PutSnapshot(_) => S::PutSnapshot(bool_result(&result)?),
        R::GetSnapshot { .. } => S::GetSnapshot(one::<GetSnapshotResult>(&result)?.snapshots),
        R::EndorseSnapshot(_) => S::EndorseSnapshot(bool_result(&result)?),
        R::StreamJoin { .. } => S::StreamJoined(one(field(&result, 0).ok_or_else(invalid)?)?),
        R::StreamSend { .. } => S::StreamSent(one(field(&result, 0).ok_or_else(invalid)?)?),
        R::Unsubscribe { .. } | R::StreamLeave { .. } => S::Ok,
    };
    Ok(RpcStep::Complete(reply))
}

/// Decode one production hub push into the replica's typed push, for both the
/// synchronous binding and the trusted Node's exact-frame transport.
/// All frames originate in the real hub; malformed output is a sim bug.
pub(crate) fn decode_push(p: LsPush) -> LogPush {
    match p.kind.as_str() {
        "head" => {
            let p: HeadPush = one(&p.payload).expect("head push");
            LogPush::Head {
                collection: p.collection,
                head: p.head,
                head_chain: p.head_chain,
            }
        }
        "items" => {
            let p: ItemsPush = one(&p.payload).expect("items push");
            LogPush::Items {
                collection: p.collection,
                items: p.items,
                head: p.head,
                head_chain: p.head_chain,
            }
        }
        "closed" => {
            let p: ClosedPush = one(&p.payload).expect("closed push");
            LogPush::Closed {
                collection: p.collection,
                reason: p.reason,
            }
        }
        "stream_msg" => {
            let p: StreamMsg = one(&p.payload).expect("stream message");
            LogPush::StreamMsg {
                collection: p.collection,
                stream: p.stream,
                from: p.from,
                message: p.message.0,
            }
        }
        "stream_event" => {
            let p: StreamEvent = one(&p.payload).expect("stream event");
            LogPush::StreamEvent {
                collection: p.collection,
                stream: p.stream,
                device: p.device,
                event: p.event,
            }
        }
        _ => panic!("unknown real hub push kind"),
    }
}

impl LogClient for RealLog {
    fn call(&mut self, request: LogRequest) -> LogReply {
        use LogRequest as R;
        use LogResponse as S;
        let result = self.request(request.method(), request_params(&request))?;
        Ok(match request {
            R::Append(_) => S::Append(one(&result)?),
            R::Read(_) => S::Read(one(&result)?),
            R::Head { .. } => S::Head(one(&result)?),
            R::Subscribe { .. } => S::Subscribed {
                head: one(field(&result, 0).ok_or_else(invalid)?)?,
                head_chain: one(field(&result, 1).ok_or_else(invalid)?)?,
            },
            R::PutObject {
                collection,
                address,
                bytes,
                ..
            } => {
                let p: PutObjectResult = one(&result)?;
                if p.status == PutStatus::Upload {
                    let op = self.direct(&p.direct.ok_or_else(invalid)?.url)?;
                    if !op.put
                        || op.collection != collection
                        || op.address != address
                        || op.expect != Some((bytes.len() as u64, sha256(&bytes)))
                    {
                        return Err(invalid());
                    }
                    let key = mdbn_log_service::service::staging_key(
                        &collection,
                        &address,
                        &op.device.ok_or_else(invalid)?,
                    );
                    self.service
                        .0
                        .host
                        .observed
                        .borrow_mut()
                        .push(("direct:upload".into(), bytes.clone()));
                    ready(self.service.0.service.objects.put(&key, bytes))
                        .map_err(|_| LogError::code(LogErrorCode::Unavailable))?;
                    let committed = self.request(
                        "commit_object",
                        CommitObjectParams {
                            collection,
                            address,
                        }
                        .to_cbor(),
                    )?;
                    if !bool_result(&committed)? {
                        return Err(invalid());
                    }
                }
                S::PutObject {
                    existed: p.status == PutStatus::Exists,
                }
            }
            R::GetObject {
                collection,
                address,
                range,
            } => {
                let p: GetObjectResult = one(&result)?;
                let bytes = if let Some(b) = p.bytes {
                    b.0
                } else {
                    let op = self.direct(&p.direct.ok_or_else(invalid)?.url)?;
                    if op.put || op.collection != collection || op.address != address {
                        return Err(invalid());
                    }
                    ready(
                        self.service
                            .0
                            .service
                            .objects
                            .get(&object_key(&collection, &address), range),
                    )
                    .map_err(|_| LogError::code(LogErrorCode::Unavailable))?
                    .ok_or_else(|| LogError::code(LogErrorCode::NotFound))?
                };
                self.service
                    .0
                    .host
                    .observed
                    .borrow_mut()
                    .push(("object:download".into(), bytes.clone()));
                S::GetObject {
                    bytes,
                    size: p.size,
                    checksum: p.checksum,
                }
            }
            R::HasObjects { .. } => S::HasObjects(one::<HasObjectsResult>(&result)?.present),
            R::PutSnapshot(_) => S::PutSnapshot(bool_result(&result)?),
            R::GetSnapshot { .. } => S::GetSnapshot(one::<GetSnapshotResult>(&result)?.snapshots),
            R::EndorseSnapshot(_) => S::EndorseSnapshot(bool_result(&result)?),
            R::StreamJoin { .. } => S::StreamJoined(one(field(&result, 0).ok_or_else(invalid)?)?),
            R::StreamSend { .. } => S::StreamSent(one(field(&result, 0).ok_or_else(invalid)?)?),
            R::Unsubscribe { .. } | R::StreamLeave { .. } => S::Ok,
        })
    }

    fn poll_pushes(&mut self) -> Vec<LogPush> {
        self.service
            .0
            .host
            .pushes
            .borrow_mut()
            .remove(&self.session.id)
            .unwrap_or_default()
            .into_iter()
            .map(decode_push)
            .collect()
    }
}

impl Drop for RealLog {
    fn drop(&mut self) {
        close(&self.service.0.host, &self.session);
        self.service
            .0
            .host
            .pushes
            .borrow_mut()
            .remove(&self.session.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mdbn_log_service::auth::Principal;
    use mdbn_log_service::testkit::{ControlPlane, Device, id16, object};
    use mdbn_wire::common::{B16, B32};
    use mdbn_wire::envelope::{Item, ItemKind};
    use mdbn_wire::hash::chain_hash;
    use mdbn_wire::policy::DeviceKind;

    fn append(client: &mut RealLog, collection: Uuid, item: Vec<u8>) -> LogReply {
        let decoded = Item::from_bytes(&item).unwrap();
        client.call(LogRequest::Append(AppendParams {
            collection,
            expect_seq: decoded.seq.unwrap(),
            expect_prev: decoded.prev.unwrap(),
            items: vec![Bytes(item)],
        }))
    }

    fn hello_params(token: String, device: Option<Uuid>, sig: mdbn_wire::common::B64) -> Cbor {
        LsHelloParams {
            version: mdbn_wire::common::Version { major: 1, minor: 0 },
            token,
            device,
            sig,
        }
        .to_cbor()
    }

    fn connection(service: &RealLogService) -> RealLog {
        // Explicit test-host nonce schedule within this service instance.
        let nonce = mdbn_wire::hash::h(
            "mdbase/sim-only/ls-open",
            &service.0.next_session.get().to_be_bytes(),
        )
        .0;
        service.connect(nonce)
    }

    fn control_client(service: &RealLogService, cp: &ControlPlane) -> RealLog {
        let mut client = connection(service);
        let token = cp.cp_token(1000);
        let sig = mdbn_log_service::testkit::sign_digest(
            cp.transport_key(),
            &mdbn_log_service::auth::hello_digest(&client.server_nonce(), &token),
        );
        client
            .request("hello", hello_params(token, None, sig))
            .unwrap();
        assert_eq!(client.session.principal, Some(Principal::ControlPlane));
        client
    }

    fn device_client(
        service: &RealLogService,
        cp: &ControlPlane,
        device: &Device,
        collection: Uuid,
    ) -> RealLog {
        let mut client = connection(service);
        let token = cp.device_token_for(device, 1000, Some(collection));
        let sig = device.hello_sig(&client.server_nonce(), &token);
        client
            .request("hello", hello_params(token, Some(device.id), sig))
            .unwrap();
        assert_eq!(
            client.session.principal,
            Some(Principal::Device {
                id: device.id,
                sign_pk: device.pk(),
                collection: Some(collection)
            })
        );
        client
    }

    fn fixture() -> (RealLogService, RealLog, ControlPlane, Device, Uuid, B32) {
        let cp = ControlPlane::new("sim-real-service");
        let owner = id16("owner");
        let device = Device::new("A", owner);
        let collection = id16("collection");
        let service = RealLogService::new(Config {
            roots: vec![cp.root_pk()],
            token_issuers: vec![cp.issuer_pk()],
            url_secret: vec![0x5a; 32],
            public_base: "https://sim.invalid".into(),
        });
        let mut control = control_client(&service, &cp);
        let genesis = cp.genesis(collection, owner);
        control
            .request(
                "create_log",
                Cbor::Map(vec![
                    (Cbor::Uint(0), collection.to_cbor()),
                    (Cbor::Uint(1), Cbor::Bytes(genesis.clone())),
                ]),
            )
            .unwrap();
        let enrol = cp.policy_item(
            collection,
            2,
            chain_hash(&genesis),
            vec![device.enrol(DeviceKind::Desktop)],
            2,
        );
        assert!(matches!(
            append(&mut control, collection, enrol.clone()),
            Ok(LogResponse::Append(AppendResult::Appended(_)))
        ));
        let mut client = device_client(&service, &cp, &device, collection);
        let rekey = device.rekey(collection, 3, chain_hash(&enrol), 0, &[device.id]);
        assert!(matches!(
            append(&mut client, collection, rekey.clone()),
            Ok(LogResponse::Append(AppendResult::Appended(_)))
        ));
        (service, client, cp, device, collection, chain_hash(&rekey))
    }

    #[test]
    fn node_wire_codec_correlates_real_replies_and_never_completes_pending_uploads() {
        let (_service, mut client, _cp, _device, collection, _prev) = fixture();
        let head = LogRequest::Head { collection };
        let bytes = client
            .exchange(&request_frame(&head, 900).unwrap(), [0x66; 32])
            .unwrap();
        assert!(matches!(
            response_frame(&head, 900, &bytes),
            Ok(RpcStep::Complete(LogResponse::Head(HeadResult {
                head: 3,
                ..
            })))
        ));
        assert!(matches!(
            response_frame(&head, 901, &bytes),
            Err(LogError::Service {
                code: LogErrorCode::Invalid,
                ..
            })
        ));
        let object = object(collection, ItemKind::Chunk, 1, vec![9; (1 << 20) + 1]);
        let put = LogRequest::PutObject {
            collection,
            address: sha256(&object),
            kind: ItemKind::Chunk,
            bytes: object,
        };
        let wire = request_frame(&put, 902).unwrap();
        let LsFrame::Request(raw) = LsFrame::from_bytes(&wire).unwrap() else {
            panic!("RPC request")
        };
        assert_eq!(raw.id, 902);
        assert_eq!(raw.method, "put_object");
        assert!(
            PutObjectParams::from_cbor(&raw.params)
                .unwrap()
                .bytes
                .is_none()
        );
        let bytes = client.exchange(&wire, [0x67; 32]).unwrap();
        assert!(matches!(
            response_frame(&put, 902, &bytes),
            Ok(RpcStep::Upload(DirectTransfer { .. }))
        ));
    }

    #[test]
    fn node_wire_codec_preserves_resource_refusal_and_rejects_wrong_inline_whole_hash() {
        let collection = id16("codec");
        let req = LogRequest::GetObject {
            collection,
            address: mdbn_wire::common::B32([7; 32]),
            range: None,
        };
        let response = |result, error| {
            LsFrame::Response(LsResponse {
                id: 9,
                result,
                error,
            })
            .to_bytes()
            .unwrap()
        };
        let refused = response(
            None,
            Some(LsError {
                code: "invalid".into(),
                reason: Some("cbor_budget".into()),
                message: None,
                details: None,
                retry_after_ms: Some(250),
            }),
        );
        assert!(
            matches!(response_frame(&req, 9, &refused), Err(LogError::Service { code: LogErrorCode::Invalid, reason: Some(r), retry_after_ms: Some(250), .. }) if r == "cbor_budget")
        );
        let body = vec![9; 64];
        let direct = DirectTransfer {
            url: "https://sim.invalid/o".into(),
            headers: Default::default(),
            expires_at: 1000,
        };
        let pending = response(
            Some(
                GetObjectResult {
                    bytes: None,
                    direct: Some(direct),
                    size: 64,
                    checksum: sha256(&body),
                }
                .to_cbor(),
            ),
            None,
        );
        assert!(matches!(
            response_frame(&req, 9, &pending),
            Ok(RpcStep::Download { size: 64, .. })
        ));
        let good = response(
            Some(
                GetObjectResult {
                    bytes: Some(Bytes(body.clone())),
                    direct: None,
                    size: 64,
                    checksum: sha256(&body),
                }
                .to_cbor(),
            ),
            None,
        );
        assert!(matches!(
            response_frame(&req, 9, &good),
            Ok(RpcStep::Complete(LogResponse::GetObject { .. }))
        ));
        let wrong = response(
            Some(
                GetObjectResult {
                    bytes: Some(Bytes(body)),
                    direct: None,
                    size: 64,
                    checksum: mdbn_wire::common::B32([8; 32]),
                }
                .to_cbor(),
            ),
            None,
        );
        assert!(response_frame(&req, 9, &wrong).is_err());
        let partial_req = LogRequest::GetObject {
            collection,
            address: mdbn_wire::common::B32([7; 32]),
            range: Some((0, 10)),
        };
        let partial = response(
            Some(
                GetObjectResult {
                    bytes: Some(Bytes(vec![9; 10])),
                    direct: None,
                    size: 64,
                    checksum: sha256(&[9; 64]),
                }
                .to_cbor(),
            ),
            None,
        );
        assert!(
            matches!(response_frame(&partial_req, 9, &partial), Ok(RpcStep::Complete(LogResponse::GetObject { size: 64, checksum, .. })) if checksum == sha256(&[9; 64]))
        );
        let short = response(
            Some(
                GetObjectResult {
                    bytes: Some(Bytes(vec![9; 9])),
                    direct: None,
                    size: 64,
                    checksum: sha256(&[9; 64]),
                }
                .to_cbor(),
            ),
            None,
        );
        assert!(response_frame(&partial_req, 9, &short).is_err());
        for range in [Some((64, 1)), Some((63, 2)), Some((u64::MAX, 1))] {
            let bad_req = LogRequest::GetObject {
                collection,
                address: mdbn_wire::common::B32([7; 32]),
                range,
            };
            assert!(
                response_frame(&bad_req, 9, &partial).is_err(),
                "never clamp requested span"
            );
        }
    }

    fn refused<T: std::fmt::Debug>(result: Result<T, LogError>, reason: &str) {
        assert!(
            matches!(result, Err(LogError::Service { code: LogErrorCode::Unauthenticated, reason: Some(ref r), .. }) if r == reason),
            "expected {reason}, got {result:?}"
        );
    }

    #[test]
    fn real_frame_boundary_retains_exact_hello_and_malformed_refusal_bytes() {
        let (service, _, cp, device, collection, _) = fixture();
        service.take_observed();
        let mut client = connection(&service);
        let token = cp.device_token_for(&device, 1000, Some(collection));
        let hello = LsFrame::Request(LsRequest {
            id: 731,
            method: "hello".into(),
            params: hello_params(
                token.clone(),
                Some(device.id),
                device.hello_sig(&client.server_nonce(), &token),
            ),
        })
        .to_bytes()
        .unwrap();
        let nonce = [0x74; 32];
        let reply = client.exchange(&hello, nonce).unwrap();
        assert!(matches!(
            LsFrame::from_bytes(&reply),
            Ok(LsFrame::Response(LsResponse {
                id: 731,
                error: None,
                result: Some(_),
                ..
            }))
        ));
        assert_eq!(client.server_nonce(), nonce);
        assert!(client.session.principal.is_some());
        assert_eq!(
            service.take_observed(),
            vec![
                ("request".into(), hello.clone()),
                ("response".into(), reply)
            ]
        );
        let malformed = [0xff];
        let refused = client.exchange(&malformed, [0x75; 32]).unwrap();
        assert!(matches!(
            LsFrame::from_bytes(&refused),
            Ok(LsFrame::Response(LsResponse {
                id: 0,
                error: Some(_),
                result: None
            }))
        ));
        assert_eq!(
            client.server_nonce(),
            nonce,
            "malformed frame must not install caller-supplied fresh nonce"
        );
        assert_eq!(
            service.take_observed(),
            vec![
                ("request".into(), malformed.to_vec()),
                ("response".into(), refused)
            ]
        );
        let replay = client.exchange(&hello, [0x76; 32]).unwrap();
        assert!(
            matches!(LsFrame::from_bytes(&replay), Ok(LsFrame::Response(LsResponse { id: 731, error: Some(e), .. })) if e.reason.as_deref() == Some("possession"))
        );
        assert_eq!(client.server_nonce(), nonce);
        assert_eq!(
            service.take_observed(),
            vec![("request".into(), hello), ("response".into(), replay)]
        );
    }

    #[test]
    fn real_hello_token_possession_and_expiry_refusals_do_not_install_authority() {
        let (service, _, cp, device, collection, _) = fixture();
        service.take_observed();
        let mut client = connection(&service);
        let nonce = client.server_nonce();
        refused(client.call(LogRequest::Head { collection }), "hello");
        let impostor = Device::with_id("impostor", device.id, device.account);
        let untrusted = ControlPlane::new("untrusted-issuer");
        let good = cp.device_token_for(&device, 1000, Some(collection));
        let wrong_issuer = untrusted.device_token_for(&device, 1000, Some(collection));
        let expired = cp.device_token_for(&device, 0, Some(collection));
        for (token, claimed_device, signer, reason) in [
            (wrong_issuer, device.id, &device, "token_signature"),
            (expired, device.id, &device, "expired"),
            (good.clone(), id16("wrong-hello-device"), &device, "device"),
            (good.clone(), device.id, &impostor, "possession"),
        ] {
            let sig = signer.hello_sig(&nonce, &token);
            refused(
                client.request("hello", hello_params(token, Some(claimed_device), sig)),
                reason,
            );
            assert_eq!(client.session.principal, None);
            assert_eq!(
                client.server_nonce(),
                nonce,
                "refusal cannot install a new nonce"
            );
            refused(client.call(LogRequest::Head { collection }), "hello");
        }
        let sig = device.hello_sig(&nonce, &good);
        client
            .request("hello", hello_params(good, Some(device.id), sig))
            .unwrap();
        assert!(matches!(
            client.call(LogRequest::Head { collection }),
            Ok(LogResponse::Head(HeadResult { head: 3, .. }))
        ));
        let observed = service.take_observed();
        assert!(observed.iter().any(|(path, bytes)| path == "request" && matches!(LsFrame::from_bytes(bytes), Ok(LsFrame::Request(r)) if r.method == "hello")));
        assert!(observed.iter().any(|(path, bytes)| path == "response"
            && matches!(
                LsFrame::from_bytes(bytes),
                Ok(LsFrame::Response(LsResponse { error: Some(_), .. }))
            )));
    }

    #[test]
    fn real_hello_rotates_nonce_and_replay_cannot_authenticate_a_fresh_connection() {
        let (service, _, cp, device, collection, _) = fixture();
        let mut a = connection(&service);
        let mut b = connection(&service);
        let initial = a.server_nonce();
        assert_ne!(initial, b.server_nonce());
        let token = cp.device_token_for(&device, 1000, Some(collection));
        let params = hello_params(
            token.clone(),
            Some(device.id),
            device.hello_sig(&initial, &token),
        );
        let result: LsHelloResult = one(&a.request("hello", params.clone()).unwrap()).unwrap();
        assert_eq!(result.server_nonce.0, a.server_nonce());
        assert_ne!(a.server_nonce(), initial);
        refused(b.request("hello", params.clone()), "possession");
        assert_eq!(b.session.principal, None);
        let authority = a.session.principal;
        let after = a.server_nonce();
        refused(a.request("hello", params), "possession");
        assert_eq!(a.session.principal, authority);
        assert_eq!(a.server_nonce(), after);
        let fresh = hello_params(
            token.clone(),
            Some(device.id),
            device.hello_sig(&after, &token),
        );
        a.request("hello", fresh).unwrap();
        assert_ne!(a.server_nonce(), after);
        service.set_now(1000);
        let mut expired = connection(&service);
        let params = hello_params(
            token.clone(),
            Some(device.id),
            device.hello_sig(&expired.server_nonce(), &token),
        );
        refused(expired.request("hello", params), "expired");
        assert_eq!(expired.session.principal, None);
        // Existing authenticated WebSockets are not per-request token verifiers;
        // this test claims expiry only at the production hello boundary.
    }

    #[test]
    fn real_authenticated_session_loses_collection_access_at_revocation() {
        use mdbn_wire::policy::{DeviceRevoke, PolicyOp};
        let (service, mut client, cp, device, collection, prev) = fixture();
        let mut control = control_client(&service, &cp);
        let revocation = cp.policy_item(
            collection,
            4,
            prev,
            vec![PolicyOp::DeviceRevoke(DeviceRevoke { device: device.id })],
            3,
        );
        append(&mut control, collection, revocation).unwrap();
        assert!(
            client.session.principal.is_some(),
            "session admission itself is unchanged"
        );
        assert!(matches!(
            client.call(LogRequest::Head { collection }),
            Err(LogError::Service {
                code: LogErrorCode::Forbidden,
                ..
            })
        ));
        assert!(matches!(
            client.call(LogRequest::Subscribe {
                collection,
                after: 3,
                inline_bytes: Some(4096)
            }),
            Err(LogError::Service {
                code: LogErrorCode::Forbidden,
                ..
            })
        ));
        assert!(
            !service
                .0
                .host
                .hubs
                .borrow()
                .get(&collection)
                .is_some_and(|h| h.is_subscribed(client.session.id))
        );
        let revoked_again = device_client(&service, &cp, &device, collection);
        assert!(
            revoked_again.session.principal.is_some(),
            "valid token proof is not collection authorization"
        );
        let mut revoked_again = revoked_again;
        assert!(matches!(
            revoked_again.call(LogRequest::Head { collection }),
            Err(LogError::Service {
                code: LogErrorCode::Forbidden,
                ..
            })
        ));
    }

    #[test]
    fn real_append_read_subscribe_replay_and_disconnect() {
        let (service, mut client, cp, device, collection, prev) = fixture();
        assert!(matches!(
            client.call(LogRequest::Subscribe {
                collection,
                after: 3,
                inline_bytes: Some(4096),
            }),
            Ok(LogResponse::Subscribed { head: 3, .. })
        ));
        let bytes = device.entry(collection, 4, prev, 1, B16([1; 16]), None, vec![9; 64]);
        let expected_chain = chain_hash(&bytes);
        assert!(matches!(
            append(&mut client, collection, bytes.clone()),
            Ok(LogResponse::Append(AppendResult::Appended(_)))
        ));
        assert!(matches!(client.poll_pushes().as_slice(),
            [LogPush::Items { head: 4, head_chain, items, .. }]
                if *head_chain == expected_chain && items[0].item.0 == bytes));
        assert!(matches!(
            append(&mut client, collection, bytes.clone()),
            Ok(LogResponse::Append(AppendResult::Appended(_)))
        ));
        let read = client
            .call(LogRequest::Read(ReadParams {
                collection,
                after: 3,
                limit: 10,
                kinds: None,
                max_bytes: None,
            }))
            .unwrap();
        assert!(
            matches!(read, LogResponse::Read(r) if r.items.len() == 1 && r.items[0].item.0 == bytes)
        );
        let session = client.session.id;
        drop(client);
        assert!(!service.0.host.hubs.borrow()[&collection].is_subscribed(session));
        service.lose_tail(&collection, 1);
        let mut observer = control_client(&service, &cp);
        assert!(matches!(
            observer.call(LogRequest::Head { collection }),
            Ok(LogResponse::Head(HeadResult { head: 3, .. }))
        ));
    }

    #[test]
    fn real_signature_scope_and_refs_errors_are_not_bypassed() {
        let (_, mut client, _, device, collection, prev) = fixture();
        let signed = device.entry(collection, 4, prev, 1, B16([2; 16]), None, vec![9; 64]);
        let mut bad = Item::from_bytes(&signed).unwrap();
        bad.body.0[0] ^= 1;
        assert!(
            matches!(append(&mut client, collection, bad.to_bytes().unwrap()),
            Err(LogError::Service { code: LogErrorCode::Invalid, reason: Some(r), .. }) if r == "signature")
        );
        assert!(matches!(
            client.call(LogRequest::Head {
                collection: id16("other")
            }),
            Err(LogError::Service { .. })
        ));
        let missing = B32([4; 32]);
        let bytes = device.entry(
            collection,
            4,
            prev,
            1,
            B16([3; 16]),
            Some(vec![missing]),
            vec![9; 64],
        );
        assert!(matches!(append(&mut client, collection, bytes),
            Err(LogError::Service { code: LogErrorCode::RefsMissing, missing: addresses, .. }) if addresses == vec![missing]));
    }

    #[test]
    fn observations_include_real_errors_and_unpolled_pushes() {
        let (service, mut client, _, device, collection, prev) = fixture();
        service.take_observed();
        client
            .call(LogRequest::Subscribe {
                collection,
                after: 3,
                inline_bytes: Some(4096),
            })
            .unwrap();
        let item = device.entry(collection, 4, prev, 1, B16([8; 16]), None, vec![9; 64]);
        append(&mut client, collection, item).unwrap();
        assert!(
            client
                .call(LogRequest::Head {
                    collection: id16("absent")
                })
                .is_err()
        );
        drop(client);
        let observed = service.take_observed();
        assert!(observed.iter().any(|(path, _)| path == "request"));
        assert!(observed.iter().any(|(path, bytes)| path == "push"
            && matches!(LsFrame::from_bytes(bytes), Ok(LsFrame::Push(_)))));
        assert!(observed.iter().any(|(path, bytes)| path == "response"
            && matches!(
                LsFrame::from_bytes(bytes),
                Ok(LsFrame::Response(LsResponse { error: Some(_), .. }))
            )));
        assert!(service.take_observed().is_empty());
    }

    #[test]
    fn real_streams_deliver_envelopes_and_disconnect_members() {
        let (service, mut a, cp, device_a, collection, prev) = fixture();
        let device_b = Device::new("B", device_a.account);
        let mut control = control_client(&service, &cp);
        let enrol = cp.policy_item(
            collection,
            4,
            prev,
            vec![device_b.enrol(DeviceKind::Desktop)],
            3,
        );
        assert!(matches!(
            append(&mut control, collection, enrol),
            Ok(LogResponse::Append(AppendResult::Appended(_)))
        ));
        let mut b = device_client(&service, &cp, &device_b, collection);
        let stream = B16([7; 16]);
        assert_eq!(
            a.call(LogRequest::StreamJoin { collection, stream }),
            Ok(LogResponse::StreamJoined(vec![]))
        );
        assert_eq!(
            b.call(LogRequest::StreamJoin { collection, stream }),
            Ok(LogResponse::StreamJoined(vec![device_a.id]))
        );
        assert!(
            matches!(a.poll_pushes().as_slice(), [LogPush::StreamEvent { device, event: StreamEventKind::Joined, .. }] if *device == device_b.id)
        );
        let message = device_b.ephemeral(collection, stream, 1, vec![9; 64]);
        assert_eq!(
            b.call(LogRequest::StreamSend {
                collection,
                stream,
                message: message.clone()
            }),
            Ok(LogResponse::StreamSent(1))
        );
        assert!(
            matches!(a.poll_pushes().as_slice(), [LogPush::StreamMsg { from, message: got, .. }] if *from == device_b.id && *got == message)
        );
        drop(b);
        assert!(
            matches!(a.poll_pushes().as_slice(), [LogPush::StreamEvent { device, event: StreamEventKind::Left, .. }] if *device == device_b.id)
        );
        assert_eq!(
            a.call(LogRequest::StreamLeave { collection, stream }),
            Ok(LogResponse::Ok)
        );
        assert_eq!(
            a.call(LogRequest::Unsubscribe { collection }),
            Ok(LogResponse::Ok)
        );
    }

    #[test]
    fn real_snapshot_pointers_and_endorsement_errors_are_preserved() {
        let (_, mut client, _, device, collection, _) = fixture();
        let chunk = object(collection, ItemKind::Chunk, 1, vec![9; 128]);
        let chunk_address = sha256(&chunk);
        assert!(
            client
                .call(LogRequest::PutObject {
                    collection,
                    address: chunk_address,
                    kind: ItemKind::Chunk,
                    bytes: chunk,
                })
                .is_ok()
        );
        let manifest = device.manifest(collection, 1, vec![chunk_address], vec![9; 128]);
        let manifest_address = sha256(&manifest);
        assert!(
            client
                .call(LogRequest::PutObject {
                    collection,
                    address: manifest_address,
                    kind: ItemKind::Manifest,
                    bytes: manifest,
                })
                .is_ok()
        );
        let put = LogRequest::PutSnapshot(PutSnapshotParams {
            collection,
            seq: 3,
            manifest: manifest_address,
            refs: vec![chunk_address],
        });
        assert_eq!(client.call(put.clone()), Ok(LogResponse::PutSnapshot(true)));
        assert_eq!(client.call(put), Ok(LogResponse::PutSnapshot(false)));
        assert!(
            matches!(client.call(LogRequest::GetSnapshot { collection }),
            Ok(LogResponse::GetSnapshot(pointers)) if pointers.len() == 1 && pointers[0].manifest == manifest_address)
        );
        assert!(
            matches!(client.call(LogRequest::EndorseSnapshot(EndorseSnapshotParams {
            collection, seq: 3, manifest: manifest_address,
        })), Err(LogError::Service { code: LogErrorCode::Forbidden, reason: Some(r), .. }) if r == "author")
        );
    }

    #[test]
    fn real_inline_and_direct_objects_preserve_bytes_ranges_and_dedup() {
        let (_, mut client, _, _, collection, _) = fixture();
        for len in [1024, (1 << 20) + 17] {
            let bytes = object(collection, ItemKind::Chunk, 1, vec![9; len]);
            let address = sha256(&bytes);
            let put = LogRequest::PutObject {
                collection,
                address,
                kind: ItemKind::Chunk,
                bytes: bytes.clone(),
            };
            assert_eq!(
                client.call(put.clone()),
                Ok(LogResponse::PutObject { existed: false })
            );
            assert_eq!(
                client.call(put),
                Ok(LogResponse::PutObject { existed: true })
            );
            assert!(
                matches!(client.call(LogRequest::GetObject { collection, address, range: None }),
                Ok(LogResponse::GetObject { bytes: got, checksum, size })
                    if got == bytes && checksum == address && size == bytes.len() as u64)
            );
            assert!(
                matches!(client.call(LogRequest::GetObject { collection, address, range: Some((20, 13)) }),
                Ok(LogResponse::GetObject { bytes: got, .. }) if got == bytes[20..33])
            );
            assert_eq!(
                client.call(LogRequest::HasObjects {
                    collection,
                    addresses: vec![address, B32([0; 32])]
                }),
                Ok(LogResponse::HasObjects(vec![true, false]))
            );
        }
    }
}
