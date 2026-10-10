use super::*;
use crate::replica::BasesViewSelection;
mod session;
use std::collections::BTreeMap;
fn selection(id: u8, source: &str, index: u32) -> BasesViewSelection {
    BasesViewSelection {
        record: B16([id; 16]),
        revision: mdbn_wire::hash::sha256(source.as_bytes()),
        index,
    }
}
#[test]
fn selected_execution_inputs_bind_actual_source_ordinal_clock_registry_and_file_facts() {
    let (_, mut a, source) = configured();
    a.create(11, "TaskNotes/Views/tasks-default.base", &source);
    a.create(12, "Task.md", "---\nstatus: open\ntags: [task]\n---\nTask");
    settle(&mut [&mut a]);
    let hints = BTreeMap::from_iter([("due".into(), "date".into())]);
    let inputs =
        a.r.capture_bases_execution_inputs(selection(11, &source, 0), Some(&hints), Some("UTC"))
            .unwrap();
    assert_eq!(inputs.view().record, B16([11; 16]));
    assert_eq!(
        inputs.view().revision,
        mdbn_wire::hash::sha256(source.as_bytes())
    );
    assert_eq!(inputs.view().index, 0);
    assert_eq!(inputs.view().name.as_deref(), Some("Tasks"));
    assert_eq!(inputs.clock().tz, "UTC");
    assert_eq!(inputs.record_count(), 2);
    assert_eq!(inputs.file_observation_count(), 2);
    assert_eq!(inputs.property_type_count(), 1);
    a.r.recheck_bases_execution_inputs(&inputs).unwrap();
    assert_eq!(a.doc(11).as_deref(), Some(source.as_str()));
}
#[test]
fn source_cas_ordinal_and_known_empty_registry_are_not_guessed() {
    let (_, mut a, source) = configured();
    a.create(1, "view.base", &source);
    settle(&mut [&mut a]);
    let empty = BTreeMap::new();
    assert!(
        a.r.capture_bases_execution_inputs(selection(1, &source, 0), Some(&empty), Some("UTC"))
            .is_ok()
    );
    assert!(
        a.r.capture_bases_execution_inputs(selection(1, &source, 0), None, Some("UTC"))
            .is_err()
    );
    assert_eq!(
        a.r.capture_bases_execution_inputs(
            selection(1, "other bytes", 0),
            Some(&empty),
            Some("UTC")
        )
        .err()
        .unwrap()
        .code(),
        Some(ErrorCode::Conflict)
    );
    assert!(
        a.r.capture_bases_execution_inputs(selection(1, &source, 999), Some(&empty), Some("UTC"))
            .is_err()
    );
}
#[test]
fn source_semantics_and_capture_recheck_refuse_unknown_renderer_and_same_head_drift() {
    let (_, mut a, _) = configured();
    let source = "views: [{type: vendorWidget, name: Unknown}]\n";
    a.create(1, "view.base", source);
    settle(&mut [&mut a]);
    assert!(
        a.r.capture_bases_execution_inputs(
            selection(1, source, 0),
            Some(&BTreeMap::new()),
            Some("UTC")
        )
        .is_err()
    );
    let (_, mut a, source) = configured();
    a.create(1, "view.base", &source);
    settle(&mut [&mut a]);
    let inputs =
        a.r.capture_bases_execution_inputs(
            selection(1, &source, 0),
            Some(&BTreeMap::new()),
            Some("UTC"),
        )
        .unwrap();
    let mut row = a.r.store.record(&B16([1; 16])).unwrap().unwrap();
    row.doc.push_str("\nchanged: true");
    row.revision = mdbn_wire::hash::sha256(row.doc.as_bytes());
    a.r.store_mut()
        .commit(Tx {
            records_put: vec![row],
            ..Tx::default()
        })
        .unwrap();
    assert_eq!(
        a.r.recheck_bases_execution_inputs(&inputs)
            .err()
            .unwrap()
            .code(),
        Some(ErrorCode::Conflict)
    );
}
#[test]
fn pending_and_property_hint_limits_refuse_before_any_execution_inputs_escape() {
    let (_, mut a, source) = configured();
    a.create(1, "view.base", &source);
    assert!(
        a.r.capture_bases_execution_inputs(
            selection(1, &source, 0),
            Some(&BTreeMap::new()),
            Some("UTC")
        )
        .is_err()
    );
    settle(&mut [&mut a]);
    let large = BTreeMap::from_iter((0..4097).map(|i| (format!("field{i}"), "date".into())));
    assert!(
        a.r.capture_bases_execution_inputs(selection(1, &source, 0), Some(&large), Some("UTC"))
            .is_err()
    );
}
