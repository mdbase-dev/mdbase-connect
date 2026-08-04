use serde_json::json;

use super::{tests::resources, WorkingSet};

#[test]
fn hosted_template_creates_executes_updates_and_deletes_obsidian_base_views() {
    let workspace = WorkingSet::materialize(resources(), []).unwrap();
    let document = "views:\n  - type: tasknotesTaskList\n    name: Focused work\n";
    let created = workspace
        .view_source_operation(
            "create_view_source",
            &json!({
                "format": "obsidian.base",
                "name": "Focused work",
                "document": document,
            }),
        )
        .unwrap();
    assert!(created.valid, "{:?}", created.diagnostics);
    assert_eq!(created.result["path"], "views/focused-work.base");
    assert_eq!(created.result["format"], "obsidian.base");

    let listed = workspace.read_operation("list_views", &json!({})).unwrap();
    assert!(listed.valid, "{:?}", listed.diagnostics);
    assert_eq!(listed.result["meta"]["total_count"], 1);
    assert_eq!(
        listed.result["views"][0]["source"]["path"],
        "views/focused-work.base"
    );

    let executed = workspace
        .read_operation(
            "execute_view",
            &json!({
                "path": "views/focused-work.base",
                "view": "focused-work",
            }),
        )
        .unwrap();
    assert!(executed.valid, "{:?}", executed.diagnostics);
    assert_eq!(executed.result["meta"]["total_count"], 0);

    let updated = workspace
        .view_source_operation(
            "update_view_source",
            &json!({
                "path": "views/focused-work.base",
                "if_revision": created.result["revision"],
                "document": document.replace("Focused work", "Deep work"),
            }),
        )
        .unwrap();
    assert!(updated.valid, "{:?}", updated.diagnostics);

    let deleted = workspace
        .view_source_operation(
            "delete_view_source",
            &json!({
                "path": "views/focused-work.base",
                "if_revision": updated.result["revision"],
            }),
        )
        .unwrap();
    assert!(deleted.valid, "{:?}", deleted.diagnostics);
    let listed = workspace.read_operation("list_views", &json!({})).unwrap();
    assert_eq!(listed.result["meta"]["total_count"], 0);
}
