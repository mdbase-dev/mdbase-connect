//! The hosted engine of one collection: the replica in hosted mode
//! (`Replica::open_hosted`) behind the client frame layer.
//!
//! One instance lives in one Durable Object. Everything here is sans-I/O and
//! deterministic; the DO host moves bytes:
//! - client frames in ([`Engine::hello`], [`Engine::frame`]) and out ([`Engine::poll`]);
//! - log calls out ([`Engine::take_log_calls`]) and replies/pushes in;
//! - timers ([`Engine::tick`], [`Engine::next_wakeup`]).
//!
//! **Writes.** `submit` requests never reach the generic `ClientApi::submit` (which
//! refuses in hosted mode): they go to `submit_logged`, and the response frame is
//! sent only when the ticket completes, i.e. after the log append (or a definitive
//! pre-log rejection). An outcome that is still unknown keeps the request open.
//!
//! **Serving.** Until the replica has rebuilt from the log after open
//! (`hosted_serving`), `hello` answers `unavailable`. Admission (verified identity,
//! grant consent) is the host's gate in front of this and is not decided here.

use std::collections::BTreeMap;

use crate::attachment_region::AttachmentRegion;
use crate::file_reads::FileReads;
use mdbn_replica::api::{ApiError, ErrorCode, SessionAuth, SessionId};
use mdbn_replica::frames::{FileReadRequest, Frames, file_read_request};
use mdbn_replica::log::{CallId, LogCall, LogPush, LogReply};
use mdbn_replica::plan::CorePlanner;
use mdbn_replica::{
    DeviceSecrets, Host, HostedCache, HostedProfile, Replica, ReplicaConfig, Store, SubmitTicket,
};
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::client::{ClientFrame, ClientResponse, SubmitParams};
use mdbn_wire::common::{B16, B32, Uuid};
use mdbn_wire::policy::CState;
use mdbn_wire::schema::Wire;

/// Largest frame sent to a client (the 1 MiB hydrated-per-request budget). A larger
/// response becomes a `too_large` problem; a larger push closes the session (the
/// client re-subscribes with a smaller window). Never truncated.
pub const MAX_OUT_FRAME: usize = 1 << 20;

/// The runtime's version, reported in `hello`.
pub const RUNTIME_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Why `open` failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenFailure(pub String);

/// Output of [`Engine::poll`].
#[derive(Debug, Clone, PartialEq)]
pub enum Out {
    /// An encoded frame for a session.
    Frame(u64, Vec<u8>),
    /// The engine closed this session; the host closes its socket.
    Closed(u64),
}

/// The open configuration, decoded from `mdb-cbor/1`:
/// `{0: collection, 1: replica_id, 2: device_id (the hosted service device),
/// 3: [* root public key (32 bytes)], 4: [* trusted signer device], 5: sign_sk,
/// 6: kem_sk, 7?: escrow_grant_only, 8: bundled_normalized_pins_cbor,
/// 9: original_signed_genesis_item, 10: SHA256_exact_original_bytes}`. Roots MUST
/// exactly match bundled pins; no additive runtime authority. The host first
/// verifies public origin BEFORE KMS, then this parse re-verifies it before any
/// key use. Keys 5/6 are loaned from custody and decoded buffers are wiped.
pub struct OpenConfig {
    /// Replica configuration (always synced cloud copy).
    pub(crate) cfg: ReplicaConfig,
    /// The service device's keys.
    pub(crate) secrets: DeviceSecrets,
    /// Private successful public verification, bound again before secret use.
    trust: crate::host_trust::VerifiedHostedGenesis,
}

impl std::fmt::Debug for OpenConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OpenConfig")
            .field("collection", &self.cfg.collection)
            .finish_non_exhaustive()
    }
}

fn field(m: &[(Cbor, Cbor)], k: u64) -> Option<&Cbor> {
    m.iter()
        .find(|(key, _)| *key == Cbor::Uint(k))
        .map(|(_, v)| v)
}

