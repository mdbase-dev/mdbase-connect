//! Actual install reply routing only; no production install flag/crypto acceptance.
use super::*;
use crate::mem::MemStore;
use crate::seal::{PlainSealer, Sealer};
use crate::store::{RecordMeta, Stage};
use crate::{DeviceSecrets, Host, ReplicaConfig, UtcOnly};
use mdbn_core::host::Clock;
use mdbn_wire::common::{B16, B64};
use std::collections::BTreeSet;
const COL: B16 = B16([7; 16]);
const DEVICE: B16 = B16([101; 16]);
const OLD: B16 = B16([9; 16]);
const STAGED: B16 = B16([10; 16]);
struct FixedClock;
impl Clock for FixedClock {
    fn now_ms(&self) -> u64 {
        1_700_000_000_000
    }
}
fn row(id: B16, path: &str) -> RecordRow {
    let doc = "prior bytes\n".to_owned();
    RecordRow {
        id,
        path: path.into(),
        path_key: path.into(),
        revision: mdbn_wire::hash::sha256(doc.as_bytes()),
        doc,
        modified_seq: 7,
        bucket: bucket16(&id),
        meta: RecordMeta::default(),
    }
}
pub(super) fn replica() -> Replica<MemStore> {
    let mut store = MemStore::new();
    store
        .commit(Tx {
            records_put: vec![row(OLD, "prior.md")],
            head: Some(Head {
                seq: 7,
                chain: B32([7; 32]),
            }),
            ..Tx::default()
        })
        .unwrap();
    let mut sealer = PlainSealer::for_device(DEVICE);
    sealer.import(&1u64.to_be_bytes()).unwrap();
    let cfg = ReplicaConfig {
        collection: COL,
        replica_id: B16([1; 16]),
        device_id: DEVICE,
        mode: mdbn_wire::client::SyncMode::Synced,
        log_endpoint: crate::log::EndpointId(1),
        verify: true,
        runtime_version: "unknown-payload-test".into(),
        trusted_roots: vec![],
        e2e: false,
        trusted_signers: vec![DEVICE],
        user_enabled_cloud_copy: false,
        chosen_state: None,
        expected_genesis: None,
        policy_pins: None,
        key_grants_only: false,
    };
    let mut r = Replica::open(
        cfg,
        store,
        Box::new(crate::plan::CorePlanner),
        Box::new(sealer),
        Host {
            clock: Box::new(FixedClock),
            entropy: Box::new(crate::crypto::TestEntropy::new(1)),
            zones: Box::new(UtcOnly),
        },
        DeviceSecrets {
            sign_sk: [1; 32],
            kem_sk: [1; 32],
        },
    )
    .unwrap();
    assert!(r.incidents.is_empty());
    r.store
        .commit(Tx {
            records_put: vec![row(STAGED, "staged.md")],
            stage: Stage::Put,
            ..Tx::default()
        })
        .unwrap();
    assert_eq!(r.store.staged_rows(), 1);
    r.install_staged.records_put.push(row(STAGED, "staged.md"));
    r.install_mseq.insert(STAGED, 42);
    r.install_resources
        .push(("mdbase.yaml".into(), "staged resource".into()));
    r
}
pub(super) fn object(kind: ItemKind, payload: &Cbor) -> Vec<u8> {
    let mut item = object_item(kind, COL, 1);
    item.salt = Some(B16([0; 16]));
    item.body = Bytes(cbor::encode(payload).unwrap());
    if kind == ItemKind::Manifest {
        item.signer = Some(DEVICE);
        item.sig = Some(B64([0; 64]));
    }
    item.to_bytes().unwrap()
}
pub(super) fn response(bytes: Vec<u8>) -> crate::log::LogReply {
    Ok(LogResponse::GetObject {
        size: bytes.len() as u64,
        checksum: mdbn_wire::hash::sha256(&bytes),
        bytes,
    })
}
fn field(c: &Cbor, key: u64, value: Cbor) -> Cbor {
    let Cbor::Map(m) = c else { panic!() };
    let mut m = m.clone();
    m.retain(|(k, _)| *k != Cbor::Uint(key));
    m.push((Cbor::Uint(key), value));
    m.sort_by_key(|(k, _)| if let Cbor::Uint(n) = k { *n } else { panic!() });
    Cbor::Map(m)
}
pub(super) fn manifest() -> ManifestPayload {
    let f = mdbn_wire::fixtures::all()
        .into_iter()
        .find(|f| f.format == "manifest")
        .unwrap();
    ManifestPayload::from_bytes(&f.bytes).unwrap()
}
fn manifest_reply(r: &mut Replica<MemStore>, payload: &Cbor) {
    let bytes = object(ItemKind::Manifest, payload);
    r.install = Some(Install::Manifest(SnapshotPointer {
        seq: 42,
        manifest: mdbn_wire::hash::sha256(&bytes),
        author: DEVICE,
        created_at: 0,
        endorsed: true,
    }));
    r.on_install_reply(response(bytes));
}
fn chunk_reply(r: &mut Replica<MemStore>, payload: &Cbor) {
    chunk_reply_kind(r, payload, SectionKind::Legacy(L::Records));
}
fn chunk_reply_kind(r: &mut Replica<MemStore>, payload: &Cbor, kind: SectionKind) {
    let bytes = object(ItemKind::Chunk, payload);
    let plain = cbor::encode(payload).unwrap();
    let cref = ChunkRef {
        address: mdbn_wire::hash::sha256(&bytes),
        plain_hash: mdbn_wire::hash::sha256(&plain),
        rows: 0,
        bucket: 0,
        plain_size: plain.len() as u64,
    };
    r.install = Some(Install::Chunks {
        manifest: Box::new(manifest()),
        queue: vec![(kind, cref)],
        next: 0,
    });
    r.on_install_reply(response(bytes));
}
pub(super) fn assert_prior(r: &Replica<MemStore>, kind: IncidentKind, cleaned: bool) {
    assert!(r.install.is_none());
    assert_eq!(
        r.head,
        Head {
            seq: 7,
            chain: B32([7; 32])
        }
    );
    assert_eq!(r.store.head().unwrap(), r.head);
    assert_eq!(r.store.record(&OLD).unwrap(), Some(row(OLD, "prior.md")));
    assert!(r.store.record(&STAGED).unwrap().is_none());
    assert_eq!(r.incidents.len(), 1);
    assert_eq!(r.incidents.values().next().unwrap().kind, kind);
    if cleaned {
        assert_eq!(r.store.staged_rows(), 0);
        assert!(r.install_staged.records_put.is_empty());
        assert!(r.install_mseq.is_empty());
        assert!(r.install_resources.is_empty());
    }
}
#[test]
fn unknown_manifest_versions_and_sections_upgrade_whole_install_preserving_prior_state() {
    let good = manifest().to_cbor();
    // fmt 2 is the ref-indexed manifest (snapshot.md §2.1); 3 is still unknown.
    for bad in [
        field(&good, 0, Cbor::Uint(3)),
        field(
            &good,
            5,
            Cbor::Array(vec![Cbor::Map(vec![
                (Cbor::Uint(0), Cbor::Uint(14)),
                (Cbor::Uint(1), Cbor::Array(vec![])),
            ])]),
        ),
        field(
            &good,
            5,
            Cbor::Array(vec![Cbor::Map(vec![
                (Cbor::Uint(0), Cbor::Uint(15)),
                (Cbor::Uint(1), Cbor::Array(vec![])),
            ])]),
        ),
    ] {
        assert!(ManifestPayload::from_cbor(&bad).unwrap_err().is_unknown());
        let mut r = replica();
        manifest_reply(&mut r, &bad);
        assert_prior(&r, IncidentKind::UpgradeRequired, true);
    }
}
#[test]
fn unknown_chunk_versions_and_sections_upgrade_whole_install_preserving_prior_state() {
    let good = ChunkPayload {
        section: SectionKind::Legacy(L::Records),
        bucket: 0,
        rows: vec![],
    }
    .to_cbor();
    for bad in [
        field(&good, 0, Cbor::Uint(2)),
        field(&good, 1, Cbor::Uint(14)),
        field(&good, 1, Cbor::Uint(15)),
    ] {
        assert!(ChunkPayload::from_cbor(&bad).unwrap_err().is_unknown());
        let mut r = replica();
        chunk_reply(&mut r, &bad);
        assert_prior(&r, IncidentKind::UpgradeRequired, true);
    }
}
#[test]
fn decoded_native_sections_still_require_authenticated_manifest_and_complete_digest() {
    for kind in [
        SectionKind::UnindexedMarkdownFiles,
        SectionKind::UnindexedMarkdownTombstones,
    ] {
        let m = field(
            &manifest().to_cbor(),
            5,
            Cbor::Array(vec![
                Section {
                    kind,
                    chunks: vec![],
                }
                .to_cbor(),
            ]),
        );
        assert!(ManifestPayload::from_cbor(&m).is_ok());
        let mut r = replica();
        manifest_reply(&mut r, &m);
        assert_prior(&r, IncidentKind::Integrity, true);
        let c = ChunkPayload {
            section: kind,
            bucket: 0,
            rows: vec![],
        }
        .to_cbor();
        assert!(ChunkPayload::from_cbor(&c).is_ok());
        let mut r = replica();
        chunk_reply_kind(&mut r, &c, kind);
        assert_prior(&r, IncidentKind::Integrity, true);
    }
}

