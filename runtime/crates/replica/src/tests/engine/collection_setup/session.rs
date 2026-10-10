use super::capture::{setup, upload};
use super::*;
use crate::{Store, file_source::SourceNeed, replica::CollectionSetupSession};
use std::collections::BTreeMap;
fn drive(a: &Node, session: &mut CollectionSetupSession, svc: &FakeLogService) -> usize {
    let objects: BTreeMap<_, _> = svc.objects(&COL).into_iter().collect();
    let mut count = 0;
    while let Some(need) = a.r.collection_setup_session_need(session).unwrap() {
        let address = match need {
            SourceNeed::BlobPart { address, .. }
            | SourceNeed::Manifest { address, .. }
            | SourceNeed::Chunk { address, .. } => address,
        };
        a.r.supply_collection_setup_session(session, need, &objects[&address])
            .unwrap();
        count += 1;
    }
    count
}
#[test]
fn session_owns_actual_inputs_and_clock_selects_only_prospective_sources() {
    let (svc, mut a) = keyed_node();
    upload(&mut a, 1, "a.base", b"views: []\r\n");
    upload(&mut a, 2, "b.base", b"views: []\n");
    upload(&mut a, 3, "unrelated.bin", b"not YAML");
    let mut input = setup();
    let clock_before = a.clock.get();
    let mut session =
        a.r.begin_collection_setup_session(input.clone(), None, None)
            .unwrap();
    input.configuration.requirements[0].value = mdbn_core::value::Value::string("txt");
    input.configuration.provisions[0].value = mdbn_core::value::Value::string("txt");
    a.clock.set(clock_before + 100_000);
    assert_eq!(drive(&a, &mut session, &svc), 4);
    let review = a.r.finish_collection_setup_session(session).unwrap();
    assert_eq!(review.assessment().files.len(), 2);
    assert!(review.assessment().applicable);
    assert!(review.clock().instant_ms < (clock_before + 100_000) as i64);
    let doc = review
        .assessment()
        .configuration
        .document
        .as_deref()
        .unwrap();
    assert!(doc.contains("base"));
    assert!(!doc.contains("txt"));
    let expected_revision = review.assessment().collection_revision;
    let expected_digest = review.assessment().assessment_digest;
    let clock = review.clock().clone();
    let plan =
        a.r.prepare_reviewed_collection_setup(review, expected_revision, expected_digest)
            .unwrap();
    assert_eq!(plan.clock(), &clock);
    assert_eq!(
        plan.operations()
            .iter()
            .filter(|op| matches!(op, mdbn_core::intent::Op::OrdinaryFileToRecord(_)))
            .count(),
        2
    );
    assert!(plan.operations().iter().any(
        |op| matches!(op,mdbn_core::intent::Op::ResourcePut(r) if r.path=="mdbase.provisions.yaml")
    ));
    a.r.recheck_prepared_collection_setup(&plan).unwrap();
    assert!(a.r.store.file(&B16([1; 16])).unwrap().is_some());
    assert!(
        a.r.store.record(&B16([1; 16])).unwrap().is_none(),
        "prepared pure data is not publication"
    );
}
#[test]
fn metadata_only_above_cap_and_authenticated_invalid_utf8_are_retained() {
    let (svc, mut a) = keyed_node();
    upload(&mut a, 1, "large.base", &vec![b'x'; (1 << 20) + 1]);
    upload(&mut a, 2, "invalid.base", &[255]);
    let mut session =
        a.r.begin_collection_setup_session(setup(), Some("UTC"), None)
            .unwrap();
    assert_eq!(drive(&a, &mut session, &svc), 2);
    let review = a.r.finish_collection_setup_session(session).unwrap();
    assert!(review.assessment().applicable);
    let files = &review.assessment().files;
    assert_eq!(files[0].diagnostic.as_deref(), Some("record_too_large"));
    assert_eq!(files[1].diagnostic.as_deref(), Some("invalid_utf8"));
    let rev = review.assessment().collection_revision;
    let digest = review.assessment().assessment_digest;
    let plan =
        a.r.prepare_reviewed_collection_setup(review, rev, digest)
            .unwrap();
    assert!(
        !plan
            .operations()
            .iter()
            .any(|op| matches!(op, mdbn_core::intent::Op::OrdinaryFileToRecord(_)))
    );
}
#[test]
fn incomplete_or_corrupt_work_cannot_finish_or_resume_a_session() {
    let (svc, mut a) = keyed_node();
    upload(&mut a, 1, "a.base", b"views: []\n");
    let session =
        a.r.begin_collection_setup_session(setup(), None, None)
            .unwrap();
    assert_eq!(
        a.r.finish_collection_setup_session(session)
            .err()
            .unwrap()
            .code(),
        Some(ErrorCode::Unavailable)
    );
    let mut session =
        a.r.begin_collection_setup_session(setup(), None, None)
            .unwrap();
    let need =
        a.r.collection_setup_session_need(&mut session)
            .unwrap()
            .unwrap();
    assert!(
        a.r.supply_collection_setup_session(&mut session, need, b"bad")
            .is_err()
    );
    assert!(a.r.collection_setup_session_need(&mut session).is_err());
    assert!(a.r.finish_collection_setup_session(session).is_err());
    // Cancellation drops all session-owned observations; a new explicit session
    // is required, never a continuation of the incomplete proof.
    let mut session =
        a.r.begin_collection_setup_session(setup(), None, None)
            .unwrap();
    a.r.collection_setup_session_need(&mut session).unwrap();
    drop(session);
    let mut fresh =
        a.r.begin_collection_setup_session(setup(), None, None)
            .unwrap();
    drive(&a, &mut fresh, &svc);
    assert!(
        a.r.finish_collection_setup_session(fresh)
            .unwrap()
            .assessment()
            .applicable
    );
}
#[test]
fn changed_review_bindings_and_prepared_lifetime_always_refuse() {
    let (_, mut a) = keyed_node();
    let session =
        a.r.begin_collection_setup_session(setup(), None, None)
            .unwrap();
    let review = a.r.finish_collection_setup_session(session).unwrap();
    let rev = review.assessment().collection_revision;
    assert_eq!(
        a.r.prepare_reviewed_collection_setup(
            review,
            rev,
            mdbn_core::ids::Hash::of(b"wrong review")
        )
        .err()
        .unwrap()
        .code(),
        Some(ErrorCode::Conflict)
    );
    let session =
        a.r.begin_collection_setup_session(setup(), None, None)
            .unwrap();
    let review = a.r.finish_collection_setup_session(session).unwrap();
    let rev = review.assessment().collection_revision;
    let digest = review.assessment().assessment_digest;
    let plan =
        a.r.prepare_reviewed_collection_setup(review, rev, digest)
            .unwrap();
    a.r.store_generation += 1;
    assert_eq!(
        a.r.recheck_prepared_collection_setup(&plan)
            .unwrap_err()
            .code(),
        Some(ErrorCode::Conflict)
    );
}
#[test]
fn delegated_and_invalid_timezone_begin_refuse_before_source_work() {
    let (_, mut a) = keyed_node();
    assert_eq!(
        a.r.begin_collection_setup_session(setup(), None, Some(B16([8; 16])))
            .err()
            .unwrap()
            .code(),
        Some(ErrorCode::Forbidden)
    );
    assert_eq!(
        a.r.begin_collection_setup_session(setup(), Some("Not/AZone"), None)
            .err()
            .unwrap()
            .code(),
        Some(ErrorCode::InvalidRequest)
    );
}
#[test]
fn blocked_components_are_reviewable_without_empty_install_success() {
    let (_, mut a) = keyed_node();
    a.r.planner = Box::new(crate::plan::CorePlanner);
    a.r.submit(
        a.s,
        SubmitParams {
            ops: vec![Op::ResourcePut(mdbn_wire::intent::ResourcePut {
                path: "mdbase.yaml".into(),
                doc: "spec_version: '0.3.0'\nx-feature: false\n".into(),
                base_revision: None,
                must_not_exist: None,
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
    let mut declaration = setup();
    declaration.configuration.provisions.push(
        mdbn_core::setup::configuration::ConfigurationProvision {
            requirement: "needs-user-flag".into(),
            path: "/x-feature/allowed".into(),
            operation: mdbn_core::setup::configuration::ConfigurationOperation::SetAdd,
            value: mdbn_core::value::Value::Bool(true),
        },
    );
    declaration.configuration.requirements.push(
        mdbn_core::setup::configuration::ConfigurationRequirement {
            id: "needs-user-flag".into(),
            path: "/x-feature/allowed".into(),
            predicate: mdbn_core::setup::configuration::ConfigurationPredicate::Contains,
            value: mdbn_core::value::Value::Bool(true),
        },
    );
    let mut session =
        a.r.begin_collection_setup_session(declaration, None, None)
            .unwrap();
    assert!(
        a.r.collection_setup_session_need(&mut session)
            .unwrap()
            .is_none()
    );
    let review = a.r.finish_collection_setup_session(session).unwrap();
    assert!(!review.assessment().applicable);
    let rev = review.assessment().collection_revision;
    let digest = review.assessment().assessment_digest;
    assert_eq!(
        a.r.prepare_reviewed_collection_setup(review, rev, digest)
            .err()
            .unwrap()
            .code(),
        Some(ErrorCode::InvalidRequest)
    );
}
