//! A device running the real replica engine over the real file store.
//!
//! `Replica<FileStore<SimFilePlatform, MemStore, MemDiskDb>>` on a simulated
//! machine. The file store publishes records as files through the machine's OS
//! model (so editors, stalls and crashes reach it). The index (`MemStore`) and
//! the file store's own rows (`MemDiskDb`) survive process crashes and power
//! loss: they model `IndexStorage` at `synchronous=FULL` until a `Kv`-backed
//! store exists. Files on disk get the full power-loss model.
//!
//! An in-process client (the host app's session) generates work during chaos:
//! creates, updates (`status` patch, `tags` add with a fresh token) and renames.
//! Receipts feed the acknowledged-write ledger and the token oracle.

use std::any::Any;
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

use mdbn_core::host::Clock;
use mdbn_replica::api::{ClientApi, Push, SessionAuth, SessionId};
use mdbn_replica::log::{CallId, EndpointId, LogCall, LogError, LogPort, LogPush, LogRequest};
use mdbn_replica::mem::{MemData, MemStore};
use mdbn_replica::replica::{AuthenticatedLogSession, LogReplyScope};
use mdbn_replica::seal::PlainSealer;
use mdbn_replica::store::{Head, RecordRow, Store};
use mdbn_replica::{DeviceSecrets, Host, Replica, ReplicaConfig, UtcOnly};
use mdbn_store_file::diskdb::MemDiskDb;
use mdbn_store_file::store::{Config as FsConfig, FileStore};
use mdbn_wire::client::{HelloParams, ReceiptState, SubmitParams, SyncMode};
use mdbn_wire::common::{B16, DataMap, Text, Uuid, Value, Version};
use mdbn_wire::intent::{Create, Op, Rename, Update};

use super::fault_store::{CommitFault, FaultStore};
use super::planner::{SimDoc, SimPlanner};
use super::real_log::{RpcStep, decode_push, response_frame};
use super::real_log_net::{CallerHello, WireEvent};
use super::real_node::{Inbound, Phase, RealWire, ReplySource, Transmit, WireStats};
use super::{LogPushMsg, LogRep, LogReq, wire_bytes};
use crate::fileplatform::SimFilePlatform;
use crate::oracle::{Ack, Kind, tokens_in};
use crate::platform::{MachineRef, Proc};
use crate::rng::SeededTestEntropy;
use crate::world::{Actor, ActorId, Ev, Payload, World};

type Fs = FaultStore<FileStore<SimFilePlatform, MemStore, MemDiskDb>>;

/// The replica the node runs.
pub type SimRep = Replica<Fs>;

const TICK: u64 = 1;
const WORK: u64 = 2;
const OBSERVE: u64 = 3;
const RECONNECT: u64 = 4;

struct MachineClock(MachineRef);

impl Clock for MachineClock {
    fn now_ms(&self) -> u64 {
        self.0.borrow().now()
    }
}

/// Node parameters.
#[derive(Debug, Clone)]
pub struct NodeCfg {
    /// Collection.
    pub collection: Uuid,
    /// Replica ID.
    pub replica_id: Uuid,
    /// Device ID.
    pub device: Uuid,
    /// Generate client work during chaos.
    pub work: bool,
    /// Mean time between client writes, ms.
    pub work_every_ms: u64,
    /// A flaky transport: every connection loss produces its own
    /// `Disconnected` … `Reconnected` pair, so reconnects overlap and the replica
    /// re-subscribes while earlier calls are still in flight.
    pub reconnect_storm: bool,
    /// Build a snapshot every this many entries (`None`: the engine default).
    pub snapshot_every: Option<u64>,
    /// Devices this device's user trusts as key sources (the other test devices;
    /// `sealed-envelope.md` §5.2).
    pub trusted: Vec<Uuid>,
    /// Real cryptography: `(sign_seed, kem_sk)` for a `KeyringSealer`. `None`
    /// uses the test-only `PlainSealer`.
    pub keys: Option<([u8; 32], [u8; 32])>,
}