#[test]
fn independent_promotion_and_continuation_guards_cannot_apply_a_legacy_prefix() {
    let all = mdbn_wire::fixtures::all();
    let full = rt::EntryPayload::from_bytes(
        &all.iter()
            .find(|f| f.format == "entry" && f.name == "runtime-v1-extended")
            .unwrap()
            .bytes,
    )
    .unwrap();
    let base = rt::EntryPayload::from(
        mdbn_wire::entry::EntryPayload::from_bytes(
            &all.iter()
                .find(|f| f.format == "entry" && f.name == "applied-with-text-table")
                .unwrap()
                .bytes,
        )
        .unwrap(),
    );
    let mut cases = Vec::new();
    for op in full
        .mutation
        .ops
        .into_iter()
        .filter(|o| matches!(o, rt::Op::OrdinaryFileToRecord(_)))
    {
        let mut e = base.clone();
        e.mutation.ops.push(op);
        cases.push(e);
    }
    for effect in full
        .effects
        .into_iter()
        .filter(|e| matches!(e, rt::Effect::ReindexOrdinaryFile(_)))
    {
        let mut e = base.clone();
        e.effects.push(effect);
        cases.push(e);
    }
    let continuation = rt::EntryPayload::from_bytes(
        &all.iter()
            .find(|f| f.format == "entry" && f.name == "runtime-v1-ordinary-continuation")
            .unwrap()
            .bytes,
    )
    .unwrap();
    cases.push(continuation);
    assert_eq!(cases.len(), 3);
    for e in cases {
        let mut r = replica();
        let before = r.head;
        let outcome = r
            .apply_payload(
                8,
                Head {
                    seq: 8,
                    chain: B32([8; 32]),
                },
                e,
                &mut BTreeSet::new(),
            )
            .unwrap();
        assert!(matches!(
            outcome,
            super::super::apply::Outcome::Stall(IncidentKind::UpgradeRequired, _)
        ));
        assert_eq!(r.head, before);
        assert_eq!(r.store.head().unwrap(), before);
        assert_eq!(r.store.record(&OLD).unwrap(), Some(row(OLD, "prior.md")));
        assert_eq!(r.store.staged_rows(), 1);
    }
}

