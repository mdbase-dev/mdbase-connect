//! Qualification-only native fixture for the real TS HostLoop/HostDriver.
//! Not a production/public RPC, WASM binding, plugin or durability provider.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]
use mdbn_core::host::Clock;
use mdbn_local_host::{Identity, OsEntropy, SystemZones};
use mdbn_platform_native::SqliteIndex;
use mdbn_replica::api::{ClientApi, SessionAuth, Target};
use mdbn_replica::log::EndpointId;
use mdbn_replica::plan::CorePlanner;
use mdbn_replica::seal::KeyringSealer;
use mdbn_replica::store::Store;
use mdbn_replica::{Host, Replica, ReplicaConfig};
use mdbn_store_file::codec::IntentRec;
use mdbn_store_file::diskdb::{DiskDb, Kind, SqlDiskDb};
use mdbn_store_file::host::{HostQueue, OpId, QueuedPlatform};
use mdbn_store_file::index::IndexDurability;
use mdbn_store_file::platform::{
    Capabilities, CaseSensitivity, Durability, EventFidelity, ReplaceStrategy,
};
use mdbn_store_file::{Config, FileStore, SqlStore};
use mdbn_wire::client::{
    Confirmation, HelloParams, Include, PublishState, ReceiptState, SubmitParams, SyncMode,
};
use mdbn_wire::common::{B16, DataMap, Text, Value, Version};
use mdbn_wire::hash::sha256;
use mdbn_wire::intent::{Create, Op};
use serde_json::{Value as Json, json};
use std::cell::{Cell, RefCell};
use std::collections::BTreeSet;
use std::future::Future;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::rc::Rc;
use std::task::{Context, Poll, Waker};
#[path = "queued-ts-host-proof/transport.rs"]
mod transport;

