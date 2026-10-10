//! The world: actors, machines, the network, chaos, and the run loop.
//!
//! **Actors** ([`Actor`]) are network participants: replicas, thin clients, the
//! log service, the policy authority. They receive [`Ev`]s from the global queue.
//!
//! **Local processes** ([`LocalProc`]) run on one machine and touch only its file
//! system: editors, git, a sync tool. They are driven by the machine's own queue,
//! so they can also run *inside* a replica's syscall when the machine hook
//! ([`MachineHost`]) interleaves them or stalls the replica.
//!
//! A run: `build` (the scenario creates machines and actors) → `run` for the
//! scenario's duration with chaos on → `quiesce` (chaos off, network healed,
//! everyone restarted, run until every actor reports settled) → the scenario's
//! checks → [`Report`].

use std::any::Any;
use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

use crate::net::{Endpoint, Fate, Net, NetConfig};
use crate::oracle::{AckLedger, Kind, Tokens, Violation};
use crate::platform::{Hook, HookAction, LocalEv, Machine, MachineRef, Os};
use crate::rng::{Ppm, SimRng};
use crate::sched::{EPOCH_MS, Queue, SimTime};
use crate::tap::{Party, Tap};
use crate::trace::Trace;

/// An actor's ID, which is also its network endpoint.
pub type ActorId = Endpoint;

/// An event for an actor.
#[derive(Debug, Clone)]
pub enum Ev {
    /// First event after spawning or restarting.
    Start,
    /// A timer the actor set.
    Timer(u64),
    /// A message.
    Msg {
        /// Sender.
        from: ActorId,
        /// Bytes: what crosses the wire (scanned by the untrusted-party tap).
        bytes: Vec<u8>,
        /// The typed value those bytes encode, when the simulator skips a codec
        /// (in-process log-service binding). Never inspected by the network.
        obj: Option<Payload>,
    },
    /// The stream connection to `peer` closed (loss, partition, peer crash).
    Closed {
        /// The other end.
        peer: ActorId,
    },
    /// The actor's process crashes now (its volatile state is gone).
    Crash,
    /// The actor's process starts again after a crash.
    Restart,
    /// Its machine lost power (already applied to the disk); the process is gone.
    PowerLoss,
}

/// A typed message body carried alongside its wire bytes.
#[derive(Clone)]
pub struct Payload(pub Rc<dyn Any>);

impl std::fmt::Debug for Payload {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Payload(..)")
    }
}

impl Payload {
    /// Downcast.
    pub fn get<T: 'static>(&self) -> Option<&T> {
        self.0.downcast_ref::<T>()
    }
}

/// A network participant.
pub trait Actor: Any {
    /// Name for traces.
    fn name(&self) -> &str;
    /// The machine it runs on, if any.
    fn machine(&self) -> Option<usize> {
        None
    }
    /// Handle one event.
    fn handle(&mut self, w: &mut World, ev: Ev);
    /// Chaos is over: stop generating work and prepare to settle.
    fn quiesce(&mut self, _w: &mut World) {}
    /// Nothing left to do (pending queues empty, caught up).
    fn settled(&self, _w: &World) -> bool {
        true
    }
    /// Downcast.
    fn as_any(&self) -> &dyn Any;
    /// Downcast.
    fn as_any_mut(&mut self) -> &mut dyn Any;
    /// The holds this actor's replica carries at the end of the run, by cause
    /// (the `HoldReason` name); the report turns them into the hold rate.
    fn holds(&self) -> Vec<String> {
        Vec::new()
    }
}

/// State shared by the world, actors and local processes.
#[derive(Debug, Default)]
pub struct Shared {
    /// Token bookkeeping (lost-edit oracle).
    pub tokens: RefCell<Tokens>,
    /// Acknowledged writes (lost-ack oracle).
    pub acks: RefCell<AckLedger>,
    /// The untrusted-party tap (no plaintext, no key material).
    pub tap: RefCell<Tap>,
    /// The trace.
    pub trace: RefCell<Trace>,
    /// Chaos is on.
    pub chaos: Cell<bool>,
    /// Free-form counters for the report.
    pub counters: RefCell<BTreeMap<String, u64>>,
    /// Violations found during the run (invariants checked as they happen).
    pub violations: RefCell<Vec<Violation>>,
    /// World start, for trace timestamps.
    pub time: SimTime,
}

impl Shared {
    /// Add to a counter.
    pub fn count(&self, k: &str, n: u64) {
        *self.counters.borrow_mut().entry(k.to_string()).or_default() += n;
    }
    /// Record a trace line at the world time.
    pub fn log(&self, who: &str, what: &str) {
        let t = self.time.elapsed();
        self.trace.borrow_mut().line(t, who, what);
    }
    /// Record a trace line at a machine time.
    pub fn log_at(&self, t: u64, who: &str, what: &str) {
        self.trace.borrow_mut().line(t - EPOCH_MS, who, what);
    }
    /// Record a detail line (traced replays only; not digested).
    pub fn detail(&self, who: &str, what: &str) {
        let mut tr = self.trace.borrow_mut();
        if tr.keep {
            let t = self.time.elapsed();
            tr.detail(format!("t={t} {who} {what}"));
        }
    }

