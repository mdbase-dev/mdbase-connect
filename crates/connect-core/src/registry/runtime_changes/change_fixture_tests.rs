#[test]
fn local_change_events_match_shared_client_fixtures() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../packages/protocol/test/fixtures/collection-changes-v1.json"
    ))
    .unwrap();
    for event in fixture["local"].as_array().unwrap() {
        let payload = &event["payload"];
        let event_type = event["type"].as_str().unwrap();
        let change = if event_type.starts_with("mdbase.record.") {
            let kind = match event_type {
                "mdbase.record.created" => "created",
                "mdbase.record.modified" => "updated",
                "mdbase.record.deleted" => "deleted",
                "mdbase.record.renamed" => "renamed",
                _ => unreachable!(),
            };
            json!({"target": "record", "change": {
                "kind": kind,
                "path": payload.get("path").or_else(|| payload.get("to")).unwrap(),
                "from": payload.get("from"),
                "before_revision": payload["previous_revision"],
                "after_revision": payload["revision"],
                "before_types": payload["previous_types"],
                "after_types": payload["types"],
                "changed_fields": payload["changed_fields"],
                "body_changed": payload["body_changed"],
            }})
        } else {
            let kind = match event_type {
                "mdbase.type.changed" => "type_definition",
                "mdbase.config.changed" => "configuration",
                "mdbase.contract.changed" => "contract",
                "mdbase.view.changed" => "view_source",
                "mdbase.resource.changed" => "file",
                "mdbase.collection.invalidated" => "other",
                _ => unreachable!(),
            };
            json!({"target": "resource", "change": {
                "kind": kind, "path": payload["path"],
                "before_revision": payload["previous_revision"],
                "after_revision": payload["revision"],
            }})
        };
        let emitted = watch_event(
            serde_json::from_value(change).unwrap(),
            event["cursor"].as_u64().unwrap(),
            0,
            event["occurred_at"].as_str().unwrap(),
            &payload["runtime"],
        );
        assert_eq!(emitted.event_type, event_type);
        assert_eq!(emitted.payload, *payload);
    }
}
