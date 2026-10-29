use super::engine::{COL, Node};
use crate::{
    attachments::{AttachmentWriter, StreamError},
    crypto::{Secret32, blob, chunked_blob::AttachmentLimits},
    fake::FakeLogService,
    log::{LogError, LogPort, LogReply, LogRequest, LogResponse},
    replica::unindexed_apply::Check,
    seal::{KeyringSealer, Sealer},
    store::{Head, Store},
};
use mdbn_wire::{
    attachment::{AttachmentContentV1, AttachmentRefV1, FileContent},
    attachment_runtime_v1 as rt,
    common::{B16, B32, Hash, Version},
    entry::Status,
    intent::{OpClock, Source},
    unindexed_markdown::{UnindexedMarkdownPayloadV1, UnindexedMarkdownPut},
};
use std::collections::BTreeMap;
use zeroize::Zeroizing;
type Objects = BTreeMap<Hash, Vec<u8>>;
#[test]
fn missing_epoch_key_does_not_mask_other_source_refs_void() {
    for (know_old_key, reverse_sources) in
        [(false, false), (true, false), (false, true), (true, true)]
    {
        let mut node = node();
        let (first, first_objects) = contents(&mut node, &vec![b'a'; 1048577], false);
        let (second, _) = blob::seal_blob(
            &Secret32([9; 32]),
            2,
            &COL,
            &vec![b'b'; 1048577],
            blob::MIN_PART_SIZE,
            false,
            &mut *node.r.host.entropy,
        )
        .unwrap();
        node.r.policy.epoch = 2;
        let mut entry = payload(first);
        entry
            .mutation
            .ops
            .push(rt::Op::UnindexedMarkdownPut(UnindexedMarkdownPut {
                id: B16([53; 16]),
                path: "second.md".into(),
                payload: UnindexedMarkdownPayloadV1 {
                    content: FileContent::Blob(second),
                },
                expected: None,
            }));
        if reverse_sources {
            entry.mutation.ops.reverse();
        }
        let entry = planned(&node, entry);
        let mut keys = crate::crypto::keys::Keyring::new();
        keys.insert(2, Secret32([9; 32]));
        if know_old_key {
            keys.insert(1, Secret32([9; 32]));
        }
        let raw = keys.to_bytes();
        let mut saved = Zeroizing::new((raw.len() as u64).to_be_bytes().to_vec());
        saved.extend_from_slice(&raw);
        let mut sealer = KeyringSealer::new(COL, B16([101; 16]), &[6; 32], &[7; 32]);
        sealer.import(&saved).unwrap();
        sealer.set_epoch(2);
        node.r.sealer = Box::new(sealer);
        let head = retain(&mut node);
        let writer = node.r.cfg.device_id;
        let before_voids = node.r.policy.voids;
        let outcome = node
            .r
            .test_apply_authorized_unindexed_with_refs(
                head.seq,
                head,
                entry,
                &mut Default::default(),
                writer,
                &first_objects.keys().copied().collect::<Vec<_>>(),
            )
            .unwrap();
        assert!(matches!(
            outcome,
            crate::replica::apply::Outcome::Void("V7: native source refs")
        ));
        assert_eq!(node.r.store.head().unwrap(), head);
        assert_eq!(node.r.head, head);
        assert_eq!(node.r.policy.voids, before_voids + 1);
        assert!(node.r.store.file(&B16([52; 16])).unwrap().is_none());
        assert!(node.r.store.file(&B16([53; 16])).unwrap().is_none());
    }
}

#[test]
fn missing_epoch_key_does_not_mask_authenticated_attachment_refs_void() {
    for warm_proof in [false, true] {
        let mut node = node();
        let (content, objects) = contents(&mut node, &vec![b'a'; 1048577], true);
        if warm_proof {
            cache_source_proof(&mut node, &content, &objects);
        }
        let (missing, parts) = blob::seal_blob(
            &Secret32([9; 32]),
            2,
            &COL,
            &vec![b'b'; 1048577],
            blob::MIN_PART_SIZE,
            false,
            &mut *node.r.host.entropy,
        )
        .unwrap();
        let FileContent::AttachmentV1(attachment) = &content else {
            unreachable!()
        };
        let mut refs = parts.iter().map(|part| part.address).collect::<Vec<_>>();
        refs.push(attachment.reference.manifest_cipher_hash);
        let mut entry = payload(FileContent::Blob(missing));
        entry
            .mutation
            .ops
            .push(rt::Op::UnindexedMarkdownPut(UnindexedMarkdownPut {
                id: B16([53; 16]),
                path: "second.md".into(),
                payload: UnindexedMarkdownPayloadV1 { content },
                expected: None,
            }));
        node.r.policy.epoch = 2;
        let entry = planned(&node, entry);
        let head = retain(&mut node);
        let writer = node.r.cfg.device_id;
        let before_voids = node.r.policy.voids;
        assert!(matches!(
            apply_body_with_refs(&mut node, head, &entry, &objects, writer, &refs),
            crate::replica::apply::Outcome::Void("V7: native source refs")
        ));
        assert_eq!(node.r.head, head);
        assert_eq!(node.r.store.head().unwrap(), head);
        assert_eq!(node.r.policy.voids, before_voids + 1);
        assert!(node.r.store.file(&B16([52; 16])).unwrap().is_none());
        assert!(node.r.store.file(&B16([53; 16])).unwrap().is_none());
    }
}

