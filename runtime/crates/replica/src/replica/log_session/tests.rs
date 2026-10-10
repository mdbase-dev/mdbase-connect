//! Private synthetic host-boundary tests, not physical TLS/PoP qualification.
use super::*;
use crate::log::LogRequest;
use crate::mem::MemStore;
use crate::replica::{DeviceSecrets, Host, ReplicaConfig, UtcOnly};
use crate::seal::PlainSealer;
use mdbn_core::host::Clock;
use mdbn_wire::client::SyncMode;
use mdbn_wire::common::{B16, B32, Bytes};
use mdbn_wire::log_service::{AppendParams, ReadParams, ReadResult};

const COL: Uuid = B16([1; 16]);
const ENDPOINT: EndpointId = EndpointId(9);
struct Now;
impl Clock for Now {
    fn now_ms(&self) -> u64 {
        100
    }
}
fn open(store: MemStore) -> Replica<MemStore> {
    Replica::open(
        ReplicaConfig {
            collection: COL,
            replica_id: B16([2; 16]),
            device_id: B16([3; 16]),
            mode: SyncMode::Synced,
            log_endpoint: ENDPOINT,
            verify: false,
            runtime_version: "test".into(),
            trusted_roots: vec![],
            trusted_signers: vec![],
            e2e: false,
            user_enabled_cloud_copy: false,
            chosen_state: None,
            expected_genesis: None,
            policy_pins: None,
            key_grants_only: false,
        },
        store,
        Box::new(crate::plan::CorePlanner),
        Box::new(PlainSealer::for_device(B16([3; 16]))),
        Host {
            clock: Box::new(Now),
            entropy: Box::new(crate::crypto::TestEntropy::new(1)),
            zones: Box::new(UtcOnly),
        },
        DeviceSecrets {
            sign_sk: [1; 32],
            kem_sk: [2; 32],
        },
    )
    .unwrap()
}
fn read_scope(r: &mut Replica<MemStore>, s: &AuthenticatedLogSession) -> LogReplyScope {
    r.calls.clear();
    r.inflight.clear();
    let id = r.queue(LogRequest::Read(ReadParams {
        collection: COL,
        after: 0,
        limit: 1,
        kinds: None,
        max_bytes: Some(1 << 20),
    }));
    r.inflight
        .insert(id, crate::replica::append::Inflight::Read);
    r.reading = true;
    r.take_authenticated_log_calls(s).unwrap().remove(0).1
}
fn empty_read() -> LogReply {
    Ok(LogResponse::Read(ReadResult {
        items: vec![],
        head: 0,
        head_chain: B32([0; 32]),
        retained_from: 1,
        behind: false,
        more: false,
        snapshot: None,
    }))
}
fn no_decode(_: CallId, _: &'static str) -> LogReply {
    panic!("stale callback was decoded")
}

#[test]
fn opaque_scopes_are_send_sync_and_wrong_bindings_cannot_drain_calls() {
    fn send_sync<T: Send + Sync>() {}
    send_sync::<AuthenticatedLogSession>();
    send_sync::<LogReplyScope>();
    let mut r = open(MemStore::new());
    assert_eq!(
        r.bind_authenticated_log(EndpointId(10), COL).unwrap_err(),
        LogSessionError::WrongBinding
    );
    assert_eq!(
        r.bind_authenticated_log(ENDPOINT, B16([4; 16]))
            .unwrap_err(),
        LogSessionError::WrongBinding
    );
    let s = r.bind_authenticated_log(ENDPOINT, COL).unwrap();
    let scope = read_scope(&mut r, &s);
    r.retire_authenticated_log(&s);
    assert_eq!(
        r.on_authenticated_log_reply(scope, no_decode),
        Err(LogSessionError::Stale)
    );
    let queued = r.calls.len();
    assert_eq!(
        r.take_authenticated_log_calls(&s).unwrap_err(),
        LogSessionError::Stale
    );
    assert_eq!(r.calls.len(), queued);
}

#[test]
fn old_reply_push_and_down_cannot_affect_replacement_before_decoder() {
    let mut r = open(MemStore::new());
    let old = r.bind_authenticated_log(ENDPOINT, COL).unwrap();
    let scope = read_scope(&mut r, &old);
    let current = r.bind_authenticated_log(ENDPOINT, COL).unwrap();
    r.retire_authenticated_log(&old);
    assert!(
        r.check_log_session(&current).is_ok(),
        "old Down must not retire new Up"
    );
    assert_eq!(
        r.on_authenticated_log_reply(scope, no_decode),
        Err(LogSessionError::Stale)
    );
    assert_eq!(
        r.on_authenticated_log_push(&old, |_| panic!("old push decoded")),
        Err(LogSessionError::Stale)
    );
    assert_eq!(r.head.seq, 0);
}