/// A device actor.
pub struct Node {
    name: String,
    machine: usize,
    me: ActorId,
    svc: ActorId,
    cfg: NodeCfg,
    rep: Option<SimRep>,
    proc: Option<Proc>,
    session: Option<SessionId>,
    inflight: BTreeSet<u64>,
    store_data: Rc<RefCell<MemData>>,
    disk_db: MemDiskDb,
    commit_fault: Rc<RefCell<CommitFault>>,
    incarnation: u64,
    /// Mutation → tokens it carries, until its receipt resolves.
    outstanding: BTreeMap<Uuid, Vec<String>>,
    next_id: u64,
    working: bool,
    /// The transport's connection is up (one `Disconnected`/`Reconnected` per
    /// real reconnect, as a WebSocket transport reports them).
    connected: bool,
    /// Epoch keys already registered with the tap.
    known_epochs: BTreeSet<(u64, Vec<u8>)>,
    /// Open failures (a bug unless a crash interrupted it).
    pub open_errors: u64,
    /// The exact-frame transport to a `RealServiceActor`, if this node uses one
    /// (otherwise the in-process binding to the fake log service).
    real: Option<RealWire>,
    /// The replica's authenticated log session for the current admitted real
    /// connection lifecycle: calls are taken, replies and pushes delivered, only
    /// through it; a lost connection retires it.
    log_session: Option<AuthenticatedLogSession>,
    /// A session was bound in this incarnation: later binds are reconnections.
    bound_once: bool,
    /// Scenario hook: cut this node's link right after its next read goes out,
    /// so that read (a repair probe) gets no reply.
    cut_next_read: bool,
}

fn hex(u: &Uuid) -> String {
    u.to_hex()
}

impl Node {
    /// A node on `machine` talking to the log service actor `svc`.
    pub fn new(name: &str, machine: usize, me: ActorId, svc: ActorId, cfg: NodeCfg) -> Self {
        Node {
            name: name.into(),
            machine,
            me,
            svc,
            cfg,
            rep: None,
            proc: None,
            session: None,
            inflight: BTreeSet::new(),
            store_data: Rc::new(RefCell::new(MemData::default())),
            disk_db: MemDiskDb::default(),
            commit_fault: Rc::new(RefCell::new(CommitFault::default())),
            incarnation: 0,
            outstanding: BTreeMap::new(),
            next_id: 1,
            working: false,
            connected: true,
            known_epochs: BTreeSet::new(),
            open_errors: 0,
            real: None,
            log_session: None,
            bound_once: false,
            cut_next_read: false,
        }
    }

    /// Talk to a [`super::real_log_net::RealServiceActor`] at `svc` over exact
    /// production frames, as this caller (the node owns the hello material).
    pub fn with_real_transport(mut self, hello: CallerHello) -> Self {
        self.real = Some(RealWire::new(hello));
        self
    }

    /// Counters of the real transport, if this node has one.
    pub fn wire_stats(&self) -> Option<WireStats> {
        self.real.as_ref().map(|wire| wire.stats())
    }

    /// Scenario hook: the next read this node sends gets no reply (the link is
    /// cut right after it goes out).
    pub fn cut_next_read(&mut self) {
        self.cut_next_read = true;
    }

    /// The running replica, if up.
    pub fn replica(&self) -> Option<&SimRep> {
        self.rep.as_ref()
    }

    /// Fail one policy-bearing Store transaction at `seq`, leaving Replica alive.
    pub fn fail_control_commit(&mut self, seq: u64) {
        assert!(seq > 0);
        let mut fault = self.commit_fault.borrow_mut();
        assert!(fault.at.is_none(), "a commit fault is already armed");
        fault.at = Some(seq);
        fault.expected_control = Some(seq);
    }

    /// Crash once after a successful commit exposes a control durability gap.
    pub fn crash_on_bad_control_head(&mut self) {
        self.commit_fault.borrow_mut().crash_after_gap = true;
    }

    /// Crashes at the precise bad-head commit boundary, across restarts.
    pub fn control_gap_crashes(&self) -> u64 {
        self.commit_fault.borrow().gap_crashes
    }

    /// Actual one-shot failures, across process restarts.
    pub fn commit_faults_injected(&self) -> u64 {
        self.commit_fault.borrow().injected
    }

    /// Temporal control durability gaps at successful Store commit boundaries.
    pub fn control_durability_gaps(&self) -> Vec<(u64, u64)> {
        self.commit_fault.borrow().missing_policy.clone()
    }

    /// Oracle-only read failures (never alter the Store commit outcome).
    pub fn control_oracle_read_errors(&self) -> u64 {
        self.commit_fault.borrow().oracle_read_errors
    }

    /// Confirmed state digest: head plus every record (id, path, doc).
    pub fn digest(&self) -> Option<(Head, Vec<RecordRow>)> {
        let r = self.rep.as_ref()?;
        Some((r.head(), r.confirmed_records().ok()?))
    }

