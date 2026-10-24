//! Real Replica construction and install reply routing at the already-verified
//! manifest boundary. These tests do not substitute a crypto/admission proof.
use super::*;
use crate::log::LogPort;
use crate::mem::MemStore;
use crate::seal::PlainSealer;
use crate::{DeviceSecrets, Host, HostedCache, HostedProfile, ReplicaConfig, UtcOnly};
use mdbn_core::host::Clock;
use mdbn_wire::common::{B16, Bytes};
use mdbn_wire::schema::Wire;

const C: Uuid = B16([3; 16]);
const DEVICE: Uuid = B16([101; 16]);
struct FixedClock;
impl Clock for FixedClock {
    fn now_ms(&self) -> u64 {
        1_700_000_000_000
    }
}
fn config() -> ReplicaConfig {
    ReplicaConfig {
        collection: C,
        replica_id: B16([1; 16]),
        device_id: DEVICE,
        mode: mdbn_wire::client::SyncMode::Synced,
        log_endpoint: crate::log::EndpointId(1),
        verify: true,
        runtime_version: "ref-index-runtime-test".into(),
        trusted_roots: vec![],
        e2e: false,
        trusted_signers: vec![DEVICE],
        user_enabled_cloud_copy: false,
        chosen_state: None,
        expected_genesis: None,
        policy_pins: None,
        key_grants_only: false,
    }
}
fn host() -> Host {
    Host {
        clock: Box::new(FixedClock),
        entropy: Box::new(crate::crypto::TestEntropy::new(1)),
        zones: Box::new(UtcOnly),
    }
}
fn secrets() -> DeviceSecrets {
    DeviceSecrets {
        sign_sk: [1; 32],
        kem_sk: [1; 32],
    }
}
fn native() -> Replica<MemStore> {
    let mut r = Replica::open(
        config(),
        MemStore::new(),
        Box::new(crate::plan::CorePlanner),
        Box::new(PlainSealer::for_device(DEVICE)),
        host(),
        secrets(),
    )
    .unwrap();
    r.take_log_calls();
    r
}
fn hosted() -> Replica<HostedCache<MemStore>> {
    let mut r = Replica::open_hosted(
        config(),
        MemStore::new(),
        Box::new(crate::plan::CorePlanner),
        Box::new(PlainSealer::for_device(DEVICE)),
        host(),
        secrets(),
        HostedProfile::default(),
    )
    .unwrap();
    r.take_log_calls();
    r
}
fn manifest() -> Box<ManifestPayload> {
    let fixture = mdbn_wire::fixtures::all()
        .into_iter()
        .find(|f| f.format == "manifest")
        .unwrap();
    Box::new(ManifestPayload::from_bytes(&fixture.bytes).unwrap())
}
fn pointer() -> SnapshotPointer {
    SnapshotPointer {
        seq: 1,
        manifest: B32([9; 32]),
        author: DEVICE,
        created_at: 0,
        endorsed: true,
    }
}
fn index(collection: Uuid, members: &[Hash]) -> (Hash, Vec<u8>) {
    let bytes = mdbn_wire::ref_index::ref_index_item(collection, members)
        .unwrap()
        .to_bytes()
        .unwrap();
    (mdbn_wire::hash::sha256(&bytes), bytes)
}
fn reply(bytes: Vec<u8>) -> crate::log::LogReply {
    Ok(crate::log::LogResponse::GetObject {
        size: bytes.len() as u64,
        checksum: mdbn_wire::hash::sha256(&bytes),
        bytes,
    })
}
fn start<S: Store>(r: &mut Replica<S>, indices: Vec<Hash>) -> crate::log::LogCall {
    r.install_after_manifest(pointer(), manifest(), indices.clone(), indices.clone());
    let calls = r.take_log_calls();
    assert_eq!(calls.len(), 1);
    assert!(
        matches!(&calls[0].request, LogRequest::GetObject { address, collection, range: None }
        if *address == indices[0] && *collection == C)
    );
    calls.into_iter().next().unwrap()
}
fn assert_refused(r: &mut Replica<MemStore>) {
    assert!(r.install.is_none());
    assert!(r.install_refs.is_none());
    assert!(
        r.take_log_calls().is_empty(),
        "no second index GET or chain read"
    );
    assert_eq!(r.store.staged_rows(), 0);
    assert_eq!(r.head.seq, 0);
    assert_eq!(r.incidents.len(), 1);
}

#[test]
fn first_wrong_address_refuses_without_fetching_the_remaining_index() {
    let mut r = native();
    let (address, bytes) = index(C, &[B32([1; 32])]);
    let call = start(&mut r, vec![address, B32([0xff; 32])]);
    let (_, wrong) = index(C, &[B32([2; 32])]);
    assert_ne!(bytes, wrong);
    r.on_log_reply(call.id, reply(wrong));
    assert_refused(&mut r);
}