#[test]
fn fresh_replica_rejects_old_scope_even_when_call_ids_collide() {
    let mut old = open(MemStore::new());
    let old_s = old.bind_authenticated_log(ENDPOINT, COL).unwrap();
    let scope = read_scope(&mut old, &old_s);
    let mut fresh = open(old.into_store());
    let s = fresh.bind_authenticated_log(ENDPOINT, COL).unwrap();
    let new_scope = read_scope(&mut fresh, &s);
    assert_eq!(
        scope.0.id, new_scope.0.id,
        "fixture must exercise call ID reuse"
    );
    assert_eq!(
        fresh.on_authenticated_log_reply(scope, no_decode),
        Err(LogSessionError::Stale)
    );
    fresh
        .on_authenticated_log_reply(new_scope, |_, _| empty_read())
        .unwrap();
}

#[test]
fn original_method_single_consumption_and_legacy_delivery_are_bound() {
    let mut r = open(MemStore::new());
    let s = r.bind_authenticated_log(ENDPOINT, COL).unwrap();
    let scope = read_scope(&mut r, &s);
    let copy = scope.clone();
    r.on_authenticated_log_reply(scope, |id, method| {
        assert_eq!(id, copy.0.id);
        assert_eq!(method, "read");
        empty_read()
    })
    .unwrap();
    assert_eq!(
        r.on_authenticated_log_reply(copy, no_decode),
        Err(LogSessionError::Stale)
    );
    let scope = read_scope(&mut r, &s);
    r.on_log_reply(scope.0.id, empty_read());
    assert_eq!(
        r.on_authenticated_log_reply(scope, no_decode),
        Err(LogSessionError::Stale),
        "legacy cannot subsequently mint authenticated context"
    );
}

#[test]
fn wrong_reply_shape_and_push_collection_fail_without_applying() {
    let mut r = open(MemStore::new());
    let s = r.bind_authenticated_log(ENDPOINT, COL).unwrap();
    let scope = read_scope(&mut r, &s);
    assert_eq!(
        r.on_authenticated_log_reply(scope, |_, _| Ok(LogResponse::Ok)),
        Err(LogSessionError::WrongShape)
    );
    assert_eq!(
        r.on_authenticated_log_push(&s, |_| Ok(LogPush::Head {
            collection: B16([4; 16]),
            head: 99,
            head_chain: B32([9; 32])
        })),
        Err(LogSessionError::WrongBinding)
    );
    assert_eq!(
        r.on_authenticated_log_push(&s, |_| Ok(LogPush::Reconnected)),
        Err(LogSessionError::WrongShape)
    );
    assert_eq!(r.head_known, 0);
}

#[test]
fn terminal_fault_and_repoint_reject_callbacks_before_decoder() {
    let mut r = open(MemStore::new());
    let s = r.bind_authenticated_log(ENDPOINT, COL).unwrap();
    let scope = read_scope(&mut r, &s);
    r.apply_fault = true; // test the port guard, not fault classification itself
    assert_eq!(
        r.on_authenticated_log_reply(scope.clone(), no_decode),
        Err(LogSessionError::ReopenRequired)
    );
    assert_eq!(
        r.bind_authenticated_log(ENDPOINT, COL).unwrap_err(),
        LogSessionError::ReopenRequired
    );
    assert_eq!(
        r.on_authenticated_log_push(&s, |_| panic!("terminal push decoded")),
        Err(LogSessionError::ReopenRequired)
    );
    let mut r = open(MemStore::new());
    let s = r.bind_authenticated_log(ENDPOINT, COL).unwrap();
    let scope = read_scope(&mut r, &s);
    r.repoint_log(EndpointId(10));
    assert_eq!(
        r.on_authenticated_log_reply(scope, no_decode),
        Err(LogSessionError::WrongBinding)
    );
}

#[test]
fn legacy_lifecycle_cannot_keep_an_old_authenticated_scope_live() {
    for event in [LogPush::Reconnected, LogPush::Disconnected] {
        let mut r = open(MemStore::new());
        let s = r.bind_authenticated_log(ENDPOINT, COL).unwrap();
        let scope = read_scope(&mut r, &s);
        r.on_log_push(event);
        assert_eq!(
            r.on_authenticated_log_reply(scope, no_decode),
            Err(LogSessionError::Stale)
        );
    }
}