fn uuid(m: &[(Cbor, Cbor)], k: u64, what: &str) -> Result<Uuid, OpenFailure> {
    let v = field(m, k).ok_or_else(|| OpenFailure(format!("missing {what}")))?;
    B16::from_cbor(v).map_err(|e| OpenFailure(format!("{what}: {e}")))
}

fn key(m: &[(Cbor, Cbor)], k: u64, what: &str) -> Result<[u8; 32], OpenFailure> {
    let v = field(m, k).ok_or_else(|| OpenFailure(format!("missing {what}")))?;
    B32::from_cbor(v)
        .map(|b| b.0)
        .map_err(|_| OpenFailure(format!("{what}: not 32 bytes")))
}

/// Overwrite a buffer that held key material (`black_box` keeps the writes).
pub fn wipe(buf: &mut [u8]) {
    for b in buf.iter_mut() {
        *b = 0;
    }
    std::hint::black_box(buf);
}

fn wipe_cbor(c: &mut Cbor) {
    match c {
        Cbor::Bytes(b) => wipe(b),
        Cbor::Array(a) => a.iter_mut().for_each(wipe_cbor),
        Cbor::Map(m) => m.iter_mut().for_each(|(_, v)| wipe_cbor(v)),
        _ => {}
    }
}

impl OpenConfig {
    /// Decode (and wipe the decoded copy of the keys).
    pub fn decode(bytes: &[u8]) -> Result<OpenConfig, OpenFailure> {
        if bytes.len() > 2 * crate::host_trust::MAX_PUBLIC_BYTES + (16 << 10) {
            return Err(OpenFailure("hosted config too large".into()));
        }
        let mut c = cbor::decode(bytes).map_err(|e| OpenFailure(format!("config: {e}")))?;
        let r = Self::parse(&c);
        wipe_cbor(&mut c);
        r
    }

    fn validate_public_trust(&self) -> Result<(), OpenFailure> {
        if !self.trust.matches_config(&self.cfg)
            || self.cfg.mode != mdbn_wire::client::SyncMode::Synced
            || !self.cfg.verify
            || self.cfg.e2e
            || !self.cfg.user_enabled_cloud_copy
            || self.cfg.chosen_state != Some(CState::CloudCopy)
        {
            return Err(OpenFailure("hosted public trust mismatch".into()));
        }
        Ok(())
    }

