//! `FakeLog`: an in-memory log service for the replica's own tests.
//!
//! It implements the parts of `log-service-api.md` a replica can observe: the
//! conditional append with chain check (I2), all-or-nothing batches (I3),
//! byte-identical replay (I4), idempotency tokens (I5), exact bytes (I7), objects
//! (I8), refs checks, snapshots, ranged reads and pushes. It does **not** verify
//! signatures or enforce policy: that is the real service's job, and replicas don't
//! trust it anyway.
//!
//! One [`FakeLogService`] holds the logs; each replica gets its own [`FakeLog`]
//! client (with its own push queue) from [`FakeLogService::client`]. Fault knobs on
//! the client simulate the outcomes the append loop must survive: committed but no
//! response, offline, and injected service errors.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::rc::{Rc, Weak};

use mdbn_wire::common::{B16, B32, Bytes, Hash, Uuid};
use mdbn_wire::envelope::{Item, ItemKind};
use mdbn_wire::hash::{CHAIN_ZERO, chain_hash, sha256};
use mdbn_wire::log_service::{
    AppendResult, Appended, Duplicate, HeadMoved, HeadResult, ReadKinds, ReadResult, SeqItem,
    SnapshotPointer,
};
use mdbn_wire::schema::Wire;

use crate::log::{LogClient, LogError, LogErrorCode, LogPush, LogReply, LogRequest, LogResponse};

#[derive(Debug, Default)]
struct Collection {
    items: Vec<Vec<u8>>,
    kinds: Vec<ItemKind>,
    chains: Vec<Hash>,
    tokens: BTreeMap<B16, u64>,
    objects: BTreeMap<B32, Vec<u8>>,
    snapshots: Vec<SnapshotPointer>,
    retained_from: u64,
}

impl Collection {
    fn head(&self) -> (u64, Hash) {
        (
            self.items.len() as u64,
            self.chains.last().copied().unwrap_or(CHAIN_ZERO),
        )
    }
}

#[derive(Debug, Default)]
struct ServiceState {
    logs: BTreeMap<Uuid, Collection>,
    clients: Vec<Weak<RefCell<ClientState>>>,
    now_ms: i64,
    /// Every `get_object` address asked for, per collection (tests prove what a
    /// replica never fetches).
    gets: Vec<(Uuid, B32)>,
}

#[derive(Debug)]
struct ClientState {
    device: Uuid,
    subscribed: BTreeSet<Uuid>,
    pushes: Vec<LogPush>,
}

/// The shared in-memory service.
#[derive(Debug, Clone, Default)]
pub struct FakeLogService {
    state: Rc<RefCell<ServiceState>>,
}

impl FakeLogService {
    /// A service with no logs. Logs are created on first append.
    pub fn new() -> FakeLogService {
        FakeLogService::default()
    }

    /// A client for one device.
    pub fn client(&self, device: Uuid) -> FakeLog {
        let st = Rc::new(RefCell::new(ClientState {
            device,
            subscribed: BTreeSet::new(),
            pushes: Vec::new(),
        }));
        self.state.borrow_mut().clients.push(Rc::downgrade(&st));
        FakeLog {
            service: self.clone(),
            client: st,
            faults: Faults::default(),
        }
    }

    /// Set the service clock (`appended_at`, snapshot `created_at`).
    pub fn set_now(&self, ms: i64) {
        self.state.borrow_mut().now_ms = ms;
    }

    /// The head of a collection's log.
    pub fn head(&self, collection: &Uuid) -> (u64, Hash) {
        self.state
            .borrow()
            .logs
            .get(collection)
            .map(Collection::head)
            .unwrap_or((0, CHAIN_ZERO))
    }

    /// Every item of a collection's log, exactly as appended.
    pub fn items(&self, collection: &Uuid) -> Vec<Vec<u8>> {
        self.state
            .borrow()
            .logs
            .get(collection)
            .map(|c| c.items.clone())
            .unwrap_or_default()
    }

    /// Compact: entries at or below `upto` are no longer returned (control items stay).
    pub fn compact(&self, collection: &Uuid, upto: u64) {
        if let Some(c) = self.state.borrow_mut().logs.get_mut(collection) {
            c.retained_from = c.retained_from.max(upto + 1);
        }
    }