#[test]
fn original_read_interval_and_capture_head_cannot_be_relabelled_after_take() {
    let mut r = open(MemStore::new());
    let s = r.bind_authenticated_log(ENDPOINT, COL).unwrap();
    r.calls.clear();
    r.inflight.clear();
    r.head = crate::store::Head {
        seq: 7,
        chain: B32([7; 32]),
    };
    let read = ReadParams {
        collection: COL,
        after: 3,
        limit: 1,
        kinds: None,
        max_bytes: Some(1 << 20),
    };
    let id = r.queue(LogRequest::Read(read.clone()));
    r.inflight
        .insert(id, crate::replica::append::Inflight::Read);
    let (mut call, scope) = r.take_authenticated_log_calls(&s).unwrap().remove(0);
    let captured_head = r.head;
    // The host owns its outgoing call, but cannot alter the original scope by
    // changing routing/params or looking up the current head after an await.
    call.id = CallId(999);
    call.endpoint = EndpointId(999);
    call.request = LogRequest::Read(ReadParams {
        after: 99,
        collection: B16([9; 16]),
        ..read.clone()
    });
    r.head = crate::store::Head {
        seq: 8,
        chain: B32([8; 32]),
    };
    assert_eq!(scope.original_read(), Some((&read, captured_head)));
    r.on_authenticated_log_reply(scope, |original_id, method| {
        assert_eq!(original_id, id);
        assert_eq!(method, "read");
        assert_ne!(original_id, call.id);
        Err(LogError::NoResponse)
    })
    .unwrap();
}

#[test]
fn retirement_classifies_unknown_append_before_replacement_without_changing_bytes() {
    use crate::replica::append::{AppendState, Inflight, Sent};
    let mut r = open(MemStore::new());
    let old = r.bind_authenticated_log(ENDPOINT, COL).unwrap();
    r.calls.clear();
    r.inflight.clear();
    let params = AppendParams {
        collection: COL,
        expect_seq: 1,
        expect_prev: B32([0; 32]),
        items: vec![Bytes(vec![1, 2, 3])],
    };
    let id = r.queue(LogRequest::Append(params.clone()));
    let mutations = vec![B16([8; 16])];
    r.inflight.insert(id, Inflight::Append);
    r.append = AppendState::InFlight(Sent {
        params: params.clone(),
        mutations: mutations.clone(),
        call: id,
    });
    let scope = r.take_authenticated_log_calls(&old).unwrap().remove(0).1;
    r.retire_authenticated_log(&old);
    assert!(
        matches!(&r.append, AppendState::RetryAt(_, sent) if sent.params == params && sent.mutations == mutations)
    );
    let current = r.bind_authenticated_log(ENDPOINT, COL).unwrap();
    assert!(
        matches!(&r.append, AppendState::InFlight(sent) if sent.params == params && sent.mutations == mutations && sent.call != id)
    );
    assert_eq!(
        r.on_authenticated_log_reply(scope, no_decode),
        Err(LogSessionError::Stale),
        "old success must not become current append proof"
    );
    let retry = r
        .take_authenticated_log_calls(&current)
        .unwrap()
        .into_iter()
        .find(|(call, _)| matches!(call.request, LogRequest::Append(_)))
        .unwrap();
    assert_eq!(retry.0.request, LogRequest::Append(params));
}

// ---------------------------------------------------------------- prefix observation

mod prefix_observation {
    use super::*;
    use crate::replica::log_session::prefix::{Anchor, PrefixRefusal, observe};
    use mdbn_wire::common::B64;
    use mdbn_wire::envelope::{Item, ItemKind};
    use mdbn_wire::hash::{CHAIN_ZERO, chain_hash};
    use mdbn_wire::log_service::{ReadKinds, SeqItem};
    use mdbn_wire::schema::Wire;

    /// A canonical log item at `seq` linking from `prev`.
    fn item(seq: u64, prev: B32) -> (Vec<u8>, B32) {
        let bytes = Item {
            kind: ItemKind::Policy,
            collection: COL,
            seq: Some(seq),
            prev: Some(prev),
            epoch: None,
            signer: Some(B16([9; 16])),
            salt: None,
            idem: None,
            refs: None,
            stream: None,
            body: Bytes(vec![seq as u8, 1, 2]),
            sig: Some(B64([0; 64])),
        }
        .to_bytes()
        .unwrap();
        let chain = chain_hash(&bytes);
        (bytes, chain)
    }