    fn parse(c: &Cbor) -> Result<OpenConfig, OpenFailure> {
        let Cbor::Map(m) = c else {
            return Err(OpenFailure("config must be a struct map".into()));
        };
        let roots = match field(m, 3) {
            Some(Cbor::Array(a)) if !a.is_empty() && a.len() <= 64 => a
                .iter()
                .map(|r| {
                    B32::from_cbor(r)
                        .map(|b| b.0)
                        .map_err(|_| OpenFailure("root: not 32 bytes".into()))
                })
                .collect::<Result<Vec<_>, _>>()?,
            _ => return Err(OpenFailure("trusted roots are required".into())),
        };
        let collection = uuid(m, 0, "collection")?;
        let (Some(Cbor::Bytes(pins)), Some(Cbor::Bytes(original)), Some(hash)) =
            (field(m, 8), field(m, 9), field(m, 10))
        else {
            return Err(OpenFailure("hosted public trust required".into()));
        };
        let hash =
            B32::from_cbor(hash).map_err(|_| OpenFailure("hosted public trust refused".into()))?;
        let trust = crate::host_trust::verify_hosted_genesis(collection, pins, original, hash)
            .map_err(|_| OpenFailure("hosted public trust refused".into()))?;
        let key_grants_only = match field(m, 7) {
            None | Some(Cbor::Bool(false)) => false,
            Some(Cbor::Bool(true)) => true,
            _ => return Err(OpenFailure("invalid escrow profile".into())),
        };
        let signers = match field(m, 4) {
            Some(Cbor::Array(a)) => a
                .iter()
                .map(|s| B16::from_cbor(s).map_err(|e| OpenFailure(format!("signer: {e}"))))
                .collect::<Result<Vec<_>, _>>()?,
            None => Vec::new(),
            Some(_) => return Err(OpenFailure("signers must be an array".into())),
        };
        let cfg = ReplicaConfig {
            collection,
            replica_id: uuid(m, 1, "replica_id")?,
            device_id: uuid(m, 2, "device_id")?,
            mode: mdbn_wire::client::SyncMode::Synced,
            log_endpoint: mdbn_replica::log::EndpointId(0),
            // The hosted replica always verifies others' entries.
            verify: true,
            runtime_version: RUNTIME_VERSION.into(),
            trusted_roots: roots,
            trusted_signers: signers,
            // The hosted replica exists only for cloud-copy collections; the log's
            // genesis must say so too, or it serves no apps.
            user_enabled_cloud_copy: true,
            chosen_state: Some(CState::CloudCopy),
            expected_genesis: Some(trust.genesis_chain_hash()),
            policy_pins: Some(trust.policy_pins().clone()),
            // 7: the minimal escrow's emission profile (fallback key grants only).
            key_grants_only,
            e2e: false,
        };
        // A shipped synced host: its trust shape is checked before any open.
        cfg.validate_host_trust()
            .map_err(|e| OpenFailure(format!("host trust: {e}")))?;
        if !trust.matches_config(&cfg) {
            return Err(OpenFailure("hosted public trust mismatch".into()));
        }
        Ok(OpenConfig {
            trust,
            secrets: DeviceSecrets {
                sign_sk: key(m, 5, "sign_sk")?,
                kem_sk: key(m, 6, "kem_sk")?,
            },
            cfg,
        })
    }
}

/// A `submit` request waiting for its ticket.
#[derive(Debug, Clone, Copy)]
struct Waiting {
    session: SessionId,
    request: u64,
}

/// One hosted collection.
pub struct Engine<S: Store> {
    replica: Replica<HostedCache<S>>,
    frames: Frames,
    submits: BTreeMap<SubmitTicket, Waiting>,
    out: Vec<Out>,
    /// The authenticated log session, bound by the host
    /// only after its transport authenticated; retired on any reset or pause.
    log_session: Option<mdbn_replica::replica::AuthenticatedLogSession>,
    /// Each sent call's original provenance, captured before it left; a reply is
    /// accepted only through it, for the session that sent it.
    log_scopes: BTreeMap<CallId, mdbn_replica::replica::LogReplyScope>,
    file_reads: FileReads,
    // READ and UPLOAD borrow this ONE backing; neither driver owns another.
    attachment_region: AttachmentRegion,
    collection: Uuid,
    // Private default-deny foundation only: all-site Engine/adapter/destination
    // enforcement is a separate PR. No issuer or caller proof can open this.
    _effect_currentness: crate::effect_currentness::ReceiverGate,
}

impl<S: Store> std::fmt::Debug for Engine<S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Engine").finish_non_exhaustive()
    }
}

fn response(id: u64, r: Result<Cbor, ApiError>) -> Vec<u8> {
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
    f.to_bytes().unwrap_or_default()
}

impl<S: Store> Engine<S> {
    /// Open the hosted replica over the cache `store` (empty after a cache drop).
    pub fn open(
        config: OpenConfig,
        store: S,
        host: Host,
        profile: HostedProfile,
    ) -> Result<Engine<S>, OpenFailure> {
        config.validate_public_trust()?;
        let sealer = mdbn_replica::seal::KeyringSealer::new(
            config.cfg.collection,
            config.cfg.device_id,
            &config.secrets.sign_sk,
            &config.secrets.kem_sk,
        );
        Self::open_with(config, store, Box::new(sealer), host, profile)
    }

