//! The frame layer: `mdb-cbor/1` client frames ↔ [`ClientApi`] calls
//! (`replica-client-api.md` §1).
//!
//! Every transport (in-process WASM bindings, local IPC, the relay) carries the same
//! frames. This module is the one place that maps them to the typed API, so the
//! daemon, the hosted replica and `runtime.wasm` behave identically:
//!
//! - `c-request` → method dispatch with CBOR params → `c-response` (result or problem);
//! - [`Push`]es → `c-push` frames, with the push type names of [`Push::kind`];
//! - `await` and `submit` with `wait: confirmed` or `wait: published` are held here
//!   until their receipt criterion is satisfied (or the timeout), from [`Push::Receipt`];
//! - `cancel {0: id}` answers a held request with `cancelled`;
//! - [`Push::FenceApply`] becomes a replica → client `c-request`; the client's
//!   `c-response` becomes [`ClientApi::fence_result`] (§14).
//!
//! Sans-I/O and deterministic: the host feeds frames in, calls [`Frames::pump`] after
//! every call into the replica, and sends what [`Frames::take_outgoing`] returns. Time
//! for `await` timeouts comes from the host through [`Frames::tick`].
//!
//! Wire shapes the contract leaves open (the `describe` result, `validate` result)
//! are documented in the SDK frame-layer contract.

use std::collections::BTreeMap;

use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::client::{
    ClientFrame, ClientPush, ClientRequest, ClientResponse, FileChunk, HelloParams, Include,
    Materialization, OpenUploadParams, Problem, PublishState, Receipt, ReceiptState, SubmitParams,
    UploadChunkParams, WaitFor,
};
use mdbn_wire::common::{Hash, Uuid, Value};
use mdbn_wire::intent::MediaClass;
use mdbn_wire::schema::{SchemaError, Wire};

use crate::api::{
    ApiError, ApiResult, CallbackId, ChangesResult, ClientApi, ConflictEntry, Describe, ErrorCode,
    FenceEditor, FenceResult, HoldResolution, ListFiles, Push, SessionAuth, SessionId, StreamId,
    Target,
};

/// The longest `await`, `wait: confirmed` or `wait: published` is held. At the limit
/// the request is answered with the current receipt(s), so a held request always answers even if
/// no receipt push ever reaches this layer (the submitting session closed, or the
/// receipt left `pending` by a path that doesn't push).
pub const MAX_HOLD_MS: i64 = 5 * 60 * 1000;

/// Request ID of `hello`, the first request of every session.
pub const HELLO_ID: u64 = 0;

/// A request held until a receipt settles.
#[derive(Debug, Clone)]
struct Held {
    session: SessionId,
    request: u64,
    /// Mutations not yet satisfying `wait`; respond when this is empty.
    waiting: Vec<Uuid>,
    wait: WaitFor,
    /// Receipts so far, in order (for `submit`).
    receipts: Vec<Receipt>,
    /// `await` returns one receipt, not a list.
    single: bool,
    /// How long to hold, at most [`MAX_HOLD_MS`].
    timeout_ms: i64,
    /// Host time the hold started; set at the first `tick` if the host hadn't ticked yet.
    started: Option<i64>,
}

/// Per-session frame state.
#[derive(Debug, Default)]
struct SessionState {
    /// Replica → client requests awaiting the client's response (fence).
    callbacks: BTreeMap<u64, CallbackId>,
    next_callback: u64,
}

/// The frame layer for one replica. See the module docs.
#[derive(Debug, Default)]
pub struct Frames {
    sessions: BTreeMap<SessionId, SessionState>,
    held: Vec<Held>,
    out: Vec<(SessionId, Vec<u8>)>,
    closed: Vec<SessionId>,
    now_ms: i64,
    ticked: bool,
}

/// What [`Frames::hello`] produced.
#[derive(Debug)]
pub struct HelloOutcome {
    /// The session, when hello succeeded.
    pub session: Option<SessionId>,
    /// The encoded `c-response` to send back (inside the Noise handshake, or as the
    /// first frame of an in-process port).
    pub response: Vec<u8>,
}

fn receipt_waiting(r: &Receipt, wait: WaitFor) -> bool {
    match wait {
        WaitFor::Pending => false,
        WaitFor::Confirmed => r.state == ReceiptState::Pending,
        WaitFor::Published => {
            matches!(r.state, ReceiptState::Pending | ReceiptState::Confirmed)
                && r.published == Some(PublishState::Publishing)
        }
    }
}

fn bad(msg: &str) -> ApiError {
    ErrorCode::InvalidRequest.err(msg.to_owned())
}

fn schema(e: SchemaError) -> ApiError {
    if e.is_unknown() {
        ErrorCode::UpgradeRequired.err_with_reason("unknown_variant", e.to_string())
    } else {
        ErrorCode::InvalidRequest.err(e.to_string())
    }
}