    fn scoped_read(
        r: &mut Replica<MemStore>,
        s: &AuthenticatedLogSession,
        after: u64,
        limit: u64,
        kinds: Option<ReadKinds>,
        max_bytes: Option<u64>,
    ) -> MatchedLogReply {
        r.calls.clear();
        r.inflight.clear();
        let id = r.queue(LogRequest::Read(ReadParams {
            collection: COL,
            after,
            limit,
            kinds,
            max_bytes,
        }));
        r.inflight
            .insert(id, crate::replica::append::Inflight::Read);
        let scope = r.take_authenticated_log_calls(s).unwrap().remove(0).1;
        MatchedLogReply { original: scope.0 }
    }

    fn reply(
        items: Vec<(u64, Vec<u8>)>,
        head: u64,
        head_chain: B32,
        retained_from: u64,
    ) -> ReadResult {
        ReadResult {
            items: items
                .into_iter()
                .map(|(seq, item)| SeqItem {
                    seq,
                    item: Bytes(item),
                })
                .collect(),
            head,
            head_chain,
            retained_from,
            behind: false,
            more: false,
            snapshot: None,
        }
    }

    #[test]
    fn matched_item_anchor_only_and_mismatch_are_distinct_observations() {
        let mut r = open(MemStore::new());
        let s = r.bind_authenticated_log(ENDPOINT, COL).unwrap();
        let (i1, c1) = item(1, CHAIN_ZERO);
        let m = scoped_read(&mut r, &s, 0, 1, None, None);
        let obs = observe(
            Some(&m),
            Some(&s),
            &reply(vec![(1, i1.clone())], 1, c1, 1),
            Anchor::GENESIS,
            r.store_generation,
        )
        .unwrap();
        assert!(obs.still_valid(Some(&s), r.head, r.store_generation));
        assert_eq!(obs.common_position(&[(1, c1)]), Some(1), "item 1 is ours");
        assert_eq!(
            obs.common_position(&[(1, B32([7; 32]))]),
            Some(0),
            "item 1 differs but links from genesis: only the anchor matches"
        );
        assert_eq!(
            obs.common_position(&[]),
            Some(0),
            "nothing retained above 0"
        );
        // An unknown anchor compares only the item itself.
        let m = scoped_read(&mut r, &s, 0, 1, None, None);
        let obs = observe(
            Some(&m),
            Some(&s),
            &reply(vec![(1, i1)], 1, c1, 1),
            Anchor {
                seq: 0,
                chain: None,
            },
            r.store_generation,
        )
        .unwrap();
        assert_eq!(obs.common_position(&[(1, c1)]), Some(1));
        assert_eq!(obs.common_position(&[(1, B32([7; 32]))]), None);
        // The service's history differs at the anchor: observed, not refused.
        let (i6, c6) = item(6, B32([5; 32]));
        let m = scoped_read(&mut r, &s, 5, 1, None, None);
        let obs = observe(
            Some(&m),
            Some(&s),
            &reply(vec![(6, i6)], 6, c6, 1),
            Anchor {
                seq: 5,
                chain: Some(B32([6; 32])),
            },
            r.store_generation,
        )
        .unwrap();
        assert_eq!(obs.common_position(&[(6, c6)]), Some(6));
        assert_eq!(obs.common_position(&[(6, B32([1; 32]))]), None);
    }

    #[test]
    fn empty_genesis_is_proven_only_by_a_matched_retained_reply() {
        let mut r = open(MemStore::new());
        let s = r.bind_authenticated_log(ENDPOINT, COL).unwrap();
        let m = scoped_read(&mut r, &s, 0, 1, None, None);
        let obs = observe(
            Some(&m),
            Some(&s),
            &reply(vec![], 0, CHAIN_ZERO, 1),
            Anchor::GENESIS,
            0,
        )
        .unwrap();
        assert_eq!(obs.common_position(&[]), Some(0));
        let m = scoped_read(&mut r, &s, 0, 1, None, None);
        assert_eq!(
            observe(
                Some(&m),
                Some(&s),
                &reply(vec![], 0, CHAIN_ZERO, 2),
                Anchor::GENESIS,
                0
            )
            .unwrap_err(),
            PrefixRefusal::Compacted
        );
        // An empty reply at a head above `after` describes nothing.
        let m = scoped_read(&mut r, &s, 0, 1, None, None);
        assert_eq!(
            observe(
                Some(&m),
                Some(&s),
                &reply(vec![], 3, B32([3; 32]), 1),
                Anchor::GENESIS,
                0
            )
            .unwrap_err(),
            PrefixRefusal::Shape
        );
        // An empty reply at the anchor itself compares the head chain.
        let m = scoped_read(&mut r, &s, 4, 1, None, None);
        let obs = observe(
            Some(&m),
            Some(&s),
            &reply(vec![], 4, B32([4; 32]), 1),
            Anchor {
                seq: 4,
                chain: Some(B32([4; 32])),
            },
            0,
        )
        .unwrap();
        assert_eq!(obs.common_position(&[]), Some(4));
    }