    fn open(&mut self, w: &mut World) {
        self.incarnation += 1;
        let m = w.machines[self.machine].clone();
        let proc = Proc::new(&m, &format!("{}#{}", self.name, self.incarnation), true);
        let platform = Rc::new(SimFilePlatform::new(proc.clone()));
        let store = FileStore::open(
            platform,
            MemStore::shared(self.store_data.clone()),
            self.disk_db.clone(),
            Box::new(MachineClock(m.clone())),
            FsConfig::default(),
        );
        let store = match store {
            Ok(s) => s,
            Err(e) => {
                if !proc.crashed.get() {
                    self.open_errors += 1;
                    w.shared.violate(
                        Kind::Bug,
                        format!("{}: file store open failed: {e:?}", self.name),
                    );
                }
                w.crashed_in_call(self.me);
                return;
            }
        };
        let crash_proc = proc.clone();
        let store = FaultStore::new(store, self.commit_fault.clone())
            .with_gap_hook(move || crash_proc.crash());
        let host = Host {
            clock: Box::new(MachineClock(m.clone())),
            entropy: Box::new(SeededTestEntropy::from_world(
                &w.rng,
                &format!("{}#{}", self.name, self.incarnation),
            )),
            zones: Box::new(UtcOnly),
        };
        let cfg = ReplicaConfig {
            collection: self.cfg.collection,
            replica_id: self.cfg.replica_id,
            device_id: self.cfg.device,
            mode: SyncMode::Synced,
            log_endpoint: EndpointId(1),
            verify: true,
            runtime_version: "sim".into(),
            trusted_roots: vec![
                mdbn_replica::testkit::TEST_ROOT,
                mdbn_replica::testkit::signed_root(),
            ],
            e2e: false,
            trusted_signers: self.cfg.trusted.clone(),
            user_enabled_cloud_copy: false,
            chosen_state: None,
            key_grants_only: false,
            expected_genesis: None,
            policy_pins: None,
        };
        let secrets = DeviceSecrets {
            sign_sk: self.cfg.keys.map_or([self.cfg.device.0[0]; 32], |k| k.0),
            kem_sk: self.cfg.keys.map_or([self.cfg.device.0[1]; 32], |k| k.1),
        };
        let sealer: Box<dyn mdbn_replica::seal::Sealer> = match &self.cfg.keys {
            Some((sign, kem)) => Box::new(mdbn_replica::seal::KeyringSealer::new(
                self.cfg.collection,
                self.cfg.device,
                sign,
                kem,
            )),
            None => Box::new(PlainSealer::for_device(self.cfg.device)),
        };
        let rep = Replica::open(cfg, store, Box::new(SimPlanner), sealer, host, secrets);
        let mut rep = match rep {
            Ok(r) => r,
            Err(e) => {
                if !proc.crashed.get() {
                    self.open_errors += 1;
                    w.shared.violate(
                        Kind::Bug,
                        format!("{}: replica open failed: {e:?}", self.name),
                    );
                }
                w.crashed_in_call(self.me);
                return;
            }
        };
        let hello = rep.hello(
            SessionAuth::Host,
            HelloParams {
                versions: vec![Version { major: 1, minor: 0 }],
                client_name: "sim-host".into(),
                client_version: "0".into(),
                features: None,
                timezone: None,
            },
        );
        match hello {
            Ok((s, _)) => self.session = Some(s),
            Err(e) => {
                w.shared
                    .violate(Kind::Bug, format!("{}: hello failed: {e:?}", self.name));
            }
        }
        if let Some(n) = self.cfg.snapshot_every {
            rep.snapshot_every = n;
        }
        self.rep = Some(rep);
        self.proc = Some(proc);
        self.connected = true;
        self.log_session = None;
        self.bound_once = false;
        if self.real.is_some() {
            // Nothing flows until this connection's hello is admitted.
            self.connected = false;
            self.connect_real(w);
        }
        w.log(&self.name, &format!("open #{}", self.incarnation));
        self.after(w);
    }

    /// Open a real connection: upgrade now, hello on the challenge.
    fn connect_real(&mut self, w: &mut World) {
        let Some(wire) = self.real.as_mut() else {
            return;
        };
        if wire.phase() != Phase::Down {
            return;
        }
        wire.register(w);
        wire.opening();
        w.send_obj(
            self.me,
            self.svc,
            Vec::new(),
            Some(Payload(Rc::new(WireEvent::Open))),
        );
    }

    /// Hand scoped calls to the real transport; returns the scopes of calls that
    /// failed without anything being sent, with the error to deliver.
    fn ship_real(
        &mut self,
        w: &mut World,
        calls: Vec<(LogCall, LogReplyScope)>,
    ) -> Vec<(LogReplyScope, LogError)> {
        let mut failed = Vec::new();
        let Some(wire) = self.real.as_mut() else {
            return failed;
        };
        for (c, scope) in calls {
            let is_read = matches!(c.request, LogRequest::Read(_));
            match wire.transmit(c, Some(scope)) {
                Transmit::Send(call, bytes) => {
                    self.inflight.insert(call);
                    w.send_obj(
                        self.me,
                        self.svc,
                        bytes,
                        Some(Payload(Rc::new(WireEvent::Frame))),
                    );
                    if is_read && self.cut_next_read {
                        self.cut_next_read = false;
                        w.shared.count("hook.probe_cuts", 1);
                        w.log(&self.name, "link cut right after a read went out");
                        w.partition(self.me, 400);
                    }
                }
                Transmit::Fail(_, scope, e) => {
                    if let Some(scope) = scope {
                        failed.push((scope, e));
                    }
                }
            }
        }
        failed
    }

