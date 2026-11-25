//! connect#1850: a record-metadata repair on a large cloud copy, over the Durable
//! Object SQL transport (`DoIndex` under the host's codec limits). The repair moves
//! one bounded slice per alarm; a newly enrolled device's key grant must not wait
//! for it, and content still does.
use super::sqlite::Sqlite;
use super::*;
use crate::do_index::{DoIndex, LIMITS, SqlHost};
use mdbn_replica::replica::adopt::{AdoptRecords, AdoptSource, AdoptStatus};
use mdbn_replica::{DeviceSecrets, Replica, ReplicaConfig};
use mdbn_store_file::index::IndexStorage;
use mdbn_store_file::index_codec::{IndexReply, IndexRequest, decode_request, encode_reply};
use mdbn_store_file::{LogCache, SqlStoreLimits};
use mdbn_wire::envelope::{Item, KeyGrantPayload};
use mdbn_wire::intent::ResourcePut;
use std::cell::RefCell;

const RECORDS: u64 = 2_000;
const JOINING: B16 = B16([0x5e; 16]);

/// The Worker host (`sql.ts`) in process: decode under the DO limits, run on SQLite.
struct DoHost(Sqlite);
impl SqlHost for DoHost {
    fn run(&mut self, request: &[u8]) -> Option<Vec<u8>> {
        let reply = match decode_request(request, LIMITS).ok()? {
            IndexRequest::Run(batch) => match self.0.run(&batch) {
                Ok(r) => IndexReply::Results(r),
                Err(e) => IndexReply::Error(e),
            },
            IndexRequest::Reset => IndexReply::ResetOk,
        };
        encode_reply(&reply, LIMITS).ok()
    }
}

/// A folder of typed notes and their type definitions.
struct Folder;
impl AdoptSource for Folder {
    fn records(&mut self) -> Result<AdoptRecords, String> {
        Ok(AdoptRecords {
            records: (0..RECORDS)
                .map(|i| {
                    let mut id = [0x0b; 16];
                    id[8..].copy_from_slice(&i.to_be_bytes());
                    (B16(id), format!("notes/{i}.md"))
                })
                .collect(),
            resources: ["task", "writer-manuscript"]
                .map(|t| format!("_types/{t}.md"))
                .into(),
            settings: None,
        })
    }
    fn read(&mut self, path: &str) -> Result<Option<String>, String> {
        if let Some(name) = path
            .strip_prefix("_types/")
            .and_then(|p| p.strip_suffix(".md"))
        {
            return Ok(Some(type_doc(name)));
        }
        let i = path
            .strip_prefix("notes/")
            .and_then(|p| p.strip_suffix(".md"))
            .ok_or("path")?;
        Ok(Some(format!(
            "---\ntype: [task, writer-manuscript]\ntitle: Note {i}\nstatus: open\n---\nSynthetic body for note {i}.\n"
        )))
    }
}

fn type_doc(name: &str) -> String {
    format!(
        "---\nkind: mdbase.type\nname: {name}\nschema: {{dialect: json-schema-2020-12, value: {{type: object}}}}\n---\n"
    )
}

/// The owner's desktop turns its folder into the cloud copy's generation-0 base.
fn adopt(svc: &FakeLogService) {
    let clock = Rc::new(Cell::new(1_700_000_000_000));
    let cfg = ReplicaConfig {
        collection: COL,
        replica_id: B16([0x61; 16]),
        device_id: OWNER_DEV,
        mode: mdbn_wire::client::SyncMode::Synced,
        log_endpoint: mdbn_replica::log::EndpointId(1),
        verify: true,
        runtime_version: "test".into(),
        trusted_roots: vec![signed_root()],
        e2e: false,
        trusted_signers: vec![OWNER_DEV, HOSTED_DEV, ESCROW_DEV],
        user_enabled_cloud_copy: false,
        chosen_state: None,
        key_grants_only: false,
        expected_genesis: None,
        policy_pins: None,
    };
    let mut d = Replica::open(
        cfg,
        MemStore::new(),
        Box::new(mdbn_replica::plan::CorePlanner),
        Box::new(SignedControlPlain::for_device(OWNER_DEV)),
        Host {
            clock: Box::new(TestClock(clock.clone())),
            entropy: Box::new(mdbn_replica::crypto::TestEntropy::new(9)),
            zones: Box::new(UtcOnly),
        },
        DeviceSecrets {
            sign_sk: [9; 32],
            kem_sk: [9; 32],
        },
    )
    .unwrap();
    d.begin_adopt(Box::new(Folder));
    let mut log = svc.client(OWNER_DEV);
    let session = d
        .bind_authenticated_log(mdbn_replica::log::EndpointId(1), COL)
        .unwrap();
    for _ in 0..1_000 {
        clock.set(clock.get() + 1_000);
        d.tick();
        loop {
            let calls = d.take_authenticated_log_calls(&session).unwrap();
            if calls.is_empty() {
                break;
            }
            for (c, scope) in calls {
                let reply = log.call(c.request);
                let _ = d.on_authenticated_log_reply(scope, |_, _| reply);
            }
        }
        if d.adopt_status() != Some(AdoptStatus::Pending) {
            break;
        }
    }
    assert_eq!(d.adopt_status(), Some(AdoptStatus::Done));
}