    /// [`Engine::open`] with a given sealer (tests use the plain test sealer).
    pub fn open_with(
        config: OpenConfig,
        store: S,
        sealer: Box<dyn mdbn_replica::Sealer>,
        host: Host,
        profile: HostedProfile,
    ) -> Result<Engine<S>, OpenFailure> {
        config.validate_public_trust()?;
        let OpenConfig { cfg, secrets, .. } = config;
        let collection = cfg.collection;
        let now_ms = i64::try_from(host.clock.now_ms()).unwrap_or(i64::MAX);
        let replica = Replica::open_hosted(
            cfg,
            store,
            Box::new(CorePlanner),
            sealer,
            host,
            secrets,
            profile,
        )
        .map_err(|e| OpenFailure(format!("{e:?}")))?;
        let effect_currentness = crate::effect_currentness::ReceiverGate::unknown();
        debug_assert!(!effect_currentness.permits_effect());
        Ok(Engine {
            replica,
            frames: Frames::new(),
            submits: BTreeMap::new(),
            out: Vec::new(),
            log_session: None,
            log_scopes: BTreeMap::new(),
            file_reads: FileReads::new(now_ms),
            attachment_region: AttachmentRegion::new(),
            collection,
            _effect_currentness: effect_currentness,
        })
    }

    /// The replica (tests, diagnostics).
    pub fn replica(&self) -> &Replica<HostedCache<S>> {
        &self.replica
    }

    #[cfg(test)]
    pub(crate) fn replica_mut(&mut self) -> &mut Replica<HostedCache<S>> {
        &mut self.replica
    }

    /// The replica's live verified hosted admission (read-only observation; never
    /// cached by the host as a permit).
    pub fn admission(&self) -> mdbn_replica::HostedAdmission {
        self.replica.verified_hosted_admission()
    }

    /// This engine's wake instance.
    pub fn wake_instance(&self) -> u64 {
        self.replica.wake_instance()
    }

    /// The replica's current verified policy holds this app grant for this key.
    pub fn grant_authorized(&self, grant: &Uuid, client_pk: &[u8; 32]) -> bool {
        self.replica.grant_authorized(grant, client_pk)
    }

    /// Whether the replica serves sessions yet (rebuilt from the log since open).
    pub fn serving(&self) -> bool {
        self.replica.hosted_serving()
    }

    /// The cache disagrees with the log's control prefix: the host drops it and
    /// reopens (the replica never serves from it).
    pub fn needs_reset(&self) -> bool {
        self.replica.hosted_needs_reset()
    }

    /// Open a session from an encoded `hello` request. The host has already
    /// admitted the connection (verified identity, grant). Returns the session
    /// (0 = refused) and the response frame.
    pub fn hello(&mut self, grant: Option<(Uuid, [u8; 32])>, frame: &[u8]) -> (u64, Vec<u8>) {
        let auth = match grant {
            None => SessionAuth::Host,
            Some((grant, client_pk)) => SessionAuth::Grant { grant, client_pk },
        };
        let out = self.frames.hello(&mut self.replica, auth, frame);
        (out.session.map_or(0, |s| s.0), out.response)
    }

    /// Resource preflight only, not a durable permit: verified current READ,
    /// folder, descriptor/revision/range and hosted health precede queueing.
    /// The ordinary frame handler repeats every gate after the host's await.
    pub fn attachment_call_requires_slot(&mut self, session: u64, frame: &[u8]) -> bool {
        if self.file_reads.active_session().is_some() {
            return false;
        }
        match file_read_request(frame) {
            Some((
                _,
                Ok(FileReadRequest::Read {
                    target,
                    range,
                    revision,
                }),
            )) => self
                .replica
                .hosted_attachment_read(SessionId(session), target, range, revision)
                .is_ok(),
            _ => false,
        }
    }
    /// Typed resource refusal through the existing RPC error envelope. Current
    /// authority is rechecked; denied callers receive the ordinary policy error.
    pub fn attachment_call_busy(&mut self, session: u64, frame: &[u8]) {
        match file_read_request(frame) {
            Some((
                id,
                Ok(FileReadRequest::Read {
                    target,
                    range,
                    revision,
                }),
            )) => {
                let result = self
                    .replica
                    .hosted_attachment_read(SessionId(session), target, range, revision)
                    .and_then(|_| Err(crate::file_reads::busy()));
                self.out.push(Out::Frame(session, response(id, result)));
            }
            _ => self.frame(session, frame),
        }
    }
    /// Whether this session still owns the ephemeral attachment stream.
    pub fn attachment_active(&self, session: u64) -> bool {
        self.file_reads.active_session() == Some(SessionId(session))
    }