    /// A message from the service on the real transport.
    fn real_msg(&mut self, w: &mut World, bytes: Vec<u8>, obj: Option<Payload>) {
        let event = obj.as_ref().and_then(|p| p.get::<WireEvent>()).copied();
        match event {
            Some(WireEvent::Challenge) => {
                let Ok(nonce) = <[u8; 32]>::try_from(bytes.as_slice()) else {
                    w.shared.violate(
                        Kind::Bug,
                        format!("{}: malformed wire challenge", self.name),
                    );
                    return;
                };
                let frame = self
                    .real
                    .as_mut()
                    .and_then(|wire| wire.challenge(&*w, &nonce));
                if let Some(frame) = frame {
                    w.send_obj(
                        self.me,
                        self.svc,
                        frame,
                        Some(Payload(Rc::new(WireEvent::Frame))),
                    );
                }
            }
            Some(WireEvent::Frame) => {
                let inbound = self.real.as_mut().map(|wire| wire.frame(&bytes));
                if let Some(inbound) = inbound {
                    self.real_inbound(w, inbound);
                }
            }
            Some(WireEvent::DirectReply) => {
                let inbound = self.real.as_mut().map(|wire| wire.direct_reply(&bytes));
                if let Some(inbound) = inbound {
                    self.real_inbound(w, inbound);
                }
            }
            _ => {
                // Typed in-process payloads never reach a node on the real transport.
                w.shared.count("real.unexpected_payload", 1);
            }
        }
    }

    fn real_inbound(&mut self, w: &mut World, inbound: Inbound) {
        match inbound {
            Inbound::Direct(msg) => {
                w.shared.count("real.direct", 1);
                w.send_obj(
                    self.me,
                    self.svc,
                    msg,
                    Some(Payload(Rc::new(WireEvent::Direct))),
                );
            }
            Inbound::Raw(frame) => {
                w.send_obj(
                    self.me,
                    self.svc,
                    frame,
                    Some(Payload(Rc::new(WireEvent::Frame))),
                );
            }
            Inbound::Admitted => {
                self.connected = true;
                w.shared.count("real.admitted", 1);
                w.log(&self.name, "real transport admitted");
                // Bind the exact replica to this authenticated connection; the
                // replica dispatches `Reconnected` itself and only then hands
                // out calls.
                if let Some(r) = self.rep.as_mut() {
                    match r.bind_authenticated_log(EndpointId(1), self.cfg.collection) {
                        Ok(session) => {
                            self.log_session = Some(session);
                            // The first bind of an incarnation is the open; every
                            // later one is a reconnection the replica was told about.
                            if self.bound_once {
                                w.shared.count("real.reconnected", 1);
                            }
                            self.bound_once = true;
                        }
                        Err(e) => {
                            self.log_session = None;
                            w.shared.count("real.bind_refused", 1);
                            w.shared.detail(&self.name, &format!("bind refused: {e:?}"));
                        }
                    }
                }
                self.after(w);
            }
            Inbound::Refused(e) => {
                // Nothing is bound yet; the replica keeps its calls queued.
                w.shared.count("real.hello_refused", 1);
                w.shared.detail(&self.name, &format!("hello refused: {e}"));
                self.connected = false;
                let d = w.rng.between(500, 2_000);
                w.timer(self.me, d, RECONNECT);
                self.after(w);
            }
            Inbound::Reply {
                call,
                scope,
                source,
            } => {
                let (Some(scope), true) = (scope, self.inflight.remove(&call)) else {
                    w.shared.count("real.stale_reply", 1);
                    return;
                };
                let Some(r) = self.rep.as_mut() else { return };
                // Decoded only inside the replica's scoped callback, against the
                // retained original request; a transport-established reply (a
                // committed upload, a verified download) is delivered as is.
                let name = self.name.clone();
                let outcome = r.on_authenticated_log_reply(scope, |id, method| {
                    let reply = match source {
                        ReplySource::Frame { request, bytes } => {
                            match response_frame(&request, id.0, &bytes) {
                                Ok(RpcStep::Complete(reply)) => Ok(reply),
                                Ok(_) => {
                                    Err(LogError::code(mdbn_replica::log::LogErrorCode::Invalid))
                                }
                                Err(e) => Err(e),
                            }
                        }
                        ReplySource::Final(reply) => reply,
                    };
                    w.shared.detail(
                        &name,
                        &format!(
                            "real reply call {} {method}: {}",
                            id.0,
                            match &reply {
                                Ok(r) => format!("{r:?}").chars().take(120).collect::<String>(),
                                Err(e) => e.to_string(),
                            }
                        ),
                    );
                    reply
                });
                if outcome.is_err() {
                    w.shared.count("real.scope_refused", 1);
                }
                self.after(w);
            }
            Inbound::Push(p) => {
                w.shared.count("real.push", 1);
                let (Some(r), Some(session)) = (self.rep.as_mut(), &self.log_session) else {
                    w.shared.count("real.stale_push", 1);
                    return;
                };
                let name = self.name.clone();
                let outcome = r.on_authenticated_log_push(session, |_collection| {
                    let push = decode_push(p);
                    w.shared.detail(
                        &name,
                        &format!(
                            "real push {}",
                            format!("{push:?}").chars().take(120).collect::<String>()
                        ),
                    );
                    Ok(push)
                });
                if outcome.is_err() {
                    w.shared.count("real.stale_push", 1);
                }
                self.after(w);
            }
            Inbound::Stale => w.shared.count("real.stale_frame", 1),
        }
    }

