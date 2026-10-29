//! A retained earlier-SEM tail, signed and encrypted, replayed on fresh replicas.
use mdbn_replica::{
    crypto::{TestEntropy, blob, keys::Keyring},
    log::{LogClient, LogRequest},
    seal::{KeyringSealer, Sealer},
    store::{Store, meta_keys},
    testkit::TestControlPlane,
};
use mdbn_wire::{
    attachment::FileContent,
    attachment_runtime_v1 as rt,
    common::{B16, B32, Bytes, Text, Version},
    entry::{Effect, PutFile, PutRecord, Status},
    envelope::{Item, ItemKind},
    intent::{DocVersion, Document, FilePut, Op, OpClock, Source},
    ordinary_file_promotion::{OrdinaryFileToRecord, ReindexOrdinaryFile},
    policy::CState,
    schema::Wire,
    unindexed_markdown::{
        PutUnindexedMarkdown, RecordToUnindexedMarkdown, ReindexUnindexedMarkdown,
        UnindexedMarkdownPayloadV1, UnindexedMarkdownPut, UnindexedMarkdownToRecord,
    },
};

use crate::{
    oracle::Kind,
    platform::{MacOs, Os},
    sut::{
        logsvc::LogService,
        node::{Node, NodeCfg},
    },
    world::{HookCfg, World},
};