    /// Record a violation now.
    pub fn violate(&self, kind: Kind, detail: String) {
        self.log("ORACLE", &format!("{kind}: {detail}"));
        self.violations
            .borrow_mut()
            .push(Violation { kind, detail });
    }
}

/// Context for a local process step.
pub struct LocalCx<'a> {
    /// The machine.
    pub m: &'a MachineRef,
    /// This process's index on the machine.
    pub idx: usize,
    /// Randomness for this machine's processes.
    pub rng: &'a mut SimRng,
    /// Shared state.
    pub shared: &'a Rc<Shared>,
}

impl LocalCx<'_> {
    /// Machine time.
    pub fn now(&self) -> u64 {
        self.m.borrow().now()
    }
    /// Run this process's `step(tag)` after `delay` ms of machine time.
    pub fn at(&mut self, delay: u64, tag: u64) {
        let t = self.now() + delay;
        self.m.borrow_mut().queue.push(
            t,
            LocalEv {
                proc: self.idx,
                tag,
            },
        );
    }
    /// Chaos is on.
    pub fn chaos(&self) -> bool {
        self.shared.chaos.get()
    }
    /// Detail trace (traced replays only).
    pub fn detail(&self, who: &str, what: &str) {
        let mut tr = self.shared.trace.borrow_mut();
        if tr.keep {
            let t = self.now() - EPOCH_MS;
            let m = self.m.borrow().name.clone();
            tr.detail(format!("t={t} {m}/{who} {what}"));
        }
    }
    /// Trace.
    pub fn log(&self, who: &str, what: &str) {
        let t = self.now();
        let m = self.m.borrow().name.clone();
        self.shared.log_at(t, &format!("{m}/{who}"), what);
    }
}

/// A process on one machine that only touches its file system.
pub trait LocalProc: Any {
    /// Name.
    fn name(&self) -> &str;
    /// Begin (schedule the first step).
    fn start(&mut self, _cx: &mut LocalCx) {}
    /// A scheduled step.
    fn step(&mut self, cx: &mut LocalCx, tag: u64);
    /// Act right now, between two syscalls of a hooked process doing `op` on `path`.
    fn interleave(&mut self, _cx: &mut LocalCx, _op: &str, _path: &str) {}
    /// The machine lost power: the process is gone, its unsaved state lost.
    fn power_loss(&mut self, _cx: &mut LocalCx) {}
    /// Chaos is over: finish in-flight work and stop.
    fn quiesce(&mut self, _cx: &mut LocalCx) {}
    /// Nothing in flight (an editor with unsaved changes is not settled).
    fn settled(&self) -> bool {
        true
    }
    /// Downcast.
    fn as_any(&self) -> &dyn Any;
    /// Downcast.
    fn as_any_mut(&mut self) -> &mut dyn Any;
}

/// What the machine hook does around hooked syscalls.
#[derive(Debug, Clone, Copy, Default)]
pub struct HookCfg {
    /// Chance a local process acts between two syscalls.
    pub p_interleave: Ppm,
    /// Chance the caller is descheduled before a syscall.
    pub p_stall: Ppm,
    /// Longest stall, ms (log-uniform up to this).
    pub stall_max_ms: u64,
    /// Chance the caller crashes before a syscall.
    pub p_crash: Ppm,
}

/// Runs a machine's local processes and acts as its syscall hook.
pub struct MachineHost {
    /// Local processes.
    pub procs: Vec<Option<Box<dyn LocalProc>>>,
    /// Randomness for local processes and hook decisions.
    pub rng: SimRng,
    /// Hook behaviour.
    pub cfg: HookCfg,
    /// Shared state.
    pub shared: Rc<Shared>,
    /// Hook statistics.
    pub stalls: u64,
    /// Hook statistics.
    pub interleavings: u64,
    /// Hook statistics.
    pub syscall_crashes: u64,
}

impl MachineHost {
    /// Run `f` on local process `i` with its context.
    pub fn with_proc(
        &mut self,
        m: &MachineRef,
        i: usize,
        f: impl FnOnce(&mut dyn LocalProc, &mut LocalCx),
    ) {
        let Some(mut p) = self.procs.get_mut(i).and_then(Option::take) else {
            return;
        };
        {
            let mut cx = LocalCx {
                m,
                idx: i,
                rng: &mut self.rng,
                shared: &self.shared,
            };
            f(p.as_mut(), &mut cx);
        }
        self.procs[i] = Some(p);
    }