/// The struct-map entries of request params (`null` or absent = empty).
fn fields(p: &Cbor) -> ApiResult<&[(Cbor, Cbor)]> {
    match p {
        Cbor::Null => Ok(&[]),
        Cbor::Map(m) if m.iter().all(|(k, _)| matches!(k, Cbor::Uint(_))) => Ok(m),
        _ => Err(bad("params must be a struct map")),
    }
}

fn field(m: &[(Cbor, Cbor)], key: u64) -> Option<&Cbor> {
    m.iter()
        .find(|(k, _)| *k == Cbor::Uint(key))
        .map(|(_, v)| v)
}

fn req(m: &[(Cbor, Cbor)], key: u64) -> ApiResult<&Cbor> {
    field(m, key).ok_or_else(|| bad(&format!("missing param {key}")))
}

fn dec<T: Wire>(c: &Cbor) -> ApiResult<T> {
    T::from_cbor(c).map_err(schema)
}

fn opt<T: Wire>(m: &[(Cbor, Cbor)], key: u64) -> ApiResult<Option<T>> {
    field(m, key).map(dec).transpose()
}

fn target(c: &Cbor) -> ApiResult<Target> {
    match c {
        Cbor::Text(p) => Ok(Target::Path(p.clone())),
        Cbor::Bytes(_) => Ok(Target::Id(dec(c)?)),
        _ => Err(bad("target must be a uuid or a path")),
    }
}

fn include(m: &[(Cbor, Cbor)], key: u64) -> ApiResult<Include> {
    Ok(opt::<Include>(m, key)?.unwrap_or(Include {
        effective: None,
        body: None,
        document: None,
        diagnostics: None,
    }))
}

fn smap(entries: Vec<(u64, Cbor)>) -> Cbor {
    Cbor::Map(
        entries
            .into_iter()
            .map(|(k, v)| (Cbor::Uint(k), v))
            .collect(),
    )
}

fn u32_of(c: &Cbor) -> ApiResult<u32> {
    let n: u64 = dec(c)?;
    u32::try_from(n).map_err(|_| bad("value out of range"))
}

/// Current SDK Describe schema: typed summaries and required contracts key 5.
fn describe_cbor(d: Describe) -> Cbor {
    let types = d
        .types
        .into_iter()
        .map(|t| {
            let implements = t
                .implements
                .into_iter()
                .map(|i| {
                    let mut fields = vec![
                        (0, i.contract.to_cbor()),
                        (1, i.version.to_cbor()),
                        (2, i.fields.to_cbor()),
                    ];
                    if let Some(binding) = i.binding {
                        fields.push((3, binding.to_cbor()));
                    }
                    smap(fields)
                })
                .collect();
            smap(vec![
                (0, t.name.to_cbor()),
                (1, t.path.to_cbor()),
                (2, Cbor::Array(implements)),
            ])
        })
        .collect();
    let contracts = d
        .contracts
        .into_iter()
        .map(|c| {
            smap(vec![
                (0, c.id.to_cbor()),
                (1, c.version.to_cbor()),
                (2, c.path.to_cbor()),
                (3, c.digest.to_cbor()),
                (4, c.contract_type.to_cbor()),
                (5, c.implemented_by.to_cbor()),
            ])
        })
        .collect();
    smap(vec![
        (0, d.spec_version.to_cbor()),
        (1, Cbor::Array(types)),
        (2, d.settings.to_cbor()),
        (3, d.inclusion.to_cbor()),
        (4, d.issues.to_cbor()),
        (5, Cbor::Array(contracts)),
    ])
}

// Producer DTOs have no expected-code field. Deprecated pending slot 3 and
// approval-push slot 1 are decode-only, never emitted or reused.
fn pending_device_cbor(d: crate::api::PendingDevice) -> Cbor {
    smap(vec![
        (0, d.device.to_cbor()),
        (1, d.account.to_cbor()),
        (2, d.kind.to_cbor()),
        (4, Cbor::Bool(d.exchange_ready)),
    ])
}

fn changes_cbor(c: ChangesResult) -> Cbor {
    smap(vec![
        (0, c.changes.to_cbor()),
        (1, Cbor::Text(c.cursor)),
        (2, Cbor::Bool(c.reset)),
    ])
}

fn conflicts_cbor(list: Vec<ConflictEntry>) -> Cbor {
    Cbor::Array(
        list.into_iter()
            .map(|e| {
                smap(vec![
                    (0, e.mutation.to_cbor()),
                    (1, Cbor::Uint(e.seq)),
                    (2, e.conflict.to_cbor()),
                ])
            })
            .collect(),
    )
}