fn cache_source_proof(node: &mut Node, content: &FileContent, objects: &Objects) {
    let source = payload(content.clone());
    let head = Head {
        seq: node.r.head.seq + 1,
        chain: B32([4; 32]),
    };
    let refs = objects.keys().copied().collect::<Vec<_>>();
    assert!(matches!(
        node.r.unindexed_source_check(head, &source, Some(&refs)),
        Check::Pending
    ));
    for _ in 0..3 {
        step(node, objects, head, false);
    }
    let Check::Ready(meta) = node.r.unindexed_source_check(head, &source, Some(&refs)) else {
        panic!("original descriptor was not authenticated");
    };
    node.r
        .store
        .commit(crate::store::Tx {
            meta,
            ..Default::default()
        })
        .unwrap();
}

#[test]
fn inventory_requires_current_descriptor_authentication_before_refs_void() {
    for (warm_inventory, warm_proof) in [(false, false), (true, false), (true, true)] {
        let mut node = node();
        let (mut content, objects) = contents(&mut node, &vec![b'x'; 1048577], true);
        if warm_proof {
            cache_source_proof(&mut node, &content, &objects);
        }
        let FileContent::AttachmentV1(attachment) = &mut content else {
            unreachable!()
        };
        let manifest_address = attachment.reference.manifest_cipher_hash;
        if warm_inventory {
            let (descriptor, expected) = crate::replica::attachment_fetch::descriptor(attachment);
            let manifest = node
                .r
                .sealer
                .open_attachment_manifest(
                    &descriptor,
                    expected,
                    &objects[&manifest_address],
                    AttachmentLimits::default(),
                )
                .unwrap();
            node.r
                .store
                .commit(crate::store::Tx {
                    meta: vec![crate::replica::attachment_inventory::inventory_meta(
                        manifest_address,
                        &manifest.manifest().chunks,
                    )],
                    ..Default::default()
                })
                .unwrap();
        }
        attachment.reference.attachment_id = B32([123; 32]);
        let entry = planned(&node, payload(content));
        let head = retain(&mut node);
        let writer = node.r.cfg.device_id;
        let before_head = node.r.store.head().unwrap();
        let before_voids = node.r.policy.voids;
        let before_proofs = node.r.store.meta("replica.unindexed_byte_proofs").unwrap();
        let mut outcome = node
            .r
            .test_apply_authorized_unindexed_with_refs(
                head.seq,
                head,
                entry.clone(),
                &mut Default::default(),
                writer,
                &[manifest_address],
            )
            .unwrap();
        assert!(matches!(
            outcome,
            crate::replica::apply::Outcome::SourcePending
        ));
        assert_eq!(node.r.store.head().unwrap(), before_head);
        step(&mut node, &objects, head, false);
        outcome = node
            .r
            .test_apply_authorized_unindexed_with_refs(
                head.seq,
                head,
                entry,
                &mut Default::default(),
                writer,
                &[manifest_address],
            )
            .unwrap();
        assert!(matches!(
            outcome,
            crate::replica::apply::Outcome::SourcePending
        ));
        assert_eq!(node.r.store.head().unwrap(), before_head);
        assert_eq!(node.r.head, before_head);
        assert_eq!(node.r.policy.voids, before_voids);
        assert_eq!(
            node.r.store.meta("replica.unindexed_byte_proofs").unwrap(),
            before_proofs
        );
        assert!(node.r.store.file(&B16([52; 16])).unwrap().is_none());
    }
}
struct ErrorPlanner;
impl crate::plan::Planner for ErrorPlanner {
    fn plan(
        &self,
        _: &mdbn_core::intent::Mutation,
        _: &dyn mdbn_core::state::StateView,
        _: &mdbn_core::plan::PlanOptions,
    ) -> Result<mdbn_core::plan::Planned, mdbn_core::plan::Rejection> {
        Err(mdbn_core::plan::Rejection::new(
            mdbn_core::plan::RejectCode::InvalidRequest,
            None,
            "planner error",
        ))
    }
}
pub(super) fn node() -> Node {
    node_store(crate::mem::MemStore::new())
}
fn node_store(store: crate::mem::MemStore) -> Node {
    let mut a = super::attachment_upload::attach_node_with(&FakeLogService::new(), 1, store);
    let mut keys = crate::crypto::keys::Keyring::new();
    keys.insert(1, Secret32([9; 32]));
    let raw = keys.to_bytes();
    let mut saved = Zeroizing::new((raw.len() as u64).to_be_bytes().to_vec());
    saved.extend_from_slice(&raw);
    let mut s = KeyringSealer::new(COL, B16([101; 16]), &[6; 32], &[7; 32]);
    s.import(&saved).unwrap();
    s.set_epoch(1);
    a.r.sealer = Box::new(s);
    a
}
pub(super) fn contents(a: &mut Node, plain: &[u8], attachment: bool) -> (FileContent, Objects) {
    if !attachment {
        let (d, parts) = blob::seal_blob(
            &Secret32([9; 32]),
            1,
            &COL,
            plain,
            blob::MIN_PART_SIZE,
            false,
            &mut *a.r.host.entropy,
        )
        .unwrap();
        return (
            FileContent::Blob(d),
            parts.into_iter().map(|p| (p.address, p.bytes)).collect(),
        );
    }
    let mut w = AttachmentWriter::new(
        &*a.r.sealer,
        COL,
        plain.len() as u64,
        AttachmentLimits::default(),
        &mut *a.r.host.entropy,
    )
    .unwrap();
    let mut objects = Objects::new();
    let mut at = 0;
    while at < plain.len() {
        let n = w.next_chunk_len() as usize;
        let o = w
            .push_chunk(&*a.r.sealer, &plain[at..at + n], &mut *a.r.host.entropy)
            .unwrap();
        objects.insert(o.cipher_hash, o.bytes);
        at += n;
    }
    let done = w.finish(&*a.r.sealer, &mut *a.r.host.entropy).unwrap();
    objects.insert(done.manifest.cipher_hash, done.manifest.bytes);
    let d = done.descriptor;
    (
        FileContent::AttachmentV1(AttachmentContentV1 {
            reference: AttachmentRefV1 {
                collection: COL,
                key_epoch: 1,
                attachment_id: d.context.attachment_id,
                manifest_cipher_hash: d.manifest_cipher_hash,
            },
            whole_plain_hash: done.expected.whole_plain_hash,
            total_plain_bytes: done.expected.total_plain_bytes,
        }),
        objects,
    )
}
pub(super) fn payload(c: FileContent) -> rt::EntryPayload {
    rt::EntryPayload {
        sem: Version { major: 1, minor: 0 },
        mutation: rt::Mutation {
            id: B16([51; 16]),
            origin: B16([1; 16]),
            base_seq: 2,
            clock: OpClock {
                instant: 1700000000000,
                tz: "UTC".into(),
                local_date: "2023-11-14".into(),
            },
            seed: B32([2; 32]),
            source: Source::External,
            ops: vec![rt::Op::UnindexedMarkdownPut(UnindexedMarkdownPut {
                id: B16([52; 16]),
                path: "huge.md".into(),
                payload: UnindexedMarkdownPayloadV1 { content: c },
                expected: None,
            })],
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
    }
}
fn step(a: &mut Node, objects: &Objects, head: Head, corrupt: bool) -> usize {
    let calls = a.r.take_log_calls();
    let mut reads = 0;
    for c in calls {
        if let LogRequest::GetObject { address, .. } = c.request {
            let mut bytes = objects[&address].clone();
            if corrupt {
                bytes[0] ^= 1;
            }
            let reply: LogReply = Ok(LogResponse::GetObject {
                size: bytes.len() as u64,
                checksum: mdbn_wire::hash::sha256(&bytes),
                bytes,
            });
            a.r.on_unindexed_source_reply(head, c.id, reply);
            reads += 1;
        }
    }
    reads
}
pub(super) fn planned(a: &Node, mut p: rt::EntryPayload) -> rt::EntryPayload {
    let m = crate::convert::runtime_mutation(&p.mutation, &|t| match t {
        mdbn_wire::common::Text::Inline(s) => Ok(s.clone()),
        _ => Err(crate::convert::ConvertError::Text(
            "test expects inline".into(),
        )),
    })
    .unwrap();
    let view = crate::plan::StoreView::new(&a.r.store, a.r.catalog.clone());
    let pl =
        a.r.planner
            .plan(
                &m,
                &view,
                &mdbn_core::plan::PlanOptions {
                    stage: mdbn_core::plan::Stage::Head,
                },
            )
            .unwrap();
    assert!(view.error().is_none());
    let sem = mdbn_core::semantics::SEM;
    p.sem = Version {
        major: sem.major,
        minor: sem.minor,
    };
    p.status = crate::convert::wstatus(pl.status);
    p.effects = pl
        .effects
        .iter()
        .map(crate::convert::wruntime_effect)
        .collect::<Result<_, _>>()
        .unwrap();
    let conflicts = pl
        .conflicts
        .iter()
        .map(crate::convert::wruntime_conflict)
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    p.conflicts = (!conflicts.is_empty()).then_some(conflicts);
    p
}
// Exercises the private authorized receiver body while production keeps its
// whole-parent activation guard. These bytes are retention fixtures, not an
// assertion of live header/signature acceptance.
pub(super) fn retain(a: &mut Node) -> Head {
    let bytes = vec![0x80];
    let head = Head {
        seq: a.r.head.seq + 1,
        chain: mdbn_wire::hash::chain_hash(&bytes),
    };
    a.r.retaining = Some(crate::store::TailRow {
        seq: head.seq,
        item: bytes,
        applied_at: a.clock.get() as i64,
    });
    head
}
fn apply_body(
    a: &mut Node,
    head: Head,
    p: &rt::EntryPayload,
    objects: &Objects,
    writer: B16,
) -> crate::replica::apply::Outcome {
    let refs = objects.keys().copied().collect::<Vec<_>>();
    apply_body_with_refs(a, head, p, objects, writer, &refs)
}
fn apply_body_with_refs(
    a: &mut Node,
    head: Head,
    p: &rt::EntryPayload,
    objects: &Objects,
    writer: B16,
    refs: &[Hash],
) -> crate::replica::apply::Outcome {
    let mut changed = std::collections::BTreeSet::new();
    let first =
        a.r.test_apply_authorized_unindexed_with_refs(
            head.seq,
            head,
            p.clone(),
            &mut changed,
            writer,
            refs,
        )
        .unwrap();
    if !matches!(first, crate::replica::apply::Outcome::SourcePending) {
        eprintln!("authorized test receiver: {first:?}");
        return first;
    }
    for _ in 0..16 {
        step(a, objects, head, false);
        let outcome =
            a.r.test_apply_authorized_unindexed_with_refs(
                head.seq,
                head,
                p.clone(),
                &mut changed,
                writer,
                refs,
            )
            .unwrap();
        if !matches!(outcome, crate::replica::apply::Outcome::SourcePending) {
            return outcome;
        }
    }
    panic!("bounded source did not finish");
}
#[test]
fn native_invalid_effect_path_voids_before_planner_mismatch() {
    let mut node = node();
    let writer = node.r.cfg.device_id;
    let (content, objects) = contents(&mut node, &vec![b'x'; 1048577], true);
    let mut payload = planned(&node, payload(content));
    let rt::Effect::PutUnindexedMarkdown(effect) = &mut payload.effects[0] else {
        panic!("expected a native put effect");
    };
    effect.path = "../escape.md".into();
    let before_voids = node.r.policy.voids;
    let head = retain(&mut node);
    assert!(matches!(
        apply_body(&mut node, head, &payload, &objects, writer),
        crate::replica::apply::Outcome::Void("V7: unindexed effect descriptor or path")
    ));
    assert_eq!(node.r.head, head);
    assert_eq!(node.r.store.head().unwrap(), head);
    assert_eq!(node.r.policy.voids, before_voids + 1);
    assert!(node.r.store.file(&B16([52; 16])).unwrap().is_none());
}

#[test]
fn missing_native_refs_void_despite_planner_drift_or_error() {
    let mut outcomes = Vec::new();
    for planner_error in [false, true] {
        let mut node = node();
        let writer = node.r.cfg.device_id;
        let (content, objects) = contents(&mut node, &vec![b'x'; 1048577], true);
        let payload = planned(&node, payload(content));
        let head = retain(&mut node);
        if planner_error {
            node.r.planner = Box::new(ErrorPlanner);
        }
        let outcome = apply_body_with_refs(&mut node, head, &payload, &objects, writer, &[]);
        outcomes.push(format!("{outcome:?}"));
    }
    assert_eq!(outcomes[0], "Void(\"V7: native source refs\")");
    assert_eq!(
        outcomes[1], outcomes[0],
        "same refs omission, planner-dependent verdict: {outcomes:?}"
    );
}

#[test]
fn native_planner_drift_stalls_before_head_advance() {
    use crate::plan::Planner;
    use mdbn_core::intent::Mutation;
    use mdbn_core::plan::{PlanOptions, Planned, RejectCode, Rejection};
    use mdbn_core::state::StateView;

    struct DriftPlanner(bool);
    impl Planner for DriftPlanner {
        fn plan(
            &self,
            mutation: &Mutation,
            state: &dyn StateView,
            options: &PlanOptions,
        ) -> Result<Planned, Rejection> {
            if self.0 {
                return Err(Rejection::new(
                    RejectCode::InvalidRequest,
                    None,
                    "planner drift",
                ));
            }
            let mut result = crate::plan::CorePlanner.plan(mutation, state, options)?;
            result.effects.clear();
            Ok(result)
        }
    }

    for planner_error in [false, true] {
        let mut node = node();
        let writer = node.r.cfg.device_id;
        let (content, objects) = contents(&mut node, &vec![b'x'; 1048577], true);
        let FileContent::AttachmentV1(attachment) = &content else {
            unreachable!()
        };
        let manifest = attachment.reference.manifest_cipher_hash;
        let payload = planned(&node, payload(content));
        assert!(!payload.effects.is_empty());
        let before_head = node.r.head;
        let before_policy = node.r.policy.clone();
        let before_meta = node.r.policy_meta();
        let before_verified = node.r.stats.verified;
        let head = retain(&mut node);
        node.r.planner = Box::new(DriftPlanner(planner_error));
        assert!(matches!(
            apply_body(&mut node, head, &payload, &objects, writer),
            crate::replica::apply::Outcome::Stall(
                mdbn_wire::client::IncidentKind::UpgradeRequired,
                _
            )
        ));
        assert_eq!(node.r.head, before_head);
        assert_eq!(node.r.store.head().unwrap(), before_head);
        assert_eq!(node.r.policy, before_policy);
        assert_eq!(node.r.store.meta(&before_meta.0).unwrap(), before_meta.1);
        assert_eq!(node.r.stats.verified, before_verified);
        assert!(
            node.r
                .store
                .meta("replica.unindexed_byte_proofs")
                .unwrap()
                .is_none()
        );
        assert!(node.r.attachment_inventory(&manifest).unwrap().is_none());
        assert!(node.r.store.file(&B16([52; 16])).unwrap().is_none());
        assert!(node.r.before.is_empty());
        assert!(!node.r.unindexed_sources.pending());
        node.r.planner = Box::new(crate::plan::CorePlanner);
        assert!(matches!(
            apply_body(&mut node, head, &payload, &objects, writer),
            crate::replica::apply::Outcome::Applied
        ));
        assert_eq!(node.r.head, head);
        assert_eq!(node.r.policy.voids, before_policy.voids);
    }
}

#[test]
fn atomic_native_create_and_both_kind_transitions_preserve_identity_without_tombs() {
    let mut a = node();
    let id = B16([52; 16]);
    let writer = a.r.cfg.device_id;
    let (content, objects) = contents(&mut a, &vec![b'x'; 1048577], true);
    let p = planned(&a, payload(content.clone()));
    let h = retain(&mut a);
    assert!(matches!(
        apply_body(&mut a, h, &p, &objects, writer),
        crate::replica::apply::Outcome::Applied
    ));
    let f = a.r.store.file(&id).unwrap().unwrap();
    assert_eq!(f.content, content);
    assert_eq!(
        f.kind,
        mdbn_wire::unindexed_markdown::FileKindV1::UnindexedOversizedMarkdown
    );
    assert!(a.r.store.record(&id).unwrap().is_none());
    assert!(a.r.store.tombstone(&id).unwrap().is_none());
    let mut small = payload(content.clone());
    small.mutation.id = B16([61; 16]);
    small.mutation.ops = vec![rt::Op::UnindexedMarkdownToRecord(
        mdbn_wire::unindexed_markdown::UnindexedMarkdownToRecord {
            id,
            path: "huge.md".into(),
            doc: mdbn_wire::common::Text::Inline("small\n".into()),
            prior: UnindexedMarkdownPayloadV1 {
                content: content.clone(),
            },
        },
    )];
    let small = planned(&a, small);
    let h = retain(&mut a);
    assert!(matches!(
        apply_body(&mut a, h, &small, &objects, writer),
        crate::replica::apply::Outcome::Applied
    ));
    assert!(a.r.store.file(&id).unwrap().is_none());
    let record = a.r.store.record(&id).unwrap().unwrap();
    assert_eq!(record.doc, "small\n");
    assert!(a.r.store.tombstone(&id).unwrap().is_none());
    let mut large = payload(content.clone());
    large.mutation.id = B16([62; 16]);
    large.mutation.ops = vec![rt::Op::RecordToUnindexedMarkdown(
        mdbn_wire::unindexed_markdown::RecordToUnindexedMarkdown {
            id,
            path: "huge.md".into(),
            payload: UnindexedMarkdownPayloadV1 { content },
            prior_revision: record.revision,
        },
    )];
    let large = planned(&a, large);
    let h = retain(&mut a);
    assert!(matches!(
        apply_body(&mut a, h, &large, &objects, writer),
        crate::replica::apply::Outcome::Applied
    ));
    assert!(a.r.store.record(&id).unwrap().is_none());
    assert!(a.r.store.file(&id).unwrap().is_some());
    assert!(a.r.store.tombstone(&id).unwrap().is_none());
}
#[test]
fn cached_source_never_replaces_mandatory_full_prior_descriptor_cas() {
    let mut a = node();
    let writer = a.r.cfg.device_id;
    let plain = vec![b'x'; 1048577];
    let (content, objects) = contents(&mut a, &plain, false);
    let p = planned(&a, payload(content.clone()));
    let h = retain(&mut a);
    assert!(matches!(
        apply_body(&mut a, h, &p, &objects, writer),
        crate::replica::apply::Outcome::Applied
    ));
    let before = a.r.store.file(&B16([52; 16])).unwrap().unwrap();
    let mut stale = payload(content.clone());
    stale.mutation.id = B16([81; 16]);
    let rt::Op::UnindexedMarkdownPut(f) = &mut stale.mutation.ops[0] else {
        unreachable!()
    };
    let mut wrong = content.clone();
    let FileContent::Blob(b) = &mut wrong else {
        unreachable!()
    };
    b.id_epoch += 1;
    f.expected = Some(UnindexedMarkdownPayloadV1 { content: wrong });
    // A dishonest writer claims overwrite instead of Core's keep-both result.
    stale.sem = p.sem;
    stale.effects = p.effects;
    let h = retain(&mut a);
    assert!(matches!(
        apply_body(&mut a, h, &stale, &objects, writer),
        crate::replica::apply::Outcome::Stall(mdbn_wire::client::IncidentKind::UpgradeRequired, _)
    ));
    assert_eq!(a.r.store.file(&B16([52; 16])).unwrap().unwrap(), before);
}
#[test]
fn native_blob_streams_private_staging_and_renames_without_fetching() {
    let mut a = node_store(crate::mem::MemStore::new().with_attachment_disk());
    let writer = a.r.cfg.device_id;
    let plain = vec![b'x'; 1048577];
    let (content, objects) = contents(&mut a, &plain, false);
    let p = planned(&a, payload(content));
    let h = retain(&mut a);
    assert!(matches!(
        apply_body(&mut a, h, &p, &objects, writer),
        crate::replica::apply::Outcome::Applied
    ));
    assert!(!a.r.store.att_disk().files.contains_key("huge.md"));
    for _ in 0..4 {
        for call in a.r.take_log_calls() {
            if let LogRequest::GetObject { address, .. } = call.request {
                let bytes = objects[&address].clone();
                a.r.on_native_blob_reply(
                    B16([52; 16]),
                    call.id,
                    Ok(LogResponse::GetObject {
                        size: bytes.len() as u64,
                        checksum: mdbn_wire::hash::sha256(&bytes),
                        bytes,
                    }),
                );
            }
        }
    }
    assert_eq!(a.r.store.att_disk().files.get("huge.md"), Some(&plain));
    assert_eq!(
        a.r.store.file(&B16([52; 16])).unwrap().unwrap().local,
        crate::store::FileLocal::Materialized
    );
    let mut moved = a.r.store.file(&B16([52; 16])).unwrap().unwrap();
    moved.path = "renamed.md".into();
    moved.path_key = "renamed.md".into();
    a.r.store
        .commit(crate::store::Tx {
            files_put: vec![moved],
            ..Default::default()
        })
        .unwrap();
    a.r.take_log_calls();
    a.r.attachment_files_changed(vec![B16([52; 16])]);
    assert!(
        !a.r.take_log_calls()
            .iter()
            .any(|c| matches!(c.request, LogRequest::GetObject { .. }))
    );
    assert!(!a.r.store.att_disk().files.contains_key("huge.md"));
    assert_eq!(a.r.store.att_disk().files.get("renamed.md"), Some(&plain));
}
#[test]
fn complete_invalid_utf8_rejects_with_actual_writer_receipt_and_advances_only_prefix() {
    let mut a = node();
    let mut plain = vec![b'x'; 1048577];
    plain[0] = 255;
    let (content, objects) = contents(&mut a, &plain, true);
    let p = planned(&a, payload(content));
    let h = retain(&mut a);
    let writer = B16([102; 16]);
    assert!(matches!(
        apply_body(&mut a, h, &p, &objects, writer),
        crate::replica::apply::Outcome::Void("unindexed_markdown_invalid_utf8")
    ));
    assert_eq!(a.r.store.head().unwrap(), h);
    assert!(a.r.store.file(&B16([52; 16])).unwrap().is_none());
    assert!(a.r.store.record(&B16([52; 16])).unwrap().is_none());
    let receipt = a.r.store.local_receipt(&p.mutation.id).unwrap().unwrap();
    assert_eq!(receipt.state, mdbn_wire::client::ReceiptState::Rejected);
    assert_eq!(receipt.seq, Some(h.seq));
    let problem = receipt.problem.unwrap();
    assert_eq!(
        problem.reason.as_deref(),
        Some("unindexed_markdown_invalid_utf8")
    );
    let mdbn_wire::common::Value::Map(details) = problem.details.unwrap() else {
        panic!("missing writer attribution");
    };
    assert!(details.contains(&(
        "writer_device".into(),
        mdbn_wire::common::Value::Text(writer.to_hex())
    )));
    assert!(
        a.r.store
            .meta("replica.unindexed_byte_proofs")
            .unwrap()
            .is_none()
    );
}
#[test]
fn authenticated_invalid_utf8_precedes_planner_stall() {
    for attachment in [false, true] {
        for planner_error in [false, true] {
            let mut node = node();
            let mut plain = vec![b'x'; 1048577];
            plain[0] = 255;
            let (content, objects) = contents(&mut node, &plain, attachment);
            let payload = planned(&node, payload(content));
            let head = retain(&mut node);
            let writer = node.r.cfg.device_id;
            let before_verified = node.r.stats.verified;
            if planner_error {
                node.r.planner = Box::new(ErrorPlanner);
            }
            assert!(matches!(
                apply_body(&mut node, head, &payload, &objects, writer),
                crate::replica::apply::Outcome::Void("unindexed_markdown_invalid_utf8")
            ));
            assert_eq!(node.r.store.head().unwrap(), head);
            assert_eq!(node.r.stats.verified, before_verified);
        }
    }
}
#[test]
fn missing_chunk_refs_precedes_planner_stall_with_cold_or_warm_inventory() {
    for planner_error in [false, true] {
        for warm_inventory in [false, true] {
            let mut node = node();
            let (content, objects) = contents(&mut node, &vec![b'x'; 1048577], true);
            let FileContent::AttachmentV1(attachment) = &content else {
                unreachable!()
            };
            let refs = [attachment.reference.manifest_cipher_hash];
            if warm_inventory {
                let (descriptor, expected) =
                    crate::replica::attachment_fetch::descriptor(attachment);
                let manifest = node
                    .r
                    .sealer
                    .open_attachment_manifest(
                        &descriptor,
                        expected,
                        &objects[&refs[0]],
                        AttachmentLimits::default(),
                    )
                    .unwrap();
                node.r
                    .store
                    .commit(crate::store::Tx {
                        meta: vec![crate::replica::attachment_inventory::inventory_meta(
                            refs[0],
                            &manifest.manifest().chunks,
                        )],
                        ..Default::default()
                    })
                    .unwrap();
            }
            let payload = planned(&node, payload(content));
            let head = retain(&mut node);
            let writer = node.r.cfg.device_id;
            let before_verified = node.r.stats.verified;
            if planner_error {
                node.r.planner = Box::new(ErrorPlanner);
            }
            assert!(matches!(
                apply_body_with_refs(&mut node, head, &payload, &objects, writer, &refs),
                crate::replica::apply::Outcome::Void("V7: native source refs")
            ));
            assert_eq!(node.r.store.head().unwrap(), head);
            assert_eq!(node.r.stats.verified, before_verified);
        }
    }
}
#[test]
fn async_production_profiles_never_confirm_before_complete_source() {
    for attachment in [false, true] {
        let mut a = node();
        let before = a.r.store.head().unwrap();
        let (content, objects) = contents(&mut a, &vec![b'x'; 1048577], attachment);
        let p = payload(content);
        let head = Head {
            seq: before.seq + 1,
            chain: B32([4; 32]),
        };
        assert!(matches!(
            a.r.unindexed_source_check(
                head,
                &p,
                Some(&objects.keys().copied().collect::<Vec<_>>())
            ),
            Check::Pending
        ));
        assert_eq!(a.r.store.head().unwrap(), before);
        for _ in 0..4 {
            step(&mut a, &objects, head, false);
            match a.r.unindexed_source_check(
                head,
                &p,
                Some(&objects.keys().copied().collect::<Vec<_>>()),
            ) {
                Check::Pending => assert_eq!(a.r.store.head().unwrap(), before),
                Check::Ready(inventory) => {
                    assert_eq!(inventory.len(), usize::from(attachment) + 1);
                    break;
                }
                _ => panic!("unexpected proof failure"),
            }
        }
        assert!(matches!(
            a.r.unindexed_source_check(
                head,
                &p,
                Some(&objects.keys().copied().collect::<Vec<_>>())
            ),
            Check::Ready(_)
        ));
        assert_eq!(a.r.store.head().unwrap(), before);
        assert_eq!(a.r.store.pending_count().unwrap(), 0);
        assert!(a.r.store.file(&B16([52; 16])).unwrap().is_none());
    }
}
#[test]
fn completed_byte_cache_avoids_refetch_but_same_hash_epoch_change_is_a_miss() {
    let mut a = node();
    let before = a.r.store.head().unwrap();
    let (content, objects) = contents(&mut a, &vec![b'x'; 1048577], false);
    let mut p = payload(content);
    let head = Head {
        seq: before.seq + 1,
        chain: B32([4; 32]),
    };
    assert!(matches!(
        a.r.unindexed_source_check(head, &p, Some(&objects.keys().copied().collect::<Vec<_>>())),
        Check::Pending
    ));
    for _ in 0..3 {
        step(&mut a, &objects, head, false);
    }
    let Check::Ready(meta) =
        a.r.unindexed_source_check(head, &p, Some(&objects.keys().copied().collect::<Vec<_>>()))
    else {
        panic!("whole source not proved");
    };
    a.r.store
        .commit(crate::store::Tx {
            meta,
            ..Default::default()
        })
        .unwrap();
    a.r.take_log_calls();
    let second = Head {
        seq: head.seq,
        chain: B32([5; 32]),
    };
    assert!(matches!(
        a.r.unindexed_source_check(
            second,
            &p,
            Some(&objects.keys().copied().collect::<Vec<_>>())
        ),
        Check::Ready(_)
    ));
    assert!(
        !a.r.take_log_calls()
            .iter()
            .any(|c| matches!(c.request, LogRequest::GetObject { .. }))
    );
    let rt::Op::UnindexedMarkdownPut(f) = &mut p.mutation.ops[0] else {
        unreachable!()
    };
    let FileContent::Blob(b) = &mut f.payload.content else {
        unreachable!()
    };
    b.id_epoch = 2;
    assert!(matches!(
        a.r.unindexed_source_check(
            Head {
                seq: head.seq,
                chain: B32([6; 32])
            },
            &p,
            Some(&objects.keys().copied().collect::<Vec<_>>())
        ),
        Check::Failed(StreamError::NoKey)
    ));
    assert_eq!(a.r.store.head().unwrap(), before);
    assert!(a.r.store.file(&B16([52; 16])).unwrap().is_none());
}
#[test]
fn late_response_after_store_generation_change_cannot_complete_old_session() {
    let mut a = node();
    let before = a.r.store.head().unwrap();
    let (content, objects) = contents(&mut a, &vec![b'x'; 1048577], true);
    let p = payload(content);
    let head = Head {
        seq: before.seq + 1,
        chain: B32([4; 32]),
    };
    assert!(matches!(
        a.r.unindexed_source_check(head, &p, Some(&objects.keys().copied().collect::<Vec<_>>())),
        Check::Pending
    ));
    a.r.store_generation += 1;
    step(&mut a, &objects, head, false);
    assert!(matches!(
        a.r.unindexed_source_check(head, &p, Some(&objects.keys().copied().collect::<Vec<_>>())),
        Check::Pending
    ));
    for _ in 0..3 {
        step(&mut a, &objects, head, false);
    }
    assert!(matches!(
        a.r.unindexed_source_check(head, &p, Some(&objects.keys().copied().collect::<Vec<_>>())),
        Check::Ready(_)
    ));
    assert_eq!(a.r.store.head().unwrap(), before);
    assert!(
        a.r.store
            .meta("replica.unindexed_byte_proofs")
            .unwrap()
            .is_none()
    );
}
#[test]
fn missing_object_retries_and_cannot_create_a_proof_or_confirmation() {
    let mut a = node();
    let before = a.r.store.head().unwrap();
    let (content, objects) = contents(&mut a, &vec![b'x'; 1048577], true);
    let p = payload(content);
    let head = Head {
        seq: before.seq + 1,
        chain: B32([4; 32]),
    };
    assert!(matches!(
        a.r.unindexed_source_check(head, &p, Some(&objects.keys().copied().collect::<Vec<_>>())),
        Check::Pending
    ));
    let call =
        a.r.take_log_calls()
            .into_iter()
            .find(|c| matches!(c.request, LogRequest::GetObject { .. }))
            .unwrap();
    a.r.on_unindexed_source_reply(head, call.id, Err(LogError::Offline));
    assert!(matches!(
        a.r.unindexed_source_check(head, &p, Some(&objects.keys().copied().collect::<Vec<_>>())),
        Check::Pending
    ));
    assert!(
        !a.r.take_log_calls()
            .iter()
            .any(|c| matches!(c.request, LogRequest::GetObject { .. }))
    );
    a.clock.set(a.clock.get() + 10000);
    a.r.unindexed_source_step();
    for _ in 0..3 {
        step(&mut a, &objects, head, false);
    }
    assert!(matches!(
        a.r.unindexed_source_check(head, &p, Some(&objects.keys().copied().collect::<Vec<_>>())),
        Check::Ready(_)
    ));
    assert_eq!(a.r.store.head().unwrap(), before);
}
#[test]
fn invalid_prefix_only_rejects_after_complete_authentication_and_late_corruption_is_not_writer_error()
 {
    for corrupt in [false, true] {
        let mut a = node();
        let before = a.r.store.head().unwrap();
        let mut plain = vec![b'x'; 8 * 1048576 + 1];
        plain[0] = 255;
        let (content, objects) = contents(&mut a, &plain, true);
        let p = planned(&a, payload(content));
        let head = retain(&mut a);
        let writer = a.r.cfg.device_id;
        a.r.planner = Box::new(ErrorPlanner);
        assert!(matches!(
            a.r.unindexed_source_check(
                head,
                &p,
                Some(&objects.keys().copied().collect::<Vec<_>>())
            ),
            Check::Pending
        ));
        step(&mut a, &objects, head, false); // manifest
        step(&mut a, &objects, head, false); // invalid UTF8 first chunk
        assert!(matches!(
            a.r.unindexed_source_check(
                head,
                &p,
                Some(&objects.keys().copied().collect::<Vec<_>>())
            ),
            Check::Pending
        ));
        step(&mut a, &objects, head, corrupt);
        match a.r.unindexed_source_check(
            head,
            &p,
            Some(&objects.keys().copied().collect::<Vec<_>>()),
        ) {
            Check::InvalidUtf8 => assert!(!corrupt),
            Check::Failed(StreamError::Corrupt(_)) => assert!(corrupt),
            _ => panic!("incorrect complete-source classification"),
        }
        assert_eq!(a.r.store.head().unwrap(), before);
        let outcome =
            a.r.test_apply_authorized_unindexed_with_refs(
                head.seq,
                head,
                p,
                &mut Default::default(),
                writer,
                &objects.keys().copied().collect::<Vec<_>>(),
            )
            .unwrap();
        if corrupt {
            assert!(matches!(
                outcome,
                crate::replica::apply::Outcome::SourcePending
            ));
            assert_eq!(a.r.store.head().unwrap(), before);
        } else {
            assert!(matches!(
                outcome,
                crate::replica::apply::Outcome::Void("unindexed_markdown_invalid_utf8")
            ));
            assert_eq!(a.r.store.head().unwrap(), head);
        }
    }
}