    /// After any call into the replica: crash check, ship log calls, drain pushes.
    fn after(&mut self, w: &mut World) {
        if self.proc.as_ref().is_some_and(|p| p.crashed.get()) {
            self.die(w, "crashed in a syscall");
            w.crashed_in_call(self.me);
            return;
        }
        let Some(rep) = self.rep.as_mut() else { return };
        if self.cfg.keys.is_some() {
            // Register every epoch key this replica holds with the tap before any
            // message it just produced can reach the log service.
            for (epoch, k) in rep.testing_epoch_keys() {
                if self.known_epochs.insert((epoch, k[..].to_vec())) {
                    w.shared
                        .tap
                        .borrow_mut()
                        .secret(&format!("epoch {epoch} key ({})", self.name), &k[..]);
                }
            }
        }
        if self.real.is_some() {
            // Only an authenticated session may take calls; unbound, the
            // replica keeps them queued until a hello is admitted.
            let calls = match &self.log_session {
                Some(session) => match rep.take_authenticated_log_calls(session) {
                    Ok(calls) => calls,
                    Err(e) => {
                        w.shared.detail(&self.name, &format!("take calls: {e:?}"));
                        w.shared.count("real.session_stale", 1);
                        Vec::new()
                    }
                },
                None => Vec::new(),
            };
            let pushes = rep.take_pushes();
            let failed = self.ship_real(w, calls);
            // Failed calls get their replies now; any calls those replies queue
            // are shipped on the next pass.
            if let Some(rep) = self.rep.as_mut() {
                for (scope, e) in failed {
                    let _ = rep.on_authenticated_log_reply(scope, |_, _| Err(e));
                }
            }
            return self.after_pushes(w, pushes);
        }
        let calls = rep.take_log_calls();
        let pushes = rep.take_pushes();
        let mut offline = Vec::new();
        for c in calls {
            if !self.connected && !self.cfg.reconnect_storm {
                // A WebSocket transport fails calls at once while disconnected:
                // nothing was sent.
                offline.push(c.id);
                continue;
            }
            self.inflight.insert(c.id.0);
            let bytes = wire_bytes(&c.request);
            let msg = LogReq {
                device: self.cfg.device,
                call: c.id.0,
                req: c.request,
            };
            w.send_obj(self.me, self.svc, bytes, Some(Payload(Rc::new(msg))));
        }
        if !offline.is_empty() {
            for id in offline {
                rep.on_log_reply(id, Err(LogError::Offline));
            }
            // Replies may queue more calls; ship them on the next pass.
            return self.after_pushes(w, pushes);
        }
        self.after_pushes(w, pushes);
    }

