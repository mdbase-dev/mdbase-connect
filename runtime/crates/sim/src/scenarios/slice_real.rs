//! `slice-real` / `slice-real-chaos`: the vertical slice over the **real** log
//! service and the exact-frame network. Two of the owner's desktops, each with
//! real keys (`KeyringSealer`) and its own caller-authenticated transport
//! ([`crate::sut::real_node`]), against the production service, session and hub
//! code behind [`crate::sut::real_log_net::RealServiceActor`]. The collection is
//! in cloud-copy state with a passive escrow: that is where the owner's desktop
//! keys every other desktop with its initial rekey; private-mode multi-device
//! keying needs an approval flow the host does not expose yet.
//!
//! Same workload, chaos model and oracles as `slice` (`-chaos`: process crashes,
//! power loss, partitions and a lossy network, so connections drop mid-call and
//! every device re-authenticates), plus the untrusted-party tap holds every
//! signing seed, KEM secret and epoch key: any of them, or any plaintext, in a
//! frame or in stored state is a violation.

use mdbn_wire::common::B16;
use mdbn_wire::policy::CState;

use super::slice::check;
use crate::net::NetConfig;
use crate::oracle::Kind;
use crate::platform::Os;
use crate::sut::node::Node;
use crate::sut::real_log_net::RealServiceActor;
use crate::sut::real_node::harness::provision;
use crate::world::{Chaos, HookCfg, World};

/// What a run needs after setup.
struct Setup {
    p: crate::sut::real_node::harness::Provisioned,
    server: u32,
    nodes: Vec<u32>,
}