    /// Run every local step due at or before `until` (machine time).
    pub fn pump(&mut self, m: &MachineRef, until: u64) {
        loop {
            let next = m.borrow().queue.peek_time();
            match next {
                Some(t) if t <= until => {
                    let (t, ev) = m.borrow_mut().queue.pop().expect("peeked");
                    {
                        let mut mm = m.borrow_mut();
                        if t > mm.world.now() {
                            mm.ahead_ms = mm.ahead_ms.max(t);
                        }
                        mm.tick();
                    }
                    self.with_proc(m, ev.proc, |p, cx| p.step(cx, ev.tag));
                }
                _ => break,
            }
        }
    }

    /// Start a local process.
    pub fn start(&mut self, m: &MachineRef, i: usize) {
        self.with_proc(m, i, |p, cx| p.start(cx));
    }

    /// Tell every local process the machine lost power.
    pub fn power_loss(&mut self, m: &MachineRef) {
        // Their pending steps die with them.
        m.borrow_mut().queue = Queue::default();
        for i in 0..self.procs.len() {
            self.with_proc(m, i, |p, cx| p.power_loss(cx));
        }
    }

    /// Chaos is over.
    pub fn quiesce(&mut self, m: &MachineRef) {
        for i in 0..self.procs.len() {
            self.with_proc(m, i, |p, cx| p.quiesce(cx));
        }
    }
}

impl Hook for MachineHost {
    fn before(&mut self, m: &MachineRef, proc: &str, op: &str, path: &str) -> HookAction {
        let now = m.borrow().now();
        self.pump(m, now);
        if !self.shared.chaos.get() || proc == "kernel" {
            if proc == "kernel" && !self.procs.is_empty() && self.shared.chaos.get() {
                // A kernel window (macOS swap): let someone look.
                let i = self.rng.index(self.procs.len());
                self.interleavings += 1;
                self.with_proc(m, i, |p, cx| p.interleave(cx, op, path));
            }
            return HookAction::Proceed;
        }
        if self.rng.chance(self.cfg.p_crash) {
            self.syscall_crashes += 1;
            return HookAction::Crash;
        }
        if self.rng.chance(self.cfg.p_stall) {
            self.stalls += 1;
            let d = self.rng.log_uniform(self.cfg.stall_max_ms);
            let until = {
                let mut mm = m.borrow_mut();
                let t = mm.now() + d;
                mm.ahead_ms = t;
                t
            };
            self.pump(m, until);
        }
        if !self.procs.is_empty() && self.rng.chance(self.cfg.p_interleave) {
            self.interleavings += 1;
            let i = self.rng.index(self.procs.len());
            self.with_proc(m, i, |p, cx| p.interleave(cx, op, path));
        }
        HookAction::Proceed
    }
}

/// Chaos parameters for the world itself.
#[derive(Debug, Clone, Default)]
pub struct Chaos {
    /// Mean time between process crashes (any crashable actor), ms; 0 = none.
    pub crash_every_ms: u64,
    /// Of those, the fraction that are machine power losses.
    pub p_power: Ppm,
    /// Power loss: chance an unsynced inode comes back torn.
    pub p_torn: Ppm,
    /// Power loss: chance an unsynced inode's new bytes survive.
    pub p_new: Ppm,
    /// Restart delay range, ms.
    pub restart_ms: (u64, u64),
    /// Mean time between partitions, ms; 0 = none.
    pub partition_every_ms: u64,
    /// Partition length range, ms.
    pub partition_ms: (u64, u64),
}

#[derive(Debug, Clone)]
enum Item {
    To(ActorId, Ev),
    Deliver {
        from: ActorId,
        to: ActorId,
        epoch: Option<u64>,
        bytes: Vec<u8>,
        obj: Option<Payload>,
    },
    ChaosCrash,
    ChaosPartition,
}

/// What one seed produced.
#[derive(Debug, Clone, Default)]
pub struct Report {
    /// Scenario name.
    pub scenario: String,
    /// Seed.
    pub seed: u64,
    /// Oracle violations; empty means clean.
    pub violations: Vec<Violation>,
    /// Determinism digest (over the whole trace).
    pub digest: u64,
    /// Final state digest (scenario-defined).
    pub state: String,
    /// Counters.
    pub counters: BTreeMap<String, u64>,
    /// Trace lines (if kept).
    pub trace: Vec<String>,
}

impl Report {
    /// No violations.
    pub fn clean(&self) -> bool {
        self.violations.is_empty()
    }
}