    fn after_pushes(&mut self, w: &mut World, pushes: Vec<(SessionId, Push)>) {
        for (_, p) in pushes {
            if let Push::Receipt(r) = p {
                // A lost-tail fallback moves an acknowledged write to a new
                // position (`relocated_from`): the ledger accepts the move only
                // from the position it recorded.
                if let Some(from) = r.relocated_from {
                    match r.state {
                        ReceiptState::Confirmed => {
                            let to = r.seq.unwrap_or(0);
                            let moved =
                                w.shared
                                    .acks
                                    .borrow_mut()
                                    .relocate(&hex(&r.mutation), from, to);
                            w.shared.detail(
                                &self.name,
                                &format!(
                                    "receipt {} relocated {from} -> {to} (ledger moved: {moved})",
                                    hex(&r.mutation)
                                ),
                            );
                            w.shared.count("slice.relocated", 1);
                        }
                        ReceiptState::Rejected => {
                            // Lost after revocation: counted apart from lost writes.
                            w.shared.count("slice.lost_after_revocation", 1);
                            let had = w.shared.acks.borrow_mut().acks.remove(&hex(&r.mutation));
                            if let Some(a) = had {
                                let mut tk = w.shared.tokens.borrow_mut();
                                for t in &a.tokens {
                                    tk.excuse(t, "lost_after_revocation");
                                }
                            }
                        }
                        _ => {}
                    }
                }
                let Some(toks) = self.outstanding.get(&r.mutation).cloned() else {
                    continue;
                };
                match r.state {
                    ReceiptState::Confirmed => {
                        let seq = r.seq.unwrap_or(0);
                        w.shared.detail(
                            &self.name,
                            &format!("receipt {} confirmed at {seq}", hex(&r.mutation)),
                        );
                        w.shared.acks.borrow_mut().ack(Ack {
                            mutation: hex(&r.mutation),
                            seq,
                            tokens: toks.clone(),
                            client: self.name.clone(),
                            at: w.time.elapsed(),
                        });
                        w.shared.count("slice.confirmed", 1);
                        self.outstanding.remove(&r.mutation);
                    }
                    ReceiptState::Rejected => {
                        let mut tk = w.shared.tokens.borrow_mut();
                        for t in &toks {
                            tk.discard(t);
                        }
                        drop(tk);
                        w.shared.count("slice.rejected", 1);
                        self.outstanding.remove(&r.mutation);
                    }
                    ReceiptState::Unknown => {
                        // The client was told the outcome is unknown: its tokens
                        // may or may not land.
                        let mut tk = w.shared.tokens.borrow_mut();
                        for t in &toks {
                            tk.excuse(t, "outcome_unknown");
                        }
                        drop(tk);
                        w.shared.count("slice.unknown", 1);
                        self.outstanding.remove(&r.mutation);
                    }
                    ReceiptState::Pending => {}
                }
            }
        }
    }

    fn die(&mut self, w: &mut World, why: &str) {
        w.log(&self.name, &format!("down: {why}"));
        if let Some(p) = self.proc.take()
            && !p.crashed.get()
        {
            p.crash();
        }
        self.rep = None;
        self.session = None;
        self.inflight.clear();
        if let Some(wire) = self.real.as_mut() {
            wire.down();
        }
        self.connected = false;
        self.log_session = None;
    }

    fn work(&mut self, w: &mut World) {
        let (Some(rep), Some(s)) = (self.rep.as_mut(), self.session) else {
            return;
        };
        let records = rep.confirmed_records().unwrap_or_default();
        let roll = w.rng.below(100);
        let (op, toks) = if records.is_empty() || roll < 25 {
            let tok = w.shared.tokens.borrow_mut().fresh(&self.name);
            let n = self.next_id;
            self.next_id += 1;
            let mut id = [0u8; 16];
            id[..8].copy_from_slice(&self.cfg.device.0[..8]);
            id[8..].copy_from_slice(&(n + (self.incarnation << 40)).to_be_bytes());
            // A small shared namespace makes concurrent creates collide.
            let path = if w.rng.chance(300_000) {
                format!("notes/shared-{}.md", w.rng.below(4))
            } else {
                format!("notes/{}-{n}-{}.md", self.name, self.incarnation)
            };
            let doc = SimDoc {
                fields: vec![
                    ("title".into(), format!("Note {n}")),
                    ("status".into(), "open".into()),
                    ("tags".into(), format!("[{tok}]")),
                ],
                body: format!("Body {n}\n"),
            }
            .render();
            register_markers(w, &B16(id), &path);
            (
                Op::Create(Create {
                    id: B16(id),
                    path: Some(path),
                    type_name: None,
                    frontmatter: None,
                    body: None,
                    document: Some(Text::Inline(doc)),
                }),
                vec![tok],
            )
        } else {
            let r = &records[w.rng.index(records.len())];
            if roll < 85 {
                let tok = w.shared.tokens.borrow_mut().fresh(&self.name);
                let status = ["open", "doing", "done"][w.rng.index(3)];
                (
                    Op::Update(Update {
                        id: r.id,
                        patch: Some(DataMap(vec![("status".into(), Value::Text(status.into()))])),
                        unset: None,
                        add: Some(DataMap(vec![(
                            "tags".into(),
                            vec![Value::Text(tok.clone())],
                        )])),
                        remove: None,
                        body: None,
                        body_edits: None,
                        body_base: None,
                        body_base_text: None,
                        base: None,
                        if_revision: None,
                    }),
                    vec![tok],
                )
            } else {
                let to = format!("notes/moved-{}-{}.md", self.name, w.rng.below(1_000_000));
                register_markers(w, &r.id, &to);
                (
                    Op::Rename(Rename {
                        id: r.id,
                        from: r.path.clone(),
                        to,
                        update_refs: false,
                        if_revision: None,
                    }),
                    Vec::new(),
                )
            }
        };
        let res = rep.submit(
            s,
            SubmitParams {
                ops: vec![op],
                mutation_id: None,
                conflict_mode: None,
                timezone: None,
                allow_partial: None,
                mutation_ids: None,
                dry_run: None,
                include: None,
                wait: None,
            },
        );
        match res {
            Ok(receipts) => {
                for r in receipts {
                    match r.state {
                        ReceiptState::Rejected => {
                            for t in &toks {
                                w.shared.tokens.borrow_mut().discard(t);
                            }
                            w.shared.count("slice.rejected_at_submit", 1);
                        }
                        _ => {
                            w.shared.count("slice.submitted", 1);
                            self.outstanding.insert(r.mutation, toks.clone());
                        }
                    }
                }
            }
            Err(e) => {
                for t in &toks {
                    w.shared.tokens.borrow_mut().discard(t);
                }
                w.shared.count("slice.submit_error", 1);
                w.shared
                    .detail(&self.name, &format!("submit failed: {e:?}"));
            }
        }
    }
}

