//! The log service as a network actor.
//!
//! Today it wraps `mdbn_replica::fake::FakeLogService` (conditional append with
//! chain check, replay of identical bytes, tokens, refs, objects, snapshots,
//! pushes; no signatures or policy). It switches to the real `mdbn-log-service`
//! in-memory backend (signatures, policy transport effects, `lose_tail`
//! failover) when that lands.
//!
//! Every inbound request goes through [`World::log_ingress`]; at quiescence the
//! whole stored log and every object go through [`World::log_state`]. The
//! service is crashable only as a whole-service restart that keeps its durable
//! state (the contract's I1: an acknowledged item is durable).

use std::any::Any;
use std::collections::BTreeMap;
use std::rc::Rc;

use mdbn_replica::fake::{FakeLog, FakeLogService};
use mdbn_replica::log::{LogClient, LogRequest};
use mdbn_wire::common::Uuid;

use super::{LogPushMsg, LogRep, LogReq, wire_bytes};
use crate::world::{Actor, ActorId, Ev, Payload, World};

/// Flush real queued pushes after a scripted control-plane append.
pub const FLUSH_PUSHES: u64 = 1;

/// The log-service actor.
pub struct LogService {
    /// The service state.
    pub svc: FakeLogService,
    /// Per device: its client, its actor, and the connection epoch its
    /// subscription lives on.
    clients: BTreeMap<Uuid, (FakeLog, ActorId, u64)>,
    /// Collections whose logs the final tap scan covers.
    pub collections: Vec<Uuid>,
    /// Adversarial behaviour (a log service that lies).
    pub adversary: Adversary,
    /// What the adversary did, for the oracles.
    pub attacks: Attacks,
}

/// A log service that lies (`sealed-envelope.md` §1 threat model).
#[derive(Debug, Clone, Copy, Default)]
pub struct Adversary {
    /// Chance an `append` is answered with a false `duplicate` pointing at an
    /// existing, unrelated position, without appending.
    pub p_false_duplicate: crate::rng::Ppm,
    /// Control items are dropped from `kinds = control` reads.
    pub withhold_control: bool,
}

/// What a lying log service did during the run.
#[derive(Debug, Clone, Default)]
pub struct Attacks {
    /// False `duplicate` replies sent.
    pub false_duplicates: u64,
    /// Appends that arrived when a false duplicate was possible (head ≥ 2).
    pub dup_opportunities: u64,
    /// Control reads answered with control items withheld.
    pub withheld_reads: u64,
}

impl LogService {
    /// A service.
    pub fn new(collections: Vec<Uuid>) -> Self {
        LogService {
            svc: FakeLogService::new(),
            clients: BTreeMap::new(),
            collections,
            adversary: Adversary::default(),
            attacks: Attacks::default(),
        }
    }

    fn deliver_pushes(&mut self, w: &mut World, me: ActorId) {
        let mut out = Vec::new();
        for (c, actor, _) in self.clients.values_mut() {
            for p in c.poll_pushes() {
                out.push((*actor, p));
            }
        }
        for (to, p) in out {
            w.send_obj(
                me,
                to,
                b"push".to_vec(),
                Some(Payload(Rc::new(LogPushMsg(p)))),
            );
        }
    }
}

impl LogService {
    /// Answer an append with a `duplicate` at an existing position that
    /// does not hold this mutation, without appending.
    fn lie(&mut self, w: &mut World, req: &LogRequest) -> Option<mdbn_replica::log::LogReply> {
        use mdbn_replica::log::LogResponse;
        use mdbn_wire::log_service::{AppendResult, Duplicate};
        let LogRequest::Append(p) = req else {
            return None;
        };
        let (head, _) = self.svc.head(&p.collection);
        // The first eligible append is always a lie, so no seed is vacuous; after
        // that, lie with the configured probability.
        let first = self.adversary.p_false_duplicate > 0 && self.attacks.false_duplicates == 0;
        if head >= 2 && self.adversary.p_false_duplicate > 0 {
            self.attacks.dup_opportunities += 1;
        }
        if head < 2 || !(first || w.rng.chance(self.adversary.p_false_duplicate)) {
            return None;
        }
        let seq = 1 + w.rng.below(head);
        self.attacks.false_duplicates += 1;
        w.log(
            "logsvc",
            &format!(
                "ADVERSARY false duplicate: append at {} answered duplicate at {seq}",
                p.expect_seq
            ),
        );
        Some(Ok(LogResponse::Append(AppendResult::Duplicate(
            Duplicate { index: 0, seq },
        ))))
    }