/// Keep all four native kinds in the tail while fresh current-SEM nodes join.
pub fn run(world: &mut World) -> String {
    let collection = B16([0x73; 16]);
    let device = B16([0x20; 16]);
    let keys = ([0x31; 32], [0x32; 32]);
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
    let machine = world.add_machine("sem-replica-0", Os::Linux, HookCfg::default());
    let actor = world.actor_count() as u32;
    let mut nodes = vec![world.spawn(Box::new(Node::new(
        "sem-replica-0",
        machine,
        actor,
        service,
        NodeCfg {
            collection,
            replica_id: B16([0x10; 16]),
            device,
            work: false,
            work_every_ms: 150,
            reconnect_storm: false,
            snapshot_every: None,
            trusted: vec![device],
            keys: Some(keys),
        },
    )))];
    world.run_chaos(4_000);
    let replica = world.actor::<Node>(nodes[0]).unwrap().replica().unwrap();
    let saved = replica.store().meta(meta_keys::KEYRING).unwrap().unwrap();
    let size = u64::from_be_bytes(saved[..8].try_into().unwrap()) as usize;
    let ring = Keyring::from_bytes(&saved[8..8 + size]).unwrap();
    let (epoch, key) = ring.latest().unwrap();
    let mut entropy = TestEntropy::new(73);
    let mut sealer = KeyringSealer::new(collection, device, &keys.0, &keys.1);
    sealer.import(&saved).unwrap();
    sealer.set_epoch(epoch);
    let mut refs = Vec::new();
    let mut object_log = log.client(device);
    let mut content = |bytes: &[u8]| {
        let (descriptor, parts) = blob::seal_blob(
            key,
            epoch,
            &collection,
            bytes,
            blob::MIN_PART_SIZE,
            false,
            &mut entropy,
        )
        .unwrap();
        for part in parts {
            refs.push(part.address);
            object_log
                .call(LogRequest::PutObject {
                    collection,
                    address: part.address,
                    kind: ItemKind::BlobPart,
                    bytes: part.bytes,
                })
                .unwrap();
        }
        FileContent::Blob(descriptor)
    };
    let oversized = UnindexedMarkdownPayloadV1 {
        content: content(&vec![b'x'; 1_048_577]),
    };
    let ordinary = content(b"small\n");
    let FileContent::Blob(ordinary_blob) = &ordinary else {
        unreachable!()
    };
    let record = B16([50; 16]);
    let file = B16([51; 16]);
    let unindexed = B16([52; 16]);
    let mut tail = vec![(
        vec![
            rt::Op::Legacy(Op::Document(Document {
                id: record,
                base: None,
                new: Some(DocVersion {
                    path: "record.md".into(),
                    doc: Text::Inline("small\n".into()),
                }),
                if_revision: None,
            })),
            rt::Op::Legacy(Op::FilePut(FilePut {
                id: file,
                path: "ordinary.md".into(),
                blob: ordinary_blob.clone(),
                if_revision: None,
                base: None,
            })),
        ],
        vec![
            rt::Effect::Legacy(Effect::PutRecord(PutRecord {
                id: record,
                path: "record.md".into(),
                doc: Text::Inline("small\n".into()),
            })),
            rt::Effect::Legacy(Effect::PutFile(PutFile {
                id: file,
                path: "ordinary.md".into(),
                blob: ordinary_blob.clone(),
            })),
        ],
    )];
    tail.push((
        vec![rt::Op::UnindexedMarkdownPut(UnindexedMarkdownPut {
            id: unindexed,
            path: "huge.md".into(),
            payload: oversized.clone(),
            expected: None,
        })],
        vec![rt::Effect::PutUnindexedMarkdown(PutUnindexedMarkdown {
            id: unindexed,
            path: "huge.md".into(),
            payload: oversized.clone(),
        })],
    ));
    tail.push((
        vec![rt::Op::RecordToUnindexedMarkdown(
            RecordToUnindexedMarkdown {
                id: record,
                path: "record.md".into(),
                payload: oversized.clone(),
                prior_revision: mdbn_wire::hash::sha256(b"small\n"),
            },
        )],
        vec![rt::Effect::PutUnindexedMarkdown(PutUnindexedMarkdown {
            id: record,
            path: "record.md".into(),
            payload: oversized.clone(),
        })],
    ));
    tail.push((
        vec![rt::Op::UnindexedMarkdownToRecord(
            UnindexedMarkdownToRecord {
                id: unindexed,
                path: "huge.md".into(),
                doc: Text::Inline("small\n".into()),
                prior: oversized,
            },
        )],
        vec![rt::Effect::ReindexUnindexedMarkdown(
            ReindexUnindexedMarkdown {
                id: unindexed,
                path: "huge.md".into(),
                doc: Text::Inline("small\n".into()),
            },
        )],
    ));
    tail.push((
        vec![rt::Op::OrdinaryFileToRecord(OrdinaryFileToRecord {
            id: file,
            path: "ordinary.md".into(),
            doc: Text::Inline("small\n".into()),
            prior: ordinary,
        })],
        vec![rt::Effect::ReindexOrdinaryFile(ReindexOrdinaryFile {
            id: file,
            path: "ordinary.md".into(),
            doc: Text::Inline("small\n".into()),
        })],
    ));
    for (ops, effects) in tail {
        let (seq, chain) = log.head(&collection);
        let payload = rt::EntryPayload {
            sem: Version { major: 1, minor: 0 },
            mutation: rt::Mutation {
                id: B16([seq as u8; 16]),
                origin: B16([0x70; 16]),
                base_seq: seq,
                clock: OpClock {
                    instant: 0,
                    tz: "UTC".into(),
                    local_date: "1970-01-01".into(),
                },
                seed: B32([73; 32]),
                source: Source::Api,
                ops,
                on_behalf: None,
                conflict_mode: None,
                validated_at: None,
                room: None,
            },
            status: Status::Applied,
            effects,
            conflicts: None,
            aliases: None,
            texts: None,
            resurrect: None,
        };
        let mut item = Item {
            kind: ItemKind::Entry,
            collection,
            seq: Some(seq + 1),
            prev: Some(chain),
            epoch: None,
            signer: Some(device),
            salt: None,
            idem: Some(B16([seq as u8; 16])),
            refs: Some(refs.clone()),
            stream: None,
            body: Bytes(vec![]),
            sig: None,
        };
        let plain = payload.to_bytes().unwrap();
        assert_eq!(rt::EntryPayload::from_bytes(&plain).unwrap(), payload);
        sealer.seal(&mut item, &plain, false, &mut entropy).unwrap();
        log.push_raw(&collection, item.to_bytes().unwrap());
    }
    world.crash(nodes[0]);
    for (index, os) in [(1, Os::MacOs(MacOs::apfs())), (2, Os::Windows)] {
        let name = format!("sem-replica-{index}");
        let machine = world.add_machine(&name, os, HookCfg::default());
        let actor = world.actor_count() as u32;
        nodes.push(world.spawn(Box::new(Node::new(
            &name,
            machine,
            actor,
            service,
            NodeCfg {
                collection,
                replica_id: B16([0x10 + index; 16]),
                device,
                work: false,
                work_every_ms: 150,
                reconnect_storm: false,
                snapshot_every: None,
                trusted: vec![device],
                keys: Some(keys),
            },
        ))));
    }
    world.timer(service, 0, crate::sut::logsvc::FLUSH_PUSHES);
    if !world.quiesce(200, 5, 60_000) {
        world.shared.violate(
            Kind::NoQuiesce,
            "earlier-SEM replicas did not settle".into(),
        );
    }
    let target = log.head(&collection).0;
    let mut digests = Vec::new();
    for actor in nodes {
        let replica = world.actor::<Node>(actor).unwrap().replica().unwrap();
        let records = replica.confirmed_records().unwrap();
        let files = replica
            .store()
            .files(mdbn_replica::store::Page {
                after: None,
                limit: 100,
            })
            .unwrap();
        let policy = mdbn_replica::policy::PolicyState::from_bytes(
            &replica.store().meta(meta_keys::POLICY).unwrap().unwrap(),
        )
        .unwrap();
        if replica.head().seq != target
            || records.len() != 2
            || files.len() != 1
            || policy.voids != 0
            || records.iter().any(|row| row.doc != "small\n")
            || !records
                .iter()
                .any(|row| row.id == file && row.path == "ordinary.md")
            || !records
                .iter()
                .any(|row| row.id == unindexed && row.path == "huge.md")
            || !files.iter().any(|row| {
                row.id == record
                    && row.path == "record.md"
                    && row.kind
                        == mdbn_wire::unindexed_markdown::FileKindV1::UnindexedOversizedMarkdown
                    && row.content.size() == 1_048_577
            })
        {
            world.shared.violate(
                Kind::Divergence,
                format!("earlier-SEM replica stopped: {:?}", replica.sync_status()),
            );
        }
        let files = files
            .into_iter()
            .map(|row| (row.id, row.path, row.kind, row.content, row.modified_seq))
            .collect::<Vec<_>>();
        digests.push((replica.head(), records, files));
    }
    if digests.windows(2).any(|pair| pair[0] != pair[1]) {
        world
            .shared
            .violate(Kind::Divergence, "earlier-SEM replicas disagree".into());
    }
    format!("{{\"replicas\":3,\"head\":{target},\"native_kinds\":4,\"records\":2,\"files\":1}}")
}

#[cfg(test)]
mod tests {
    #[test]
    fn retained_previous_sem_native_tail_converges() {
        let report = crate::scenario::run_seed(
            "semantics-retained-native",
            73,
            &crate::scenario::Opts::default(),
        )
        .unwrap();
        assert!(report.violations.is_empty(), "{report:?}");
        assert_eq!(
            report.state,
            include_str!("../../../../conformance/determinism/retained-native.expected.json")
                .trim()
        );
    }
}