    #[test]
    fn provenance_session_filter_and_anchor_refusals() {
        let mut r = open(MemStore::new());
        let s = r.bind_authenticated_log(ENDPOINT, COL).unwrap();
        let (i1, c1) = item(1, CHAIN_ZERO);
        let ok = reply(vec![(1, i1)], 1, c1, 1);
        assert_eq!(
            observe(None, Some(&s), &ok, Anchor::GENESIS, 0).unwrap_err(),
            PrefixRefusal::NoProvenance
        );
        let m = scoped_read(&mut r, &s, 0, 1, Some(ReadKinds::Control), None);
        assert_eq!(
            observe(Some(&m), Some(&s), &ok, Anchor::GENESIS, 0).unwrap_err(),
            PrefixRefusal::Filtered
        );
        let m = scoped_read(&mut r, &s, 0, 1, None, None);
        assert_eq!(
            observe(
                Some(&m),
                Some(&s),
                &ok,
                Anchor {
                    seq: 1,
                    chain: None
                },
                0
            )
            .unwrap_err(),
            PrefixRefusal::WrongAnchor
        );
        // A replacement session retires the scope's session: stale, and an
        // observation taken earlier is no longer valid either.
        let m = scoped_read(&mut r, &s, 0, 1, None, None);
        let obs = observe(Some(&m), Some(&s), &ok, Anchor::GENESIS, r.store_generation).unwrap();
        let fresh = r.bind_authenticated_log(ENDPOINT, COL).unwrap();
        assert_eq!(
            observe(Some(&m), Some(&fresh), &ok, Anchor::GENESIS, 0).unwrap_err(),
            PrefixRefusal::StaleSession
        );
        assert!(!obs.still_valid(Some(&fresh), r.head, r.store_generation));
        assert!(!obs.still_valid(None, r.head, r.store_generation));
        // Same session, but the store instance or the asking view changed.
        let m = scoped_read(&mut r, &fresh, 0, 1, None, None);
        let obs = observe(Some(&m), Some(&fresh), &ok, Anchor::GENESIS, 7).unwrap();
        assert!(obs.still_valid(Some(&fresh), r.head, 7));
        assert!(!obs.still_valid(Some(&fresh), r.head, 8));
        let moved = Head {
            seq: r.head.seq + 1,
            chain: r.head.chain,
        };
        assert!(!obs.still_valid(Some(&fresh), moved, 7));
    }

