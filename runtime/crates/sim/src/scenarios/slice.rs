//! `slice` / `slice-chaos`: simulated multi-device workloads.
//!
//! Two devices, each running the real replica engine over the real file store
//! on its own simulated Linux machine, and one log service. Their in-process
//! clients create, update and rename records during the run, and the records
//! are published as files. `slice` restarts device B once, mid-run, on a calm
//! network. `slice-chaos` adds process crashes at any syscall, power loss,
//! partitions, a lossy network and stalls.
//!
//! Oracles, after quiescence:
//! - **no lost acknowledged write:** every mutation a client saw confirmed at
//!   `seq` is recorded at `seq` on every replica;
//! - **no lost accepted write:** a mutation accepted as pending whose receipt the
//!   client never saw (its process died) is in the log or still pending, never
//!   gone;
//! - **no lost token:** every token of a non-rejected write is in the converged
//!   state (adds are unions, no deletes in this workload);
//! - **convergence:** identical heads and record sets on both replicas;
//! - **files:** each replica's folder holds exactly its confirmed records;
//! - **untrusted-party tap:** everything the log service received or stores.
//!   The engine uses `PlainSealer` in this scenario,
//!   so this oracle **fires**; the scenario is not included in the sweep.

use mdbn_wire::common::B16;

use crate::net::NetConfig;
use crate::oracle::{Kind, tokens_in};
use crate::platform::Os;
use crate::sut::logsvc::{Adversary, LogService};
use crate::sut::node::{Node, NodeCfg, confirmed_tokens};
use crate::world::{Chaos, HookCfg, World};

/// Run. `chaos`: crashes, power loss, partitions and a lossy network.
pub fn run(w: &mut World, chaos: bool, storm: bool) -> String {
    run_with(w, chaos, storm, Adversary::default())
}

