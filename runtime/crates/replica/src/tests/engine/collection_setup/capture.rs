use super::*;
use crate::log::LogClient;
use crate::{
    Store,
    file_source::SourceNeed,
    replica::{AttachmentSource, AttachmentUploadParams},
};
use mdbn_core::{
    intent::OpClock,
    setup::{
        configuration::{
            ConfigurationDeclaration, ConfigurationOperation, ConfigurationPredicate,
            ConfigurationProvision, ConfigurationRequirement,
        },
        envelope::CollectionSetup,
    },
    value::Value,
};
use std::collections::BTreeMap;
struct Rng(u8);
impl crate::crypto::Entropy for Rng {
    fn fill(&mut self, out: &mut [u8]) {
        for b in out {
            self.0 = self.0.wrapping_mul(31).wrapping_add(7);
            *b = self.0;
        }
    }
}
impl crate::crypto::CsprngEntropy for Rng {}
struct Bytes(Vec<u8>);
impl AttachmentSource for Bytes {
    fn len(&self) -> u64 {
        self.0.len() as u64
    }
    fn read_at(&mut self, offset: u64, out: &mut [u8]) -> Result<(), String> {
        let start = offset as usize;
        out.copy_from_slice(self.0.get(start..start + out.len()).ok_or("range")?);
        Ok(())
    }
}
pub(super) fn setup() -> CollectionSetup {
    CollectionSetup {
        application_id: "app.tasks".into(),
        declaration_digest: mdbn_core::ids::Hash::of(b"declaration"),
        type_packs: vec![],
        configuration: ConfigurationDeclaration {
            requirements: vec![ConfigurationRequirement {
                id: "base-extension".into(),
                path: "/settings/record_extensions".into(),
                predicate: ConfigurationPredicate::Contains,
                value: Value::string("base"),
            }],
            provisions: vec![ConfigurationProvision {
                requirement: "base-extension".into(),
                operation: ConfigurationOperation::SetAdd,
                path: "/settings/record_extensions".into(),
                value: Value::string("base"),
            }],
        },
    }
}
fn clock() -> OpClock {
    OpClock {
        instant_ms: 0,
        tz: "UTC".into(),
        local_date: "1970-01-01".into(),
    }
}
pub(super) fn upload(a: &mut Node, id: u8, path: &str, plain: &[u8]) {
    a.r.planner = Box::new(crate::plan::CorePlanner);
    let mutation =
        a.r.start_attachment_upload(
            AttachmentUploadParams {
                file: B16([id; 16]),
                path: path.into(),
                if_revision: None,
                mutation: None,
            },
            Box::new(Bytes(plain.to_vec())),
        )
        .unwrap();
    settle(&mut [&mut *a]);
    assert!(
        a.r.store.file(&B16([id; 16])).unwrap().is_some(),
        "verified upload must create an Ordinary file"
    );
    assert!(a.r.close_attachment_upload(&mutation));
}
fn authenticate(
    a: &Node,
    capture: &mut crate::replica::SetupCapturedInventory,
    id: u8,
    objects: &BTreeMap<B32, Vec<u8>>,
) {
    let mut work =
        a.r.begin_collection_setup_source(capture, crate::convert::uuid(&B16([id; 16])))
            .unwrap();
    while let Some(need) = a.r.collection_setup_source_need(&mut work).unwrap() {
        let address = match need {
            SourceNeed::BlobPart { address, .. }
            | SourceNeed::Manifest { address, .. }
            | SourceNeed::Chunk { address, .. } => address,
        };
        a.r.supply_collection_setup_source(&mut work, need, &objects[&address])
            .unwrap();
    }
    a.r.finish_collection_setup_source(capture, work).unwrap();
}
#[test]
fn verified_attachment_source_and_actor_held_state_assess_exact_ordinary_promotion() {
    let (svc, mut a) = keyed_node();
    upload(&mut a, 1, "tasks.base", b"views: []\r\n");
    let mut capture = a.r.capture_collection_setup_inventory(None).unwrap();
    assert_eq!(capture.files().len(), 1);
    let requirements =
        a.r.captured_collection_setup_source_requirements(&capture, &setup(), &clock())
            .unwrap();
    assert_eq!(requirements.files, capture.files());
    assert!(requirements.applicable);
    let objects = svc.objects(&COL).into_iter().collect();
    authenticate(&a, &mut capture, 1, &objects);
    let assessment =
        a.r.assess_captured_collection_setup(&capture, &setup(), &clock())
            .unwrap();
    assert!(assessment.applicable);
    assert_eq!(assessment.files[0].action, "promote");
    assert_eq!(
        assessment.files[0].source_digest,
        Some(mdbn_core::ids::revision("views: []\r\n"))
    );
    assert!(
        a.r.store.file(&B16([1; 16])).unwrap().is_some(),
        "assessment is not publication"
    );
    assert!(a.r.store.record(&B16([1; 16])).unwrap().is_none());
}
#[test]
fn verified_legacy_blob_source_uses_the_same_frozen_provider_and_assessment() {
    let (svc, mut a) = keyed_node();
    a.r.planner = Box::new(crate::plan::CorePlanner);
    let keys = a.r.testing_epoch_keys();
    let (epoch, key) = keys.first().unwrap();
    let (blob, parts) = crate::crypto::blob::seal_blob(
        &crate::crypto::Secret32(**key),
        *epoch,
        &COL,
        b"views: []\r\n",
        crate::crypto::blob::MIN_PART_SIZE,
        false,
        &mut Rng(1),
    )
    .unwrap();
    for p in parts {
        a.log
            .call(crate::log::LogRequest::PutObject {
                collection: COL,
                address: p.address,
                kind: mdbn_wire::envelope::ItemKind::BlobPart,
                bytes: p.bytes,
            })
            .unwrap();
    }
    a.r.submit(
        a.s,
        SubmitParams {
            ops: vec![Op::FilePut(mdbn_wire::intent::FilePut {
                id: B16([1; 16]),
                path: "blob.base".into(),
                blob,
                if_revision: None,
                base: None,
            })],
            mutation_id: None,
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
    settle(&mut [&mut a]);
    assert!(a.r.store.file(&B16([1; 16])).unwrap().is_some());
    let mut capture = a.r.capture_collection_setup_inventory(None).unwrap();
    let objects = svc.objects(&COL).into_iter().collect();
    authenticate(&a, &mut capture, 1, &objects);
    assert_eq!(
        a.r.assess_captured_collection_setup(&capture, &setup(), &clock())
            .unwrap()
            .files[0]
            .action,
        "promote"
    );
}

#[test]
fn authenticated_invalid_utf8_and_yaml_are_retained_not_fatal_source_failures() {
    let (svc, mut a) = keyed_node();
    upload(&mut a, 1, "invalid.base", &[255, 1]);
    upload(&mut a, 2, "yaml.base", b"---\n[not: mapping\n---\n");
    let mut capture = a.r.capture_collection_setup_inventory(None).unwrap();
    let objects = svc.objects(&COL).into_iter().collect();
    authenticate(&a, &mut capture, 1, &objects);
    authenticate(&a, &mut capture, 2, &objects);
    let assessed =
        a.r.assess_captured_collection_setup(&capture, &setup(), &clock())
            .unwrap();
    assert!(assessed.applicable);
    assert_eq!(
        assessed.files[0].diagnostic.as_deref(),
        Some("invalid_utf8")
    );
    assert_eq!(assessed.files[1].action, "retain");
}
#[test]
fn no_source_proof_or_corrupt_ciphertext_cannot_become_empty_success() {
    let (svc, mut a) = keyed_node();
    upload(&mut a, 1, "tasks.base", b"views: []\n");
    let capture = a.r.capture_collection_setup_inventory(None).unwrap();
    assert_eq!(
        a.r.assess_captured_collection_setup(&capture, &setup(), &clock())
            .unwrap_err()
            .code(),
        Some(ErrorCode::Unavailable)
    );
    let mut capture = a.r.capture_collection_setup_inventory(None).unwrap();
    let mut work =
        a.r.begin_collection_setup_source(&capture, crate::convert::uuid(&B16([1; 16])))
            .unwrap();
    let need =
        a.r.collection_setup_source_need(&mut work)
            .unwrap()
            .unwrap();
    let SourceNeed::Manifest { address, .. } = need else {
        unreachable!()
    };
    let objects: BTreeMap<_, _> = svc.objects(&COL).into_iter().collect();
    let mut raw = objects[&address].clone();
    let last = raw.len() - 1;
    raw[last] ^= 1;
    assert!(
        a.r.supply_collection_setup_source(&mut work, need, &raw)
            .is_err()
    );
    assert!(
        a.r.finish_collection_setup_source(&mut capture, work)
            .is_err()
    );
    assert!(
        a.r.assess_captured_collection_setup(&capture, &setup(), &clock())
            .is_err()
    );
}
#[test]
fn unfinished_work_cancellation_and_concurrent_work_poison_the_capture() {
    let (_, mut a) = keyed_node();
    upload(&mut a, 1, "tasks.base", b"views: []\n");
    let capture = a.r.capture_collection_setup_inventory(None).unwrap();
    let work =
        a.r.begin_collection_setup_source(&capture, crate::convert::uuid(&B16([1; 16])))
            .unwrap();
    drop(work);
    assert!(
        a.r.assess_captured_collection_setup(&capture, &setup(), &clock())
            .is_err()
    );
    let capture = a.r.capture_collection_setup_inventory(None).unwrap();
    let work =
        a.r.begin_collection_setup_source(&capture, crate::convert::uuid(&B16([1; 16])))
            .unwrap();
    assert!(
        a.r.begin_collection_setup_source(&capture, crate::convert::uuid(&B16([1; 16])))
            .is_err()
    );
    drop(work);
    assert!(
        a.r.assess_captured_collection_setup(&capture, &setup(), &clock())
            .is_err()
    );
}
#[test]
fn full_holder_and_authority_are_rechecked_after_transport_await() {
    let (svc, mut a) = keyed_node();
    upload(&mut a, 1, "tasks.base", b"views: []\n");
    let capture = a.r.capture_collection_setup_inventory(None).unwrap();
    let mut work =
        a.r.begin_collection_setup_source(&capture, crate::convert::uuid(&B16([1; 16])))
            .unwrap();
    let need =
        a.r.collection_setup_source_need(&mut work)
            .unwrap()
            .unwrap();
    let SourceNeed::Manifest { address, .. } = need else {
        unreachable!()
    };
    let objects: BTreeMap<_, _> = svc.objects(&COL).into_iter().collect();
    a.r.store_generation += 1;
    assert_eq!(
        a.r.supply_collection_setup_source(&mut work, need, &objects[&address])
            .unwrap_err()
            .code(),
        Some(ErrorCode::Conflict)
    );
    assert!(
        a.r.assess_captured_collection_setup(&capture, &setup(), &clock())
            .is_err()
    );
}
#[test]
fn full_descriptor_path_and_kind_drift_refuse_even_if_the_head_is_unchanged() {
    for change in 0..3 {
        let (svc, mut a) = keyed_node();
        upload(&mut a, 1, "tasks.base", b"views: []\n");
        let capture = a.r.capture_collection_setup_inventory(None).unwrap();
        let mut work =
            a.r.begin_collection_setup_source(&capture, crate::convert::uuid(&B16([1; 16])))
                .unwrap();
        let need =
            a.r.collection_setup_source_need(&mut work)
                .unwrap()
                .unwrap();
        let SourceNeed::Manifest { address, .. } = need else {
            unreachable!()
        };
        let objects: BTreeMap<_, _> = svc.objects(&COL).into_iter().collect();
        let head = a.r.head;
        let mut row = a.r.store.file(&B16([1; 16])).unwrap().unwrap();
        match change {
            0 => {
                let mdbn_wire::attachment::FileContent::AttachmentV1(ref mut c) = row.content
                else {
                    unreachable!()
                };
                c.reference.attachment_id = B32([9; 32]);
            }
            1 => row.path = "other.base".into(),
            _ => row.kind = mdbn_wire::unindexed_markdown::FileKindV1::UnindexedOversizedMarkdown,
        }
        // Test-only corrupt projection: deliberately leave the trusted head alone.
        a.r.store
            .commit(crate::store::Tx {
                files_put: vec![row],
                ..Default::default()
            })
            .unwrap();
        assert_eq!(a.r.head, head);
        assert_eq!(
            a.r.supply_collection_setup_source(&mut work, need, &objects[&address])
                .unwrap_err()
                .code(),
            Some(ErrorCode::Conflict)
        );
        assert!(
            a.r.assess_captured_collection_setup(&capture, &setup(), &clock())
                .is_err()
        );
    }
}

#[test]
fn complete_inventory_and_prospective_requirements_cross_the_page_boundary() {
    let (_, mut a) = keyed_node();
    for id in 1..=130 {
        upload(&mut a, id, &format!("views/{id}.base"), b"views: []\n");
    }
    let capture = a.r.capture_collection_setup_inventory(None).unwrap();
    assert_eq!(capture.files().len(), 130);
    let needs =
        a.r.captured_collection_setup_source_requirements(&capture, &setup(), &clock())
            .unwrap();
    assert_eq!(needs.files, capture.files());
    assert!(needs.applicable);
}

#[test]
fn empty_complete_eof_is_valid_but_store_head_error_is_not_empty_inventory() {
    let (_, a) = keyed_node();
    let capture = a.r.capture_collection_setup_inventory(None).unwrap();
    assert!(capture.files().is_empty());
    assert!(
        a.r.assess_captured_collection_setup(&capture, &setup(), &clock())
            .unwrap()
            .applicable
    );
    a.r.store.data().borrow_mut().fail_head_reads = 1;
    assert_eq!(
        a.r.capture_collection_setup_inventory(None)
            .err()
            .unwrap()
            .code(),
        Some(ErrorCode::Unavailable)
    );
}