/// The simulated world for one seed.
pub struct World {
    /// Seed.
    pub seed: u64,
    /// World time.
    pub time: SimTime,
    /// World-level randomness (chaos, network).
    pub rng: SimRng,
    queue: Queue<Item>,
    /// The network.
    pub net: Net,
    /// Machines.
    pub machines: Vec<MachineRef>,
    /// Their hosts (local processes + hook).
    pub hosts: Vec<Rc<RefCell<MachineHost>>>,
    actors: Vec<Option<Box<dyn Actor>>>,
    names: Vec<String>,
    /// Actors that chaos may crash.
    pub crashable: Vec<ActorId>,
    /// Actors that chaos may partition.
    pub partitionable: Vec<ActorId>,
    /// Down actors (crashed, waiting to restart).
    pub down: BTreeSet<ActorId>,
    /// Actors stopped for good (a device that was lost or replaced).
    pub retired: BTreeSet<ActorId>,
    peers: BTreeSet<(ActorId, ActorId)>,
    /// Shared state.
    pub shared: Rc<Shared>,
    /// Chaos parameters.
    pub chaos: Chaos,
    /// Hard stop: a bug was found and the scenario asked to stop early.
    pub stop: bool,
}

impl Drop for World {
    fn drop(&mut self) {
        // Machines and their hosts reference each other (hook ↔ processes):
        // break the cycles so a sweep doesn't leak a world per seed.
        for m in &self.machines {
            if let Ok(mut m) = m.try_borrow_mut() {
                m.hook = None;
            }
        }
        for h in &self.hosts {
            if let Ok(mut h) = h.try_borrow_mut() {
                h.procs.clear();
            }
        }
    }
}

impl World {
    /// A world for `seed`; `keep_trace` keeps trace lines for printing.
    pub fn new(seed: u64, keep_trace: bool) -> Self {
        let rng = SimRng::new(seed);
        let time = SimTime::default();
        let shared = Rc::new(Shared {
            trace: RefCell::new(Trace::new(keep_trace)),
            time: time.clone(),
            ..Default::default()
        });
        World {
            seed,
            net: Net::new(NetConfig::calm(), rng.fork("net")),
            rng: rng.fork("world"),
            time,
            queue: Queue::default(),
            machines: Vec::new(),
            hosts: Vec::new(),
            actors: Vec::new(),
            names: Vec::new(),
            crashable: Vec::new(),
            partitionable: Vec::new(),
            down: BTreeSet::new(),
            retired: BTreeSet::new(),
            peers: BTreeSet::new(),
            shared,
            chaos: Chaos::default(),
            stop: false,
        }
    }

    /// World time, ms.
    pub fn now(&self) -> u64 {
        self.time.now()
    }

    /// Trace a line.
    pub fn log(&self, who: &str, what: &str) {
        self.shared.log(who, what);
    }

    /// Add a machine; returns its index.
    pub fn add_machine(&mut self, name: &str, os: Os, hook: HookCfg) -> usize {
        let i = self.machines.len();
        let m = Machine::new(
            i,
            name,
            os,
            self.time.clone(),
            self.rng.fork(&format!("machine/{name}")),
        );
        let host = Rc::new(RefCell::new(MachineHost {
            procs: Vec::new(),
            rng: self.rng.fork(&format!("host/{name}")),
            cfg: hook,
            shared: self.shared.clone(),
            stalls: 0,
            interleavings: 0,
            syscall_crashes: 0,
        }));
        {
            let mut mm = m.borrow_mut();
            mm.hook = Some(host.clone() as Rc<RefCell<dyn Hook>>);
            mm.verbose = self.shared.trace.borrow().keep;
        }
        self.machines.push(m);
        self.hosts.push(host);
        i
    }

    /// Add a local process to machine `m`; it starts immediately.
    pub fn add_local(&mut self, m: usize, p: Box<dyn LocalProc>) -> usize {
        let host = self.hosts[m].clone();
        let i = {
            let mut h = host.borrow_mut();
            h.procs.push(Some(p));
            h.procs.len() - 1
        };
        host.borrow_mut().start(&self.machines[m], i);
        i
    }

    /// A local process, downcast.
    pub fn local<T: 'static>(&self, m: usize, i: usize) -> Option<std::cell::Ref<'_, T>> {
        let h = self.hosts[m].borrow();
        std::cell::Ref::filter_map(h, |h| {
            h.procs
                .get(i)
                .and_then(|p| p.as_ref())
                .and_then(|p| p.as_any().downcast_ref::<T>())
        })
        .ok()
    }

    /// Run `f` on local process `i` of machine `m` (e.g. the editor fence).
    pub fn with_local(
        &mut self,
        m: usize,
        i: usize,
        f: impl FnOnce(&mut dyn LocalProc, &mut LocalCx),
    ) {
        let mref = self.machines[m].clone();
        let host = self.hosts[m].clone();
        host.borrow_mut().with_proc(&mref, i, f);
    }