#[test]
fn malformed_manifest_and_chunk_payloads_remain_integrity_and_preserve_prior_state() {
    for manifest in [true, false] {
        let mut r = replica();
        let bad = Cbor::Bool(false);
        if manifest {
            manifest_reply(&mut r, &bad);
        } else {
            chunk_reply(&mut r, &bad);
        }
        assert_prior(&r, IncidentKind::Integrity, true);
    }
}
#[test]
fn failed_staging_cleanup_cannot_be_downgraded_to_upgrade() {
    let bad = field(&manifest().to_cbor(), 0, Cbor::Uint(2));
    let mut r = replica();
    r.store.fail_commits(1);
    manifest_reply(&mut r, &bad);
    assert_prior(&r, IncidentKind::Integrity, false);
    assert_eq!(r.store.staged_rows(), 1);
    let incident = r.incidents.values().next().unwrap();
    assert!(
        matches!(&incident.details,Some(Value::Text(s)) if s.contains("staging cleanup failed"))
    );
}
#[test]
fn terminal_apply_fault_is_not_cleared_and_no_cleanup_commit_is_issued() {
    let bad = field(&manifest().to_cbor(), 0, Cbor::Uint(2));
    let mut r = replica();
    r.apply_fault = true;
    let commits = r.store.data().borrow().commits;
    manifest_reply(&mut r, &bad);
    assert_prior(&r, IncidentKind::Integrity, false);
    assert!(r.apply_fault);
    assert_eq!(r.store.data().borrow().commits, commits);
    assert_eq!(r.store.staged_rows(), 1);
}