#[test]
fn fmt2_discards_header_preview_before_retaining_verified_members() {
    let mut r = native();
    let (address, bytes) = index(C, &[B32([1; 32]), B32([2; 32]), B32([3; 32])]);
    let mut metadata: Vec<_> = (0..4096u32)
        .map(|n| {
            let mut hash = [0; 32];
            hash[..4].copy_from_slice(&n.to_be_bytes());
            B32(hash)
        })
        .collect();
    metadata.push(address);
    metadata.sort();
    metadata.dedup();
    r.install_refs = Some(metadata.iter().copied().collect());
    r.install_after_manifest(pointer(), manifest(), metadata, vec![address]);
    assert!(
        r.install_refs.is_none(),
        "header preview is not retained during fmt2 admission"
    );
    let call = r.take_log_calls().pop().unwrap();
    r.on_log_reply(call.id, reply(bytes));
    assert!(
        r.install_refs.is_some(),
        "only final verified union supplies source closure"
    );
}

#[test]
fn incoming_reserved_capacity_is_charged_even_for_a_small_valid_object() {
    let mut r = native();
    let (address, mut bytes) = index(C, &[B32([1; 32])]);
    bytes.reserve_exact(budget::MAX_OBJECT_BYTES + 1);
    assert!(bytes.len() < budget::MAX_OBJECT_BYTES);
    assert!(bytes.capacity() > budget::MAX_OBJECT_BYTES);
    let call = start(&mut r, vec![address, B32([0xff; 32])]);
    r.on_log_reply(call.id, reply(bytes));
    assert_refused(&mut r);
}

#[test]
fn first_wrong_collection_kind_or_shape_refuses_before_next_fetch() {
    let (_, collection) = index(B16([4; 16]), &[B32([1; 32])]);
    let (_, raw) = index(C, &[B32([1; 32])]);
    let mut kind = mdbn_wire::envelope::Item::from_bytes(&raw).unwrap();
    kind.kind = ItemKind::BlobPart;
    let mut shape = mdbn_wire::envelope::Item::from_bytes(&raw).unwrap();
    shape.body = Bytes(vec![0]);
    for bytes in [
        collection,
        kind.to_bytes().unwrap(),
        shape.to_bytes().unwrap(),
    ] {
        let mut r = native();
        let address = mdbn_wire::hash::sha256(&bytes);
        let call = start(&mut r, vec![address, B32([0xff; 32])]);
        r.on_log_reply(call.id, reply(bytes));
        assert_refused(&mut r);
    }
}

#[test]
fn first_depth_two_member_refuses_before_retention_or_next_fetch() {
    let mut r = native();
    let another = B32([0xff; 32]);
    let (address, bytes) = index(C, &[another]);
    let call = start(&mut r, vec![address, another]);
    r.on_log_reply(call.id, reply(bytes));
    assert_refused(&mut r);
}

#[test]
fn valid_arrivals_retain_compact_verified_members_then_resolve_before_chain() {
    let mut r = native();
    let mut objects = BTreeMap::new();
    for members in [
        vec![B32([1; 32]), B32([2; 32])],
        vec![B32([2; 32]), B32([3; 32])],
    ] {
        let (address, bytes) = index(C, &members);
        objects.insert(address, bytes);
    }
    let indices: Vec<_> = objects.keys().copied().collect();
    let call = start(&mut r, indices.clone());
    r.request_next_ref_index();
    assert!(
        r.take_log_calls().is_empty(),
        "outstanding GET cannot be duplicated"
    );
    r.on_log_reply(call.id, reply(objects.remove(&indices[0]).unwrap()));
    let Some(Install::RefIndices { fetched, .. }) = &r.install else {
        panic!("ref-index state")
    };
    assert_eq!(fetched.len(), 1);
    assert_eq!(fetched[&indices[0]].0.len(), 2);
    assert!(r.install_refs.is_none());
    assert_eq!(r.store.staged_rows(), 0);
    let calls = r.take_log_calls();
    assert_eq!(calls.len(), 1);
    assert!(
        matches!(&calls[0].request, LogRequest::GetObject { address, .. } if *address == indices[1])
    );
    r.on_log_reply(calls[0].id, reply(objects.remove(&indices[1]).unwrap()));
    assert!(matches!(r.install, Some(Install::Chain(..))));
    assert_eq!(
        r.install_refs,
        Some(
            [B32([1; 32]), B32([2; 32]), B32([3; 32])]
                .into_iter()
                .collect()
        )
    );
    assert_eq!(r.store.staged_rows(), 0);
    let calls = r.take_log_calls();
    assert_eq!(calls.len(), 1);
    assert!(matches!(calls[0].request, LogRequest::Read(_)));
}

#[test]
fn real_hosted_profile_refuses_fmt2_before_any_index_get_but_fmt1_still_checks_chain() {
    let mut r = hosted();
    assert!(r.is_hosted());
    let (address, _) = index(C, &[B32([1; 32])]);
    r.install_after_manifest(pointer(), manifest(), vec![address], vec![address]);
    assert!(r.take_log_calls().is_empty());
    assert!(r.install.is_none());
    assert!(r.install_refs.is_none());
    assert!(r.incidents.values().any(|incident| matches!(&incident.details,
        Some(mdbn_wire::common::Value::Text(s)) if s.contains("hosted_ref_index_install_unqualified"))));
    let direct = vec![B32([1; 32]), B32([2; 32])];
    r.install_after_manifest(pointer(), manifest(), direct.clone(), vec![]);
    assert_eq!(r.install_refs, Some(direct.into_iter().collect()));
    assert!(matches!(r.install, Some(Install::Chain(..))));
    let calls = r.take_log_calls();
    assert_eq!(calls.len(), 1);
    assert!(matches!(calls[0].request, LogRequest::Read(_)));
}