    /// Lose the last `n` items, as on a failover to a lagging node: the head and
    /// chain roll back and their idempotency tokens are forgotten, so the same
    /// position can be taken by different bytes. Subscribers are not told.
    /// Snapshot pointers above the new head are dropped. Test only.
    pub fn lose_tail(&self, collection: &Uuid, n: u64) {
        let mut st = self.state.borrow_mut();
        let Some(c) = st.logs.get_mut(collection) else {
            return;
        };
        let keep = (c.items.len() as u64).saturating_sub(n);
        let keep = usize::try_from(keep).unwrap_or(usize::MAX);
        c.items.truncate(keep);
        c.kinds.truncate(keep);
        c.chains.truncate(keep);
        let head = keep as u64;
        c.tokens.retain(|_, seq| *seq <= head);
        c.snapshots.retain(|p| p.seq <= head);
    }

    /// Append raw item bytes at the head without any check, as a lying or
    /// corrupted service would: no signature, token or policy verification.
    /// Test only (lost-tail observer negatives).
    pub fn push_raw(&self, collection: &Uuid, bytes: Vec<u8>) {
        let kind = Item::from_bytes(&bytes)
            .map(|i| i.kind)
            .unwrap_or(ItemKind::Entry);
        let mut st = self.state.borrow_mut();
        let c = st.logs.entry(*collection).or_default();
        c.chains.push(chain_hash(&bytes));
        c.kinds.push(kind);
        c.items.push(bytes);
    }

    /// Every object address a client asked `get_object` for, in order.
    pub fn object_gets(&self, collection: &Uuid) -> Vec<B32> {
        self.state
            .borrow()
            .gets
            .iter()
            .filter(|(c, _)| c == collection)
            .map(|(_, a)| *a)
            .collect()
    }

    /// Objects stored for a collection (address → bytes), for plaintext oracles.
    pub fn objects(&self, collection: &Uuid) -> Vec<(B32, Vec<u8>)> {
        self.state
            .borrow()
            .logs
            .get(collection)
            .map(|c| c.objects.iter().map(|(a, b)| (*a, b.clone())).collect())
            .unwrap_or_default()
    }

    /// Fault: an object disappears (collected, or lost by the store).
    pub fn forget_object(&self, collection: &Uuid, address: &B32) {
        if let Some(c) = self.state.borrow_mut().logs.get_mut(collection) {
            c.objects.remove(address);
        }
    }