fn push_payload(p: &Push) -> Cbor {
    match p {
        Push::Receipt(r) => r.to_cbor(),
        Push::ApprovalReady {
            device,
            exchange_ready,
        } => smap(vec![
            (0, device.to_cbor()),
            (2, Cbor::Bool(*exchange_ready)),
        ]),
        Push::QueryUpdate(u) => u.to_cbor(),
        Push::Changes(c) => changes_cbor(c.clone()),
        Push::Status(s) => s.to_cbor(),
        Push::Holds(h) => h.to_cbor(),
        Push::Conflicts(c) => conflicts_cbor(c.clone()),
        Push::Presence { record, peers } => smap(vec![(0, record.to_cbor()), (1, peers.to_cbor())]),
        Push::FileChunk(c) => c.to_cbor(),
        Push::TransferProgress(t) => t.to_cbor(),
        Push::FenceApply { apply, .. } => smap(vec![
            (0, Cbor::Text(apply.path.clone())),
            (1, apply.base.to_cbor()),
            (
                2,
                Cbor::Array(
                    apply
                        .edits
                        .iter()
                        .map(|(s, e, t)| {
                            Cbor::Array(vec![Cbor::Uint(*s), Cbor::Uint(*e), Cbor::Text(t.clone())])
                        })
                        .collect(),
                ),
            ),
            (3, apply.expected.to_cbor()),
        ]),
        Push::Closed(problem) => problem.to_cbor(),
    }
}

impl Frames {
    /// An empty frame layer.
    pub fn new() -> Self {
        Self::default()
    }

    /// Advance the host clock (for `await` timeouts).
    pub fn tick(&mut self, api: &mut dyn ClientApi, now_ms: i64) {
        self.now_ms = now_ms;
        self.ticked = true;
        for h in &mut self.held {
            h.started.get_or_insert(now_ms);
        }
        let (due, keep): (Vec<Held>, Vec<Held>) =
            std::mem::take(&mut self.held).into_iter().partition(|h| {
                h.started
                    .is_some_and(|s| s.saturating_add(h.timeout_ms) <= now_ms)
            });
        self.held = keep;
        for h in due {
            // At the timeout, answer with the current (still pending) receipts.
            let receipts: ApiResult<Vec<Receipt>> = h
                .receipts
                .iter()
                .map(|r| api.receipt(h.session, r.mutation))
                .collect();
            let result = receipts.map(|rs| {
                if h.single {
                    rs.into_iter()
                        .next()
                        .map(|r| r.to_cbor())
                        .unwrap_or(Cbor::Null)
                } else {
                    rs.to_cbor()
                }
            });
            self.respond(h.session, h.request, result);
        }
    }

    /// Open a session from an encoded `hello` request frame.
    pub fn hello(
        &mut self,
        api: &mut dyn ClientApi,
        auth: SessionAuth,
        frame: &[u8],
    ) -> HelloOutcome {
        let (id, result) = match decode_request(frame) {
            Ok(r) if r.method == "hello" => (
                r.id,
                HelloParams::from_cbor(&r.params)
                    .map_err(schema)
                    .and_then(|p| api.hello(auth, p)),
            ),
            Ok(r) => (
                r.id,
                Err(ErrorCode::Unauthenticated.err("the first request must be hello")),
            ),
            Err(e) => (HELLO_ID, Err(e)),
        };
        let (session, response) = match result {
            Ok((s, hello)) => {
                self.sessions.insert(s, SessionState::default());
                (Some(s), response_bytes(id, Ok(hello.to_cbor())))
            }
            Err(e) => (None, response_bytes(id, Err(e))),
        };
        let mut out = HelloOutcome { session, response };
        if let Some(s) = out.session {
            // Pushes the hello itself queued (none today) follow the response.
            self.pump(api);
            out.session = Some(s);
        }
        out
    }

    /// Feed one encoded frame received from `session`'s client.
    pub fn on_frame(&mut self, api: &mut dyn ClientApi, session: SessionId, frame: &[u8]) {
        if !self.sessions.contains_key(&session) {
            return;
        }
        let parsed = cbor::decode(frame)
            .map_err(|e| bad(&format!("not mdb-cbor/1: {e}")))
            .and_then(|c| ClientFrame::from_cbor(&c).map_err(schema));
        match parsed {
            Ok(ClientFrame::Request(r)) => self.on_request(api, session, r),
            Ok(ClientFrame::Response(r)) => self.on_response(api, session, r),
            // Clients send no pushes; ignore.
            Ok(ClientFrame::Push(_)) => {}
            // A frame we can't parse has no request ID to answer: close the session.
            Err(_) => self.close(api, session),
        }
        self.pump(api);
    }

    /// Close a session (transport closed): drops held requests and callbacks.
    pub fn close(&mut self, api: &mut dyn ClientApi, session: SessionId) {
        if self.sessions.remove(&session).is_some() {
            api.close(session);
            // Drop already serialized but unsent data when authorization or
            // apply recovery closes a session; never flush stale plaintext.
            self.out.retain(|(s, _)| *s != session);
            self.held.retain(|h| h.session != session);
            self.closed.push(session);
        }
    }

    /// Drain pushes from the replica into frames, and answer held requests whose
    /// receipts settled. Call after every call into the replica (and after `tick`).
    pub fn pump(&mut self, api: &mut dyn ClientApi) {
        for (session, push) in api.take_pushes() {
            // The receipt push goes out first, then any response it releases.
            let settled = match &push {
                Push::Receipt(r) => Some(r.clone()),
                _ => None,
            };
            self.forward(api, session, push);
            if let Some(r) = settled {
                self.settle(&r);
            }
        }
    }

