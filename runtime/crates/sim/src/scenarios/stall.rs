//! A replica stalled on an entry this build cannot read re-reads it on a
//! bounded backoff, not in a loop driven by each read reply.
use mdbn_replica::{
    crypto::{TestEntropy, keys::Keyring},
    seal::{KeyringSealer, Sealer},
    store::{Store, meta_keys},
    testkit::TestControlPlane,
};
use mdbn_wire::{
    attachment_runtime_v1 as rt,
    cbor::{self, Cbor},
    client::IncidentKind,
    common::{B16, B32, Bytes, Version},
    entry::Status,
    envelope::{Item, ItemKind},
    intent::{OpClock, Source},
    policy::CState,
    schema::Wire,
};

use crate::{
    oracle::Kind,
    platform::Os,
    sut::{
        logsvc::LogService,
        node::{Node, NodeCfg},
    },
    world::{Ev, HookCfg, World},
};

/// How long the stalled replica runs.
const STALLED_MS: u64 = 120_000;
/// Read probes double from 1 s to every 30 s: 7 in two minutes, plus margin
/// for the reopen's own requests.
const MAX_REQUESTS: u64 = 20;

/// Append a signed, sealed entry whose payload has a format this build does not
/// know, so the replica stalls with `upgrade_required`, then count its requests.
pub fn run_upgrade_required(world: &mut World) -> String {
    let collection = B16([0x74; 16]);
    let device = B16([0x21; 16]);
    let keys = ([0x33; 32], [0x34; 32]);
    world.expect_log_service();
    let service = world.spawn(Box::new(LogService::new(vec![collection])));
    let log = world.actor::<LogService>(service).unwrap().svc.clone();
    TestControlPlane::signed(collection).genesis_with_keys(
        &log,
        CState::E2e,
        device,
        &keys.0,
        &keys.1,
    );
    let machine = world.add_machine("stall-replica", Os::Linux, HookCfg::default());
    let actor = world.actor_count() as u32;
    let node = world.spawn(Box::new(Node::new(
        "stall-replica",
        machine,
        actor,
        service,
        NodeCfg {
            collection,
            replica_id: B16([0x11; 16]),
            device,
            work: false,
            work_every_ms: 150,
            reconnect_storm: false,
            snapshot_every: None,
            trusted: vec![device],
            keys: Some(keys),
        },
    )));
    world.run_chaos(4_000);
    if !world.quiesce(200, 5, 60_000) {
        world
            .shared
            .violate(Kind::NoQuiesce, "replica did not settle".into());
    }
    let replica = world.actor::<Node>(node).unwrap().replica().unwrap();
    let saved = replica.store().meta(meta_keys::KEYRING).unwrap().unwrap();
    let size = u64::from_be_bytes(saved[..8].try_into().unwrap()) as usize;
    let (epoch, _) = Keyring::from_bytes(&saved[8..8 + size])
        .unwrap()
        .latest()
        .unwrap();
    let mut sealer = KeyringSealer::new(collection, device, &keys.0, &keys.1);
    sealer.import(&saved).unwrap();
    sealer.set_epoch(epoch);
    let (seq, chain) = log.head(&collection);
    let payload = rt::EntryPayload {
        sem: Version {
            major: mdbn_core::semantics::SEM.major,
            minor: mdbn_core::semantics::SEM.minor,
        },
        mutation: rt::Mutation {
            id: B16([0x75; 16]),
            origin: B16([0x70; 16]),
            base_seq: seq,
            clock: OpClock {
                instant: 0,
                tz: "UTC".into(),
                local_date: "1970-01-01".into(),
            },
            seed: B32([0x74; 32]),
            source: Source::Api,
            ops: vec![],
            on_behalf: None,
            conflict_mode: None,
            validated_at: None,
            room: None,
        },
        status: Status::Applied,
        effects: vec![],
        conflicts: None,
        aliases: None,
        texts: None,
        resurrect: None,
    };
    // The same payload under a later `fmt`.
    let Cbor::Map(mut fields) = payload.to_cbor() else {
        unreachable!()
    };
    fields[0] = (Cbor::Uint(0), Cbor::Uint(2));
    let plain = cbor::encode(&Cbor::Map(fields)).unwrap();
    assert!(
        rt::EntryPayload::from_bytes(&plain)
            .unwrap_err()
            .is_unknown()
    );
    let mut item = Item {
        kind: ItemKind::Entry,
        collection,
        seq: Some(seq + 1),
        prev: Some(chain),
        epoch: None,
        signer: Some(device),
        salt: None,
        idem: Some(B16([0x75; 16])),
        refs: None,
        stream: None,
        body: Bytes(vec![]),
        sig: None,
    };
    sealer
        .seal(&mut item, &plain, false, &mut TestEntropy::new(74))
        .unwrap();
    log.push_raw(&collection, item.to_bytes().unwrap());
    let requests = |world: &World| {
        world
            .shared
            .tap
            .borrow()
            .per_path
            .get("request")
            .copied()
            .unwrap_or(0)
    };
    // Reopen, as a device starting up after the entry was appended: its first
    // read reaches the entry and stalls.
    world.crash(node);
    let before = requests(world);
    world.at(node, 1, Ev::Restart);
    let until = world.now() + STALLED_MS;
    world.run_until(until);
    let sent = requests(world) - before;
    world.shared.count("stall.requests", sent);
    let replica = world.actor::<Node>(node).unwrap().replica().unwrap();
    let status = replica.sync_status();
    if replica.head().seq != seq
        || !status
            .incidents
            .iter()
            .any(|i| i.kind == IncidentKind::UpgradeRequired)
    {
        world.shared.violate(
            Kind::Bug,
            format!("replica did not stall at {}: {status:?}", seq + 1),
        );
    }
    if sent > MAX_REQUESTS {
        world.shared.violate(
            Kind::NoQuiesce,
            format!(
                "stalled replica sent {sent} log requests in {STALLED_MS} ms (at most {MAX_REQUESTS})"
            ),
        );
    }
    format!("{{\"stalled_at\":{}}}", seq + 1)
}

#[cfg(test)]
mod tests {
    #[test]
    fn upgrade_required_stall_reads_on_a_bounded_backoff() {
        for seed in [1, 2, 3] {
            let report = crate::scenario::run_seed(
                "stall-upgrade-required",
                seed,
                &crate::scenario::Opts::default(),
            )
            .unwrap();
            assert!(report.violations.is_empty(), "{report:?}");
        }
    }
}
