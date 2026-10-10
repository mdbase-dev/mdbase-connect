//! Atomic control commit failure, live public retry, then reopen.
//!
//! This exercises the real Replica/FileStore through Node's normal network
//! replies and timer ticks; it never calls private apply methods. PlainSealer
//! is a policy fixture only, not encryption or gate-1 acceptance evidence.

use mdbn_replica::policy::PolicyState;
use mdbn_replica::store::{Store, meta_keys};
use mdbn_replica::testkit::TestControlPlane;
use mdbn_wire::common::B16;
use mdbn_wire::policy::CState;

use crate::oracle::Kind;
use crate::platform::Os;
use crate::sut::logsvc::LogService;
use crate::sut::node::{Node, NodeCfg};
use crate::world::{HookCfg, World};

fn durable(w: &World, node: u32) -> Option<(u64, PolicyState)> {
    let r = w.actor::<Node>(node)?.replica()?;
    let bytes = r.store().meta(meta_keys::POLICY).ok()??;
    Some((r.head().seq, PolicyState::from_bytes(&bytes).ok()?))
}

/// `fault`: fail exactly one policy-bearing commit before any Store effects.
pub fn run(w: &mut World, fault: bool, crash_window: bool) -> String {
    let collection = B16([0xc7; 16]);
    let observer = B16([0x20; 16]);
    let victim = B16([0x21; 16]);
    w.expect_log_service();
    let machine = w.add_machine("control-observer", Os::Linux, HookCfg::default());
    let svc = w.spawn(Box::new(LogService::new(vec![collection])));
    let mut cp = TestControlPlane::new(collection);
    cp.bootstrap(
        &w.actor::<LogService>(svc).expect("service").svc,
        CState::E2e,
        &[observer, victim],
    );
    let me = w.actor_count() as u32;
    let node = w.spawn(Box::new(Node::new(
        "control-observer",
        machine,
        me,
        svc,
        NodeCfg {
            collection,
            replica_id: B16([0x10; 16]),
            device: observer,
            work: false,
            work_every_ms: 150,
            reconnect_storm: false,
            snapshot_every: None,
            keys: None,
            trusted: vec![observer, victim],
        },
    )));
    w.run_chaos(4_000);
    let before = durable(w, node);
    if !before.as_ref().is_some_and(|(head, p)| {
        *head == 2 && p.seq == 2 && p.devices.get(&victim).is_some_and(|d| d.active)
    }) {
        w.shared.violate(
            Kind::Bug,
            "control fixture never established active keyed devices at head 2".into(),
        );
    }
    let target = cp.revoke(&w.actor::<LogService>(svc).expect("service").svc, victim);
    w.shared.count("control.revoke_seq", target);
    if fault {
        w.actor_mut::<Node>(node)
            .expect("node")
            .fail_control_commit(target);
    }
    if crash_window {
        w.actor_mut::<Node>(node)
            .expect("node")
            .crash_on_bad_control_head();
    }
    // The direct test-control-plane append queues genuine service pushes;
    // wake their transport without forging a head hint or touching Replica.
    w.timer(svc, 0, crate::sut::logsvc::FLUSH_PUSHES);
    // Allow ordinary on_log_reply/tick retry on the SAME live Replica; no
    // scripted crash, disconnect, direct apply or Store mutation in this phase.
    w.run_chaos(12_000);
    let gap_crashes = w.actor::<Node>(node).expect("node").control_gap_crashes();
    w.shared.count("control.gap_crashes", gap_crashes);
    let injected = w
        .actor::<Node>(node)
        .expect("node")
        .commit_faults_injected();
    w.shared.count("control.commit_faults", injected);
    if injected != u64::from(fault) {
        w.shared.violate(
            Kind::Bug,
            format!(
                "control fault coverage: expected {}, got {injected}",
                u64::from(fault)
            ),
        );
    }
    if w.actor::<Node>(node).and_then(Node::replica).is_none() {
        w.shared.violate(
            Kind::Bug,
            "atomic commit error discarded the live Replica before the retry/error phase".into(),
        );
    }
    // A checkpointable sealer may recover via ordinary read retry. An opaque
    // sealer may safely park until host reopen. Neither may acknowledge the
    // control position without the corresponding durable authorization state.
    if let Some((head, p)) = durable(w, node) {
        w.shared.count("control.before_reopen_head", head);
        w.shared.count("control.before_reopen_policy_seq", p.seq);
        if head >= target && (p.seq < target || p.devices.get(&victim).is_none_or(|d| d.active)) {
            w.shared.violate(
                Kind::Divergence,
                format!(
                    "control head {head} acknowledged without durable revocation (policy seq {})",
                    p.seq
                ),
            );
        }
    } else {
        w.shared
            .violate(Kind::Bug, "missing durable policy after live retry".into());
    }
    let gaps = w
        .actor::<Node>(node)
        .expect("node")
        .control_durability_gaps();
    w.shared
        .count("control.head_without_policy", gaps.len() as u64);
    for (head, policy) in gaps {
        w.shared.violate(Kind::Divergence, format!(
            "successful commit acknowledged head {head} with durable policy {policy}, missing control {target}"
        ));
    }
    let read_errors = w
        .actor::<Node>(node)
        .expect("node")
        .control_oracle_read_errors();
    w.shared.count("control.oracle_read_errors", read_errors);
    if read_errors != 0 {
        w.shared.violate(
            Kind::Bug,
            "control durability oracle could not read committed state".into(),
        );
    }
    w.log("world", "reopen after live control commit retry");
    w.crash(node);
    w.run_chaos(6_000);
    if !w.quiesce(200, 5, 60_000) {
        w.shared.violate(
            Kind::NoQuiesce,
            "control observer did not settle after reopen".into(),
        );
    }
    let Some((head, p)) = durable(w, node) else {
        w.shared
            .violate(Kind::Bug, "reopened observer has no durable policy".into());
        return "missing policy".into();
    };
    let active = p.devices.get(&victim).is_none_or(|d| d.active);
    w.shared.count("control.reopened_head", head);
    w.shared.count("control.reopened_policy_seq", p.seq);
    w.shared
        .count("control.reopened_victim_active", u64::from(active));
    if head < target || p.seq < target || active {
        w.shared.violate(Kind::Divergence, format!("revoked device revived on reopen: head {head}, policy seq {}, victim active={active}, revocation seq {target}", p.seq));
    }
    format!("head {head}, policy {}, revoked {}", p.seq, !active)
}