    fn forward(&mut self, api: &mut dyn ClientApi, session: SessionId, push: Push) {
        {
            let Some(state) = self.sessions.get_mut(&session) else {
                return;
            };
            match &push {
                Push::FenceApply { id, .. } => {
                    let rid = state.next_callback;
                    state.next_callback += 1;
                    state.callbacks.insert(rid, *id);
                    let f = ClientFrame::Request(ClientRequest {
                        id: rid,
                        method: "fence_apply".into(),
                        params: push_payload(&push),
                    });
                    self.send(session, &f);
                }
                Push::Closed(_) => {
                    let f = ClientFrame::Push(ClientPush {
                        kind: push.kind().into(),
                        payload: push_payload(&push),
                    });
                    self.close(api, session);
                    self.send(session, &f);
                }
                _ => {
                    let f = ClientFrame::Push(ClientPush {
                        kind: push.kind().into(),
                        payload: push_payload(&push),
                    });
                    self.send(session, &f);
                }
            }
        }
    }

    /// Frames to send, per session, in order.
    pub fn take_outgoing(&mut self) -> Vec<(SessionId, Vec<u8>)> {
        std::mem::take(&mut self.out)
    }

    /// Sessions this layer closed (a `closed` push, or a malformed frame). The host
    /// closes their transports.
    pub fn take_closed(&mut self) -> Vec<SessionId> {
        std::mem::take(&mut self.closed)
    }

    fn settle(&mut self, r: &Receipt) {
        let mut done = Vec::new();
        for (i, h) in self.held.iter_mut().enumerate() {
            if let Some(slot) = h.receipts.iter_mut().find(|x| x.mutation == r.mutation) {
                *slot = r.clone();
            }
            if let Some(pos) = h.waiting.iter().position(|m| *m == r.mutation) {
                if receipt_waiting(r, h.wait) {
                    continue;
                }
                h.waiting.remove(pos);
                if h.waiting.is_empty() {
                    done.push(i);
                }
            }
        }
        for i in done.into_iter().rev() {
            let h = self.held.remove(i);
            let result = if h.single {
                h.receipts
                    .into_iter()
                    .next()
                    .map(|r| r.to_cbor())
                    .unwrap_or(Cbor::Null)
            } else {
                h.receipts.to_cbor()
            };
            self.respond(h.session, h.request, Ok(result));
        }
    }

    fn send(&mut self, session: SessionId, f: &ClientFrame) {
        // Encoding our own well-formed values cannot fail; if it ever does, the
        // client sees the session close rather than a corrupt frame.
        if let Ok(b) = f.to_bytes() {
            self.out.push((session, b));
        }
    }

    fn respond(&mut self, session: SessionId, id: u64, r: ApiResult<Cbor>) {
        if !self.sessions.contains_key(&session) {
            return;
        }
        self.out.push((session, response_bytes(id, r)));
    }

    fn on_response(&mut self, api: &mut dyn ClientApi, session: SessionId, r: ClientResponse) {
        let Some(cb) = self
            .sessions
            .get_mut(&session)
            .and_then(|s| s.callbacks.remove(&r.id))
        else {
            return;
        };
        let result = match (&r.result, &r.problem) {
            (Some(c), None) => fence_result(c),
            // A client that failed the callback: treat the buffer as unknown.
            _ => Some(FenceResult::NotOpen),
        };
        if let Some(fr) = result {
            let _ = api.fence_result(session, cb, fr);
        }
    }