    fn handle(&self, me: &Rc<RefCell<ClientState>>, req: LogRequest) -> LogReply {
        match req {
            LogRequest::Append(p) => {
                self.append(p.collection, p.expect_seq, p.expect_prev, p.items)
            }
            LogRequest::Read(p) => {
                let st = self.state.borrow();
                let empty = Collection::default();
                let c = st.logs.get(&p.collection).unwrap_or(&empty);
                Ok(LogResponse::Read(read(c, p.after, p.limit, p.kinds)))
            }
            LogRequest::Head { collection } => {
                let st = self.state.borrow();
                let empty = Collection::default();
                let c = st.logs.get(&collection).unwrap_or(&empty);
                let (head, head_chain) = c.head();
                Ok(LogResponse::Head(HeadResult {
                    head,
                    head_chain,
                    retained_from: c.retained_from.max(1),
                    snapshot: c.snapshots.last().cloned(),
                }))
            }
            LogRequest::Subscribe { collection, .. } => {
                me.borrow_mut().subscribed.insert(collection);
                let (head, head_chain) = self.head(&collection);
                Ok(LogResponse::Subscribed { head, head_chain })
            }
            LogRequest::Unsubscribe { collection } => {
                me.borrow_mut().subscribed.remove(&collection);
                Ok(LogResponse::Ok)
            }
            LogRequest::PutObject {
                collection,
                address,
                kind,
                bytes,
            } => {
                if matches!(
                    kind,
                    ItemKind::Manifest | ItemKind::Chunk | ItemKind::RefIndex
                ) && sha256(&bytes) != address
                {
                    return Err(LogError::code(LogErrorCode::Invalid));
                }
                if kind == ItemKind::RefIndex
                    && mdbn_wire::ref_index::open_ref_index(&collection, &address, &bytes).is_err()
                {
                    return Err(LogError::code(LogErrorCode::Invalid));
                }
                let mut st = self.state.borrow_mut();
                let c = st.logs.entry(collection).or_default();
                let existed = c.objects.contains_key(&address);
                c.objects.entry(address).or_insert(bytes);
                Ok(LogResponse::PutObject { existed })
            }
            LogRequest::GetObject {
                collection,
                address,
                range,
            } => {
                self.state.borrow_mut().gets.push((collection, address));
                let st = self.state.borrow();
                let Some(b) = st
                    .logs
                    .get(&collection)
                    .and_then(|c| c.objects.get(&address))
                else {
                    return Err(LogError::code(LogErrorCode::NotFound));
                };
                let (off, len) = range.unwrap_or((0, b.len() as u64));
                let start = usize::try_from(off).unwrap_or(usize::MAX).min(b.len());
                let end = start
                    .saturating_add(usize::try_from(len).unwrap_or(usize::MAX))
                    .min(b.len());
                Ok(LogResponse::GetObject {
                    bytes: b[start..end].to_vec(),
                    size: b.len() as u64,
                    checksum: sha256(b),
                })
            }
            LogRequest::HasObjects {
                collection,
                addresses,
            } => {
                let st = self.state.borrow();
                let c = st.logs.get(&collection);
                Ok(LogResponse::HasObjects(
                    addresses
                        .iter()
                        .map(|a| c.is_some_and(|c| c.objects.contains_key(a)))
                        .collect(),
                ))
            }
            LogRequest::PutSnapshot(p) => {
                let device = me.borrow().device;
                let mut st = self.state.borrow_mut();
                let now = st.now_ms;
                let c = st.logs.entry(p.collection).or_default();
                let head = c.items.len() as u64;
                let newer = c.snapshots.last().is_none_or(|s| p.seq > s.seq);
                let refs_ok = c.objects.contains_key(&p.manifest)
                    && p.refs.iter().all(|r| c.objects.contains_key(r));
                if !refs_ok {
                    return Err(LogError::Service {
                        code: LogErrorCode::RefsMissing,
                        reason: None,
                        retry_after_ms: None,
                        missing: p
                            .refs
                            .iter()
                            .chain(std::iter::once(&p.manifest))
                            .filter(|r| !c.objects.contains_key(*r))
                            .copied()
                            .collect(),
                    });
                }
                // Ref-index expansion as the real service does it
                // (`log-service-api.md` §7): every member exists and is not an index.
                let is_index =
                    |b: &[u8]| Item::from_bytes(b).is_ok_and(|i| i.kind == ItemKind::RefIndex);
                let mut members = Vec::new();
                for r in &p.refs {
                    if c.objects.get(r).is_some_and(|b| is_index(b)) {
                        members.extend(
                            mdbn_wire::ref_index::open_ref_index(&p.collection, r, &c.objects[r])
                                .map_err(|_| LogError::code(LogErrorCode::Invalid))?,
                        );
                    }
                }
                if members
                    .iter()
                    .any(|m| c.objects.get(m).is_some_and(|b| is_index(b)))
                {
                    return Err(LogError::code(LogErrorCode::Invalid));
                }
                let absent: Vec<B32> = members
                    .iter()
                    .filter(|m| !c.objects.contains_key(*m))
                    .copied()
                    .collect();
                if !absent.is_empty() {
                    return Err(LogError::Service {
                        code: LogErrorCode::RefsMissing,
                        reason: None,
                        retry_after_ms: None,
                        missing: absent,
                    });
                }
                if p.seq > head || !newer {
                    return Ok(LogResponse::PutSnapshot(false));
                }
                c.snapshots.push(SnapshotPointer {
                    seq: p.seq,
                    manifest: p.manifest,
                    author: device,
                    created_at: now,
                    endorsed: false,
                });
                if c.snapshots.len() > 2 {
                    c.snapshots.remove(0);
                }
                Ok(LogResponse::PutSnapshot(true))
            }
            LogRequest::GetSnapshot { collection } => {
                let st = self.state.borrow();
                let mut v = st
                    .logs
                    .get(&collection)
                    .map(|c| c.snapshots.clone())
                    .unwrap_or_default();
                v.reverse();
                Ok(LogResponse::GetSnapshot(v))
            }
            LogRequest::EndorseSnapshot(p) => {
                let device = me.borrow().device;
                let mut st = self.state.borrow_mut();
                let Some(c) = st.logs.get_mut(&p.collection) else {
                    return Ok(LogResponse::EndorseSnapshot(false));
                };
                for s in &mut c.snapshots {
                    if s.seq == p.seq && s.manifest == p.manifest && s.author != device {
                        s.endorsed = true;
                        return Ok(LogResponse::EndorseSnapshot(true));
                    }
                }
                Ok(LogResponse::EndorseSnapshot(false))
            }
            LogRequest::StreamJoin { .. } => Ok(LogResponse::StreamJoined(Vec::new())),
            LogRequest::StreamLeave { .. } => Ok(LogResponse::Ok),
            LogRequest::StreamSend { .. } => Ok(LogResponse::StreamSent(0)),
        }
    }