    #[test]
    fn interval_shape_bounds_chain_and_compaction_are_never_evidence() {
        let mut r = open(MemStore::new());
        let s = r.bind_authenticated_log(ENDPOINT, COL).unwrap();
        let (i1, c1) = item(1, CHAIN_ZERO);
        let (i2, c2) = item(2, c1);
        let (i2x, _) = item(2, B32([9; 32]));
        let refused = |r: &mut Replica<MemStore>, limit, max_bytes, rr: ReadResult| {
            let m = scoped_read(r, &s, 0, limit, None, max_bytes);
            observe(Some(&m), Some(&s), &rr, Anchor::GENESIS, 0).unwrap_err()
        };
        // More items than asked for.
        assert_eq!(
            refused(
                &mut r,
                1,
                None,
                reply(vec![(1, i1.clone()), (2, i2.clone())], 2, c2, 1)
            ),
            PrefixRefusal::Shape
        );
        // A gap or relabelled position.
        assert_eq!(
            refused(&mut r, 2, None, reply(vec![(2, i2.clone())], 2, c2, 1)),
            PrefixRefusal::Shape
        );
        assert_eq!(
            refused(&mut r, 2, None, reply(vec![(1, i2.clone())], 2, c2, 1)),
            PrefixRefusal::Shape
        );
        // Bytes that are not an item.
        assert_eq!(
            refused(
                &mut r,
                1,
                None,
                reply(vec![(1, vec![0xff, 0, 1])], 1, c1, 1)
            ),
            PrefixRefusal::Shape
        );
        // The service's own items do not link.
        assert_eq!(
            refused(
                &mut r,
                2,
                None,
                reply(vec![(1, i1.clone()), (2, i2x)], 2, c2, 1)
            ),
            PrefixRefusal::Chain
        );
        // Head below the last item, or a head chain that is not the last item's.
        assert_eq!(
            refused(
                &mut r,
                2,
                None,
                reply(vec![(1, i1.clone()), (2, i2.clone())], 1, c1, 1)
            ),
            PrefixRefusal::Shape
        );
        assert_eq!(
            refused(&mut r, 1, None, reply(vec![(1, i1.clone())], 1, c2, 1)),
            PrefixRefusal::Shape
        );
        // Over the byte budget (only the first item may exceed it).
        assert_eq!(
            refused(
                &mut r,
                2,
                Some(1),
                reply(vec![(1, i1.clone()), (2, i2.clone())], 2, c2, 1)
            ),
            PrefixRefusal::Bounds
        );
        let m = scoped_read(&mut r, &s, 0, 1, None, Some(1));
        assert!(
            observe(
                Some(&m),
                Some(&s),
                &reply(vec![(1, i1.clone())], 1, c1, 1),
                Anchor::GENESIS,
                0
            )
            .is_ok()
        );
        // Compacted: unknown, never negative; a contradictory `behind` is a shape error.
        let mut compacted = reply(vec![], 9, B32([9; 32]), 5);
        compacted.behind = true;
        let m = scoped_read(&mut r, &s, 2, 1, None, None);
        assert_eq!(
            observe(
                Some(&m),
                Some(&s),
                &compacted,
                Anchor {
                    seq: 2,
                    chain: None
                },
                0
            )
            .unwrap_err(),
            PrefixRefusal::Compacted
        );
        let mut lying = reply(vec![], 9, B32([9; 32]), 1);
        lying.behind = true;
        assert_eq!(refused(&mut r, 1, None, lying), PrefixRefusal::Shape);
        // The service's head fell below the request: its view moved.
        let m = scoped_read(&mut r, &s, 4, 1, None, None);
        assert_eq!(
            observe(
                Some(&m),
                Some(&s),
                &reply(vec![], 2, B32([2; 32]), 1),
                Anchor {
                    seq: 4,
                    chain: None
                },
                0
            )
            .unwrap_err(),
            PrefixRefusal::Moved
        );
    }

    /// Replica-repair's negatives: an interval whose items are not this
    /// collection's well-formed log items is never prefix evidence, however
    /// well its positions and chain links line up with the request.
    #[test]
    fn foreign_or_unsigned_items_are_never_prefix_evidence() {
        let mut r = open(MemStore::new());
        let s = r.bind_authenticated_log(ENDPOINT, COL).unwrap();
        let forged = |collection, signer, sig, seq: u64, prev: B32| {
            let bytes = Item {
                kind: ItemKind::Policy,
                collection,
                seq: Some(seq),
                prev: Some(prev),
                epoch: None,
                signer,
                salt: None,
                idem: None,
                refs: None,
                stream: None,
                body: Bytes(vec![seq as u8, 1, 2]),
                sig,
            }
            .to_bytes()
            .unwrap();
            let chain = chain_hash(&bytes);
            (bytes, chain)
        };
        let other = mdbn_wire::common::B16([0xEE; 16]);
        // Another collection's items, linked from our genesis anchor.
        let (f1, fc1) = forged(other, Some(B16([9; 16])), Some(B64([0; 64])), 1, CHAIN_ZERO);
        let m = scoped_read(&mut r, &s, 0, 4, None, None);
        let got = observe(
            Some(&m),
            Some(&s),
            &reply(vec![(1, f1)], 1, fc1, 1),
            Anchor::GENESIS,
            0,
        );
        assert!(
            got.is_err(),
            "another collection's item accepted as our prefix: {got:?}"
        );
        // Our collection, but unsigned items.
        let (u1, uc1) = forged(COL, None, None, 1, CHAIN_ZERO);
        let m = scoped_read(&mut r, &s, 0, 4, None, None);
        let got = observe(
            Some(&m),
            Some(&s),
            &reply(vec![(1, u1)], 1, uc1, 1),
            Anchor::GENESIS,
            0,
        );
        assert!(
            got.is_err(),
            "unsigned item accepted as our prefix: {got:?}"
        );
    }
}