    fn on_request(&mut self, api: &mut dyn ClientApi, session: SessionId, r: ClientRequest) {
        let id = r.id;
        match r.method.as_str() {
            "cancel" => {
                let target = fields(&r.params)
                    .and_then(|m| req(m, 0).cloned())
                    .and_then(|c| dec::<u64>(&c));
                if let Ok(t) = target
                    && let Some(i) = self
                        .held
                        .iter()
                        .position(|h| h.session == session && h.request == t)
                {
                    self.held.remove(i);
                    self.respond(
                        session,
                        t,
                        Err(ErrorCode::Cancelled.err("cancelled by the client")),
                    );
                }
                self.respond(session, id, Ok(Cbor::Null));
            }
            "submit" => match SubmitParams::from_cbor(&r.params).map_err(schema) {
                Err(e) => self.respond(session, id, Err(e)),
                Ok(p) => {
                    let wait = p.wait.unwrap_or(WaitFor::Pending);
                    match api.submit(session, p) {
                        Err(e) => self.respond(session, id, Err(e)),
                        Ok(receipts) => {
                            let waiting: Vec<Uuid> = receipts
                                .iter()
                                .filter(|r| receipt_waiting(r, wait))
                                .map(|r| r.mutation)
                                .collect();
                            if !waiting.is_empty() {
                                self.held.push(Held {
                                    session,
                                    request: id,
                                    waiting,
                                    wait,
                                    receipts,
                                    single: false,
                                    timeout_ms: MAX_HOLD_MS,
                                    started: self.ticked.then_some(self.now_ms),
                                });
                            } else {
                                self.respond(session, id, Ok(receipts.to_cbor()));
                            }
                        }
                    }
                }
            },
            "await" => {
                let parsed = fields(&r.params)
                    .and_then(|m| Ok((dec::<Uuid>(req(m, 0)?)?, opt::<u64>(m, 1)?)));
                match parsed.and_then(|(m, t)| Ok((api.receipt(session, m)?, t))) {
                    Err(e) => self.respond(session, id, Err(e)),
                    Ok((rc, _)) if rc.state != ReceiptState::Pending => {
                        self.respond(session, id, Ok(rc.to_cbor()))
                    }
                    Ok((rc, timeout)) => {
                        let timeout_ms = timeout
                            .map_or(MAX_HOLD_MS, |t| i64::try_from(t).unwrap_or(i64::MAX))
                            .min(MAX_HOLD_MS);
                        self.held.push(Held {
                            session,
                            request: id,
                            waiting: vec![rc.mutation],
                            wait: WaitFor::Confirmed,
                            receipts: vec![rc],
                            single: true,
                            timeout_ms,
                            started: self.ticked.then_some(self.now_ms),
                        });
                    }
                }
            }
            method => {
                let result = dispatch(api, session, method, &r.params);
                self.respond(session, id, result);
            }
        }
    }
}

fn fence_result(c: &Cbor) -> Option<FenceResult> {
    let m = fields(c).ok()?;
    match field(m, 0)? {
        Cbor::Uint(0) => Some(FenceResult::Applied),
        Cbor::Uint(1) => Some(FenceResult::NotOpen),
        Cbor::Uint(2) => match field(m, 1) {
            Some(Cbor::Text(b)) => Some(FenceResult::BufferChanged(b.clone())),
            _ => Some(FenceResult::NotOpen),
        },
        _ => None,
    }
}

fn decode_request(frame: &[u8]) -> ApiResult<ClientRequest> {
    let c = cbor::decode(frame).map_err(|e| bad(&format!("not mdb-cbor/1: {e}")))?;
    match ClientFrame::from_cbor(&c).map_err(schema)? {
        ClientFrame::Request(r) => Ok(r),
        _ => Err(bad("expected a request")),
    }
}

fn response_bytes(id: u64, r: ApiResult<Cbor>) -> Vec<u8> {
    let f = match r {
        Ok(result) => ClientFrame::Response(ClientResponse {
            id,
            result: Some(result),
            problem: None,
        }),
        Err(e) => ClientFrame::Response(ClientResponse {
            id,
            result: None,
            problem: Some(e.into_problem()),
        }),
    };
    f.to_bytes().unwrap_or_else(|_| {
        // Only an unencodable result (a non-finite float) gets here.
        let p: Problem = ErrorCode::Internal.problem("result could not be encoded");
        ClientFrame::Response(ClientResponse {
            id,
            result: None,
            problem: Some(p),
        })
        .to_bytes()
        .unwrap_or_default()
    })
}

fn unit(r: ApiResult<()>) -> ApiResult<Cbor> {
    r.map(|()| Cbor::Null)
}