    fn append(
        &self,
        collection: Uuid,
        expect_seq: u64,
        expect_prev: Hash,
        items: Vec<Bytes>,
    ) -> LogReply {
        let invalid = |reason: &str| LogError::Service {
            code: LogErrorCode::Invalid,
            reason: Some(reason.to_string()),
            retry_after_ms: None,
            missing: Vec::new(),
        };
        if items.is_empty() || items.len() > 64 {
            return Err(invalid("shape"));
        }
        if items.iter().map(|b| b.0.len()).sum::<usize>() > 4 << 20
            || items.iter().any(|b| b.0.len() > 1 << 20)
        {
            return Err(LogError::code(LogErrorCode::TooLarge));
        }
        let mut decoded = Vec::with_capacity(items.len());
        for (i, b) in items.iter().enumerate() {
            let Ok(item) = Item::from_bytes(&b.0) else {
                return Err(invalid("shape"));
            };
            if item.check_shape().is_err()
                || item.collection != collection
                || !item.kind.is_log_item()
                || item.seq != Some(expect_seq + i as u64)
            {
                return Err(invalid("shape"));
            }
            decoded.push(item);
        }
        let mut st = self.state.borrow_mut();
        let now = st.now_ms;
        let c = st.logs.entry(collection).or_default();
        let (head, head_chain) = c.head();
        // I4: byte-identical replay.
        if expect_seq >= 1 && expect_seq <= head {
            let start = usize::try_from(expect_seq - 1).unwrap_or(usize::MAX);
            let same = items
                .iter()
                .enumerate()
                .all(|(i, b)| c.items.get(start + i).is_some_and(|x| *x == b.0));
            if same {
                let last = expect_seq + items.len() as u64 - 1;
                let li = usize::try_from(last - 1).unwrap_or(usize::MAX);
                return Ok(LogResponse::Append(AppendResult::Appended(Appended {
                    first: expect_seq,
                    last,
                    head_chain: c.chains[li],
                    appended_at: now,
                })));
            }
        }
        if expect_seq != head + 1 || expect_prev != head_chain {
            return Ok(LogResponse::Append(AppendResult::HeadMoved(HeadMoved {
                head,
                head_chain,
            })));
        }
        let mut prev = head_chain;
        for (item, b) in decoded.iter().zip(&items) {
            if item.prev != Some(prev) {
                return Err(invalid("chain"));
            }
            prev = chain_hash(&b.0);
        }
        for (i, item) in decoded.iter().enumerate() {
            if let Some(t) = item.idem
                && let Some(seq) = c.tokens.get(&t)
            {
                return Ok(LogResponse::Append(AppendResult::Duplicate(Duplicate {
                    index: i as u64,
                    seq: *seq,
                })));
            }
        }
        let missing: Vec<B32> = decoded
            .iter()
            .flat_map(|i| i.refs.iter().flatten())
            .filter(|a| !c.objects.contains_key(*a))
            .copied()
            .collect();
        if !missing.is_empty() {
            return Err(LogError::Service {
                code: LogErrorCode::RefsMissing,
                reason: None,
                retry_after_ms: None,
                missing,
            });
        }
        let mut pushed = Vec::new();
        for (item, b) in decoded.iter().zip(items) {
            let seq = c.items.len() as u64 + 1;
            if let Some(t) = item.idem {
                c.tokens.insert(t, seq);
            }
            c.chains.push(chain_hash(&b.0));
            c.kinds.push(item.kind);
            pushed.push(SeqItem {
                seq,
                item: b.clone(),
            });
            c.items.push(b.0);
        }
        let (new_head, new_chain) = c.head();
        let clients: Vec<Rc<RefCell<ClientState>>> =
            st.clients.iter().filter_map(Weak::upgrade).collect();
        for cl in clients {
            let mut cl = cl.borrow_mut();
            if cl.subscribed.contains(&collection) {
                cl.pushes.push(LogPush::Items {
                    collection,
                    items: pushed.clone(),
                    head: new_head,
                    head_chain: new_chain,
                });
            }
        }
        Ok(LogResponse::Append(AppendResult::Appended(Appended {
            first: expect_seq,
            last: new_head,
            head_chain: new_chain,
            appended_at: now,
        })))
    }
}