impl Actor for Node {
    fn name(&self) -> &str {
        &self.name
    }
    fn machine(&self) -> Option<usize> {
        Some(self.machine)
    }
    fn handle(&mut self, w: &mut World, ev: Ev) {
        match ev {
            Ev::Start | Ev::Restart => {
                self.open(w);
                if self.rep.is_some() {
                    w.timer(self.me, 1, TICK);
                    w.timer(self.me, 50, OBSERVE);
                    if self.cfg.work && !self.working {
                        self.working = true;
                        let d = w.rng.around(self.cfg.work_every_ms);
                        w.timer(self.me, d, WORK);
                    }
                }
            }
            Ev::Timer(TICK) => {
                if let Some(r) = self.rep.as_mut() {
                    r.tick();
                    self.after(w);
                }
                if self.rep.is_some() {
                    w.timer(self.me, 20, TICK);
                }
            }
            Ev::Timer(OBSERVE) => {
                if let Some(r) = self.rep.as_mut() {
                    if let Err(e) = r.observe(None) {
                        w.shared.detail(&self.name, &format!("observe: {e:?}"));
                    }
                    self.after(w);
                }
                if self.rep.is_some() {
                    w.timer(self.me, 150, OBSERVE);
                }
            }
            Ev::Timer(WORK) => {
                if w.shared.chaos.get() && self.cfg.work {
                    self.work(w);
                    self.after(w);
                    let d = w.rng.around(self.cfg.work_every_ms);
                    w.timer(self.me, d, WORK);
                } else {
                    self.working = false;
                }
            }
            Ev::Timer(RECONNECT) if self.real.is_some() => {
                if self.rep.is_none()
                    || self
                        .real
                        .as_ref()
                        .is_some_and(|wire| wire.phase() != Phase::Down)
                {
                    return;
                }
                if w.net.partitioned(self.me, w.now()) {
                    w.timer(self.me, 200, RECONNECT);
                    return;
                }
                self.connect_real(w);
            }
            Ev::Timer(RECONNECT) => {
                if self.connected && !self.cfg.reconnect_storm {
                    return;
                }
                if w.net.partitioned(self.me, w.now()) {
                    w.timer(self.me, 200, RECONNECT);
                    return;
                }
                self.connected = true;
                if let Some(r) = self.rep.as_mut() {
                    r.on_log_push(LogPush::Reconnected);
                    self.after(w);
                }
            }
            Ev::Msg { from, bytes, obj } if self.real.is_some() && from == self.svc => {
                self.real_msg(w, bytes, obj);
            }
            Ev::Msg { obj, .. } => {
                let Some(obj) = obj else { return };
                if let Some(rep) = obj.get::<LogRep>() {
                    w.shared.detail(
                        &self.name,
                        &format!(
                            "reply call {} ({}): {}",
                            rep.call,
                            if self.inflight.contains(&rep.call) {
                                "live"
                            } else {
                                "stale"
                            },
                            match &rep.reply {
                                Ok(r) => format!("{r:?}").chars().take(120).collect::<String>(),
                                Err(e) => e.to_string(),
                            }
                        ),
                    );
                    if self.inflight.remove(&rep.call)
                        && let Some(r) = self.rep.as_mut()
                    {
                        r.on_log_reply(CallId(rep.call), rep.reply.clone());
                        self.after(w);
                    }
                } else if let Some(p) = obj.get::<LogPushMsg>()
                    && let Some(r) = self.rep.as_mut()
                {
                    w.shared.detail(
                        &self.name,
                        &format!(
                            "push {}",
                            format!("{:?}", p.0).chars().take(120).collect::<String>()
                        ),
                    );
                    r.on_log_push(p.0.clone());
                    self.after(w);
                }
            }
            Ev::Closed { peer } if peer == self.svc && self.real.is_some() => {
                // Transmitted frames have unknown outcomes: retiring the session
                // classifies them so and tells the replica it is disconnected.
                let sent = self
                    .real
                    .as_mut()
                    .map(|wire| wire.down())
                    .unwrap_or_default();
                w.shared.detail(
                    &self.name,
                    &format!(
                        "connection closed; {} calls in flight -> session retired",
                        sent.len()
                    ),
                );
                self.connected = false;
                self.inflight.clear();
                let Some(r) = self.rep.as_mut() else { return };
                if let Some(session) = self.log_session.take() {
                    r.retire_authenticated_log(&session);
                }
                let d = w.rng.between(20, 500);
                w.timer(self.me, d, RECONNECT);
                self.after(w);
            }
            Ev::Closed { peer } if peer == self.svc => {
                // Every call in flight on the dead connection has an unknown
                // outcome; the transport reports one `Disconnected` per reconnect.
                w.shared.detail(
                    &self.name,
                    &format!(
                        "connection closed; {} calls in flight -> NoResponse",
                        self.inflight.len()
                    ),
                );
                if let Some(r) = self.rep.as_mut() {
                    for c in std::mem::take(&mut self.inflight) {
                        r.on_log_reply(CallId(c), Err(LogError::NoResponse));
                    }
                    if self.connected || self.cfg.reconnect_storm {
                        self.connected = false;
                        r.on_log_push(LogPush::Disconnected);
                        let d = w.rng.between(20, 500);
                        w.timer(self.me, d, RECONNECT);
                    }
                    self.after(w);
                }
            }
            Ev::Crash => self.die(w, "crash"),
            Ev::PowerLoss => self.die(w, "power loss"),
            _ => {}
        }
    }
    fn settled(&self, w: &World) -> bool {
        // Nothing pending, and caught up with the log.
        let log_head = if self.real.is_some() {
            w.actor::<super::real_log_net::RealServiceActor>(self.svc)
                .and_then(|s| s.head(&self.cfg.collection))
        } else {
            w.actor::<super::logsvc::LogService>(self.svc)
                .map(|s| s.svc.head(&self.cfg.collection).0)
        };
        self.rep.as_ref().is_some_and(|r| {
            r.sync_status().pending == 0 && log_head.is_none_or(|h| r.head().seq >= h)
        })
    }
    fn holds(&self) -> Vec<String> {
        self.rep
            .as_ref()
            .and_then(|r| r.store().holds().ok())
            .unwrap_or_default()
            .iter()
            .map(|h| format!("{:?}", h.reason))
            .collect()
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}

impl Node {
    /// Mutations this node's client submitted whose receipt it never saw
    /// (the process died first): (mutation, tokens).
    pub fn unresolved(&self) -> Vec<(Uuid, Vec<String>)> {
        self.outstanding
            .iter()
            .map(|(m, t)| (*m, t.clone()))
            .collect()
    }