/// Every request method except `hello`, `cancel`, `submit` and `await`.
fn dispatch(api: &mut dyn ClientApi, s: SessionId, method: &str, params: &Cbor) -> ApiResult<Cbor> {
    let m = fields(params);
    match method {
        "describe" => api.describe(s).map(describe_cbor),
        "get_resource" => {
            let m = m?;
            if m.len() != 1 {
                return Err(bad("get_resource requires exactly one path field"));
            }
            let resource = api.get_resource(s, dec(req(m, 0)?)?)?;
            Ok(smap(vec![
                (0, Cbor::Text(resource.path)),
                (1, resource.revision.to_cbor()),
                (2, Cbor::Uint(resource.size)),
                (3, Cbor::Uint(u64::from(!resource.confirmed))),
                (4, Cbor::Text(resource.text)),
            ]))
        }
        "list_resources" => {
            let invalid = || {
                ErrorCode::InvalidRequest.err_with_reason(
                    "invalid_resource_params",
                    "invalid resource list parameters",
                )
            };
            let Cbor::Map(m) = params else {
                return Err(invalid());
            };
            if m.iter().any(|(key, _)| !matches!(key, Cbor::Uint(0..=3))) {
                return Err(ErrorCode::InvalidRequest
                    .err_with_reason("unknown_param", "list_resources supports only params 0–3"));
            }
            for key in 0..=3 {
                if m.iter().filter(|(k, _)| *k == Cbor::Uint(key)).count() > 1 {
                    return Err(invalid());
                }
            }
            let bounded_text = |key| -> ApiResult<Option<String>> {
                match field(m, key) {
                    None => Ok(None),
                    Some(Cbor::Text(value)) if value.len() <= crate::store::RESOURCE_PATH_BYTES => {
                        Ok(Some(value.clone()))
                    }
                    Some(Cbor::Text(_)) => Err(ErrorCode::TooLarge.err_with_reason(
                        "resource_budget_exceeded",
                        "resource parameter exceeds its fixed budget",
                    )),
                    _ => Err(invalid()),
                }
            };
            let text = match field(m, 1) {
                None => None,
                Some(Cbor::Bool(value)) => Some(*value),
                _ => return Err(invalid()),
            };
            let limit = match field(m, 3) {
                None => None,
                Some(Cbor::Uint(value @ 1..=128)) => Some(*value as u32),
                Some(Cbor::Uint(value)) if *value > 128 => {
                    return Err(ErrorCode::TooLarge.err_with_reason(
                        "resource_budget_exceeded",
                        "resource limit exceeds the 128-row cap",
                    ));
                }
                _ => return Err(invalid()),
            };
            let result = api.list_resources(
                s,
                crate::api::ListResources {
                    folder: bounded_text(0)?,
                    text,
                    cursor: bounded_text(2)?,
                    limit,
                },
            )?;
            Ok(result.to_cbor())
        }
        "get" => {
            let m = m?;
            let r = api.get(s, target(req(m, 0)?)?, include(m, 1)?)?;
            Ok(r.to_cbor())
        }
        "query" => {
            let m = m?;
            if m.iter().any(|(key, _)| !matches!(key, Cbor::Uint(0 | 1))) {
                return Err(ErrorCode::InvalidRequest.err_with_reason(
                    "unknown_param",
                    "query supports only params 0 (query) and 1 (include)",
                ));
            }
            let q: Value = dec(req(m, 0)?)?;
            Ok(api.query(s, q, include(m, 1)?)?.to_cbor())
        }
        "subscribe" => {
            let m = m?;
            let q: Value = dec(req(m, 0)?)?;
            let sub = api.subscribe(s, q, include(m, 1)?)?;
            Ok(smap(vec![(0, Cbor::Uint(sub))]))
        }
        "unsubscribe" => unit(api.unsubscribe(s, dec(req(m?, 0)?)?)),
        "changes" => {
            let m = m?;
            let cursor = match field(m, 0) {
                None | Some(Cbor::Null) => None,
                Some(c) => Some(dec::<String>(c)?),
            };
            let limit = field(m, 1).map(u32_of).transpose()?;
            let watch = opt::<bool>(m, 2)?.unwrap_or(false);
            api.changes(s, cursor, limit, watch).map(changes_cbor)
        }
        "validate" => {
            let m = m?;
            let targets = match field(m, 0) {
                None | Some(Cbor::Null) => None,
                Some(Cbor::Array(a)) => Some(a.iter().map(target).collect::<ApiResult<_>>()?),
                Some(_) => return Err(bad("validate targets must be a list")),
            };
            let out = api.validate(s, targets)?;
            Ok(Cbor::Array(
                out.into_iter()
                    .map(|(id, issues)| smap(vec![(0, id.to_cbor()), (1, issues.to_cbor())]))
                    .collect(),
            ))
        }
        "receipt" => Ok(api.receipt(s, dec(req(m?, 0)?)?)?.to_cbor()),
        "get_status" => Ok(api.status(s)?.to_cbor()),
        "applied_prefix" => Ok(api.applied_prefix(s, dec(req(m?, 0)?)?)?.to_cbor()),
        "subscribe_status" => unit(api.subscribe_status(s)),
        "list_holds" => Ok(api.list_holds(s)?.to_cbor()),
        "subscribe_holds" => unit(api.subscribe_holds(s)),
        "resolve_hold" => {
            let m = m?;
            let id: Uuid = dec(req(m, 0)?)?;
            let how = match (dec::<u64>(req(m, 1)?)?, field(m, 2)) {
                (0, _) => HoldResolution::KeepMine,
                (1, _) => HoldResolution::TakeTheirs,
                (2, Some(Cbor::Text(doc))) => HoldResolution::Use(doc.clone()),
                (2, Some(c @ Cbor::Bytes(_))) => HoldResolution::UseUpload(dec(c)?),
                (2, _) => return Err(bad("use needs a document or an upload's transfer ID")),
                (3, _) => HoldResolution::Delete,
                (4, _) => HoldResolution::KeepBoth,
                (n, _) => {
                    return Err(ErrorCode::UpgradeRequired
                        .err_with_reason("unknown_variant", format!("hold resolution {n}")));
                }
            };
            Ok(api.resolve_hold(s, id, how)?.to_cbor())
        }
        "list_conflicts" => {
            let m = m?;
            api.list_conflicts(s, opt(m, 0)?).map(conflicts_cbor)
        }
        "subscribe_conflicts" => unit(api.subscribe_conflicts(s)),
        "pending_devices" => Ok(Cbor::Array(
            api.pending_devices(s)?
                .into_iter()
                .map(pending_device_cbor)
                .collect(),
        )),
        "approve_device" => {
            let m = m?;
            unit(api.approve_device(s, dec(req(m, 0)?)?, dec(req(m, 1)?)?))
        }
        "reject_device" => unit(api.reject_device(s, dec(req(m?, 0)?)?)),
        "list_files" => {
            let m = m?;
            let p = ListFiles {
                folder: opt(m, 0)?,
                media: opt::<Vec<MediaClass>>(m, 1)?,
                cursor: opt(m, 2)?,
                limit: field(m, 3).map(u32_of).transpose()?,
            };
            let l = api.list_files(s, p)?;
            let mut e = vec![(0, l.files.to_cbor())];
            if let Some(c) = l.cursor {
                e.push((1, Cbor::Text(c)));
            }
            e.push((2, Cbor::Bool(l.complete)));
            Ok(smap(e))
        }
        "get_file" => Ok(api.get_file(s, target(req(m?, 0)?)?)?.to_cbor()),
        "open_upload" => Ok(api
            .open_upload(s, dec::<OpenUploadParams>(params)?)?
            .to_cbor()),
        "upload_chunk" => {
            let n = api.upload_chunk(s, dec::<UploadChunkParams>(params)?)?;
            Ok(smap(vec![(0, Cbor::Uint(n))]))
        }
        "commit_upload" => Ok(api.commit_upload(s, dec(req(m?, 0)?)?)?.to_cbor()),
        "abort_upload" => unit(api.abort_upload(s, dec(req(m?, 0)?)?)),
        "read_file" => {
            let m = m?;
            let range = match field(m, 1) {
                None => None,
                Some(Cbor::Array(a)) if a.len() == 2 => Some((dec(&a[0])?, dec(&a[1])?)),
                Some(_) => return Err(bad("range must be [offset, length]")),
            };
            let rev: Option<Hash> = opt(m, 2)?;
            let (StreamId(stream), view) = api.read_file(s, target(req(m, 0)?)?, range, rev)?;
            Ok(smap(vec![(0, Cbor::Uint(stream)), (1, view.to_cbor())]))
        }
        "ack_chunks" => {
            let m = m?;
            unit(api.ack_chunks(s, StreamId(dec(req(m, 0)?)?), dec(req(m, 1)?)?))
        }
        "fetch_file" => unit(api.fetch_file(s, dec(req(m?, 0)?)?)),
        "evict_file" => unit(api.evict_file(s, dec(req(m?, 0)?)?)),
        "get_materialization" => Ok(api.get_materialization(s)?.to_cbor()),
        "set_materialization" => unit(api.set_materialization(s, dec::<Materialization>(params)?)),
        "presence_join" => {
            let m = m?;
            unit(api.presence_join(s, dec(req(m, 0)?)?, dec(req(m, 1)?)?))
        }
        "presence_update" => {
            let m = m?;
            unit(api.presence_update(s, dec(req(m, 0)?)?, dec(req(m, 1)?)?))
        }
        "presence_leave" => unit(api.presence_leave(s, dec(req(m?, 0)?)?)),
        "subscribe_presence" => unit(api.subscribe_presence(s, dec(req(m?, 0)?)?)),
        "fence_report" => {
            let m = m?;
            let list = match req(m, 0)? {
                Cbor::Array(a) => a,
                _ => return Err(bad("fence_report needs a list")),
            };
            let editors = list
                .iter()
                .map(|e| {
                    let f = fields(e)?;
                    Ok(FenceEditor {
                        path: dec(req(f, 0)?)?,
                        dirty: dec(req(f, 1)?)?,
                        buffer: dec(req(f, 2)?)?,
                    })
                })
                .collect::<ApiResult<_>>()?;
            unit(api.fence_report(s, editors))
        }
        _ => Err(ErrorCode::InvalidRequest
            .err_with_reason("unknown_method", format!("unknown method {method}"))),
    }
}