/// [`run`] against a lying log service.
pub fn run_with(w: &mut World, chaos: bool, storm: bool, adv: Adversary) -> String {
    let collection = B16([0xc0; 16]);
    w.expect_log_service();
    {
        let mut tap = w.shared.tap.borrow_mut();
        // Frontmatter field names, body text and the folder; record IDs and
        // paths are added by the nodes as they create them.
        for m in ["title", "status", "tags", "Body ", "notes/"] {
            tap.marker(&format!("field or text {m:?}"), m.as_bytes());
        }
        // Paths this scenario exercises: each must be scanned at least once.
        for p in [
            "request",
            "item:entry",
            "stored:item:entry",
            "stored:item:policy",
        ] {
            tap.require(p);
        }
    }
    let hook = if chaos {
        HookCfg {
            p_interleave: 0,
            p_stall: 5_000,
            stall_max_ms: 2_000,
            p_crash: 300,
        }
    } else {
        HookCfg::default()
    };
    let ma = w.add_machine("ma", Os::Linux, hook);
    let mb = w.add_machine("mb", Os::Linux, hook);
    if chaos {
        w.net.cfg = NetConfig::lossy();
        w.chaos = Chaos {
            crash_every_ms: 4_000,
            p_power: 300_000,
            p_torn: 300_000,
            p_new: 300_000,
            restart_ms: (100, 2_000),
            partition_every_ms: 6_000,
            partition_ms: (200, 4_000),
        };
    } else {
        w.chaos.restart_ms = (200, 500);
    }
    let svc = w.spawn(Box::new(LogService::new(vec![collection])));
    // Genesis and the initial rekey for both devices (a test control plane).
    let devices = vec![B16([0x20; 16]), B16([0x21; 16])];
    if let Some(ls) = w.actor_mut::<LogService>(svc) {
        ls.adversary = adv;
        mdbn_replica::testkit::TestControlPlane::new(collection).bootstrap(
            &ls.svc,
            mdbn_wire::policy::CState::E2e,
            &devices,
        );
    }
    let mut nodes = Vec::new();
    for (i, (m, name)) in [(ma, "A"), (mb, "B")].into_iter().enumerate() {
        let me = w.actor_count() as u32;
        let cfg = NodeCfg {
            collection,
            replica_id: B16([0x10 + i as u8; 16]),
            device: B16([0x20 + i as u8; 16]),
            work: true,
            work_every_ms: 150,
            reconnect_storm: storm,
            snapshot_every: None,
            trusted: devices.clone(),
            keys: None,
        };
        let id = w.spawn(Box::new(Node::new(name, m, me, svc, cfg)));
        w.crashable.push(id);
        w.partitionable.push(id);
        nodes.push(id);
    }
    if chaos {
        w.run_chaos(20_000);
    } else {
        w.run_chaos(8_000);
        w.log("world", "scripted restart of B");
        w.crash(nodes[1]);
        w.run_chaos(8_000);
    }
    if !w.quiesce(200, 5, 60_000) {
        let detail = nodes
            .iter()
            .map(|n| {
                let x = w.actor::<Node>(*n);
                format!(
                    "{}: up={} pending={:?}",
                    w.name(*n),
                    x.is_some_and(|x| x.replica().is_some()),
                    x.and_then(|x| x.replica().map(|r| r.sync_status().pending))
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        w.shared.violate(Kind::NoQuiesce, detail);
    }
    if let Some(s) = w.actor_mut::<LogService>(svc) {
        let items = s.svc.items(&collection);
        let objects = s.svc.objects(&collection);
        for (i, it) in items.iter().enumerate() {
            w.log_state(&format!("stored item {}", i + 1), it);
        }
        for (a, b) in objects {
            w.log_state(&format!("stored object {}", a.to_hex()), &b);
        }
    }
    let svc_head = w
        .actor::<LogService>(svc)
        .map_or(0, |s| s.svc.head(&collection).0);
    check(w, &nodes, svc_head)
}

/// Which lie the log service tells.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lie {
    /// None: the honest baseline.
    Honest,
    /// False `duplicate` replies.
    FalseDuplicate,
    /// Control items withheld from control-only reads.
    WithholdControl,
}

/// `slice-adv-dup`: the chaos slice against a log service that answers some
/// appends (10%) with a false `duplicate` (an existing position holding another
/// mutation). The replica must confirm only after reading its own item there
/// no lost ack, no wrong ack, everything eventually appended.
pub fn run_false_duplicate(w: &mut World) -> String {
    let state = run_with(
        w,
        true,
        false,
        Adversary {
            p_false_duplicate: 100_000,
            ..Adversary::default()
        },
    );
    let svc = w.actors_of::<LogService>()[0];
    let n = w
        .actor::<LogService>(svc)
        .map_or(0, |s| s.attacks.false_duplicates);
    w.shared.count("adversary.false_duplicates", n);
    let chances = w
        .actor::<LogService>(svc)
        .map_or(0, |s| s.attacks.dup_opportunities);
    if n == 0 && chances > 0 {
        w.shared.violate(
            Kind::Bug,
            "the adversary had chances but never lied: the scenario is vacuous".into(),
        );
    }
    if chances == 0 {
        // Every append landed before a false duplicate was possible.
        w.shared.count("adversary.no_opportunity", 1);
    }
    state
}

/// `slice-snapshot` / `slice-adv-withhold`: device A works with frequent
/// snapshots; the log is then compacted, and device B (enrolled, never run)
/// joins behind retention and must install the snapshot.
///
/// - Honest: B installs, reads the tail and converges with A.
/// - Withheld control items: the log service drops control items from
///   control-only reads. B must recompute the manifest's control chain from the
///   control items it reads, find the mismatch and refuse the install. Installing
///   anyway is an `undetected-attack`.
pub fn run_snapshot(w: &mut World, lie: Lie) -> String {
    let collection = B16([0xc7; 16]);
    w.expect_log_service();
    w.shared.tap.borrow_mut().require("object:manifest");
    let ma = w.add_machine("ma", Os::Linux, HookCfg::default());
    let mb = w.add_machine("mb", Os::Linux, HookCfg::default());
    w.chaos.restart_ms = (200, 500);
    let svc = w.spawn(Box::new(LogService::new(vec![collection])));
    let devices = [B16([0x20; 16]), B16([0x21; 16])];
    if let Some(ls) = w.actor_mut::<LogService>(svc) {
        let mut cp = mdbn_replica::testkit::TestControlPlane::new(collection);
        cp.bootstrap(&ls.svc, mdbn_wire::policy::CState::E2e, &devices);
        // An otherwise harmless signed control item after key delivery. Hiding
        // it must fail the control-chain check, not merely leave B without keys.
        cp.append(
            &ls.svc,
            vec![mdbn_wire::policy::PolicyOp::Freeze(
                mdbn_wire::policy::Freeze {
                    frozen: false,
                    reason: None,
                },
            )],
        );
    }
    if lie == Lie::WithholdControl
        && let Some(ls) = w.actor_mut::<LogService>(svc)
    {
        ls.adversary.withhold_control = true;
    }
    let cfg = |i: u8, work: bool| NodeCfg {
        collection,
        replica_id: B16([0x10 + i; 16]),
        device: devices[i as usize],
        work,
        work_every_ms: 100,
        reconnect_storm: false,
        snapshot_every: Some(25),
        trusted: devices.to_vec(),
        keys: None,
    };
    let me = w.actor_count() as u32;
    let a = w.spawn(Box::new(Node::new("A", ma, me, svc, cfg(0, true))));
    w.run_chaos(10_000);
    if !w.quiesce(200, 5, 30_000) {
        w.shared.violate(Kind::NoQuiesce, "A did not settle".into());
    }
    // Compact everything but a short tail.
    let head = w
        .actor::<LogService>(svc)
        .map_or(0, |s| s.svc.head(&collection).0);
    let built = w
        .actor::<Node>(a)
        .and_then(|n| n.replica().map(|r| r.stats.snapshots_built))
        .unwrap_or(0);
    w.shared.count("snapshot.built", built);
    // Compact through the latest snapshot (never past it: snapshot.md §5).
    let snap = w.actor::<LogService>(svc).and_then(|s| {
        use mdbn_replica::log::{LogClient, LogRequest, LogResponse};
        let mut obs = s.svc.client(B16([0xee; 16]));
        match obs.call(LogRequest::GetSnapshot { collection }) {
            Ok(LogResponse::GetSnapshot(ps)) => ps.iter().map(|p| p.seq).max(),
            _ => None,
        }
    });
    let upto = snap.unwrap_or(0);
    if let Some(s) = w.actor::<LogService>(svc) {
        s.svc.compact(&collection, upto);
    }
    w.log(
        "world",
        &format!("log compacted through {upto} (head {head})"),
    );
    let me = w.actor_count() as u32;
    let b = w.spawn(Box::new(Node::new("B", mb, me, svc, cfg(1, false))));
    let settled = w.quiesce(200, 5, 30_000);
    let installed = w
        .actor::<Node>(b)
        .and_then(|n| n.replica().map(|r| r.stats.snapshots_installed))
        .unwrap_or(0);
    w.shared.count("snapshot.installed", installed);
    let withheld = w
        .actor::<LogService>(svc)
        .map_or(0, |s| s.attacks.withheld_reads);
    w.shared.count("adversary.withheld_reads", withheld);
    let control_items = w.actor::<LogService>(svc).map_or(0, |s| {
        s.svc
            .items(&collection)
            .iter()
            .filter(|i| {
                !matches!(
                    crate::sut::logsvc::item_kind(i),
                    "entry" | "undecodable" | "other"
                )
            })
            .count()
    });
    w.shared.count("log.control_items", control_items as u64);
    match lie {
        Lie::WithholdControl => {
            let refused_chain = w.actor::<Node>(b).and_then(Node::replica).is_some_and(|r| {
                r.sync_status().incidents.iter().any(|incident| {
                    incident.kind == mdbn_wire::client::IncidentKind::Integrity
                        && matches!(&incident.details, Some(mdbn_wire::common::Value::Text(s))
                            if s.contains("manifest control chain differs"))
                })
            });
            w.shared
                .count("snapshot.refused_control_chain", u64::from(refused_chain));
            if withheld == 0 || !refused_chain {
                w.shared.violate(
                    Kind::Bug,
                    "the withheld-control run did not demonstrate a control-chain refusal".into(),
                );
            }
            if control_items < 3 {
                w.shared.violate(
                    Kind::Bug,
                    "no control items beyond bootstrap to withhold: the scenario is vacuous".into(),
                );
            }
            if installed > 0 {
                w.shared.violate(
                    Kind::UndetectedAttack,
                    format!(
                        "B installed a snapshot although the log service withheld control items ({withheld} control reads tampered{})",
                        if withheld == 0 { "; B never read control items to check the manifest's control chain" } else { "" }
                    ),
                );
            }
            String::from("withheld")
        }
        _ => {
            if !settled {
                w.shared
                    .violate(Kind::NoQuiesce, "B did not catch up".into());
            }
            if installed == 0 {
                w.shared.violate(
                    Kind::Bug,
                    format!(
                        "B never installed a snapshot (A built {built}): the scenario is vacuous"
                    ),
                );
            }
            if let Some(s) = w.actor_mut::<LogService>(svc) {
                let items = s.svc.items(&collection);
                for (i, it) in items.iter().enumerate() {
                    w.log_state(&format!("stored item {}", i + 1), it);
                }
            }
            let svc_head = w
                .actor::<LogService>(svc)
                .map_or(0, |s| s.svc.head(&collection).0);
            check(w, &[a, b], svc_head)
        }
    }
}

/// `slice-sealed[-chaos]`: one device on the **real** `KeyringSealer`.
///
/// The control plane writes a signed genesis that enrols the device with real
/// Ed25519/X25519 keys. The device performs the initial rekey (HPKE-wrapping the
/// epoch key to itself) and seals every entry. Its user works through crashes,
/// power loss, partitions and a lossy network (`-chaos`). At the end the same
/// device is **restored onto a fresh store on a new machine**: it must unwrap the
/// key from the log, read everything back and converge.
///
/// The tap holds the device's signing seed and KEM secret from the start, and every
/// epoch key the moment a replica mints or learns it, so any of them reaching the
/// log service, raw or encoded, is a `key-exposure` violation. Content markers and
/// tokens catch plaintext, including DEFLATE frames.
pub fn run_sealed(w: &mut World, chaos: bool) -> String {
    let collection = B16([0xc5; 16]);
    w.expect_log_service();
    {
        let mut tap = w.shared.tap.borrow_mut();
        for m in ["title", "status", "tags", "Body ", "notes/"] {
            tap.marker(&format!("field or text {m:?}"), m.as_bytes());
        }
        for p in [
            "request",
            "item:entry",
            "item:rekey",
            "stored:item:entry",
            "stored:item:policy",
            "stored:item:rekey",
        ] {
            tap.require(p);
        }
    }
    let hook = if chaos {
        HookCfg {
            p_interleave: 0,
            p_stall: 5_000,
            stall_max_ms: 2_000,
            p_crash: 300,
        }
    } else {
        HookCfg::default()
    };
    // Establish a real acknowledged write before the adversary starts. The
    // stress phase still runs for the full 20 seconds with unchanged faults.
    let ma = w.add_machine("ma", Os::Linux, HookCfg::default());
    let mr = w.add_machine("mr", Os::Linux, HookCfg::default());
    if !chaos {
        w.chaos.restart_ms = (200, 500);
    }
    // Device keys from the seed (the sim's stand-in for the platform keychain).
    let mut sign = [0u8; 32];
    let mut kem = [0u8; 32];
    for b in sign.iter_mut().chain(kem.iter_mut()) {
        *b = w.rng.below(256) as u8;
    }
    {
        let mut tap = w.shared.tap.borrow_mut();
        tap.secret("device signing seed", &sign);
        tap.secret("device KEM secret", &kem);
    }
    let device = B16([0x30; 16]);
    let svc = w.spawn(Box::new(LogService::new(vec![collection])));
    if let Some(ls) = w.actor_mut::<LogService>(svc) {
        mdbn_replica::testkit::TestControlPlane::signed(collection).genesis_with_keys(
            &ls.svc,
            mdbn_wire::policy::CState::E2e,
            device,
            &sign,
            &kem,
        );
    }
    let cfg = NodeCfg {
        collection,
        replica_id: B16([0x31; 16]),
        device,
        work: true,
        work_every_ms: 150,
        reconnect_storm: false,
        trusted: vec![device],
        snapshot_every: None,
        keys: Some((sign, kem)),
    };
    let me = w.actor_count() as u32;
    let a = w.spawn(Box::new(Node::new("A", ma, me, svc, cfg.clone())));
    w.crashable.push(a);
    w.partitionable.push(a);
    if chaos {
        w.run_chaos(2_000);
        let warm_confirmed = w
            .shared
            .counters
            .borrow()
            .get("slice.confirmed")
            .copied()
            .unwrap_or(0);
        w.shared.count("sealed.warm_confirmed", warm_confirmed);
        if warm_confirmed == 0 {
            w.shared.violate(
                Kind::Bug,
                "sealed workload never established an acknowledged write before chaos".into(),
            );
        }
        w.hosts[ma].borrow_mut().cfg = hook;
        w.net.cfg = NetConfig::lossy();
        w.chaos = Chaos {
            crash_every_ms: 4_000,
            p_power: 300_000,
            p_torn: 300_000,
            p_new: 300_000,
            restart_ms: (100, 2_000),
            partition_every_ms: 6_000,
            partition_ms: (200, 4_000),
        };
        w.run_chaos(20_000);
    } else {
        w.run_chaos(8_000);
        w.log("world", "scripted restart of A");
        w.crash(a);
        w.run_chaos(8_000);
    }
    // Let A finish its pending work, then lose the device for good.
    if !w.quiesce(200, 5, 60_000) {
        w.shared.violate(
            Kind::NoQuiesce,
            "A did not settle before the device was lost".into(),
        );
    }
    let before = w.actor::<Node>(a).and_then(Node::digest);
    let svc_head = w
        .actor::<LogService>(svc)
        .map_or(0, |s| s.svc.head(&collection).0);
    check(w, &[a], svc_head);
    w.retire(a);
    // Restore: the same device's keys, a fresh store, an empty disk.
    w.log("world", "restore A onto a fresh store on a new machine");
    let me = w.actor_count() as u32;
    let restored = w.spawn(Box::new(Node::new(
        "A-restored",
        mr,
        me,
        svc,
        NodeCfg { work: false, ..cfg },
    )));
    let nodes = vec![restored];
    if !w.quiesce(200, 5, 60_000) {
        let detail = nodes
            .iter()
            .map(|n| {
                let x = w.actor::<Node>(*n);
                format!(
                    "{}: up={} pending={:?} head={:?}",
                    w.name(*n),
                    x.is_some_and(|x| x.replica().is_some()),
                    x.and_then(|x| x.replica().map(|r| r.sync_status().pending)),
                    x.and_then(|x| x.replica().map(|r| r.head().seq)),
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        w.shared.violate(Kind::NoQuiesce, detail);
    }
    let after = w.actor::<Node>(restored).and_then(Node::digest);
    if before != after {
        w.shared.violate(
            Kind::Divergence,
            format!(
                "the restored device differs from the lost one: head {:?} vs {:?}, {:?} vs {:?} records",
                after.as_ref().map(|d| d.0.seq),
                before.as_ref().map(|d| d.0.seq),
                after.as_ref().map(|d| d.1.len()),
                before.as_ref().map(|d| d.1.len()),
            ),
        );
    }
    if let Some(s) = w.actor_mut::<LogService>(svc) {
        let items = s.svc.items(&collection);
        let objects = s.svc.objects(&collection);
        for (i, it) in items.iter().enumerate() {
            w.log_state(&format!("stored item {}", i + 1), it);
        }
        for (a, b) in objects {
            w.log_state(&format!("stored object {}", a.to_hex()), &b);
        }
    }
    let epochs = [a, restored]
        .iter()
        .filter_map(|n| w.actor::<Node>(*n))
        .filter_map(|n| n.replica().map(|r| r.testing_epoch_keys().len() as u64))
        .max()
        .unwrap_or(0);
    w.shared.count("sealed.epochs", epochs);
    if epochs == 0 {
        w.shared.violate(
            Kind::Bug,
            "no epoch key: the real sealer never keyed (the scenario would be vacuous)".into(),
        );
    }
    if w.shared
        .counters
        .borrow()
        .get("slice.confirmed")
        .copied()
        .unwrap_or(0)
        == 0
    {
        w.shared.violate(
            Kind::Bug,
            "sealed workload confirmed no writes: the acknowledged-write oracle would be vacuous"
                .into(),
        );
    }
    let svc_head = w
        .actor::<LogService>(svc)
        .map_or(0, |s| s.svc.head(&collection).0);
    check(w, &nodes, svc_head)
}

/// The oracles after quiescence: convergence on the log head `svc_head`,
/// acknowledged writes at their positions on every replica, late receipts,
/// tokens, and files matching the confirmed records.
pub(crate) fn check(w: &mut World, nodes: &[u32], svc_head: u64) -> String {
    let digests: Vec<_> = nodes
        .iter()
        .map(|n| {
            (
                w.name(*n).to_string(),
                w.actor::<Node>(*n).and_then(Node::digest),
            )
        })
        .collect();
    // Convergence.
    let first = digests[0].1.clone();
    for (name, d) in &digests {
        match d {
            None => w
                .shared
                .violate(Kind::NoQuiesce, format!("{name} is not running at the end")),
            Some((h, recs)) => {
                if h.seq != svc_head {
                    w.shared.violate(
                        Kind::Divergence,
                        format!("{name} head {} but the log head is {svc_head}", h.seq),
                    );
                }
                if Some((h, recs)) != first.as_ref().map(|(a, b)| (a, b)) {
                    w.shared.violate(
                        Kind::Divergence,
                        format!(
                            "{name} differs from {}: head {:?} vs {:?}, {} vs {} records",
                            digests[0].0,
                            h.seq,
                            first.as_ref().map(|f| f.0.seq),
                            recs.len(),
                            first.as_ref().map_or(0, |f| f.1.len())
                        ),
                    );
                }
            }
        }
    }
    // Acknowledged writes are recorded at their position on every replica.
    let acks = w.shared.acks.borrow().clone();
    for a in acks.acks.values() {
        for n in nodes {
            let Some(x) = w.actor::<Node>(*n) else {
                continue;
            };
            let Some(m) = parse_uuid(&a.mutation) else {
                continue;
            };
            let got = x.receipt_seq(&m);
            if got != Some(a.seq) {
                w.shared.violate(
                    Kind::LostAck,
                    format!(
                        "{} acked to {} at seq {} (t={}), but {} records it at {got:?}",
                        a.mutation,
                        a.client,
                        a.seq,
                        a.at,
                        w.name(*n)
                    ),
                );
            }
        }
    }
    for v in acks.conflicts.iter() {
        w.shared.violate(Kind::LostAck, v.clone());
    }
    // Accepted writes whose receipt push was never seen (the process died):
    // the client asks for the receipt after reconnecting.
    for n in nodes {
        let unresolved = w
            .actor::<Node>(*n)
            .map(Node::unresolved)
            .unwrap_or_default();
        for (m, toks) in unresolved {
            let rc = w.actor_mut::<Node>(*n).and_then(|x| x.ask_receipt(&m));
            use mdbn_wire::client::ReceiptState as R;
            match rc.as_ref().map(|r| r.state) {
                Some(R::Rejected) => {
                    for t in &toks {
                        w.shared.tokens.borrow_mut().discard(t);
                    }
                    w.shared.count("slice.rejected_seen_late", 1);
                }
                Some(R::Unknown) => {
                    for t in &toks {
                        w.shared.tokens.borrow_mut().excuse(t, "outcome_unknown");
                    }
                }
                Some(R::Confirmed) => {
                    let seq = rc.as_ref().and_then(|r| r.seq).unwrap_or(0);
                    let on_all = nodes
                        .iter()
                        .filter_map(|o| w.actor::<Node>(*o))
                        .all(|o| o.receipt_seq(&m) == Some(seq));
                    if !on_all {
                        w.shared.violate(
                            Kind::LostAck,
                            format!("{} confirms {} at {seq} but not every replica has it there", w.name(*n), m.to_hex()),
                        );
                    }
                }
                Some(R::Pending) => w.shared.violate(
                    Kind::NoQuiesce,
                    format!(
                        "{} still has {} pending after quiescence (not lost: still queued; liveness)",
                        w.name(*n),
                        m.to_hex()
                    ),
                ),
                other => w.shared.violate(
                    Kind::LostAck,
                    format!(
                        "{} accepted {} (pending) and after quiescence its receipt is {other:?}, in no replica's log",
                        w.name(*n),
                        m.to_hex()
                    ),
                ),
            }
        }
    }
    // Tokens.
    if let Some(x) = w.actor::<Node>(nodes[0]) {
        let present = confirmed_tokens(x);
        let lost = w.shared.tokens.borrow().lost(&present);
        for t in lost.iter().take(10) {
            w.shared.violate(
                Kind::LostEdit,
                format!("token {t} is in no confirmed record"),
            );
        }
    }
    // Files on disk match the confirmed records.
    for n in nodes {
        let Some(x) = w.actor::<Node>(*n) else {
            continue;
        };
        let Some((_, recs)) = x.digest() else {
            continue;
        };
        let m = w.machines[w
            .actor::<Node>(*n)
            .and_then(crate::world::Actor::machine)
            .unwrap_or(0)]
        .clone();
        let mm = m.borrow();
        let mut paths = std::collections::BTreeSet::new();
        for r in &recs {
            paths.insert(r.path.clone());
            match mm.disk.read(&r.path) {
                Some(b) if b == r.doc.as_bytes() => {}
                Some(b) => w.shared.violate(
                    Kind::FileMismatch,
                    format!(
                        "{}: file {} differs from the confirmed record (file tokens {:?})",
                        w.name(*n),
                        r.path,
                        tokens_in(b)
                    ),
                ),
                None => w.shared.violate(
                    Kind::FileMismatch,
                    format!("{}: file {} is missing", w.name(*n), r.path),
                ),
            }
        }
        for p in mm.disk.names.keys() {
            if p.ends_with(".md") && !p.starts_with(".mdbase") && !paths.contains(p) {
                w.shared.violate(
                    Kind::FileMismatch,
                    format!("{}: stray file {p}", w.name(*n)),
                );
            }
        }
        w.shared.count("slice.records", recs.len() as u64);
    }
    format!("head={svc_head}")
}

pub(crate) fn parse_uuid(hex: &str) -> Option<B16> {
    if hex.len() != 32 {
        return None;
    }
    let mut b = [0u8; 16];
    for (i, x) in b.iter_mut().enumerate() {
        *x = u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).ok()?;
    }
    Some(B16(b))
}

#[cfg(test)]
mod tests {
    use crate::scenario::{Opts, run_seed};

    /// The key oracle is armed on the real sealer: device signing seed, KEM secret
    /// and at least one epoch key are registered, and frames were scanned.
    #[test]
    fn sealed_slice_registers_keys_with_the_tap() {
        let r = run_seed("slice-sealed", 1, &Opts::default()).unwrap();
        assert!(r.clean(), "{:?}", r.violations);
        assert!(r.counters["tap.secrets"] >= 3, "{:?}", r.counters);
        assert!(r.counters["tap.scanned"] > 10, "{:?}", r.counters);
        assert!(r.counters["sealed.epochs"] >= 1, "{:?}", r.counters);
        assert!(r.counters["slice.confirmed"] > 0, "{:?}", r.counters);
        for p in [
            "request",
            "item:entry",
            "item:rekey",
            "stored:item:entry",
            "stored:item:policy",
            "stored:item:rekey",
        ] {
            assert!(r.counters[&format!("tap.path.{p}")] > 0, "{:?}", r.counters);
        }
    }
}
