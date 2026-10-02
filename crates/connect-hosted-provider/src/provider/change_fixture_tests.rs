use super::*;

#[test]
fn hosted_change_events_match_shared_client_fixtures() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../packages/protocol/test/fixtures/collection-changes-v1.json"
    ))
    .unwrap();
    for event in fixture["hosted"].as_array().unwrap() {
        let payload = &event["payload"];
        let record = |path: &str, revision: &str, frontmatter: &Value, types: &Value| SyncRecord {
            record_id: Uuid::nil(),
            path: path.to_owned(),
            document: String::new(),
            revision: revision.to_owned(),
            frontmatter: frontmatter.as_object().unwrap().clone(),
            body: String::new(),
            types: serde_json::from_value(types.clone()).unwrap(),
        };
        let before = payload.get("before").map(|frontmatter| {
            record(
                payload
                    .get("from")
                    .unwrap_or(&payload["path"])
                    .as_str()
                    .unwrap(),
                payload["previous_revision"].as_str().unwrap(),
                frontmatter,
                payload.get("previous_types").unwrap_or(&payload["types"]),
            )
        });
        let after = payload.get("after").map(|frontmatter| {
            record(
                payload
                    .get("to")
                    .unwrap_or(&payload["path"])
                    .as_str()
                    .unwrap(),
                payload["revision"].as_str().unwrap(),
                frontmatter,
                &payload["types"],
            )
        });
        let (event_type, emitted) = application_change(before.as_ref(), after.as_ref());
        assert_eq!(event_type, event["type"].as_str().unwrap());
        assert_eq!(emitted, *payload);
    }
}