    /// A frame from a session's client.
    pub fn frame(&mut self, session: u64, frame: &[u8]) {
        let session = SessionId(session);
        if let Some((id, request)) = file_read_request(frame) {
            let result = request.and_then(|request| match request {
                FileReadRequest::Read {
                    target,
                    range,
                    revision,
                } => self.file_reads.start(
                    &mut self.replica,
                    session,
                    target,
                    range,
                    revision,
                    &mut self.attachment_region,
                ),
                FileReadRequest::Ack { stream, offset } => self.file_reads.ack(
                    &self.replica,
                    session,
                    stream,
                    offset,
                    &self.attachment_region,
                ),
                FileReadRequest::Cancel { stream } => {
                    self.file_reads
                        .cancel(session, stream, &mut self.attachment_region)
                }
            });
            self.out.push(Out::Frame(session.0, response(id, result)));
            return;
        }
        if let Some((id, params)) = submit_request(frame) {
            match self.replica.submit_logged(session, params) {
                Ok(ticket) => {
                    self.submits.insert(
                        ticket,
                        Waiting {
                            session,
                            request: id,
                        },
                    );
                }
                Err(e) => self.out.push(Out::Frame(session.0, response(id, Err(e)))),
            }
            self.drain_acks();
            self.frames.pump(&mut self.replica);
            return;
        }
        self.frames.on_frame(&mut self.replica, session, frame);
    }

    /// The client's socket closed.
    pub fn close(&mut self, session: u64) {
        self.file_reads
            .close(SessionId(session), &mut self.attachment_region);
        self.submits.retain(|_, w| w.session.0 != session);
        self.frames.close(&mut self.replica, SessionId(session));
    }

    /// Run timers.
    pub fn tick(&mut self, now_ms: i64) {
        if let Some(session) = self.file_reads.tick(now_ms, &mut self.attachment_region) {
            self.close(session.0);
            self.out.push(Out::Closed(session.0));
        }
        self.replica.tick();
        self.frames.tick(&mut self.replica, now_ms);
        self.drain_acks();
    }

    /// When to call [`Engine::tick`] next (host ms), if at all.
    pub fn next_wakeup(&self) -> Option<i64> {
        match (self.replica.next_wakeup(), self.file_reads.deadline()) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }

    /// Bind the log session. The host calls this only after its transport
    /// authenticated (token obtained, binding configured); it re-subscribes.
    /// Any earlier session is retired first: its calls' outcomes are unknown.
    pub fn bind_log(&mut self, collection: Uuid) -> bool {
        self.retire_log();
        let ok = match self
            .replica
            .bind_authenticated_log(mdbn_replica::log::EndpointId(0), collection)
        {
            Ok(s) => {
                self.log_session = Some(s);
                true
            }
            Err(_) => false,
        };
        self.drain_acks();
        ok
    }

    /// Retire the current log session (reset, pause, replaced engine, transport
    /// lost): later replies for its calls are refused before any decoding.
    pub fn retire_log(&mut self) {
        self.file_reads
            .retire_transport(&mut self.attachment_region);
        if let Some(s) = self.log_session.take() {
            self.log_scopes.clear();
            self.replica.retire_authenticated_log(&s);
            self.drain_acks();
        }
    }