    /// Ask the replica (as a reconnecting client would) for the receipt of a
    /// mutation whose push it never saw.
    pub fn ask_receipt(&mut self, mutation: &Uuid) -> Option<mdbn_wire::client::Receipt> {
        let s = self.session?;
        self.rep.as_mut()?.receipt(s, *mutation).ok()
    }

    /// Position at which this node's store recorded `mutation`, if any.
    pub fn receipt_seq(&self, mutation: &Uuid) -> Option<u64> {
        let r = self.rep.as_ref()?;
        Store::receipt(r.store(), mutation)
            .ok()
            .flatten()
            .map(|x| x.seq)
    }
}

/// Tokens in a node's confirmed state.
pub fn confirmed_tokens(n: &Node) -> BTreeSet<String> {
    n.digest()
        .map(|(_, recs)| {
            recs.iter()
                .flat_map(|r| tokens_in(r.doc.as_bytes()))
                .collect()
        })
        .unwrap_or_default()
}

/// Content markers for a record: its ID as 16 raw bytes and as hyphenated text,
/// and its path. Registered before the write is submitted, so every scan after
/// that looks for them.
fn register_markers(w: &World, id: &Uuid, path: &str) {
    let mut tap = w.shared.tap.borrow_mut();
    tap.marker(&format!("record id {}", id.to_hex()), &id.0);
    tap.marker("record id (text)", id.to_uuid_string().as_bytes());
    tap.marker("record path", path.as_bytes());
}