/// An older replica decodes manifests with the fmt-1 codec: a ref-indexed (fmt 2)
/// manifest is an unknown format to it, the path that stalls the whole install
/// with `UpgradeRequired` before any row (snapshot.md §2.1).
#[test]
fn ref_indexed_manifests_are_unknown_to_fmt1_decoders() {
    let fmt2 = mdbn_wire::ref_index::encode_manifest(&manifest(), &[B32([0x11; 32])]).unwrap();
    let old = ManifestPayload::from_bytes(&fmt2).unwrap_err();
    assert!(old.is_unknown(), "{old}");
    let (m, idx) = mdbn_wire::ref_index::decode_manifest(&fmt2).unwrap();
    assert_eq!((m, idx), (manifest(), vec![B32([0x11; 32])]));
}

fn ref_index_state(r: &mut Replica<MemStore>, index: &[u8]) {
    let a = mdbn_wire::hash::sha256(index);
    r.install = Some(Install::RefIndices {
        p: SnapshotPointer {
            seq: 42,
            manifest: B32([0x42; 32]),
            author: DEVICE,
            created_at: 0,
            endorsed: true,
        },
        m: Box::new(manifest()),
        item_refs: vec![a],
        ref_indices: vec![a],
        fetched: BTreeMap::new(),
    });
}

#[test]
fn ref_indices_resolve_before_the_chain_check_or_refuse_the_install() {
    let member = B32([0x33; 32]);
    let index = mdbn_wire::ref_index::ref_index_item(COL, &[member])
        .unwrap()
        .to_bytes()
        .unwrap();
    // Verified index: the complete set is kept and the chain check follows.
    let mut r = replica();
    ref_index_state(&mut r, &index);
    r.on_install_reply(response(index.clone()));
    assert!(matches!(r.install, Some(Install::Chain(..))));
    assert_eq!(r.install_refs, Some(BTreeSet::from([member])));
    // Bytes that are not the named index refuse the install, prior state kept.
    let mut tampered = index.clone();
    *tampered.last_mut().unwrap() ^= 1;
    let mut r = replica();
    ref_index_state(&mut r, &index);
    r.on_install_reply(response(tampered));
    assert!(r.install_refs.is_none());
    assert_prior(&r, IncidentKind::Integrity, true);
}