    /// Trusted host-only immutable object request. The returned ticket captures
    /// this bound transport/read; reserve/write/complete never accept another
    /// ticket. It is not an app RPC or an admission permit.
    pub fn attachment_object(&mut self) -> Option<Cbor> {
        self.log_session.as_ref()?;
        match self
            .file_reads
            .object(&self.replica, &self.attachment_region)
        {
            Ok(Some(o)) => {
                let call = mdbn_replica::log::LogCall {
                    id: CallId(o.ticket),
                    endpoint: mdbn_replica::log::EndpointId(0),
                    request: mdbn_replica::log::LogRequest::GetObject {
                        collection: self.collection,
                        address: o.address,
                        range: None,
                    },
                };
                let frame = mdbn_replica::log_codec::request(&call).ok()?;
                Some(Cbor::Array(vec![
                    Cbor::Uint(o.ticket),
                    Cbor::Uint(o.session.0),
                    o.address.to_cbor(),
                    o.expected_bytes.map_or(Cbor::Null, Cbor::Uint),
                    Cbor::Bytes(frame),
                ]))
            }
            Ok(None) => None,
            Err(session) => {
                self.close(session.0);
                self.out.push(Out::Closed(session.0));
                None
            }
        }
    }
    /// Recheck the original ticket and READ/folder/wake/health, after every await.
    pub fn attachment_allowed(&self, ticket: u64) -> bool {
        self.log_session.is_some()
            && self
                .file_reads
                .allowed(&self.replica, ticket, &self.attachment_region)
    }
    /// Bound ciphertext allocation, before streaming network segments into WASM.
    pub fn attachment_reserve(&mut self, ticket: u64, size: u64) -> bool {
        self.log_session.is_some()
            && self
                .file_reads
                .reserve(&self.replica, ticket, size, &mut self.attachment_region)
    }
    #[cfg(test)]
    pub(crate) fn test_attachment_region(&mut self) -> &mut AttachmentRegion {
        &mut self.attachment_region
    }

    /// Borrow the next bounded fixed-region slice; no ownership/key export and
    /// no plaintext output. Host views must not be retained across awaits.
    pub fn attachment_region(&mut self, ticket: u64, size: usize) -> Option<*mut u8> {
        self.log_session.as_ref()?;
        self.file_reads
            .region(&self.replica, ticket, size, &mut self.attachment_region)
    }
    /// Commit exactly the minted slice after its synchronous host copy.
    pub fn attachment_written(&mut self, ticket: u64, size: usize) -> bool {
        self.log_session.is_some()
            && self
                .file_reads
                .written(&self.replica, ticket, size, &self.attachment_region)
    }
    /// Append the next bounded network segment; no plaintext is released here.
    pub fn attachment_write(&mut self, ticket: u64, bytes: &[u8]) -> bool {
        self.log_session.is_some()
            && bytes.len() <= MAX_OUT_FRAME
            && self
                .file_reads
                .append(&self.replica, ticket, bytes, &mut self.attachment_region)
    }
    /// Authenticate the complete object in place before exposing a plaintext span.
    pub fn attachment_complete(&mut self, ticket: u64, checksum: B32) -> bool {
        if self.log_session.is_none() {
            return false;
        }
        match self
            .file_reads
            .complete(&self.replica, ticket, checksum, &mut self.attachment_region)
        {
            Ok(done) => done,
            Err(session) => {
                self.close(session.0);
                self.out.push(Out::Closed(session.0));
                false
            }
        }
    }
    /// Abort this exact pending object only, never a newer request's stream.
    pub fn attachment_failed(&mut self, ticket: u64) {
        if let Some(session) = self.file_reads.fail(ticket, &mut self.attachment_region) {
            self.close(session.0);
            self.out.push(Out::Closed(session.0));
        }
    }

    /// Log calls to send, each with its scope captured before it leaves. None
    /// until a session is bound: calls wait queued for genuine admission.
    pub fn take_log_calls(&mut self) -> Vec<LogCall> {
        let Some(session) = self.log_session.clone() else {
            return Vec::new();
        };
        match self.replica.take_authenticated_log_calls(&session) {
            Ok(calls) => calls
                .into_iter()
                .map(|(call, scope)| {
                    self.log_scopes.insert(call.id, scope);
                    call
                })
                .collect(),
            Err(_) => Vec::new(),
        }
    }