fn setup(w: &mut World, label: &str, chaos: bool) -> Setup {
    let p = provision(label, 2, CState::CloudCopy);
    w.expect_log_service();
    p.register_secrets(w);
    {
        let mut tap = w.shared.tap.borrow_mut();
        for m in ["title", "status", "tags", "Body ", "notes/"] {
            tap.marker(&format!("field or text {m:?}"), m.as_bytes());
        }
        for path in ["real:request", "real:response", "real:push", "state"] {
            tap.require(path);
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
    let server = w.actor_count() as u32;
    w.spawn(Box::new(RealServiceActor::new(server, p.service.clone())));
    let mut nodes = Vec::new();
    for (i, (m, name)) in [(ma, "A"), (mb, "B")].into_iter().enumerate() {
        let me = w.actor_count() as u32;
        let cfg = p.node_cfg(i, B16([0x10 + i as u8; 16]), true, None);
        let id = w.spawn(Box::new(
            Node::new(name, m, me, server, cfg).with_real_transport(p.hello(i)),
        ));
        w.crashable.push(id);
        w.partitionable.push(id);
        nodes.push(id);
    }
    Setup { p, server, nodes }
}

/// Quiesce, count transport outcomes, put everything the service stores through
/// the tap, and run the slice oracles against the stored head.
fn finish(w: &mut World, s: &Setup) -> String {
    let collection = s.p.collection;
    if !w.quiesce(200, 5, 60_000) {
        let detail = s
            .nodes
            .iter()
            .map(|n| {
                let x = w.actor::<Node>(*n);
                format!(
                    "{}: up={} status={:?} wire={:?}",
                    w.name(*n),
                    x.is_some_and(|x| x.replica().is_some()),
                    x.and_then(|x| x.replica().map(|r| r.sync_status())),
                    x.and_then(Node::wire_stats)
                )
            })
            .collect::<Vec<_>>()
            .join("; ");
        w.shared.violate(Kind::NoQuiesce, detail);
    }
    for n in &s.nodes {
        if let Some(stats) = w.actor::<Node>(*n).and_then(Node::wire_stats) {
            let name = w.name(*n).to_string();
            w.shared
                .count(&format!("real.{name}.admitted"), stats.admitted);
            w.shared
                .count(&format!("real.{name}.refused"), stats.refused);
            w.shared
                .count(&format!("real.{name}.no_response"), stats.no_response);
            w.shared.count(&format!("real.{name}.stale"), stats.stale);
            w.shared.count(
                &format!("real.{name}.unmodeled_direct"),
                stats.unmodeled_direct,
            );
            if stats.unmodeled_direct > 0 {
                w.shared.violate(
                    Kind::Bug,
                    format!("{name}: a direct transfer was required but is not modelled"),
                );
            }
        }
    }
    // Everything the service stores, through the tap.
    let items = s.p.service.stored_items(&collection);
    for (seq, bytes) in &items {
        w.log_state(&format!("stored item {seq}"), bytes);
    }
    if items.is_empty() {
        // Scanned and empty (a compaction through the head): the state path
        // was checked, there was nothing to leak.
        w.log_state("stored log, empty", &[]);
    }
    w.shared.count("log.items", items.len() as u64);
    let svc_head = w
        .actor::<RealServiceActor>(s.server)
        .and_then(|x| x.head(&collection))
        .unwrap_or(0);
    check(w, &s.nodes, svc_head)
}

/// Run. `chaos`: crashes, power loss, partitions and a lossy network.
pub fn run(w: &mut World, chaos: bool) -> String {
    let s = setup(w, "slice-real", chaos);
    if chaos {
        w.run_chaos(20_000);
    } else {
        w.run_chaos(8_000);
        w.log("world", "scripted restart of B");
        w.crash(s.nodes[1]);
        w.run_chaos(8_000);
    }
    finish(w, &s)
}

/// `slice-real-snapshots`: A works alone with a snapshot every 25 entries, so
/// manifests and chunks go to the real service as objects (`put_object`,
/// `put_snapshot`, self-endorsement); then B joins late and reads everything
/// (no compaction: the real service only compacts below a 10,000-entry grace,
/// so B is not behind retention). Oracles: the slice oracles, snapshots were
/// built, and no snapshot object needed a direct transfer the harness does not
/// model.
pub fn run_snapshots(w: &mut World) -> String {
    let p = provision("slice-real-snapshots", 2, CState::CloudCopy);
    w.expect_log_service();
    p.register_secrets(w);
    {
        let mut tap = w.shared.tap.borrow_mut();
        for m in ["title", "status", "tags", "Body ", "notes/"] {
            tap.marker(&format!("field or text {m:?}"), m.as_bytes());
        }
        for path in ["real:request", "real:response", "real:push", "state"] {
            tap.require(path);
        }
    }
    let ma = w.add_machine("ma", Os::Linux, HookCfg::default());
    let mb = w.add_machine("mb", Os::Linux, HookCfg::default());
    w.chaos.restart_ms = (200, 500);
    let server = w.actor_count() as u32;
    w.spawn(Box::new(RealServiceActor::new(server, p.service.clone())));
    let me = w.actor_count() as u32;
    let cfg = p.node_cfg(0, B16([0x10; 16]), true, Some(25));
    let a = w.spawn(Box::new(
        Node::new("A", ma, me, server, cfg).with_real_transport(p.hello(0)),
    ));
    w.run_chaos(10_000);
    if !w.quiesce(200, 5, 30_000) {
        w.shared.violate(Kind::NoQuiesce, "A did not settle".into());
    }
    let built = w
        .actor::<Node>(a)
        .and_then(|n| n.replica().map(|r| r.stats.snapshots_built))
        .unwrap_or(0);
    w.shared.count("snapshot.built", built);
    if built == 0 {
        w.shared.violate(
            Kind::Bug,
            "A built no snapshot: the scenario is vacuous".into(),
        );
    }
    let me = w.actor_count() as u32;
    let cfg = p.node_cfg(1, B16([0x11; 16]), false, Some(25));
    let b = w.spawn(Box::new(
        Node::new("B", mb, me, server, cfg).with_real_transport(p.hello(1)),
    ));
    let s = Setup {
        p,
        server,
        nodes: vec![a, b],
    };
    let state = finish(w, &s);
    let installed = w
        .actor::<Node>(b)
        .and_then(|n| n.replica().map(|r| r.stats.snapshots_installed))
        .unwrap_or(0);
    w.shared.count("snapshot.installed", installed);
    state
}

/// `slice-real-snapshot-install`: like `slice-real-snapshots`, but after A has
/// built snapshots the real service compacts its entries through the latest
/// snapshot position (never past it: snapshot.md §5), so B joins behind
/// retention and must install the snapshot over the real service, then read the
/// tail and converge. The install is the oracle: B must install, and the slice
/// oracles hold.
pub fn run_snapshot_install(w: &mut World) -> String {
    let p = provision("slice-real-snapshot-install", 2, CState::CloudCopy);
    let collection = p.collection;
    w.expect_log_service();
    p.register_secrets(w);
    {
        let mut tap = w.shared.tap.borrow_mut();
        for m in ["title", "status", "tags", "Body ", "notes/"] {
            tap.marker(&format!("field or text {m:?}"), m.as_bytes());
        }
        for path in ["real:request", "real:response", "real:push", "state"] {
            tap.require(path);
        }
    }
    let ma = w.add_machine("ma", Os::Linux, HookCfg::default());
    let mb = w.add_machine("mb", Os::Linux, HookCfg::default());
    w.chaos.restart_ms = (200, 500);
    let server = w.actor_count() as u32;
    w.spawn(Box::new(RealServiceActor::new(server, p.service.clone())));
    let me = w.actor_count() as u32;
    let cfg = p.node_cfg(0, B16([0x10; 16]), true, Some(25));
    let a = w.spawn(Box::new(
        Node::new("A", ma, me, server, cfg).with_real_transport(p.hello(0)),
    ));
    w.run_chaos(10_000);
    if !w.quiesce(200, 5, 30_000) {
        w.shared.violate(Kind::NoQuiesce, "A did not settle".into());
    }
    let built = w
        .actor::<Node>(a)
        .and_then(|n| n.replica().map(|r| r.stats.snapshots_built))
        .unwrap_or(0);
    w.shared.count("snapshot.built", built);
    let head = w
        .actor::<RealServiceActor>(server)
        .and_then(|x| x.head(&collection))
        .unwrap_or(0);
    // Compact through the latest snapshot the service holds, never past it.
    let upto = p.service.stored_snapshots(&collection).into_iter().max();
    let retained_from = upto.and_then(|u| p.service.compact_through(&collection, u));
    w.shared
        .count("log.retained_from", retained_from.unwrap_or(0));
    w.log(
        "world",
        &format!("log compacted through {upto:?} (head {head}, retained_from {retained_from:?})"),
    );
    if built == 0 || retained_from.is_none_or(|r| r <= 2) {
        w.shared.violate(
            Kind::Bug,
            format!("no retention behind a snapshot (built {built}, retained_from {retained_from:?}): vacuous"),
        );
    }
    let me = w.actor_count() as u32;
    let cfg = p.node_cfg(1, B16([0x11; 16]), false, Some(25));
    let b = w.spawn(Box::new(
        Node::new("B", mb, me, server, cfg).with_real_transport(p.hello(1)),
    ));
    let s = Setup {
        p,
        server,
        nodes: vec![a, b],
    };
    let state = finish(w, &s);
    let installed = w
        .actor::<Node>(b)
        .and_then(|n| n.replica().map(|r| r.stats.snapshots_installed))
        .unwrap_or(0);
    w.shared.count("snapshot.installed", installed);
    if installed == 0 {
        w.shared.violate(
            Kind::Bug,
            "B joined behind retention and installed no snapshot".into(),
        );
    }
    state
}

/// `slice-real-join-ahead` / `-waiting`: the join-ahead keying order. A works
/// alone in a cloud-copy collection and
/// writes sealed entries; only then does the control plane enrol B, and the
/// escrow's `key_grant` to B comes later still. B joins with the grant already
/// logged (or, `waiting`, before it, so it first waits for a key and the bounded
/// probe finds the grant). B must read ahead to its grant, decrypt A's earlier
/// entries and converge: the slice oracles, plus B actually waited (non-vacuous)
/// and holds no key-wait stall at the end.
pub fn run_join_ahead(w: &mut World, waiting: bool) -> String {
    use crate::sut::real_node::harness::provision_with;
    use mdbn_wire::client::IncidentKind;
    let p = provision_with("slice-real-join-ahead", 2, 1, CState::CloudCopy);
    w.expect_log_service();
    p.register_secrets(w);
    {
        let mut tap = w.shared.tap.borrow_mut();
        for m in ["title", "status", "tags", "Body ", "notes/"] {
            tap.marker(&format!("field or text {m:?}"), m.as_bytes());
        }
        for path in ["real:request", "real:response", "real:push", "state"] {
            tap.require(path);
        }
    }
    let ma = w.add_machine("ma", Os::Linux, HookCfg::default());
    let mb = w.add_machine("mb", Os::Linux, HookCfg::default());
    w.chaos.restart_ms = (200, 500);
    let server = w.actor_count() as u32;
    w.spawn(Box::new(RealServiceActor::new(server, p.service.clone())));
    let me = w.actor_count() as u32;
    let cfg = p.node_cfg(0, B16([0x10; 16]), true, None);
    let a = w.spawn(Box::new(
        Node::new("A", ma, me, server, cfg).with_real_transport(p.hello(0)),
    ));
    w.run_chaos(6_000);
    if !w.quiesce(200, 5, 30_000) {
        w.shared.violate(Kind::NoQuiesce, "A did not settle".into());
    }
    let written = w
        .shared
        .counters
        .borrow()
        .get("slice.confirmed")
        .copied()
        .unwrap_or(0);
    if written == 0 {
        w.shared.violate(
            Kind::Bug,
            "A wrote nothing before B joined: the scenario is vacuous".into(),
        );
    }
    let enrolled = p.enrol_late(1);
    w.log(
        "world",
        &format!("B enrolled after A's content: {enrolled:?}"),
    );
    let grant = |w: &mut World, p: &crate::sut::real_node::harness::Provisioned| {
        let at = p.escrow_grant(1);
        w.log("world", &format!("escrow key_grant to B: {at:?}"));
        if at.is_err() || enrolled.is_err() {
            w.shared
                .violate(Kind::Bug, format!("setup failed: {enrolled:?} {at:?}"));
        }
    };
    if !waiting {
        grant(w, &p);
    }
    let me = w.actor_count() as u32;
    // B reads (its key comes from the escrow, which it does not trust to seal).
    let cfg = p.node_cfg(1, B16([0x11; 16]), false, None);
    let b = w.spawn(Box::new(
        Node::new("B", mb, me, server, cfg).with_real_transport(p.hello(1)),
    ));
    if waiting {
        w.run_chaos(3_000);
        let stalled = w
            .actor::<Node>(b)
            .and_then(|n| n.replica().and_then(|r| r.key_wait_reason()));
        let waited = stalled.is_some();
        w.shared.count("join_ahead.waited", u64::from(waited));
        if !waited {
            w.shared.violate(
                Kind::Bug,
                format!("B was not waiting for a key before its grant ({stalled:?}): vacuous"),
            );
        }
        grant(w, &p);
    }
    let s = Setup {
        p,
        server,
        nodes: vec![a, b],
    };
    let state = finish(w, &s);
    let waiting_for_key = w.actor::<Node>(b).and_then(|n| {
        n.replica().map(|r| {
            r.sync_status()
                .incidents
                .iter()
                .any(|i| i.kind == IncidentKind::WaitingForKey)
        })
    });
    if waiting_for_key != Some(false) {
        w.shared.violate(
            Kind::SilentHold,
            format!("B still waiting for a key after its grant: {waiting_for_key:?}"),
        );
    }
    state
}

/// How the service loses its tail (lost-tail repair contract).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LostTail {
    /// Both devices online; subscribers are not told. Each author repairs its own.
    Online,
    /// A crashes just before the loss: B, which applied A's entries, is the holder
    /// that must repair them; A restarts afterwards.
    AuthorCrash,
    /// B is partitioned before the loss and A keeps writing into the gap, so B's
    /// lost entries can only come back by the fallback (roll back, resurrect at
    /// new positions with `relocated_from`).
    Overwrite,
    /// Both devices lose their connection right after the loss, while the first
    /// regression probes are in flight: a probe without a reply is unknown, never
    /// prefix evidence, and must be re-issued on the next authenticated session.
    ProbeCut,
    /// The service compacts right after the loss but still retains the
    /// shortened head: one retained item is enough to prove the common prefix,
    /// and the repair completes.
    Compacted,
    /// The service compacts through the shortened head right after the loss,
    /// so the interval a device must compare is gone: the prefix is unprovable
    /// and the repair must park with an incident, never roll back or relocate.
    Unprovable,
}

/// `slice-real-lost-tail*`: after a calm warm-up with acknowledged writes from
/// both devices, the real service loses its last items as on a failover to a
/// lagging node. The agreed outcomes (interface note §2) are the slice oracles:
/// every acknowledged write ends in the final log exactly once, at its original
/// position after a repair or at a new one with `relocated_from` after the
/// fallback; no divergence; no stuck device. The ops incident must be raised
/// (`log_regressed`, or the older `integrity` "log head regressed"), and
/// `lost_entries` incidents are counted, not judged.
pub fn run_lost_tail(w: &mut World, variant: LostTail) -> String {
    use mdbn_wire::client::IncidentKind;
    let s = setup(w, "slice-real-lost-tail", false);
    w.run_chaos(6_000);
    let before = w
        .shared
        .counters
        .borrow()
        .get("slice.confirmed")
        .copied()
        .unwrap_or(0);
    if before == 0 {
        w.shared.violate(
            Kind::Bug,
            "no acknowledged write before the lost tail: the scenario is vacuous".into(),
        );
    }
    match variant {
        LostTail::Online | LostTail::ProbeCut | LostTail::Compacted | LostTail::Unprovable => {}
        LostTail::AuthorCrash => {
            w.log("world", "A crashes before the loss");
            w.crash(s.nodes[0]);
        }
        LostTail::Overwrite => {
            w.log("world", "B is cut off before the loss");
            w.partition(s.nodes[1], 3_000);
        }
    }
    let head = w
        .actor::<RealServiceActor>(s.server)
        .and_then(|x| x.head(&s.p.collection))
        .unwrap_or(0);
    // Lose a short tail, never the control prefix.
    let n = 4.min(head.saturating_sub(2));
    let new_head = head - n;
    let acked_lost = w
        .shared
        .acks
        .borrow()
        .acks
        .values()
        .filter(|a| a.seq > new_head)
        .count() as u64;
    w.shared.count("lost_tail.items", n);
    w.shared.count("lost_tail.acked_lost", acked_lost);
    if acked_lost == 0 {
        w.shared.violate(
            Kind::Bug,
            format!(
                "the lost tail ({n} items above {new_head}) held no acknowledged write: vacuous"
            ),
        );
    }
    w.log(
        "world",
        &format!("LOST TAIL: {n} items, head {head} -> {new_head}"),
    );
    s.p.service.lose_tail(&s.p.collection, n);
    if matches!(variant, LostTail::Compacted | LostTail::Unprovable) {
        // Compacted keeps exactly the new head retained; Unprovable compacts
        // through it, leaving the service with no entry at all.
        let through = match variant {
            LostTail::Compacted => new_head - 1,
            _ => new_head,
        };
        let retained_from = s.p.service.compact_through(&s.p.collection, through);
        w.log(
            "world",
            &format!("service compacted through {through}: retained_from={retained_from:?}"),
        );
        w.shared.count("lost_tail.compacted_through", through);
        if retained_from != Some(through + 1) {
            w.shared
                .violate(Kind::Bug, "the service did not compact as asked".into());
        }
    }
    if matches!(variant, LostTail::ProbeCut) {
        w.log(
            "world",
            "each device's next read (its regression probe) is cut",
        );
        for n in &s.nodes {
            if let Some(x) = w.actor_mut::<Node>(*n) {
                x.cut_next_read();
            }
        }
    }
    w.run_chaos(8_000);
    let settled = finish(w, &s);
    let mut regressed = 0;
    let mut lost_entries = 0;
    for n in &s.nodes {
        if let Some(st) = w
            .actor::<Node>(*n)
            .and_then(|x| x.replica().map(|r| r.sync_status()))
        {
            for i in &st.incidents {
                match i.kind {
                    IncidentKind::LogRegressed => regressed += 1,
                    IncidentKind::Integrity if matches!(&i.details, Some(mdbn_wire::common::Value::Text(t)) if t.contains("regressed")) => {
                        regressed += 1
                    }
                    IncidentKind::LostEntries => lost_entries += 1,
                    _ => {}
                }
            }
        }
    }
    w.shared.count("lost_tail.regressed_incidents", regressed);
    w.shared
        .count("lost_tail.lost_entries_incidents", lost_entries);
    if regressed == 0 {
        w.shared.violate(
            Kind::SilentHold,
            "no device reported the log regression (ops signal missing)".into(),
        );
    }
    settled
}
