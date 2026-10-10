use super::*;
use crate::replica::BasesDiscoveryHandle;

fn discovery_actor(source: &str) -> (Replica<ProjectionStore>, SessionId) {
    let (svc, mut a, _) = configured();
    a.create(11, "Views/actual.base", source);
    a.create(
        1,
        "Tasks/plain.md",
        "---\ntags: [task]\nstatus: open\n---\n",
    );
    settle(&mut [&mut a]);
    let mut r = projected(&svc, a);
    // Discovery's explicitly specified PRIMARY bounded inventory algorithm is
    // different from the execution tests' forbidden whole-source warm fallback.
    r.store().armed.set(false);
    let (session, _) = r
        .hello(
            SessionAuth::Host,
            HelloParams {
                versions: vec![Version { major: 1, minor: 0 }],
                client_name: "discovery test".into(),
                client_version: "test".into(),
                features: None,
                timezone: None,
            },
        )
        .unwrap();
    (r, session)
}
#[test]
fn primary_inventory_empty_definition_page_makes_real_progress_before_eof() {
    let (svc, mut a, _) = configured();
    for id in 1..=70 {
        a.create(id, &format!("Tasks/{id}.md"), "---\ntags: [task]\n---\n");
    }
    a.create(200, "Views/late.base", THREE);
    settle(&mut [&mut a]);
    let mut r = projected(&svc, a);
    r.store().armed.set(false);
    let (session, _) = r
        .hello(
            SessionAuth::Host,
            HelloParams {
                versions: vec![Version { major: 1, minor: 0 }],
                client_name: "paged universe".into(),
                client_version: "test".into(),
                features: None,
                timezone: None,
            },
        )
        .unwrap();
    let first = r
        .encode_bases_discovery_page(session, Some("UTC"), 128, None, |_, page, _| {
            Ok((page.views.len(), page.next))
        })
        .unwrap();
    assert_eq!(first.0, 0);
    assert!(first.1.is_some());
    let second = r
        .encode_bases_discovery_page(session, Some("UTC"), 128, first.1, |_, page, _| {
            Ok((
                page.views
                    .iter()
                    .map(|v| (v.record, v.index))
                    .collect::<Vec<_>>(),
                page.next,
            ))
        })
        .unwrap();
    assert_eq!(
        second.0,
        vec![
            (B16([200; 16]), 0),
            (B16([200; 16]), 1),
            (B16([200; 16]), 2)
        ]
    );
    assert!(second.1.is_none());
}
#[test]
fn native_discovery_slots_are_globally_bounded_and_close_releases_only_residency() {
    let (mut r, session) = discovery_actor(THREE);
    let mut sessions = vec![session];
    for _ in 1..65 {
        sessions.push(
            r.hello(
                SessionAuth::Host,
                HelloParams {
                    versions: vec![Version { major: 1, minor: 0 }],
                    client_name: "bounded slots".into(),
                    client_version: "test".into(),
                    features: None,
                    timezone: None,
                },
            )
            .unwrap()
            .0,
        );
    }
    for session in &sessions[..64] {
        assert!(
            r.encode_bases_discovery_page(*session, Some("UTC"), 1, None, |_, page, _| Ok(
                page.next
            ))
            .unwrap()
            .is_some()
        );
    }
    let encoded = Cell::new(false);
    assert!(
        r.encode_bases_discovery_page(sessions[64], Some("UTC"), 1, None, |_, _, _| {
            encoded.set(true);
            Ok(())
        })
        .is_err()
    );
    assert!(!encoded.get());
    r.close(sessions[0]);
    assert!(
        r.encode_bases_discovery_page(sessions[64], Some("UTC"), 1, None, |_, page, _| Ok(
            page.next
        ))
        .unwrap()
        .is_some()
    );
}
#[test]
fn reentrant_encoder_cannot_publish_a_sixty_fifth_resident_slot() {
    let (mut r, session) = discovery_actor(THREE);
    let mut other_sessions = Vec::new();
    for _ in 0..64 {
        other_sessions.push(
            r.hello(
                SessionAuth::Host,
                HelloParams {
                    versions: vec![Version { major: 1, minor: 0 }],
                    client_name: "reentry residency".into(),
                    client_version: "test".into(),
                    features: None,
                    timezone: None,
                },
            )
            .unwrap()
            .0,
        );
    }
    let encoded = Cell::new(false);
    let result = r.encode_bases_discovery_page(session, Some("UTC"), 1, None, |actor, _, _| {
        for other in &other_sessions {
            assert!(
                actor
                    .encode_bases_discovery_page(*other, Some("UTC"), 1, None, |_, page, _| Ok(
                        page.next
                    ))?
                    .is_some()
            );
        }
        encoded.set(true);
        Ok(())
    });
    assert!(encoded.get());
    assert!(result.is_err());
    // All 64 admitted inner slots still exist; the outer failed publication
    // cannot displace one or exceed the residency ceiling.
    assert!(
        r.encode_bases_discovery_page(session, Some("UTC"), 1, None, |_, _, _| Ok(()))
            .is_err()
    );
    r.close(other_sessions[0]);
    assert!(
        r.encode_bases_discovery_page(session, Some("UTC"), 1, None, |_, page, _| Ok(page.next))
            .unwrap()
            .is_some()
    );
}
#[test]
fn discovery_residency_never_adds_a_strong_catalog_pin_and_drift_is_conflict() {
    let (mut r, session) = discovery_actor(THREE);
    let before = std::sync::Arc::strong_count(&r.catalog);
    let strong = r.collection_setup_capture_fence(None).unwrap();
    assert_eq!(std::sync::Arc::strong_count(&r.catalog), before + 1);
    drop(strong);
    let token = r
        .encode_bases_discovery_page(session, Some("UTC"), 1, None, |_, page, _| Ok(page.next))
        .unwrap()
        .unwrap();
    assert_eq!(std::sync::Arc::strong_count(&r.catalog), before);
    // Actual private actor catalog replacement; no source or ordinal fallback.
    r.catalog = std::sync::Arc::new(mdbn_core::types::Catalog::empty());
    let encoded = Cell::new(false);
    let error = r
        .encode_bases_discovery_page(session, Some("UTC"), 1, Some(token), |_, _, _| {
            encoded.set(true);
            Ok(())
        })
        .err()
        .unwrap();
    assert_eq!(error.code(), Some(ErrorCode::Conflict));
    assert!(!encoded.get());
}
#[test]
fn postcodec_catalog_drift_cannot_publish_discovery_or_exact_source() {
    let (mut r, session) = discovery_actor(THREE);
    let result = r.encode_bases_discovery_page(session, Some("UTC"), 1, None, |actor, _, _| {
        actor.catalog = std::sync::Arc::new(mdbn_core::types::Catalog::empty());
        Ok(())
    });
    assert_eq!(result.err().unwrap().code(), Some(ErrorCode::Conflict));
    let (mut r, session) = discovery_actor(THREE);
    let selection = r
        .encode_bases_discovery_page(session, Some("UTC"), 1, None, |_, page, _| {
            let view = &page.views[0];
            Ok(BasesViewSelection {
                record: view.record,
                revision: view.revision,
                index: view.index,
            })
        })
        .unwrap();
    let result = r.encode_bases_view_source(session, selection, Some("UTC"), |actor, _, _| {
        actor.catalog = std::sync::Arc::new(mdbn_core::types::Catalog::empty());
        Ok(())
    });
    assert_eq!(result.err().unwrap().code(), Some(ErrorCode::Conflict));
}
const THREE: &str = "views:\n  - type: table\n    name: duplicate\n  - type: table\n    name: duplicate\n  - type: table\n";
#[test]
fn native_discovery_pages_original_ordinals_and_duplicate_names_under_one_clock() {
    let (mut r, session) = discovery_actor(THREE);
    let mut token = None;
    let mut indices = Vec::new();
    let mut clock = None;
    for _ in 0..8 {
        let (next, rows, current_clock) = r
            .encode_bases_discovery_page(session, Some("UTC"), 1, token, |_, page, _| {
                Ok((
                    page.next,
                    page.views
                        .iter()
                        .map(|view| (view.record, view.index, view.name.clone(), view.revision))
                        .collect::<Vec<_>>(),
                    page.clock.clone(),
                ))
            })
            .unwrap();
        if let Some(first) = &clock {
            assert_eq!(first, &current_clock);
        } else {
            clock = Some(current_clock);
        }
        for (id, ordinal, name, revision) in rows {
            assert_eq!(id, B16([11; 16]));
            assert_eq!(revision, mdbn_wire::hash::sha256(THREE.as_bytes()));
            assert_eq!(
                name.as_deref(),
                if ordinal < 2 { Some("duplicate") } else { None }
            );
            indices.push(ordinal);
        }
        token = next;
        if token.is_none() {
            break;
        }
    }
    assert_eq!(indices, vec![0, 1, 2]);
    assert!(token.is_none());
}
#[test]
fn unknown_or_foreign_discovery_handle_never_restarts_or_encodes() {
    let (mut r, session) = discovery_actor(THREE);
    let encoded = Cell::new(false);
    assert!(
        r.encode_bases_discovery_page(SessionId(u64::MAX), Some("UTC"), 1, None, |_, _, _| {
            encoded.set(true);
            Ok(())
        })
        .is_err()
    );
    assert!(
        r.encode_bases_discovery_page(
            session,
            Some("UTC"),
            1,
            Some(BasesDiscoveryHandle([7; 32])),
            |_, _, _| {
                encoded.set(true);
                Ok(())
            }
        )
        .is_err()
    );
    assert!(!encoded.get());
}
#[test]
fn consumed_discovery_handle_is_not_reusable() {
    let (mut r, session) = discovery_actor(THREE);
    let token = r
        .encode_bases_discovery_page(session, Some("UTC"), 1, None, |_, page, _| Ok(page.next))
        .unwrap()
        .unwrap();
    r.encode_bases_discovery_page(session, Some("UTC"), 1, Some(token), |_, _, _| Ok(()))
        .unwrap();
    assert!(
        r.encode_bases_discovery_page(session, Some("UTC"), 1, Some(token), |_, _, _| Ok(()))
            .is_err()
    );
}
#[test]
fn discovery_codec_as_of_drift_suppresses_publication_and_handle() {
    let (mut r, session) = discovery_actor(THREE);
    let result = r.encode_bases_discovery_page(session, Some("UTC"), 1, None, |r, _, _| {
        r.view_version += 1;
        Ok(vec![1])
    });
    assert!(result.is_err());
}
#[test]
fn discovery_codec_readiness_drift_suppresses_publication() {
    let (mut r, session) = discovery_actor(THREE);
    assert!(
        r.encode_bases_discovery_page(session, Some("UTC"), 1, None, |r, _, _| {
            r.store().ready.set(false);
            Ok(vec![1])
        })
        .is_err()
    );
}
#[test]
fn closing_session_invalidates_native_discovery_slot() {
    let (mut r, session) = discovery_actor(THREE);
    let token = r
        .encode_bases_discovery_page(session, Some("UTC"), 1, None, |_, page, _| Ok(page.next))
        .unwrap()
        .unwrap();
    r.close(session);
    assert!(
        r.encode_bases_discovery_page(session, Some("UTC"), 1, Some(token), |_, _, _| Ok(()))
            .is_err()
    );
}
#[test]
fn exact_source_is_native_original_bytes_and_revision_not_a_reused_path() {
    let (mut r, session) = discovery_actor(THREE);
    let source = r
        .encode_bases_view_source(session, selection(THREE, 1), Some("UTC"), |_, source, _| {
            Ok((
                source.source.clone(),
                source.view.index,
                source.view.revision,
            ))
        })
        .unwrap();
    assert_eq!(
        source,
        (
            THREE.to_owned(),
            1,
            mdbn_wire::hash::sha256(THREE.as_bytes())
        )
    );
    let encoded = Cell::new(false);
    let mut wrong = selection(THREE, 1);
    wrong.revision = B32([9; 32]);
    assert!(
        r.encode_bases_view_source(session, wrong, Some("UTC"), |_, _, _| {
            encoded.set(true);
            Ok(())
        })
        .is_err()
    );
    assert!(!encoded.get());
}
#[test]
fn exact_source_codec_authority_or_readiness_change_is_not_published() {
    let (mut r, session) = discovery_actor(THREE);
    assert!(
        r.encode_bases_view_source(session, selection(THREE, 1), Some("UTC"), |r, _, _| {
            r.close(session);
            Ok(vec![1])
        })
        .is_err()
    );
    let (mut r, session) = discovery_actor(THREE);
    assert!(
        r.encode_bases_view_source(session, selection(THREE, 1), Some("UTC"), |r, _, _| {
            r.store().ready.set(false);
            Ok(vec![1])
        })
        .is_err()
    );
}
#[test]
fn malformed_actual_source_is_visible_refusal_not_empty_catalog() {
    let (mut r, session) = discovery_actor(THREE);
    // Normal signed mutation planning rejects malformed source before storing
    // it. Inject a real owned Store-row validity fault, not a phantom catalog.
    let mut row = r.store().inner.record(&B16([11; 16])).unwrap().unwrap();
    row.doc = "views: [\n".into();
    row.revision = mdbn_wire::hash::sha256(row.doc.as_bytes());
    r.store_mut()
        .inner
        .commit(crate::store::Tx {
            records_put: vec![row],
            ..Default::default()
        })
        .unwrap();
    let encoded = Cell::new(false);
    assert!(
        r.encode_bases_discovery_page(session, Some("UTC"), 128, None, |_, _, _| {
            encoded.set(true);
            Ok(())
        })
        .is_err()
    );
    assert!(!encoded.get());
}