/// Existing file-read wire requests, decoded by the shared frame codec for a
/// host-owned streaming runtime. No alternate parameter grammar is introduced.
#[derive(Debug)]
pub enum FileReadRequest {
    /// Capture a pinned file read.
    Read {
        /// File identity or exact path.
        target: Target,
        /// Requested offset and length.
        range: Option<(u64, u64)>,
        /// Expected whole-file digest.
        revision: Option<Hash>,
    },
    /// Cumulative file offset acknowledged by this session.
    Ack {
        /// This session's opaque file stream.
        stream: StreamId,
        /// Cumulative file offset.
        offset: u64,
    },
    /// Stop this session's file stream (existing SDK cancellation request).
    Cancel {
        /// This session's opaque file stream.
        stream: StreamId,
    },
}

/// Recognized requests return their original ID even on a parameter error.
/// Everything else remains with the ordinary frame dispatcher.
pub fn file_read_request(frame: &[u8]) -> Option<(u64, ApiResult<FileReadRequest>)> {
    let c = cbor::decode(frame).ok()?;
    let ClientFrame::Request(r) = ClientFrame::from_cbor(&c).ok()? else {
        return None;
    };
    if !matches!(
        r.method.as_str(),
        "read_file" | "ack_chunks" | "cancel_stream"
    ) {
        return None;
    }
    let parsed = (|| {
        let m = fields(&r.params)?;
        Ok(match r.method.as_str() {
            "read_file" => {
                let range = match field(m, 1) {
                    None => None,
                    Some(Cbor::Array(a)) if a.len() == 2 => Some((dec(&a[0])?, dec(&a[1])?)),
                    Some(_) => return Err(bad("range must be [offset, length]")),
                };
                FileReadRequest::Read {
                    target: target(req(m, 0)?)?,
                    range,
                    revision: opt(m, 2)?,
                }
            }
            "ack_chunks" => FileReadRequest::Ack {
                stream: StreamId(dec(req(m, 0)?)?),
                offset: dec(req(m, 1)?)?,
            },
            _ => FileReadRequest::Cancel {
                stream: StreamId(dec(req(m, 0)?)?),
            },
        })
    })();
    Some((r.id, parsed))
}

