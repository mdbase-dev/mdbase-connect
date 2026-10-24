//! Real SQLite candidate/residual differential, including failure retention.
use super::*;
use mdbn_core::views::bases::*;
use std::collections::{BTreeMap, BTreeSet};
fn pages(
    store: &SqlStore<Trace>,
    requirements: &BasesProjectionRequirements,
    candidate: Option<BasesCandidate>,
) -> Vec<QueryProjectionRow> {
    let state = store.query_projection_state().unwrap().unwrap();
    let mut request = QueryProjectionRequest {
        generation: state.generation,
        head: state.head,
        predicate: QueryPredicate::All,
        bases_candidate: candidate,
        bases_records: None,
        after: None,
        limit: 2,
        max_bytes: 1 << 20,
        fields: requirements.fields.clone(),
        tags: requirements.tags,
    };
    let mut rows = Vec::new();
    loop {
        let page = store.query_projection_page(&request).unwrap();
        request.after = page.rows.last().map(|row| row.id);
        rows.extend(page.rows);
        if !page.has_more {
            break;
        }
        assert!(request.after.is_some());
    }
    rows
}
fn required(plan: &AdmittedBasesView) -> BasesProjectionRequirements {
    plan.projection_requirements(&mut WorkBudget::new())
        .unwrap()
}
fn evaluate(
    plan: &AdmittedBasesView,
    hints: &BTreeMap<String, String>,
    clock: CapturedClock,
    requirements: &BasesProjectionRequirements,
    row: &QueryProjectionRow,
) -> Result<bool, EvaluationFailure> {
    let raw =
        mdbn_core::value::Map::from_iter(requirements.fields.iter().zip(&row.fields).filter_map(
            |(name, value)| match value {
                RawField::Missing => None,
                RawField::Present(value) => Some((name.clone(), value.clone())),
            },
        ));
    let mut work = WorkBudget::new();
    let types = CapturedPropertyTypes::capture(hints, &mut work)?;
    let file = CapturedFile::new(&row.path, Some(row.source_bytes), None, None, &mut work)?;
    let file = CapturedFileBindings::capture(&file, row.tags.as_deref(), &mut work)?;
    let bindings = types
        .projected_bindings(&raw, &mut work)?
        .with_clock(clock)
        .with_file(file);
    plan.project(bindings, &mut work, &|| false)
        .map(|p| p.is_some())
}
fn clock(zone: &str) -> CapturedClock {
    let mut work = WorkBudget::new();
    CapturedClock::new(
        1781075828070,
        BasesTimezone::capture(zone, &mut work).unwrap(),
        &mut work,
    )
    .unwrap()
}
fn plan(filter: &str) -> AdmittedBasesView {
    let raw = mdbn_core::value::Map::from_iter([
        ("filters".into(), CoreValue::Text(filter.into())),
        ("order".into(), CoreValue::List(vec![])),
    ]);
    AdmittedBasesView::compile(
        &BaseFields {
            filters: None,
            formulas: None,
            properties: None,
            views: &CoreValue::Null,
        },
        &BaseView {
            index: 0,
            view_type: "table",
            name: None,
            raw: &raw,
        },
        FileTimeAvailability {
            created: false,
            modified: false,
            tags: true,
        },
        &mut WorkBudget::new(),
    )
    .unwrap()
}
fn differential(
    store: &SqlStore<Trace>,
    plan: &AdmittedBasesView,
    hints: &BTreeMap<String, String>,
    clock: CapturedClock,
) -> (BTreeSet<B16>, BTreeSet<B16>) {
    let requirements = required(plan);
    let all = pages(store, &requirements, None);
    let candidate = plan
        .candidate(hints, clock, &mut WorkBudget::new())
        .unwrap();
    let selected = pages(store, &requirements, Some(candidate));
    let ids = selected.iter().map(|r| r.id).collect::<BTreeSet<_>>();
    let mut matches = BTreeSet::new();
    for row in &all {
        match evaluate(plan, hints, clock, &requirements, row) {
            Ok(false) => {}
            Ok(true) => {
                assert!(ids.contains(&row.id), "lost match {:?}", row.id);
                matches.insert(row.id);
            }
            Err(e) => assert!(ids.contains(&row.id), "hidden failure {:?}: {e:?}", row.id),
        }
    }
    (matches, ids)
}
#[test]
fn all_five_unchanged_shared_views_keep_membership_and_failure_domain() {
    let fixture = mdbn_core::yaml::parse_value(include_str!(
        "../../../../../replica/src/tests/data/bases-first-slice.json"
    ))
    .unwrap()
    .unwrap();
    let resources = fixture
        .get("resources")
        .unwrap()
        .as_list()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r.get("path").unwrap().as_str().unwrap(),
                r.get("source").unwrap().as_str().unwrap(),
            )
        })
        .collect::<Vec<_>>();
    let catalog = Catalog::load(resources);
    let records = fixture.get("records").unwrap().as_list().unwrap();
    let mut names = BTreeMap::new();
    let rows = records
        .iter()
        .enumerate()
        .map(|(i, r)| {
            let mut row = row(i as u16 + 1, "");
            names.insert(row.id, r.get("id").unwrap().as_str().unwrap().to_owned());
            row.path = r.get("path").unwrap().as_str().unwrap().into();
            row.path_key = mdbn_core::paths::path_key(&row.path);
            row.doc = r.get("source").unwrap().as_str().unwrap().into();
            row.revision = revision(row.doc.as_bytes());
            row
        })
        .collect();
    let (store, _, blobs, _, _) = open("bases_candidate_five_views", rows, &[]);
    let hints = fixture
        .get("property_types")
        .unwrap()
        .as_map()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.to_owned(), v.as_str().unwrap().to_owned()))
        .collect();
    for view in fixture.get("views").unwrap().as_list().unwrap() {
        let source = fixture
            .get("sources")
            .unwrap()
            .as_list()
            .unwrap()
            .iter()
            .find(|s| s.get("command") == view.get("command"))
            .unwrap();
        let document = mdbn_core::doc::Document::parse_at(
            "TaskNotes/Views/test.base",
            source.get("source").unwrap().as_str().unwrap(),
        );
        let opclock = mdbn_core::intent::OpClock {
            instant_ms: 1781075828070,
            tz: "UTC".into(),
            local_date: "2026-06-10".into(),
        };
        let base = discover_base_record(
            &catalog,
            "TaskNotes/Views/test.base",
            &document,
            &opclock,
            &mut WorkBudget::new(),
        )
        .unwrap()
        .unwrap();
        let index = view
            .get("index")
            .unwrap()
            .as_number()
            .unwrap()
            .as_i64()
            .unwrap() as usize;
        let plan = AdmittedBasesView::compile(
            &base.fields,
            &base.views[index],
            FileTimeAvailability {
                created: false,
                modified: false,
                tags: true,
            },
            &mut WorkBudget::new(),
        )
        .unwrap();
        let (matched, _) = differential(&store, &plan, &hints, clock("UTC"));
        let matched = matched
            .iter()
            .map(|id| names[id].as_str())
            .collect::<BTreeSet<_>>();
        let expected = view
            .get("matched")
            .unwrap()
            .as_list()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect::<BTreeSet<_>>();
        assert_eq!(matched, expected, "view {:?}", view.get("name"));
    }
    assert_eq!(
        blobs.get(),
        0,
        "candidate pages never hydrate source records"
    );
}
#[test]
fn selective_dates_do_not_hide_unknown_tags_typed_null_links_or_earlier_errors() {
    let mut unknown_tags = row(8, "tags: [task]\ndue: 2026-06-01\nstatus: open");
    unknown_tags.doc.push_str("`#uncaptured` #task");
    unknown_tags.revision = revision(unknown_tags.doc.as_bytes());
    let rows = vec![
        row(1, "tags: [task]\ndue: 2026-06-10\nstatus: open"),
        row(2, "tags: [task]\ndue: 2026-06-01\nstatus: open"),
        row(3, "tags: [task]\ndue: null\nstatus: open"),
        row(4, "tags: [task]\ndue: bad-date\nstatus: open"),
        row(5, "tags: [task]\ndue: 2026-06-01\nstatus: '[[Link]]'"),
        row(6, "tags: [task]\ndue: 2026-06-10\nstatus: done"),
        row(7, "tags: [project]\ndue: bad-date\nstatus: '[[Link]]'"),
        unknown_tags,
        row(9, "tags: [task]\ndue: '2026-06-10T23:00:00Z'\nstatus: open"),
        row(10, "tags: [task]\ndue: 2011-12-30\nstatus: open"),
    ];
    let (store, index, _, _, _) = open("bases_candidate_failure_domain", rows, &[]);
    let hints = BTreeMap::from([("due".into(), "date".into())]);
    let p = plan(
        "file.hasTag('task') && status != 'done' && due.isEmpty() == false && date(due).format('YYYY-MM-DD') == today().format('YYYY-MM-DD')",
    );
    let (matches, selected) = differential(&store, &p, &hints, clock("UTC"));
    assert_eq!(matches, BTreeSet::from([id(1), id(9)]));
    for n in [3, 4, 5, 8, 9] {
        assert!(selected.contains(&id(n)));
    }
    for n in [2, 6, 7, 10] {
        assert!(!selected.contains(&id(n)));
    }
    // A named-zone midnight gap cannot be treated as a canonical date-only
    // mismatch. Date-bearing branches remain unknown in that profile.
    let (_, selected) = differential(&store, &p, &hints, clock("Pacific/Apia"));
    assert!(selected.contains(&id(10)));
    // Missing optional facts are never invented as a complete empty map.
    sql(
        &index,
        "DELETE FROM st_qraw_fact WHERE id=?",
        vec![SqlValue::Blob(id(2).0.to_vec())],
    );
    assert!(
        differential(&store, &p, &hints, clock("UTC"))
            .1
            .contains(&id(2))
    );
}
#[test]
fn ordered_unknown_before_false_is_retained_but_false_prefix_can_short_circuit() {
    let (store, _, _, _, _) = open(
        "bases_candidate_ordered_unknown",
        vec![
            row(1, "tags: [task]\nstatus: '[[Link]]'"),
            row(2, "tags: [task]\nstatus: open"),
        ],
        &[],
    );
    let hints = BTreeMap::new();
    let p = plan("status == 'open' && false");
    assert!(
        differential(&store, &p, &hints, clock("UTC"))
            .1
            .contains(&id(1))
    );
    let p = plan("false && status == 'open'");
    assert!(differential(&store, &p, &hints, clock("UTC")).1.is_empty());
}