fn key_grants_to(svc: &FakeLogService, device: B16) -> usize {
    svc.items(&COL)
        .iter()
        .filter_map(|raw| Item::from_bytes(raw).ok())
        .filter(|i| i.kind == ItemKind::KeyGrant)
        .filter(|i| KeyGrantPayload::from_bytes(&i.body.0).is_ok_and(|g| g.recipient == device))
        .count()
}

/// A served cloud copy of [`RECORDS`] notes whose catalog just changed: the
/// hosted engine is repairing record metadata and not serving.
fn repairing(svc: &FakeLogService) -> Hosted<LogCache<DoIndex>> {
    adopt(svc);
    let index = Rc::new(RefCell::new(DoIndex::new(Box::new(DoHost(Sqlite::new())))));
    let mut h = open_store(
        svc,
        LogCache::open(index, SqlStoreLimits::default()).unwrap(),
        2,
    );
    h.pump_pushless();
    assert!(h.e.serving());
    assert_eq!(
        h.e.replica().confirmed_records().unwrap().len() as u64,
        RECORDS
    );
    // An app provisions another type: every record's metadata is checked again.
    let (session, _) = h.e.hello(None, &hello());
    h.e.frame(
        session,
        &submit_op(
            1,
            Op::ResourcePut(ResourcePut {
                path: "_types/other.md".into(),
                doc: Text::Inline(type_doc("other")),
                base_revision: None,
                must_not_exist: None,
            }),
        ),
    );
    h.pump_pushless();
    assert!(
        !h.e.serving(),
        "the record-metadata repair runs over alarms"
    );
    h
}

/// One alarm: the Worker ticks, then syncs.
fn alarm(h: &mut Hosted<LogCache<DoIndex>>) {
    h.clock.set(h.clock.get() + 1_000);
    h.e.tick(h.clock.get() as i64, false);
    h.pump_pushless();
}

#[test]
fn a_joining_device_is_keyed_during_a_record_metadata_repair() {
    let (svc, mut cp) = world_with_cp();
    let mut h = repairing(&svc);
    cp.enrol(
        &svc,
        TestDevice {
            device: JOINING,
            account: TEST_OWNER,
            kind: DeviceKind::Desktop,
        },
    );
    // The control plane's activation: a fresh head on the bound session, one sync.
    assert!(h.e.request_log_head());
    h.pump_pushless();
    assert_eq!(
        key_grants_to(&svc, JOINING),
        1,
        "granted in the activation's own sync"
    );
    assert!(!h.e.serving(), "while the repair still runs");
    let mut alarms = 0;
    while !h.e.serving() {
        alarms += 1;
        assert!(alarms < 100, "the repair finishes");
        alarm(&mut h);
    }
    assert!(alarms > 1, "the repair spans several alarms at this size");
    assert_eq!(h.e.applied_head().0, svc.head(&COL).0);
}

#[test]
fn entries_wait_for_the_repair_without_rereading_the_log() {
    let (svc, _) = world_with_cp();
    let mut h = repairing(&svc);
    let held = h.e.applied_head();
    // Another wake instance writes an entry while this one repairs.
    let mut writer = open_with_entropy(&svc, 7);
    for _ in 0..8 {
        writer.pump(false);
        writer.e.tick(writer.clock.get() as i64, false);
    }
    assert!(writer.e.serving());
    let (session, _) = writer.e.hello(None, &hello());
    writer.e.frame(session, &submit(2, "during-repair.md"));
    writer.pump(false);
    assert_eq!(svc.head(&COL).0, held.0 + 1);

    assert!(h.e.request_log_head());
    let mut reads = 0;
    for _ in 0..8 {
        for c in h.e.take_log_calls() {
            reads += usize::from(matches!(c.request, LogRequest::Read(_)));
            let reply = h.log.call(c.request);
            let _ = h.e.on_log_reply(c.id, reply);
        }
    }
    assert_eq!(h.e.applied_head(), held, "content waits for the repair");
    assert_eq!(
        reads, 1,
        "one read finds the entry; no read loop while held"
    );
    let mut alarms = 0;
    while !h.e.serving() {
        alarms += 1;
        assert!(alarms < 100, "the repair finishes and the entry applies");
        alarm(&mut h);
    }
    assert_eq!(h.e.applied_head().0, held.0 + 1);
}