/// A `file-chunk` push, for hosts that build them outside the replica.
pub fn file_chunk_push(mut c: FileChunk) -> Vec<u8> {
    let encoded = file_chunk_push_slice(c.stream, c.offset, &c.bytes.0, c.last);
    zeroize::Zeroize::zeroize(&mut c.bytes.0);
    encoded
}

/// Encode the exact existing canonical `file_chunk` Push from an authenticated
/// borrowed slice. One framed output allocation, no plaintext/Cbor body clones.
/// The caller retains responsibility for wiping its source region and output.
pub fn file_chunk_push_slice(stream: u64, offset: u64, bytes: &[u8], last: bool) -> Vec<u8> {
    fn head(out: &mut Vec<u8>, major: u8, value: u64) {
        let prefix = major << 5;
        match value {
            0..=23 => out.push(prefix | value as u8),
            24..=255 => {
                out.push(prefix | 24);
                out.push(value as u8);
            }
            256..=65535 => {
                out.push(prefix | 25);
                out.extend_from_slice(&(value as u16).to_be_bytes());
            }
            65536..=4294967295 => {
                out.push(prefix | 26);
                out.extend_from_slice(&(value as u32).to_be_bytes());
            }
            _ => {
                out.push(prefix | 27);
                out.extend_from_slice(&value.to_be_bytes());
            }
        }
    }
    let mut out = Vec::with_capacity(bytes.len().saturating_add(64));
    out.extend_from_slice(&[0xa3, 0, 2, 1, 0x6a]);
    out.extend_from_slice(b"file_chunk");
    out.extend_from_slice(&[2, 0xa4, 0]);
    head(&mut out, 0, stream);
    out.push(1);
    head(&mut out, 0, offset);
    out.push(2);
    head(&mut out, 2, bytes.len() as u64);
    out.extend_from_slice(bytes);
    out.extend_from_slice(&[3, if last { 0xf5 } else { 0xf4 }]);
    out
}

#[cfg(test)]
mod approval_codec_tests {
    use super::*;
    use mdbn_wire::{common::B16, policy::DeviceKind};

    fn golden(name: &str) -> Vec<u8> {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("tests/approval-wire-golden.json")).unwrap();
        let hex = fixture[name]["cbor_hex"].as_str().unwrap();
        hex.as_bytes()
            .chunks_exact(2)
            .map(|b| u8::from_str_radix(std::str::from_utf8(b).unwrap(), 16).unwrap())
            .collect()
    }

    #[test]
    fn pending_golden_uses_ready_slot_four_and_never_sas_slot_three() {
        let payload = pending_device_cbor(crate::api::PendingDevice {
            device: B16([0; 16]),
            account: B16([1; 16]),
            kind: DeviceKind::Desktop,
            exchange_ready: true,
        });
        assert_eq!(cbor::encode(&payload).unwrap(), golden("pending_device"));
        let fields = fields(&payload).unwrap();
        assert!(field(fields, 3).is_none());
        assert_eq!(field(fields, 4), Some(&Cbor::Bool(true)));
    }

    #[test]
    fn approval_push_golden_uses_ready_slot_two_and_never_sas_slot_one() {
        let push = Push::ApprovalReady {
            device: B16([0; 16]),
            exchange_ready: true,
        };
        assert_eq!(push.kind(), "approval");
        let payload = push_payload(&push);
        assert_eq!(cbor::encode(&payload).unwrap(), golden("approval_ready"));
        let fields = fields(&payload).unwrap();
        assert!(field(fields, 1).is_none());
        assert_eq!(field(fields, 2), Some(&Cbor::Bool(true)));
    }

    #[test]
    fn unready_push_is_not_a_code_or_key_delivery_ack() {
        let payload = push_payload(&Push::ApprovalReady {
            device: B16([0; 16]),
            exchange_ready: false,
        });
        let fields = fields(&payload).unwrap();
        assert_eq!(fields.len(), 2);
        assert!(field(fields, 1).is_none());
        assert_eq!(field(fields, 2), Some(&Cbor::Bool(false)));
    }
}
