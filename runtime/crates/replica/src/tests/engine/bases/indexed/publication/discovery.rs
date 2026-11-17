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
/// A replica whose primary inventory is `records` (created in batches with
/// the given IDs) plus a three-view Base at the largest identity.
fn inventory_actor(records: &[(B16, String, String)]) -> (Replica<ProjectionStore>, SessionId) {
    inventory_universe(records, true)
}
/// `records`, plus the three-view late Base only when `late`.
fn inventory_universe(
    records: &[(B16, String, String)],
    late: bool,
) -> (Replica<ProjectionStore>, SessionId) {
    let (svc, mut a, _) = configured();
    // Batches stay within one mutation's bounds: 100 records or ~256 KiB.
    let mut batches: Vec<&[(B16, String, String)]> = Vec::new();
    let (mut start, mut bytes) = (0, 0);
    for (i, (_, _, doc)) in records.iter().enumerate() {
        if i > start && (i - start == 100 || bytes + doc.len() > 256 * 1024) {
            batches.push(&records[start..i]);
            (start, bytes) = (i, 0);
        }
        bytes += doc.len();
    }
    batches.push(&records[start..]);
    for batch in batches {
        a.r.submit(
            a.s,
            submission(
                batch
                    .iter()
                    .map(|(id, path, doc)| {
                        Op::Create(Create {
                            id: *id,
                            path: Some(path.clone()),
                            type_name: None,
                            frontmatter: None,
                            body: None,
                            document: Some(Text::Inline(doc.clone())),
                        })
                    })
                    .collect(),
            ),
        )
        .unwrap();
        settle(&mut [&mut a]);
    }
    if late {
        a.create(255, "Views/late.base", THREE);
        settle(&mut [&mut a]);
    }
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
    (r, session)
}
fn task_id(n: u16) -> B16 {
    let mut id = [0; 16];
    id[..2].copy_from_slice(&n.to_be_bytes());
    id[15] = 1;
    B16(id)
}
type DiscoveredPage = (Vec<(B16, u32)>, Option<BasesDiscoveryHandle>);
fn discovery_page(
    r: &mut Replica<ProjectionStore>,
    session: SessionId,
    resume: Option<BasesDiscoveryHandle>,
) -> DiscoveredPage {
    r.encode_bases_discovery_page(
        session,
        Some("UTC"),
        128,
        resume,
        crate::replica::UnreadableSources::Refuse,
        |_, page, _| {
            Ok((
                page.views
                    .iter()
                    .map(|v| (v.record, v.index))
                    .collect::<Vec<_>>(),
                page.next,
            ))
        },
    )
    .unwrap()
}
const LATE: [(B16, u32); 3] = [
    (B16([255; 16]), 0),
    (B16([255; 16]), 1),
    (B16([255; 16]), 2),
];
#[test]
fn a_few_hundred_records_are_discovered_in_one_page() {
    // One relayed round trip per page: a typical collection must not need one
    // page per 64 records (tasknotes-app#449, 13 pages for 773 records).
    let records: Vec<_> = (0..300)
        .map(|n| {
            (
                task_id(n),
                format!("Tasks/{n}.md"),
                format!(
                    "---\ntags: [task]\nstatus: open\ntitle: task {n}\n---\nnotes for task {n}\n"
                ),
            )
        })
        .collect();
    let (mut r, session) = inventory_actor(&records);
    let (views, next) = discovery_page(&mut r, session, None);
    assert_eq!(views, LATE.to_vec());
    assert!(next.is_none());
}
#[test]
fn record_bound_page_without_views_makes_real_progress_before_eof() {
    let records: Vec<_> = (0..1100)
        .map(|n| {
            (
                task_id(n),
                format!("Tasks/{n}.md"),
                "---\ntags: [task]\n---\n".into(),
            )
        })
        .collect();
    let (mut r, session) = inventory_actor(&records);
    // Spend the request's time budget on the first page.
    r.store().tick.set(2_000);
    let (views, next) = discovery_page(&mut r, session, None);
    assert!(views.is_empty());
    assert!(next.is_some());
    let (views, next) = discovery_page(&mut r, session, next);
    assert_eq!(views, LATE.to_vec());
    assert!(next.is_none());
}
#[test]
fn source_bytes_bound_a_page_and_its_continuation_is_exact() {
    // Each record is ~200 KiB, so a 1 MiB page holds five of them.
    let body = "x".repeat(200 * 1024);
    let records: Vec<_> = (0..12)
        .map(|n| {
            (
                task_id(n),
                format!("Tasks/{n}.md"),
                format!("---\ntags: [task]\n---\n{body}\n"),
            )
        })
        .collect();
    let (mut r, session) = inventory_actor(&records);
    // One page per request, so each request shows one page's byte bound.
    r.store().tick.set(2_000);
    let mut pages = 0;
    let mut views = Vec::new();
    let mut next = None;
    loop {
        let (page, token) = discovery_page(&mut r, session, next);
        pages += 1;
        views.extend(page);
        next = token;
        if next.is_none() {
            break;
        }
        assert!(pages < 10);
    }
    assert_eq!(views, LATE.to_vec());
    assert_eq!(pages, 3);
}
#[test]
fn a_page_classifies_the_whole_source_profile_and_rereads_only_bases() {
    // Discovery reads every record, one relayed round trip per page, so a
    // collection of ordinary notes must not cost a page per 512 KiB
    // (tasknotes-app#436: ~33 round trips, 19.5 s, for a large vault). Only a
    // Base is reread by the final CAS, so ~900 KiB of notes is one page.
    let body = "x".repeat(30 * 1024);
    let records: Vec<_> = (0..30)
        .map(|n| {
            (
                task_id(n),
                format!("Notes/{n}.md"),
                format!("---\ntags: [note]\n---\n{body}\n"),
            )
        })
        .collect();
    let (mut r, session) = inventory_actor(&records);
    let (views, next) = discovery_page(&mut r, session, None);
    assert_eq!(views, LATE.to_vec());
    assert!(next.is_none());
}
#[test]
fn a_base_whose_reread_no_longer_fits_starts_the_next_page() {
    // Three ~200 KiB notes and a ~300 KiB Base fit one page's source work,
    // but rereading the Base would not, so the page ends before the Base and
    // the next page classifies and rereads it whole.
    let filler = "x".repeat(200 * 1024);
    let mut records: Vec<_> = (0..3)
        .map(|n| {
            (
                task_id(n),
                format!("Notes/{n}.md"),
                format!("---\ntags: [note]\n---\n{filler}\n"),
            )
        })
        .collect();
    let comment = format!("# {}\n", "y".repeat(300 * 1024));
    records.push((
        task_id(3),
        "Views/big.base".into(),
        format!("{comment}{THREE}"),
    ));
    let (mut r, session) = inventory_actor(&records);
    r.store().tick.set(2_000);
    let (views, next) = discovery_page(&mut r, session, None);
    assert!(views.is_empty());
    let (views, next) = discovery_page(&mut r, session, next);
    let big: Vec<_> = (0..3).map(|i| (task_id(3), i)).collect();
    let mut expected = big;
    expected.extend(LATE);
    assert_eq!(views, expected);
    assert!(next.is_none());
}
fn tiny_notes(count: u16) -> Vec<(B16, String, String)> {
    (0..count)
        .map(|n| {
            (
                task_id(n),
                format!("Notes/{n}.md"),
                "---\ntags: [note]\n---\n".into(),
            )
        })
        .collect()
}
#[test]
fn one_request_reads_on_until_a_late_view() {
    // 2200 notes are three record-bound pages before the only Base. On a
    // Private collection each request is a relayed round trip, so the pages
    // must not each cost one (tasknotes-app#436).
    let (mut r, session) = inventory_actor(&tiny_notes(2200));
    let (views, next) = discovery_page(&mut r, session, None);
    assert_eq!(views, LATE.to_vec());
    assert!(next.is_none());
}
#[test]
fn a_universe_without_views_ends_in_one_request() {
    let (mut r, session) = inventory_universe(&tiny_notes(2200), false);
    let (views, next) = discovery_page(&mut r, session, None);
    assert!(views.is_empty());
    assert!(next.is_none());
}
#[test]
fn the_request_time_budget_stops_between_pages_with_a_continuation() {
    // Each 1000-record page hydrates in 8 calls; at 100 ms per call the first
    // page leaves budget for a second, and the second spends it.
    let (mut r, session) = inventory_actor(&tiny_notes(3300));
    r.store().tick.set(100);
    let (views, next) = discovery_page(&mut r, session, None);
    assert!(views.is_empty());
    assert!(next.is_some());
    let (views, next) = discovery_page(&mut r, session, next);
    assert_eq!(views, LATE.to_vec());
    assert!(next.is_none());
}
#[test]
fn a_refusal_on_a_later_page_fails_the_request_and_its_continuation() {
    let (mut r, session) = inventory_actor(&tiny_notes(1100));
    // Planning rejects malformed frontmatter before storing it; inject a real
    // store-row fault on the second page instead.
    let mut row = r.store().inner.record(&task_id(1050)).unwrap().unwrap();
    row.doc = "---\ntags: [\n---\n".into();
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
        r.encode_bases_discovery_page(
            session,
            Some("UTC"),
            128,
            None,
            crate::replica::UnreadableSources::Refuse,
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
            r.encode_bases_discovery_page(
                *session,
                Some("UTC"),
                1,
                None,
                crate::replica::UnreadableSources::Refuse,
                |_, page, _| Ok(page.next)
            )
            .unwrap()
            .is_some()
        );
    }
    let encoded = Cell::new(false);
    assert!(
        r.encode_bases_discovery_page(
            sessions[64],
            Some("UTC"),
            1,
            None,
            crate::replica::UnreadableSources::Refuse,
            |_, _, _| {
                encoded.set(true);
                Ok(())
            }
        )
        .is_err()
    );
    assert!(!encoded.get());
    r.close(sessions[0]);
    assert!(
        r.encode_bases_discovery_page(
            sessions[64],
            Some("UTC"),
            1,
            None,
            crate::replica::UnreadableSources::Refuse,
            |_, page, _| Ok(page.next)
        )
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
    let result = r.encode_bases_discovery_page(
        session,
        Some("UTC"),
        1,
        None,
        crate::replica::UnreadableSources::Refuse,
        |actor, _, _| {
            for other in &other_sessions {
                assert!(
                    actor
                        .encode_bases_discovery_page(
                            *other,
                            Some("UTC"),
                            1,
                            None,
                            crate::replica::UnreadableSources::Refuse,
                            |_, page, _| Ok(page.next)
                        )?
                        .is_some()
                );
            }
            encoded.set(true);
            Ok(())
        },
    );
    assert!(encoded.get());
    assert!(result.is_err());
    // All 64 admitted inner slots still exist; the outer failed publication
    // cannot displace one or exceed the residency ceiling.
    assert!(
        r.encode_bases_discovery_page(
            session,
            Some("UTC"),
            1,
            None,
            crate::replica::UnreadableSources::Refuse,
            |_, _, _| Ok(())
        )
        .is_err()
    );
    r.close(other_sessions[0]);
    assert!(
        r.encode_bases_discovery_page(
            session,
            Some("UTC"),
            1,
            None,
            crate::replica::UnreadableSources::Refuse,
            |_, page, _| Ok(page.next)
        )
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
        .encode_bases_discovery_page(
            session,
            Some("UTC"),
            1,
            None,
            crate::replica::UnreadableSources::Refuse,
            |_, page, _| Ok(page.next),
        )
        .unwrap()
        .unwrap();
    assert_eq!(std::sync::Arc::strong_count(&r.catalog), before);
    // Actual private actor catalog replacement; no source or ordinal fallback.
    r.catalog = std::sync::Arc::new(mdbn_core::types::Catalog::empty());
    let encoded = Cell::new(false);
    let error = r
        .encode_bases_discovery_page(
            session,
            Some("UTC"),
            1,
            Some(token),
            crate::replica::UnreadableSources::Refuse,
            |_, _, _| {
                encoded.set(true);
                Ok(())
            },
        )
        .err()
        .unwrap();
    assert_eq!(error.code(), Some(ErrorCode::Conflict));
    assert!(!encoded.get());
}
#[test]
fn postcodec_catalog_drift_cannot_publish_discovery_or_exact_source() {
    let (mut r, session) = discovery_actor(THREE);
    let result = r.encode_bases_discovery_page(
        session,
        Some("UTC"),
        1,
        None,
        crate::replica::UnreadableSources::Refuse,
        |actor, _, _| {
            actor.catalog = std::sync::Arc::new(mdbn_core::types::Catalog::empty());
            Ok(())
        },
    );
    assert_eq!(result.err().unwrap().code(), Some(ErrorCode::Conflict));
    let (mut r, session) = discovery_actor(THREE);
    let selection = r
        .encode_bases_discovery_page(
            session,
            Some("UTC"),
            1,
            None,
            crate::replica::UnreadableSources::Refuse,
            |_, page, _| {
                let view = &page.views[0];
                Ok(BasesViewSelection {
                    record: view.record,
                    revision: view.revision,
                    index: view.index,
                })
            },
        )
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
            .encode_bases_discovery_page(
                session,
                Some("UTC"),
                1,
                token,
                crate::replica::UnreadableSources::Refuse,
                |_, page, _| {
                    Ok((
                        page.next,
                        page.views
                            .iter()
                            .map(|view| (view.record, view.index, view.name.clone(), view.revision))
                            .collect::<Vec<_>>(),
                        page.clock.clone(),
                    ))
                },
            )
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
        r.encode_bases_discovery_page(
            SessionId(u64::MAX),
            Some("UTC"),
            1,
            None,
            crate::replica::UnreadableSources::Refuse,
            |_, _, _| {
                encoded.set(true);
                Ok(())
            }
        )
        .is_err()
    );
    assert!(
        r.encode_bases_discovery_page(
            session,
            Some("UTC"),
            1,
            Some(BasesDiscoveryHandle([7; 32])),
            crate::replica::UnreadableSources::Refuse,
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
        .encode_bases_discovery_page(
            session,
            Some("UTC"),
            1,
            None,
            crate::replica::UnreadableSources::Refuse,
            |_, page, _| Ok(page.next),
        )
        .unwrap()
        .unwrap();
    r.encode_bases_discovery_page(
        session,
        Some("UTC"),
        1,
        Some(token),
        crate::replica::UnreadableSources::Refuse,
        |_, _, _| Ok(()),
    )
    .unwrap();
    assert!(
        r.encode_bases_discovery_page(
            session,
            Some("UTC"),
            1,
            Some(token),
            crate::replica::UnreadableSources::Refuse,
            |_, _, _| Ok(())
        )
        .is_err()
    );
}
#[test]
fn discovery_codec_as_of_drift_suppresses_publication_and_handle() {
    let (mut r, session) = discovery_actor(THREE);
    let result = r.encode_bases_discovery_page(
        session,
        Some("UTC"),
        1,
        None,
        crate::replica::UnreadableSources::Refuse,
        |r, _, _| {
            r.view_version += 1;
            Ok(vec![1])
        },
    );
    assert!(result.is_err());
}
#[test]
fn discovery_codec_derived_readiness_drift_does_not_certify_or_block_primary_reads() {
    let (mut r, session) = discovery_actor(THREE);
    let output = r
        .encode_bases_discovery_page(
            session,
            Some("UTC"),
            1,
            None,
            crate::replica::UnreadableSources::Refuse,
            |r, page, _| {
                r.store().ready.set(false);
                Ok(page.views[0].revision)
            },
        )
        .unwrap();
    assert_eq!(output, mdbn_wire::hash::sha256(THREE.as_bytes()));
    assert!(!r.store().query_projection_state().unwrap().unwrap().ready);
}
#[test]
fn closing_session_invalidates_native_discovery_slot() {
    let (mut r, session) = discovery_actor(THREE);
    let token = r
        .encode_bases_discovery_page(
            session,
            Some("UTC"),
            1,
            None,
            crate::replica::UnreadableSources::Refuse,
            |_, page, _| Ok(page.next),
        )
        .unwrap()
        .unwrap();
    r.close(session);
    assert!(
        r.encode_bases_discovery_page(
            session,
            Some("UTC"),
            1,
            Some(token),
            crate::replica::UnreadableSources::Refuse,
            |_, _, _| Ok(())
        )
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
fn exact_source_codec_authority_change_refuses_but_derived_readiness_is_independent() {
    let (mut r, session) = discovery_actor(THREE);
    assert!(
        r.encode_bases_view_source(session, selection(THREE, 1), Some("UTC"), |r, _, _| {
            r.close(session);
            Ok(vec![1])
        })
        .is_err()
    );
    let (mut r, session) = discovery_actor(THREE);
    let original = r
        .encode_bases_view_source(session, selection(THREE, 1), Some("UTC"), |r, source, _| {
            r.store().ready.set(false);
            Ok(source.source.clone())
        })
        .unwrap();
    assert_eq!(original, THREE);
    assert!(!r.store().query_projection_state().unwrap().unwrap().ready);
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
        r.encode_bases_discovery_page(
            session,
            Some("UTC"),
            128,
            None,
            crate::replica::UnreadableSources::Refuse,
            |_, _, _| {
                encoded.set(true);
                Ok(())
            }
        )
        .is_err()
    );
    assert!(!encoded.get());
}
/// Frontmatter-style lines on top of a Base: two YAML documents (tasknotes-app,
/// "Couldn't load your views" on collection F5).
const BROKEN: &str = "---\nviews: TODO\n---\nviews:\n  - {type: table}\n";
/// Planning refuses malformed YAML, so replace stored rows as a file scan can.
fn break_records(r: &mut Replica<ProjectionStore>, ids: &[B16], doc: &str) {
    let rows = ids
        .iter()
        .map(|id| {
            let mut row = r.store().inner.record(id).unwrap().unwrap();
            row.doc = doc.into();
            row.revision = mdbn_wire::hash::sha256(row.doc.as_bytes());
            row
        })
        .collect();
    r.store_mut()
        .inner
        .commit(crate::store::Tx {
            records_put: rows,
            ..Default::default()
        })
        .unwrap();
}
type Unreadable = Vec<(B16, String, &'static str)>;
type ReportedPage = (Vec<(B16, u32)>, Unreadable, Option<BasesDiscoveryHandle>);
fn reporting_page(
    r: &mut Replica<ProjectionStore>,
    session: SessionId,
    resume: Option<BasesDiscoveryHandle>,
) -> ReportedPage {
    r.encode_bases_discovery_page(
        session,
        Some("UTC"),
        128,
        resume,
        crate::replica::UnreadableSources::Report,
        |_, page, _| {
            Ok((
                page.views.iter().map(|v| (v.record, v.index)).collect(),
                page.unreadable
                    .iter()
                    .map(|u| (u.record, u.path.clone(), u.problem.detail()))
                    .collect(),
                page.next,
            ))
        },
    )
    .unwrap()
}
fn report_all(
    r: &mut Replica<ProjectionStore>,
    session: SessionId,
) -> (Vec<(B16, u32)>, Unreadable) {
    let (mut views, mut unreadable, mut next) = reporting_page(r, session, None);
    while next.is_some() {
        let (more_views, more_unreadable, resume) = reporting_page(r, session, next);
        views.extend(more_views);
        unreadable.extend(more_unreadable);
        next = resume;
    }
    (views, unreadable)
}
#[test]
fn an_unreadable_record_is_named_and_every_other_view_is_still_discovered() {
    let records = vec![
        (task_id(1), "Views/broken.base".to_owned(), THREE.to_owned()),
        (
            task_id(2),
            "Tasks/broken.md".to_owned(),
            "---\ntags: [task]\n---\n".to_owned(),
        ),
    ];
    let (mut r, session) = inventory_actor(&records);
    break_records(&mut r, &[task_id(1)], BROKEN);
    break_records(&mut r, &[task_id(2)], "---\ntags: [\n---\n");
    // Request version 1 still refuses the whole discovery.
    let refused = r
        .encode_bases_discovery_page(
            session,
            Some("UTC"),
            128,
            None,
            crate::replica::UnreadableSources::Refuse,
            |_, _, _| Ok(()),
        )
        .unwrap_err();
    assert_eq!(refused.problem().code, "invalid_request");
    assert_eq!(
        refused.problem().reason.as_deref(),
        Some("view_metadata_unavailable")
    );
    let (views, unreadable) = report_all(&mut r, session);
    assert_eq!(
        unreadable,
        vec![
            (
                task_id(1),
                "Views/broken.base".to_owned(),
                "base_raw_frontmatter_unavailable"
            ),
            (
                task_id(2),
                "Tasks/broken.md".to_owned(),
                "base_raw_frontmatter_unavailable"
            ),
        ]
    );
    assert_eq!(views, LATE);
}
#[test]
fn a_page_names_at_most_32_unreadable_records_and_the_next_page_continues() {
    let ids: Vec<_> = (1..=40).map(task_id).collect();
    let records: Vec<_> = ids
        .iter()
        .enumerate()
        .map(|(n, id)| (*id, format!("Views/broken-{n}.base"), THREE.to_owned()))
        .collect();
    let (mut r, session) = inventory_actor(&records);
    break_records(&mut r, &ids, BROKEN);
    let (views, first, next) = reporting_page(&mut r, session, None);
    assert!(views.is_empty());
    assert_eq!(first.len(), 32);
    assert!(next.is_some());
    let (views, unreadable) = report_all(&mut r, session);
    assert_eq!(unreadable.iter().map(|u| u.0).collect::<Vec<_>>(), ids);
    assert_eq!(views, LATE);
}
