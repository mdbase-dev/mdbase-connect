//! Catching up inside deferred-durability windows, crashed at every point.
//!
//! A device applies the entries of one read page inside one deferred-durability
//! window: one durable commit a page instead of one an entry. This scenario
//! checks that a crash anywhere in that leaves the device where per-entry
//! commits would have.
//!
//! Device B goes offline with a write of its own still pending while A writes
//! on, with a control item (a device revocation) in the middle. B then comes
//! back and catches up over several short pages, publishes every record to its
//! folder and appends its pending write. The run is repeated with B's process
//! crashed at each numbered point of that catch-up (see [`CrashPlan`]): before
//! and after every store commit, at the edges of every window (including after
//! the last entry of a page is applied and before the window closes), at every
//! file-system call that changes the folder, and after every batch of outputs
//! leaves the process. A crash inside a window loses the window's commits, as
//! the native index does.
//!
//! Every run must end in the state of the reference run, whose store declines
//! windows (every commit durable on its own): the same head, records, folder
//! contents and log, and nothing pending. A file published from state that a
//! crash then rolled back would be read as an external edit at the next open
//! and show up as a different log.

use std::cell::RefCell;
use std::rc::Rc;

use mdbn_replica::mem::MemData;
use mdbn_replica::testkit::TestControlPlane;
use mdbn_wire::common::B16;
use mdbn_wire::policy::CState;

use crate::oracle::Kind;
use crate::platform::{Hook, HookAction, MachineRef, Os};
use crate::sut::fault_store::CrashPlan;
use crate::sut::logsvc::{FLUSH_PUSHES, LogService, item_kind};
use crate::sut::node::{Node, NodeCfg, WRITE_ONCE};
use crate::world::{HookCfg, World};

/// Items per read: a catch-up of a few dozen entries takes several pages.
const PAGE: u64 = 8;

/// How the catching-up device commits, and where it crashes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// The store declines windows: every commit is durable on its own.
    PerItem,
    /// Windows, no crash.
    Window,
    /// Windows, crashed at this point of the catch-up (1-based).
    CrashAt(u64),
}

impl Mode {
    /// `catchup-per-item`, `catchup-window`, `catchup-window-crash-<point>`.
    pub fn parse(name: &str) -> Option<Mode> {
        match name {
            "catchup-per-item" => Some(Mode::PerItem),
            "catchup-window" => Some(Mode::Window),
            n => n
                .strip_prefix("catchup-window-crash-")?
                .parse()
                .ok()
                .filter(|point| *point > 0)
                .map(Mode::CrashAt),
        }
    }
}

/// The catching-up process's file-system calls that change the folder are
/// crash points too. None may happen while a window is open.
struct FolderWrites {
    inner: Rc<RefCell<dyn Hook>>,
    plan: Rc<RefCell<CrashPlan>>,
    index: Rc<RefCell<MemData>>,
    in_window: Rc<RefCell<u64>>,
    process: String,
}

impl Hook for FolderWrites {
    fn before(&mut self, m: &MachineRef, proc: &str, op: &str, path: &str) -> HookAction {
        let kind = match op {
            "list" | "read" | "stat" => None,
            _ if !proc.starts_with(&self.process) => None,
            "fsync" | "fsync_dir" | "syncfs" => Some("folder sync"),
            _ => Some("folder write"),
        };
        if let Some(kind) = kind {
            let in_window = self.index.borrow().deferred;
            if in_window && self.plan.borrow().armed {
                *self.in_window.borrow_mut() += 1;
            }
            if self.plan.borrow_mut().hit(kind, in_window) {
                return HookAction::Crash;
            }
        }
        self.inner.borrow_mut().before(m, proc, op, path)
    }
}