    /// Drop control items from control-only reads.
    fn tamper(
        &mut self,
        reply: mdbn_replica::log::LogReply,
        req: &LogRequest,
    ) -> mdbn_replica::log::LogReply {
        use mdbn_replica::log::LogResponse;
        use mdbn_wire::log_service::ReadKinds;
        match (req, reply) {
            (LogRequest::Read(p), Ok(LogResponse::Read(mut r)))
                if self.adversary.withhold_control && p.kinds == Some(ReadKinds::Control) =>
            {
                let before = r.items.len();
                // Keep the bootstrap genesis and initial rekey, so the joining
                // device can authenticate/decrypt the manifest. Withhold later
                // control items to exercise the control-chain check itself.
                r.items.retain(|i| i.seq <= 2);
                if r.items.len() < before {
                    self.attacks.withheld_reads += 1;
                }
                Ok(LogResponse::Read(r))
            }
            (_, reply) => reply,
        }
    }
}

impl Actor for LogService {
    fn name(&self) -> &str {
        "logsvc"
    }
    fn handle(&mut self, w: &mut World, ev: Ev) {
        let me = w.actors_of::<LogService>().first().copied().unwrap_or(0);
        self.svc.set_now(w.now() as i64);
        match ev {
            Ev::Timer(FLUSH_PUSHES) => self.deliver_pushes(w, me),
            Ev::Msg { from, bytes, obj } => {
                w.log_ingress(&format!("from {}", w.name(from)), &bytes);
                let Some(r) = obj.as_ref().and_then(|o| o.get::<LogReq>()).cloned() else {
                    return;
                };
                tap_request(w, &r.req);
                let svc = self.svc.clone();
                let epoch = w.net.epoch(me, from);
                let entry = self
                    .clients
                    .entry(r.device)
                    .or_insert_with(|| (svc.client(r.device), from, epoch));
                entry.1 = from;
                entry.2 = epoch;
                let reply = match self.lie(w, &r.req) {
                    Some(lie) => lie,
                    None => self
                        .clients
                        .get_mut(&r.device)
                        .expect("just inserted")
                        .0
                        .call(r.req.clone()),
                };
                let reply = self.tamper(reply, &r.req);
                if let Err(e) = &reply {
                    // Error and log strings the service produces.
                    w.log_path("error", r.req.method(), e.to_string().as_bytes());
                }
                w.shared.detail(
                    "logsvc",
                    &format!(
                        "{} from {} call {} -> {}",
                        r.req.method(),
                        w.name(from),
                        r.call,
                        describe(&r.req, &reply)
                    ),
                );
                w.send_obj(
                    me,
                    from,
                    b"reply".to_vec(),
                    Some(Payload(Rc::new(LogRep {
                        call: r.call,
                        reply,
                    }))),
                );
                self.deliver_pushes(w, me);
            }
            Ev::Closed { peer } => {
                // The connection is gone: so is its subscription.
                // Only if the subscription lives on the connection that closed: a
                // late close notice must not drop a newer connection's subscription.
                let col = self.collections.clone();
                let current = w.net.epoch(me, peer);
                for (c, actor, epoch) in self.clients.values_mut() {
                    if *actor == peer && *epoch != current {
                        for collection in &col {
                            let _ = c.call(LogRequest::Unsubscribe {
                                collection: *collection,
                            });
                        }
                        let _ = c.poll_pushes();
                    }
                }
            }
            _ => {}
        }
    }
    fn quiesce(&mut self, w: &mut World) {
        for c in self.collections.clone() {
            for (i, item) in self.svc.items(&c).iter().enumerate() {
                w.log_path(
                    &format!("stored:item:{}", item_kind(item)),
                    &format!("{}", i + 1),
                    item,
                );
            }
            for (a, b) in self.svc.objects(&c) {
                w.log_path(&format!("stored:object:{}", item_kind(&b)), &a.to_hex(), &b);
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

/// Encode for the tap (re-exported for nodes).
pub fn request_bytes(r: &LogRequest) -> Vec<u8> {
    wire_bytes(r)
}

fn describe(req: &LogRequest, reply: &mdbn_replica::log::LogReply) -> String {
    use mdbn_replica::log::LogResponse;
    use mdbn_wire::log_service::AppendResult;
    let what = match req {
        LogRequest::Append(p) => format!("expect {} items {} ", p.expect_seq, p.items.len()),
        LogRequest::Read(p) => format!("after {} ", p.after),
        LogRequest::Subscribe { after, .. } => format!("after {after} "),
        _ => String::new(),
    };
    let out = match reply {
        Ok(LogResponse::Append(AppendResult::Appended(a))) => {
            format!("appended {}..{}", a.first, a.last)
        }
        Ok(LogResponse::Append(AppendResult::HeadMoved(h))) => format!("head_moved {}", h.head),
        Ok(LogResponse::Append(AppendResult::Duplicate(d))) => {
            format!("duplicate idx {} at {}", d.index, d.seq)
        }
        Ok(LogResponse::Read(r)) => format!("{} items, head {}", r.items.len(), r.head),
        Ok(LogResponse::Subscribed { head, .. }) => format!("head {head}"),
        Ok(_) => "ok".into(),
        Err(e) => e.to_string(),
    };
    format!("{what}{out}")
}

/// Name of an item envelope's kind (`entry`, `policy`, `rekey`, ...).
pub fn item_kind(bytes: &[u8]) -> &'static str {
    use mdbn_wire::envelope::{Item, ItemKind};
    use mdbn_wire::schema::Wire;
    match Item::from_bytes(bytes).map(|i| i.kind) {
        Ok(ItemKind::Entry) => "entry",
        Ok(ItemKind::Policy) => "policy",
        Ok(ItemKind::Rekey) => "rekey",
        Ok(ItemKind::KeyGrant) => "key_grant",
        Ok(ItemKind::Base) => "base",
        Ok(ItemKind::Manifest) => "manifest",
        Ok(ItemKind::Chunk) => "chunk",
        Ok(ItemKind::BlobPart) => "blob-part",
        Ok(ItemKind::Ephemeral) => "ephemeral",
        #[allow(unreachable_patterns)]
        Ok(_) => "other",
        Err(_) => "undecodable",
    }
}

/// Scan a request on its own paths: every appended item by kind, objects by
/// kind, snapshot pointers, ephemeral sends.
fn tap_request(w: &World, req: &LogRequest) {
    use mdbn_wire::schema::Wire;
    match req {
        LogRequest::Append(p) => {
            for it in &p.items {
                w.log_path(&format!("item:{}", item_kind(&it.0)), "append", &it.0);
            }
        }
        LogRequest::PutObject { bytes, .. } => {
            w.log_path(&format!("object:{}", item_kind(bytes)), "put", bytes);
        }
        LogRequest::PutSnapshot(p) => {
            w.log_path("snapshot-pointer", "put", &p.to_bytes().unwrap_or_default());
        }
        LogRequest::EndorseSnapshot(p) => {
            w.log_path(
                "snapshot-pointer",
                "endorse",
                &p.to_bytes().unwrap_or_default(),
            );
        }
        LogRequest::StreamSend { message, .. } => {
            w.log_path("ephemeral", "send", message);
        }
        _ => {}
    }
}