#[derive(Clone)]
struct HostClock(Rc<Cell<u64>>);
impl Clock for HostClock {
    fn now_ms(&self) -> u64 {
        self.0.get()
    }
}
struct Bridge {
    input: BufReader<std::fs::File>,
    output: std::fs::File,
    clock: HostClock,
    emitted: BTreeSet<OpId>,
    pre_io_receipt: Option<Json>,
}
impl Bridge {
    fn command(&mut self) -> Json {
        let mut line = String::new();
        let count = (&mut self.input)
            .take(1024 * 1024 + 1)
            .read_line(&mut line)
            .unwrap();
        assert!(
            count > 0 && count <= 1024 * 1024,
            "bounded owned fixture command"
        );
        serde_json::from_str(&line).unwrap()
    }
    fn reply(&mut self, mut value: Json) {
        if let Some(witness) = &self.pre_io_receipt {
            value["preIoReceipt"] = witness.clone();
        }
        writeln!(self.output, "{}", value).unwrap();
        self.output.flush().unwrap();
    }
    fn drive<T>(
        &mut self,
        stage: &str,
        queue: &HostQueue,
        mut poll: impl FnMut(u64) -> (Poll<mdbn_replica::store::StoreResult<T>>, Option<u64>),
    ) -> T {
        for _ in 0..8192 {
            let command = self.command();
            match command["op"].as_str().unwrap() {
                "Complete" => {
                    queue.complete(
                        OpId(command["id"].as_str().unwrap().parse().unwrap()),
                        transport::completion(&command["done"]),
                    );
                }
                "Poll" => {
                    let now = command["now"].as_u64().unwrap();
                    self.clock.0.set(now);
                    let (result, wake) = poll(now);
                    let requests = queue.take_requests();
                    let requests = requests
                        .into_iter()
                        .map(|(id, op)| {
                            assert!(self.emitted.insert(id), "ORIGINAL IO never restarts");
                            json!({"id":id.0.to_string(),"op":transport::request(op)})
                        })
                        .collect::<Vec<_>>();
                    match result {
                        Poll::Pending => {
                            assert!(
                                !requests.is_empty() || queue.in_flight() > 0 || wake.is_some(),
                                "pending owns actual IO or an actual timer"
                            );
                            self.reply(json!({"stage":stage,"ready":false,"wake":wake,"requests":requests}));
                        }
                        Poll::Ready(result) => {
                            assert!(requests.is_empty());
                            assert_eq!(queue.in_flight(), 0);
                            self.reply(
                                json!({"stage":stage,"ready":true,"wake":null,"requests":[]}),
                            );
                            return result.unwrap();
                        }
                    }
                }
                _ => panic!("unknown private fixture command"),
            }
        }
        panic!("bounded original fixture drive exhausted");
    }
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn main() {
    let root = PathBuf::from(std::env::args().nth(1).expect("owned qualification root"));
    let mode = std::env::args().nth(2).unwrap_or_else(|| "success".into());
    assert!(
        mode == "success" || mode == "cas-drift",
        "bounded fixture scenario"
    );
    assert!(root.is_absolute());
    assert!(
        root.file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("joint-host-")
    );
    assert_eq!(
        std::fs::read_to_string(root.join("fixture-owner")).unwrap(),
        "queued-ts-host-proof-v1"
    );
    let state = root.join("core-state");
    std::fs::create_dir(&state).unwrap();
    let clock = HostClock(Rc::new(Cell::new(0)));
    // Ordered FIFO open handshake. All collection IO goes to the REAL TS host.
    let input = BufReader::new(
        std::fs::OpenOptions::new()
            .read(true)
            .open(root.join("to-core"))
            .unwrap(),
    );
    let output = std::fs::OpenOptions::new()
        .write(true)
        .open(root.join("from-core"))
        .unwrap();
    let mut bridge = Bridge {
        input,
        output,
        clock: clock.clone(),
        emitted: BTreeSet::new(),
        pre_io_receipt: None,
    };
    // Exact VaultPlatform declaration: guarded, no fsync or inode identity.
    let caps = Capabilities {
        replace: ReplaceStrategy::GuardedInPlace,
        exclusive_create: false,
        durability: Durability::None,
        case: CaseSensitivity::Sensitive,
        file_ids: false,
        mtime_resolution_ns: 1_000_000,
        events: EventFidelity::Hint,
        transient_missing: false,
        private_dir: mdbn_store_file::platform::RelPath::new(".mdbase").unwrap(),
    };
    let (platform, queue) = QueuedPlatform::new(caps);
    let index = Rc::new(RefCell::new(
        SqliteIndex::open(state.join("index.sqlite"), IndexDurability::Durable).unwrap(),
    ));
    let mut opening = FileStore::start_open(
        Rc::new(platform),
        SqlStore::open(index.clone()).unwrap(),
        SqlDiskDb::open(index.clone()).unwrap(),
        Box::new(clock.clone()),
        Config {
            quiescence_ms: 0,
            move_window_ms: 0,
            queued_publication: true,
            ..Config::default()
        },
    );
    let store = bridge.drive("opening", &queue, |now| {
        let result = opening.poll(now);
        (result, opening.next_wakeup())
    });
    let identity =
        Identity::load_or_create(&state.join("identity.json"), 1, &mut OsEntropy).unwrap();
    let cfg = ReplicaConfig {
        collection: identity.collection,
        replica_id: identity.replica_id,
        device_id: identity.device_id,
        mode: SyncMode::LocalOnly,
        log_endpoint: EndpointId(0),
        verify: false,
        runtime_version: env!("CARGO_PKG_VERSION").into(),
        trusted_roots: Vec::new(),
        e2e: false,
        trusted_signers: vec![identity.device_id],
        user_enabled_cloud_copy: false,
        chosen_state: None,
        expected_genesis: None,
        policy_pins: None,
        key_grants_only: false,
    };
    let sealer = KeyringSealer::new(
        identity.collection,
        identity.device_id,
        &identity.secrets.sign_sk,
        &identity.secrets.kem_sk,
    );
    let host = Host {
        clock: Box::new(clock.clone()),
        entropy: Box::new(OsEntropy),
        zones: Box::new(SystemZones::default()),
    };
    let mut replica = Replica::open(
        cfg,
        store,
        Box::new(CorePlanner),
        Box::new(sealer),
        host,
        identity.secrets.clone(),
    )
    .unwrap();
    let (session, _) = replica
        .hello(
            SessionAuth::Host,
            HelloParams {
                versions: vec![Version { major: 1, minor: 0 }],
                client_name: "owned-ts-host-qualification".into(),
                client_version: "1".into(),
                features: None,
                timezone: None,
            },
        )
        .unwrap();
    {
        let mut observe = std::pin::pin!(replica.observe_async(None));
        // With zero quiet/move windows and present originals this scan suspends
        // ONLY on original HostQueue IO, never a guessed wake-up.
        bridge.drive("rescan", &queue, |_| {
            (
                observe
                    .as_mut()
                    .poll(&mut Context::from_waker(Waker::noop())),
                None,
            )
        });
    }
    let bundle: Json = serde_json::from_slice(include_bytes!(
        "../tests/fixtures/reader-semantic-digests/bundle.json"
    ))
    .unwrap();
    let resources = bundle["resources"].as_array().unwrap();
    assert_eq!(resources.len(), 8);
    let mut witnesses = Vec::new();
    for resource in resources {
        let path = resource["path"].as_str().unwrap();
        let document = resource["document"].as_str().unwrap();
        let read = replica.get_resource(session, path.into()).unwrap();
        assert!(read.confirmed);
        assert_eq!(read.text, document);
        assert_eq!(read.revision, sha256(document.as_bytes()));
        witnesses.push(json!({"path":path,"document":read.text,"revision":hex(&read.revision.0),"confirmed":read.confirmed}));
    }
    let describe = replica.describe(session).unwrap();
    assert_eq!(describe.contracts.len(), 3);
    assert!(describe.issues.is_empty());
    let contracts=describe.contracts.into_iter().map(|c|json!({"id":c.id,"version":c.version,"digest":hex(&c.digest.0),"implementedBy":c.implemented_by})).collect::<Vec<_>>();
    let id = B16(mdbn_local_host::host::uuid_v7(
        clock.now_ms(),
        &mut OsEntropy,
    ));
    let mid = B16(mdbn_local_host::host::uuid_v7(
        clock.now_ms(),
        &mut OsEntropy,
    ));
    let receipts = replica
        .submit(
            session,
            SubmitParams {
                ops: vec![Op::Create(Create {
                    id,
                    path: Some("notes/original.md".into()),
                    type_name: None,
                    frontmatter: Some(DataMap(vec![(
                        "title".into(),
                        Value::Text("Original TS host document".into()),
                    )])),
                    body: Some(Text::Inline("ORIGINAL TS host publication body.\n".into())),
                    document: None,
                })],
                mutation_id: Some(mid),
                conflict_mode: None,
                timezone: None,
                allow_partial: None,
                mutation_ids: None,
                dry_run: None,
                include: None,
                wait: None,
            },
        )
        .unwrap();
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0].mutation, mid);
    let pending = replica.receipt(session, mid).unwrap();
    assert_ne!(pending.published, Some(PublishState::Published));
    assert!(replica.publish_waits_open() > 0);
    assert_eq!(pending.mutation, mid);
    assert_eq!(
        queue.in_flight(),
        0,
        "no host work before original queued drive"
    );
    bridge.pre_io_receipt = Some(
        json!({"id":hex(&id.0),"mutation":hex(&pending.mutation.0),"state":format!("{:?}",pending.state),"published":pending.published.map(|p|format!("{p:?}")),"hostInFlight":queue.in_flight(),"publicationWaits":replica.publish_waits_open()}),
    );
    let mut original_intents = std::collections::BTreeMap::new();
    {
        let mut progress = replica.store_mut().start_progress();
        bridge.drive("publication", &queue, |now| {
            let result = progress.poll(now);
            for (kind, _, bytes) in SqlDiskDb::open(index.clone()).unwrap().load().unwrap() {
                if kind == Kind::Intent {
                    let intent = IntentRec::from_bytes(&bytes).unwrap();
                    if let Some(original) = original_intents.get(&intent.n) {
                        assert_eq!(original, &bytes);
                    } else {
                        original_intents.insert(intent.n, bytes);
                    }
                }
            }
            (result, progress.next_wakeup())
        });
    }
    assert_eq!(original_intents.len(), 1);
    replica.on_store_progress();
    let receipt = replica.receipt(session, mid).unwrap();
    assert_eq!(receipt.mutation, mid);
    assert_eq!(receipt.state, ReceiptState::Confirmed);
    if mode == "cas-drift" {
        assert_eq!(receipt.published, Some(PublishState::NotPublished));
        assert_eq!(replica.publish_waits_open(), 0);
        assert!(replica.store_mut().take_publish_results().is_empty());
        assert_eq!(queue.in_flight(), 0);
        assert!(queue.take_requests().is_empty());
        let command = bridge.command();
        assert_eq!(command["op"], "Poll");
        bridge.reply(json!({"stage":"done","ready":true,"wake":null,"requests":[],"outcome":"cas-drift","resources":witnesses,"contracts":contracts,"record":{"id":hex(&id.0),"mutation":hex(&mid.0),"receiptMutation":hex(&receipt.mutation.0),"published":false,"confirmed":true},"originalIntents":original_intents.len(),"inFlight":queue.in_flight(),"qualification":"joined-ts-host-native-filestore-original-cas-refusal-not-wasm-obsidian-or-durability"}));
        return;
    }
    assert_eq!(receipt.published, Some(PublishState::Published));
    assert!(receipt.seq.is_none());
    let read = replica
        .get(
            session,
            Target::Id(id),
            Include {
                effective: None,
                body: Some(true),
                document: Some(true),
                diagnostics: Some(true),
            },
        )
        .unwrap();
    assert_eq!(read.id, id);
    assert_eq!(read.state.state, Confirmation::Confirmed);
    assert!(read.state.hold.is_none());
    assert_eq!(read.state.unresolved.unwrap_or(0), 0);
    assert_eq!(
        read.body.as_deref(),
        Some("ORIGINAL TS host publication body.\n")
    );
    let document = read.document.unwrap();
    assert_eq!(read.revision, sha256(document.as_bytes()));
    assert_eq!(replica.publish_waits_open(), 0);
    assert!(replica.store_mut().take_publish_results().is_empty());
    assert_eq!(queue.in_flight(), 0);
    let command = bridge.command();
    assert_eq!(command["op"], "Poll");
    bridge.reply(json!({"stage":"done","ready":true,"wake":null,"requests":[],"outcome":"published","resources":witnesses,"contracts":contracts,"record":{"id":hex(&id.0),"mutation":hex(&mid.0),"receiptMutation":hex(&receipt.mutation.0),"published":true,"confirmed":true,"document":document,"revision":hex(&read.revision.0)},"originalIntents":original_intents.len(),"inFlight":queue.in_flight(),"qualification":"joined-ts-host-native-filestore-local-only-not-wasm-obsidian-or-durability"}));
}