/// Run the catch-up in `mode`. The returned state is the final head, records,
/// folder contents, pending count and log, comparable across modes.
pub fn run(w: &mut World, mode: Mode) -> String {
    let collection = B16([0xc9; 16]);
    let (writer, reader, victim) = (B16([0x20; 16]), B16([0x21; 16]), B16([0x22; 16]));
    let devices = vec![writer, reader, victim];
    w.expect_log_service();
    w.chaos.restart_ms = (200, 500);
    let ma = w.add_machine("ma", Os::Linux, HookCfg::default());
    let mb = w.add_machine("mb", Os::Linux, HookCfg::default());
    let svc = w.spawn(Box::new(LogService::new(vec![collection])));
    let mut cp = TestControlPlane::new(collection);
    if let Some(ls) = w.actor_mut::<LogService>(svc) {
        ls.read_page = Some(PAGE);
        cp.bootstrap(&ls.svc, CState::E2e, &devices);
    }
    let plan = Rc::new(RefCell::new(CrashPlan {
        at: match mode {
            Mode::CrashAt(point) => Some(point),
            _ => None,
        },
        ..CrashPlan::default()
    }));
    let cfg = |i: u8, work: bool| NodeCfg {
        collection,
        replica_id: B16([0x10 + i; 16]),
        device: devices[usize::from(i)],
        work,
        work_every_ms: 60,
        reconnect_storm: false,
        snapshot_every: None,
        trusted: devices.clone(),
        keys: None,
    };
    let me = w.actor_count() as u32;
    let a = w.spawn(Box::new(Node::new("A", ma, me, svc, cfg(0, true))));
    let me = w.actor_count() as u32;
    let node = Node::new("B", mb, me, svc, cfg(1, false))
        .with_crash_plan(plan.clone())
        .with_per_item_commits(mode == Mode::PerItem);
    let index = node.store_data();
    let b = w.spawn(Box::new(node));
    let folder_writes_in_window = Rc::new(RefCell::new(0));
    {
        let mut machine = w.machines[mb].borrow_mut();
        if let Some(inner) = machine.hook.take() {
            machine.hook = Some(Rc::new(RefCell::new(FolderWrites {
                inner,
                plan: plan.clone(),
                index: index.clone(),
                in_window: folder_writes_in_window.clone(),
                process: "B#".into(),
            })));
        }
    }

    // Both devices follow the log live.
    w.run_chaos(600);
    // B goes offline and writes; A writes on, around a control item.
    w.partition(b, 3_600_000);
    w.timer(b, 100, WRITE_ONCE);
    w.run_chaos(1_300);
    let control = match w.actor::<LogService>(svc) {
        Some(ls) => cp.revoke(&ls.svc, victim),
        None => 0,
    };
    w.timer(svc, 0, FLUSH_PUSHES);
    w.run_chaos(1_300);
    // A's client stops with the chaos; let its last appends land.
    let t = w.now() + 1_000;
    w.run_until(t);

    let head = |w: &World, n: u32| {
        w.actor::<Node>(n)
            .and_then(Node::replica)
            .map(|r| r.head().seq)
    };
    let log_head = |w: &World| {
        w.actor::<LogService>(svc)
            .map_or(0, |s| s.svc.head(&collection).0)
    };
    let behind = head(w, b).unwrap_or(0);
    let pending = w
        .actor::<Node>(b)
        .and_then(Node::replica)
        .map_or(0, |r| r.sync_status().pending);
    let target = log_head(w);
    w.shared
        .count("catchup.items", target.saturating_sub(behind));
    w.shared.count("catchup.pending_before", pending);
    if target < behind + 4 * PAGE || !(behind < control && control < target) || pending == 0 {
        w.shared.violate(
            Kind::Bug,
            format!(
                "vacuous catch-up: B at {behind}, log at {target}, control item at {control}, \
                 {pending} pending"
            ),
        );
    }
    let windows_before = index.borrow().windows.0;

    // B comes back: catch up, publish, append its own write.
    plan.borrow_mut().armed = true;
    w.net.heal();
    let t = w.now() + 6_000;
    w.run_until(t);
    if !w.quiesce(200, 5, 60_000) {
        w.shared.violate(
            Kind::NoQuiesce,
            format!("B did not settle: head {:?} of {}", head(w, b), log_head(w)),
        );
    }
    plan.borrow_mut().armed = false;

    {
        let plan = plan.borrow();
        w.shared.count("catchup.points", plan.seen);
        for (kind, n) in &plan.kinds {
            w.shared.count(&format!("catchup.points.{kind}"), *n);
        }
        w.shared
            .count("catchup.crashed", u64::from(plan.crashed_at.is_some()));
        if let Some(kind) = plan.crashed_at {
            w.shared.count(&format!("catchup.crashed_at.{kind}"), 1);
            w.shared.count(
                "catchup.crashed_in_window",
                u64::from(plan.crashed_in_window),
            );
        }
        if matches!(mode, Mode::CrashAt(_)) && plan.crashed_at.is_none() {
            w.shared.violate(
                Kind::Bug,
                format!("{mode:?}: the catch-up has only {} points", plan.seen),
            );
        }
    }
    // Without a crash the index is never rolled back, so its counter is whole.
    if !matches!(mode, Mode::CrashAt(_)) {
        w.shared
            .count("catchup.windows", index.borrow().windows.0 - windows_before);
    }
    let in_window = *folder_writes_in_window.borrow();
    if in_window > 0 {
        w.shared.violate(
            Kind::Bug,
            format!("{in_window} folder changes while a window was open"),
        );
    }

    let items = w
        .actor::<LogService>(svc)
        .map(|s| s.svc.items(&collection))
        .unwrap_or_default();
    for (i, item) in items.iter().enumerate() {
        w.log_state(&format!("stored item {}", i + 1), item);
    }
    let checked = super::slice::check(w, &[a, b], items.len() as u64);

    let digest = |parts: &mut dyn Iterator<Item = Vec<u8>>| {
        let mut all = Vec::new();
        let mut n = 0u64;
        for part in parts {
            all.extend((part.len() as u64).to_be_bytes());
            all.extend(part);
            n += 1;
        }
        format!("{n}:{}", &mdbn_wire::hash::sha256(&all).to_hex()[..16])
    };
    let (head, records) = w
        .actor::<Node>(b)
        .and_then(Node::digest)
        .unwrap_or((mdbn_replica::store::Head::GENESIS, Vec::new()));
    let records = digest(&mut records.iter().flat_map(|r| {
        [
            r.id.0.to_vec(),
            r.path.clone().into_bytes(),
            r.doc.as_bytes().to_vec(),
        ]
    }));
    let folder = {
        let machine = w.machines[mb].borrow();
        let files: Vec<(String, Vec<u8>)> = machine
            .disk
            .names
            .keys()
            .filter(|p| !p.starts_with(".mdbase"))
            .map(|p| (p.clone(), machine.disk.read(p).unwrap_or_default().to_vec()))
            .collect();
        digest(
            &mut files
                .into_iter()
                .flat_map(|(p, bytes)| [p.into_bytes(), bytes]),
        )
    };
    let pending = w
        .actor::<Node>(b)
        .and_then(Node::replica)
        .map_or(u64::MAX, |r| r.sync_status().pending);
    let kinds = items.iter().map(|i| item_kind(i)).collect::<Vec<_>>();
    let entries = kinds.iter().filter(|k| **k == "entry").count();
    // What was sent to the log, apart from what a restarted process draws
    // anew: an item sealed after a restart has a fresh salt, and so does the
    // chain over it.
    let log = digest(&mut items.iter().map(|bytes| {
        use mdbn_wire::schema::Wire;
        match mdbn_wire::envelope::Item::from_bytes(bytes) {
            Ok(mut item) => {
                item.salt = None;
                item.prev = None;
                item.to_bytes().unwrap_or_default()
            }
            Err(_) => bytes.clone(),
        }
    }));
    format!(
        "head {}; records {records}; folder {folder}; pending {pending}; \
         log {log} ({entries} entries); {checked}",
        head.seq,
    )
}