fn read(c: &Collection, after: u64, limit: u64, kinds: Option<ReadKinds>) -> ReadResult {
    let (head, head_chain) = c.head();
    let control = kinds == Some(ReadKinds::Control);
    let retained_from = c.retained_from.max(1);
    let behind = !control && after + 1 < retained_from;
    let mut items = Vec::new();
    let mut more = false;
    let mut bytes = 0usize;
    if !behind {
        let limit = limit.min(1000);
        for seq in (after + 1)..=head {
            let i = usize::try_from(seq - 1).unwrap_or(usize::MAX);
            let kind = c.kinds[i];
            let is_control = kind != ItemKind::Entry;
            if control && !is_control {
                continue;
            }
            if !is_control && seq < retained_from {
                continue;
            }
            if items.len() as u64 >= limit || bytes >= 8 << 20 {
                more = true;
                break;
            }
            bytes += c.items[i].len();
            items.push(SeqItem {
                seq,
                item: Bytes(c.items[i].clone()),
            });
        }
    }
    ReadResult {
        items,
        head,
        head_chain,
        retained_from,
        behind,
        snapshot: if behind {
            c.snapshots.last().cloned()
        } else {
            None
        },
        more,
    }
}

/// Fault knobs for one client.
#[derive(Debug, Clone, Default)]
pub struct Faults {
    /// Calls fail with `Offline` (nothing reaches the service).
    pub offline: bool,
    /// The next this-many calls are performed, but answered with `NoResponse`.
    pub lose_replies: u32,
    /// The next this-many calls are not performed and answered with `NoResponse`.
    pub lose_requests: u32,
    /// The next call fails with this service error, without being performed.
    pub fail_next: Option<LogErrorCode>,
    /// Fault (malicious service): the next this-many non-control reads are answered
    /// `behind` with the latest snapshot pointer and no items.
    pub lie_behind: u32,
    /// Fault (malicious service): the next this-many appends are answered
    /// `duplicate` of their first item at this position, without appending.
    pub false_duplicate: Option<(u32, u64)>,
    /// Fault (lost objects): the next this-many appends are refused
    /// `refs_missing`, without being performed.
    pub refs_missing_appends: u32,
}

/// One device's client of a [`FakeLogService`].
#[derive(Debug)]
pub struct FakeLog {
    service: FakeLogService,
    client: Rc<RefCell<ClientState>>,
    /// Fault injection.
    pub faults: Faults,
}

impl FakeLog {
    /// The service behind this client.
    pub fn service(&self) -> &FakeLogService {
        &self.service
    }
}

impl LogClient for FakeLog {
    fn call(&mut self, request: LogRequest) -> LogReply {
        if self.faults.offline {
            return Err(LogError::Offline);
        }
        if self.faults.lose_requests > 0 {
            self.faults.lose_requests -= 1;
            return Err(LogError::NoResponse);
        }
        if let Some(code) = self.faults.fail_next.take() {
            return Err(LogError::code(code));
        }
        if let Some((n, seq)) = self.faults.false_duplicate
            && n > 0
            && matches!(&request, LogRequest::Append(_))
        {
            self.faults.false_duplicate = (n > 1).then_some((n - 1, seq));
            return Ok(LogResponse::Append(AppendResult::Duplicate(Duplicate {
                index: 0,
                seq,
            })));
        }
        if self.faults.refs_missing_appends > 0 && matches!(&request, LogRequest::Append(_)) {
            self.faults.refs_missing_appends -= 1;
            return Err(LogError::Service {
                code: LogErrorCode::RefsMissing,
                reason: None,
                retry_after_ms: None,
                missing: vec![mdbn_wire::common::B32([0xee; 32])],
            });
        }
        let lie = self.faults.lie_behind > 0
            && matches!(&request, LogRequest::Read(p) if p.kinds.is_none());
        let mut reply = self.service.handle(&self.client, request);
        if lie {
            self.faults.lie_behind -= 1;
            if let Ok(LogResponse::Read(r)) = &mut reply {
                r.behind = true;
                r.items.clear();
                r.snapshot = self
                    .service
                    .state
                    .borrow()
                    .logs
                    .values()
                    .next()
                    .and_then(|c| c.snapshots.first().cloned());
            }
        }
        if self.faults.lose_replies > 0 {
            self.faults.lose_replies -= 1;
            return Err(LogError::NoResponse);
        }
        reply
    }

    fn poll_pushes(&mut self) -> Vec<LogPush> {
        if self.faults.offline {
            return Vec::new();
        }
        std::mem::take(&mut self.client.borrow_mut().pushes)
    }
}
