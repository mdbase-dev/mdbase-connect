use super::*;
use crate::value::Map;
use crate::views::bases::{BasesTimezone, CapturedClock, CapturedFile, CapturedFileBindings};
#[test]
fn task_profile_filter_boundary_preserves_required_file_preflight_even_when_lazy() {
    let source = Value::string("false && file.hasTag('task')");
    let mut budget = WorkBudget::new();
    let plan = AdmittedBasesFilter::compile(
        Some(&source),
        None,
        &BTreeMap::new(),
        Profile::TaskSlice1,
        &mut budget,
    )
    .unwrap();
    assert_eq!(
        plan.matches(Bindings::raw(&Map::new()), &mut budget, &|| false)
            .unwrap_err(),
        EvaluationFailure::MetadataUnavailable("file_metadata_not_captured")
    );
}
#[test]
fn task_profile_global_tags_and_local_captured_date_filter_use_one_meter() {
    let shared = Value::string("file.hasTag('task')");
    let local = Value::string("date(due).date() == today() && status != 'done'");
    let mut budget = WorkBudget::new();
    let plan = AdmittedBasesFilter::compile(
        Some(&shared),
        Some(&local),
        &BTreeMap::new(),
        Profile::TaskSlice1,
        &mut budget,
    )
    .unwrap();
    let zone = BasesTimezone::capture("UTC", &mut budget).unwrap();
    let clock = CapturedClock::new(1781075828070, zone, &mut budget).unwrap();
    let file = CapturedFile::new("Tasks/Today.md", Some(60), None, None, &mut budget).unwrap();
    let tags = vec!["task/subtask".into()];
    let facts = CapturedFileBindings::capture(&file, Some(&tags), &mut budget).unwrap();
    let note = Map::from_iter([
        ("due".into(), Value::string("2026-06-10")),
        ("status".into(), Value::string("open")),
    ]);
    assert!(
        plan.matches(
            Bindings::raw(&note).with_clock(clock).with_file(facts),
            &mut budget,
            &|| false
        )
        .unwrap()
    );
}