    /// Spawn an actor; it gets [`Ev::Start`] at the current time.
    pub fn spawn(&mut self, a: Box<dyn Actor>) -> ActorId {
        let id = self.actors.len() as ActorId;
        self.names.push(a.name().to_string());
        self.actors.push(Some(a));
        self.queue.push(self.now(), Item::To(id, Ev::Start));
        id
    }

    /// Actor name.
    pub fn name(&self, id: ActorId) -> &str {
        &self.names[id as usize]
    }

    /// Number of actors.
    pub fn actor_count(&self) -> usize {
        self.actors.len()
    }

    /// An actor, downcast (None while it is handling an event).
    pub fn actor<T: 'static>(&self, id: ActorId) -> Option<&T> {
        self.actors
            .get(id as usize)?
            .as_ref()?
            .as_any()
            .downcast_ref::<T>()
    }

    /// An actor, downcast, mutably.
    pub fn actor_mut<T: 'static>(&mut self, id: ActorId) -> Option<&mut T> {
        self.actors
            .get_mut(id as usize)?
            .as_mut()?
            .as_any_mut()
            .downcast_mut::<T>()
    }

    /// Every actor of type `T`.
    pub fn actors_of<T: 'static>(&self) -> Vec<ActorId> {
        (0..self.actors.len() as ActorId)
            .filter(|i| self.actor::<T>(*i).is_some())
            .collect()
    }

    /// Deliver `ev` to `to` after `delay`.
    pub fn at(&mut self, to: ActorId, delay: u64, ev: Ev) {
        let t = self.now() + delay;
        self.queue.push(t, Item::To(to, ev));
    }

    /// Set a timer.
    pub fn timer(&mut self, to: ActorId, delay: u64, tag: u64) {
        self.at(to, delay, Ev::Timer(tag));
    }

    fn machine_now(&self, a: ActorId) -> u64 {
        match self
            .actors
            .get(a as usize)
            .and_then(|x| x.as_ref())
            .and_then(|x| x.machine())
        {
            Some(m) => self.machines[m].borrow().now(),
            None => self.now(),
        }
    }

    /// Send over the stream connection between `from` and `to`.
    pub fn send(&mut self, from: ActorId, to: ActorId, bytes: Vec<u8>) {
        self.send_obj(from, to, bytes, None);
    }

    /// Send bytes plus the typed value they encode.
    pub fn send_obj(&mut self, from: ActorId, to: ActorId, bytes: Vec<u8>, obj: Option<Payload>) {
        let now = self.machine_now(from).max(self.now());
        self.peers.insert((from.min(to), from.max(to)));
        match self.net.send_stream(now, from, to) {
            Fate::Deliver { at, epoch, .. } => self.queue.push(
                at,
                Item::Deliver {
                    from,
                    to,
                    epoch: Some(epoch),
                    bytes,
                    obj,
                },
            ),
            Fate::Reset | Fate::Lost => {
                let lat = self.net.cfg.latency_ms.1;
                self.queue
                    .push(now + 1, Item::To(from, Ev::Closed { peer: to }));
                self.queue
                    .push(now + lat, Item::To(to, Ev::Closed { peer: from }));
            }
        }
    }

    /// Send a datagram (unary request/response): independent loss, reordering,
    /// duplication.
    pub fn send_unary(&mut self, from: ActorId, to: ActorId, bytes: Vec<u8>) {
        let now = self.machine_now(from).max(self.now());
        if let Fate::Deliver { at, dup_at, .. } = self.net.send_datagram(now, from, to) {
            if let Some(d) = dup_at {
                self.queue.push(
                    d,
                    Item::Deliver {
                        from,
                        to,
                        epoch: None,
                        bytes: bytes.clone(),
                        obj: None,
                    },
                );
            }
            self.queue.push(
                at,
                Item::Deliver {
                    from,
                    to,
                    epoch: None,
                    bytes,
                    obj: None,
                },
            );
        }
    }

    /// Partition `a` for `len` ms; its peers see their connections close.
    pub fn partition(&mut self, a: ActorId, len: u64) {
        let until = self.now() + len;
        self.net.partition(a, until);
        self.log(
            self.name(a).to_string().as_str(),
            &format!("PARTITION {len}ms"),
        );
        self.notify_closed(a);
    }

    fn notify_closed(&mut self, a: ActorId) {
        let peers: Vec<ActorId> = self
            .peers
            .iter()
            .filter_map(|(x, y)| {
                if *x == a {
                    Some(*y)
                } else if *y == a {
                    Some(*x)
                } else {
                    None
                }
            })
            .collect();
        for p in peers {
            self.net.reset(a, p);
            self.at(p, 1, Ev::Closed { peer: a });
            self.at(a, 1, Ev::Closed { peer: p });
        }
    }

    /// Crash actor `a` now and restart it after a delay.
    pub fn crash(&mut self, a: ActorId) {
        if self.down.contains(&a) {
            return;
        }
        self.down.insert(a);
        self.dispatch(a, Ev::Crash);
        self.notify_closed(a);
        let d = self
            .rng
            .between(self.chaos.restart_ms.0, self.chaos.restart_ms.1);
        self.at(a, d.max(1), Ev::Restart);
    }

    /// Stop actor `a` for good: its process dies and never restarts (a device
    /// that was lost, wiped or replaced). Its state stays readable.
    pub fn retire(&mut self, a: ActorId) {
        self.log(self.name(a).to_string().as_str(), "RETIRED");
        self.retired.insert(a);
        self.crashable.retain(|x| *x != a);
        self.partitionable.retain(|x| *x != a);
        if self.down.insert(a) {
            self.dispatch(a, Ev::Crash);
            self.notify_closed(a);
        }
    }

    /// The actor's process was found crashed (by a syscall hook) during its own
    /// handler: treat it as a crash.
    pub fn crashed_in_call(&mut self, a: ActorId) {
        if self.down.contains(&a) {
            return;
        }
        self.down.insert(a);
        self.notify_closed(a);
        let d = self
            .rng
            .between(self.chaos.restart_ms.0, self.chaos.restart_ms.1);
        self.at(a, d.max(1), Ev::Restart);
    }

    /// Power loss on machine `m`: disk and stores revert, local processes and every
    /// actor on the machine die; actors restart after a delay.
    pub fn power_loss(&mut self, m: usize) {
        let mref = self.machines[m].clone();
        let changed = {
            let mut mm = mref.borrow_mut();
            mm.tick();
            let mut r = self.rng.fork(&format!("power/{}", self.now()));
            let ch = mm
                .disk
                .power_loss(&mut r, self.chaos.p_torn, self.chaos.p_new);
            let names: Vec<String> = mm.kv.keys().cloned().collect();
            for n in names {
                if let Some(kv) = mm.kv.get_mut(&n) {
                    kv.power_loss(&mut r);
                }
            }
            mm.handles.clear();
            ch
        };
        let mname = mref.borrow().name.clone();
        self.log(&mname, &format!("POWER LOSS changed={}", changed.len()));
        self.hosts[m].borrow_mut().power_loss(&mref);
        let on: Vec<ActorId> = (0..self.actors.len() as ActorId)
            .filter(|a| {
                self.actors[*a as usize]
                    .as_ref()
                    .is_some_and(|x| x.machine() == Some(m))
            })
            .collect();
        for a in on {
            if self.down.insert(a) {
                self.dispatch(a, Ev::PowerLoss);
                self.notify_closed(a);
                let d = self
                    .rng
                    .between(self.chaos.restart_ms.0, self.chaos.restart_ms.1);
                self.at(a, d.max(1), Ev::Restart);
            }
        }
    }

    fn dispatch(&mut self, to: ActorId, ev: Ev) {
        let Some(mut a) = self.actors.get_mut(to as usize).and_then(Option::take) else {
            return;
        };
        if matches!(ev, Ev::Restart) {
            if self.retired.contains(&to) {
                self.actors[to as usize] = Some(a);
                return;
            }
            self.down.remove(&to);
        }
        a.handle(self, ev);
        self.actors[to as usize] = Some(a);
    }

    fn schedule_chaos(&mut self) {
        if self.chaos.crash_every_ms > 0 && !self.crashable.is_empty() {
            let d = self.rng.bursty(self.chaos.crash_every_ms * 2);
            self.queue.push(self.now() + d, Item::ChaosCrash);
        }
        if self.chaos.partition_every_ms > 0 && !self.partitionable.is_empty() {
            let d = self.rng.bursty(self.chaos.partition_every_ms * 2);
            self.queue.push(self.now() + d, Item::ChaosPartition);
        }
    }

    fn step(&mut self, item: Item) {
        match item {
            Item::To(to, ev) => {
                if self.down.contains(&to) && !matches!(ev, Ev::Restart) {
                    return;
                }
                self.dispatch(to, ev)
            }
            Item::Deliver {
                from,
                to,
                epoch,
                bytes,
                obj,
            } => {
                let now = self.now();
                if self.down.contains(&to) || self.down.contains(&from) {
                    return;
                }
                let ok = match epoch {
                    Some(e) => self.net.deliverable(now, from, to, e),
                    None => !self.net.partitioned(to, now),
                };
                if ok {
                    self.dispatch(to, Ev::Msg { from, bytes, obj });
                }
            }
            Item::ChaosCrash => {
                if !self.shared.chaos.get() {
                    return;
                }
                let a = self.crashable[self.rng.index(self.crashable.len())];
                let m = self.actors[a as usize].as_ref().and_then(|x| x.machine());
                if let Some(m) = m
                    && self.rng.chance(self.chaos.p_power)
                {
                    self.power_loss(m);
                } else if !self.down.contains(&a) {
                    self.log(self.name(a).to_string().as_str(), "CRASH (chaos)");
                    self.crash(a);
                }
                let d = self.rng.bursty(self.chaos.crash_every_ms * 2);
                self.queue.push(self.now() + d, Item::ChaosCrash);
            }
            Item::ChaosPartition => {
                if !self.shared.chaos.get() {
                    return;
                }
                let a = self.partitionable[self.rng.index(self.partitionable.len())];
                let len = self
                    .rng
                    .between(self.chaos.partition_ms.0, self.chaos.partition_ms.1);
                self.partition(a, len);
                let d = self.rng.bursty(self.chaos.partition_every_ms * 2);
                self.queue.push(self.now() + d, Item::ChaosPartition);
            }
        }
    }

    /// Run events until world time `until`.
    pub fn run_until(&mut self, until: u64) {
        while !self.stop {
            let tg = self.queue.peek_time();
            let mut tm: Option<(u64, usize)> = None;
            for (i, m) in self.machines.iter().enumerate() {
                if let Some(t) = m.borrow().queue.peek_time()
                    && tm.is_none_or(|(b, _)| t < b)
                {
                    tm = Some((t, i));
                }
            }
            let local_first = match (tg, tm) {
                (None, None) => break,
                (Some(g), Some((l, _))) => l < g,
                (None, Some(_)) => true,
                (Some(_), None) => false,
            };
            if local_first {
                let (t, i) = tm.expect("some");
                if t > until {
                    break;
                }
                if t > self.now() {
                    self.time.set(t);
                }
                let m = self.machines[i].clone();
                let host = self.hosts[i].clone();
                let now = m.borrow().now();
                host.borrow_mut().pump(&m, now.max(t));
            } else {
                let t = tg.expect("some");
                if t > until {
                    break;
                }
                let (t, item) = self.queue.pop().expect("peeked");
                // An actor whose machine is running ahead (a stalled process) gets
                // its events when the machine catches up.
                if let Item::To(a, _) | Item::Deliver { to: a, .. } = &item {
                    let ahead = self.machine_now(*a);
                    if ahead > t && ahead > self.now() {
                        self.queue.push(ahead, item);
                        continue;
                    }
                }
                if t > self.now() {
                    self.time.set(t);
                }
                self.step(item);
            }
            self.drain_machine_traces();
        }
        if until > self.now() {
            self.time.set(until);
        }
    }

    fn drain_machine_traces(&mut self) {
        for m in &self.machines {
            let (lines, detail) = {
                let mut mm = m.borrow_mut();
                (
                    std::mem::take(&mut mm.trace),
                    std::mem::take(&mut mm.detail),
                )
            };
            let mut tr = self.shared.trace.borrow_mut();
            for l in lines {
                tr.push(l);
            }
            for l in detail {
                tr.detail(l);
            }
        }
    }

    /// Run with chaos on for `ms`.
    pub fn run_chaos(&mut self, ms: u64) {
        self.shared.chaos.set(true);
        self.schedule_chaos();
        let end = self.now() + ms;
        self.run_until(end);
        self.shared.chaos.set(false);
    }

    /// Chaos off, heal, restart everyone, and run until every actor is settled for
    /// `stable_rounds` consecutive rounds of `round_ms`, or `max_ms` passes.
    /// Returns true if settled.
    pub fn quiesce(&mut self, round_ms: u64, stable_rounds: u32, max_ms: u64) -> bool {
        self.shared.chaos.set(false);
        self.net.heal();
        self.log("world", "QUIESCE");
        for i in 0..self.machines.len() {
            let m = self.machines[i].clone();
            let h = self.hosts[i].clone();
            h.borrow_mut().quiesce(&m);
        }
        let downs: Vec<ActorId> = self.down.difference(&self.retired).copied().collect();
        for a in downs {
            self.at(a, 1, Ev::Restart);
        }
        for a in 0..self.actors.len() as ActorId {
            if let Some(mut x) = self.actors[a as usize].take() {
                x.quiesce(self);
                self.actors[a as usize] = Some(x);
            }
        }
        let end = self.now() + max_ms;
        let mut stable = 0;
        while self.now() < end && !self.stop {
            let t = self.now() + round_ms;
            self.run_until(t);
            let locals_settled = self.hosts.iter().all(|h| {
                h.borrow()
                    .procs
                    .iter()
                    .all(|p| p.as_ref().is_none_or(|p| p.settled()))
            });
            let settled = self.down.is_subset(&self.retired)
                && locals_settled
                && self
                    .actors
                    .iter()
                    .enumerate()
                    .filter(|(i, _)| !self.retired.contains(&(*i as ActorId)))
                    .all(|(_, a)| a.as_ref().is_none_or(|a| a.settled(self)));
            if settled {
                stable += 1;
                if stable >= stable_rounds {
                    return true;
                }
            } else {
                stable = 0;
            }
        }
        false
    }

    /// A log service takes part: its tap must scan something by the end.
    pub fn expect_log_service(&self) {
        self.shared.tap.borrow_mut().expected = true;
    }

    /// The log service received `bytes` (a whole inbound frame, an object body, a
    /// stream message). Every log-service actor calls this for everything it gets.
    pub fn log_ingress(&self, what: &str, bytes: &[u8]) {
        self.shared
            .tap
            .borrow_mut()
            .scan_path(Party::LogService, "request", what, bytes);
    }

    /// The log service received or stores `bytes` on a named path (per-path counts).
    pub fn log_path(&self, path: &str, what: &str, bytes: &[u8]) {
        self.shared
            .tap
            .borrow_mut()
            .scan_path(Party::LogService, path, what, bytes);
    }

    /// The log service stores or emits `bytes` (final state, error strings, logs).
    pub fn log_state(&self, what: &str, bytes: &[u8]) {
        self.shared
            .tap
            .borrow_mut()
            .scan_path(Party::LogService, "state", what, bytes);
    }

    /// A private scenario exercises this party: at least one scan is required.
    pub fn expect_untrusted_party(&self, party: Party) {
        self.shared.tap.borrow_mut().require_party(party);
    }

    /// Bytes actually received, stored or emitted by an untrusted party.
    /// Call at the transport boundary, never on the device's plaintext side.
    pub fn untrusted_bytes(&self, party: Party, what: &str, bytes: &[u8]) {
        self.shared.tap.borrow_mut().scan(party, what, bytes);
    }

    /// A private collection's hosted replica holds `bytes`: no plaintext or keys allowed.
    pub fn hosted_private_state(&self, what: &str, bytes: &[u8]) {
        self.shared
            .tap
            .borrow_mut()
            .scan(Party::HostedPrivate, what, bytes);
    }

    /// Finish: collect violations, counters and the digest. The untrusted-party
    /// oracles run here for every scenario.
    pub fn report(&self, scenario: &str, state: String) -> Report {
        {
            let tap = self.shared.tap.borrow();
            for h in &tap.hits {
                self.shared.violate(h.kind, h.detail.clone());
            }
            for party in tap.unscanned_parties() {
                self.shared.violate(
                    Kind::Plaintext,
                    format!(
                        "{} took part but its tap scanned nothing: the oracle would be vacuous",
                        party.name()
                    ),
                );
            }
            for (party, count) in &tap.per_party {
                self.shared
                    .count(&format!("tap.party.{}", party.name()), *count);
            }
            for p in tap.unscanned() {
                self.shared.violate(
                    Kind::Plaintext,
                    format!("tap path {p} was exercised but never scanned: the oracle would be vacuous there"),
                );
            }
            for (p, n) in &tap.per_path {
                self.shared.count(&format!("tap.path.{p}"), *n);
            }
            self.shared.count("tap.scanned", tap.scanned);
            self.shared.count("tap.secrets", tap.secrets.len() as u64);
            self.shared.count("tap.inflated", tap.inflated);
        }
        let mut counters = self.shared.counters.borrow().clone();
        // Hold rate: every hold left on any replica, by cause, against every
        // write the scenario made (each write mints one token).
        for a in self.actors.iter().flatten() {
            for reason in a.holds() {
                *counters.entry(format!("hold.{reason}")).or_default() += 1;
                *counters.entry("hold.total".into()).or_default() += 1;
            }
        }
        *counters.entry("writes.minted".into()).or_default() +=
            self.shared.tokens.borrow().minted();
        for h in &self.hosts {
            let h = h.borrow();
            *counters.entry("hook.stalls".into()).or_default() += h.stalls;
            *counters.entry("hook.interleavings".into()).or_default() += h.interleavings;
            *counters.entry("hook.crashes".into()).or_default() += h.syscall_crashes;
        }
        for m in &self.machines {
            let m = m.borrow();
            *counters.entry("disk.power_losses".into()).or_default() += m.disk.stats.power_losses;
            *counters.entry("disk.torn".into()).or_default() += m.disk.stats.torn;
        }
        *counters.entry("net.lost".into()).or_default() += self.net.stats.lost;
        *counters.entry("net.resets".into()).or_default() += self.net.stats.resets;
        let mut tr = self.shared.trace.borrow_mut();
        tr.digest.str(&state);
        Report {
            scenario: scenario.into(),
            seed: self.seed,
            violations: self.shared.violations.borrow().clone(),
            digest: tr.digest.0,
            state,
            counters,
            trace: std::mem::take(&mut tr.lines),
        }
    }
}