    /// A reply to a log call, decoded only after its scope is validated against
    /// the current session. The decoder gets the call's original method. Returns
    /// whether the reply was accepted.
    pub fn on_log_reply_with(
        &mut self,
        id: CallId,
        decode: impl FnOnce(CallId, &'static str) -> LogReply,
    ) -> bool {
        let Some(scope) = self.log_scopes.remove(&id) else {
            return false;
        };
        let ok = self
            .replica
            .on_authenticated_log_reply(scope, decode)
            .is_ok();
        self.drain_acks();
        ok
    }

    /// A reply already decoded (tests, and local failures such as an unencodable
    /// call or a transport error): accepted through the same scope check.
    pub fn on_log_reply(&mut self, id: CallId, reply: LogReply) -> bool {
        self.on_log_reply_with(id, move |_, _| reply)
    }

    /// A push from the log service, accepted only for the current session.
    pub fn on_log_push(&mut self, push: LogPush) -> bool {
        let Some(session) = self.log_session.clone() else {
            return false;
        };
        let ok = self
            .replica
            .on_authenticated_log_push(&session, move |_| Ok(push))
            .is_ok();
        self.drain_acks();
        ok
    }

    fn drain_acks(&mut self) {
        for ack in self.replica.take_acks() {
            let Some(w) = self.submits.remove(&ack.ticket) else {
                continue;
            };
            if w.session != ack.session {
                continue;
            }
            self.out.push(Out::Frame(
                w.session.0,
                response(w.request, Ok(ack.receipts.to_cbor())),
            ));
        }
    }

    /// Everything to deliver, in order.
    pub fn poll(&mut self) -> Vec<Out> {
        self.drain_acks();
        self.frames.pump(&mut self.replica);
        let mut out: Vec<Out> = std::mem::take(&mut self.out);
        for (s, b) in self.frames.take_outgoing() {
            if b.len() <= MAX_OUT_FRAME {
                out.push(Out::Frame(s.0, b));
                continue;
            }
            match oversize(&b) {
                Some(problem) => out.push(Out::Frame(s.0, problem)),
                None => {
                    self.frames.close(&mut self.replica, s);
                }
            }
        }
        for session in self.frames.take_closed() {
            self.file_reads.close(session, &mut self.attachment_region);
            out.push(Out::Closed(session.0));
        }
        match self
            .file_reads
            .poll(&self.replica, &mut self.attachment_region)
        {
            Ok(Some((session, frame))) => out.push(Out::Frame(session.0, frame)),
            Ok(None) => {}
            Err(session) => {
                self.close(session.0);
                out.push(Out::Closed(session.0));
            }
        }
        out
    }
}

/// An oversized response as a `too_large` problem for the same request; `None` for
/// anything else (a push).
fn oversize(frame: &[u8]) -> Option<Vec<u8>> {
    let c = cbor::decode(frame).ok()?;
    match ClientFrame::from_cbor(&c).ok()? {
        ClientFrame::Response(r) => Some(response(
            r.id,
            Err(ErrorCode::TooLarge.err_with_reason(
                "hosted_response_budget",
                "the result exceeds 1 MiB; narrow the query or page it",
            )),
        )),
        _ => None,
    }
}

/// A `submit` request frame: its ID and params. Anything else (including a submit
/// whose params don't decode, which the frame layer answers) is `None`.
fn submit_request(frame: &[u8]) -> Option<(u64, SubmitParams)> {
    let c = cbor::decode(frame).ok()?;
    let ClientFrame::Request(r) = ClientFrame::from_cbor(&c).ok()? else {
        return None;
    };
    if r.method != "submit" {
        return None;
    }
    SubmitParams::from_cbor(&r.params).ok().map(|p| (r.id, p))
}

/// Refuse a call with `unavailable` (for host-side gates).
pub fn unavailable(reason: &str, message: &str) -> ApiError {
    ErrorCode::Unavailable.err_with_reason(reason, message)
}
