use super::*;

#[test]
fn change_payloads_and_kinds_match_the_shared_typescript_catalog() {
    let catalog: Value = serde_json::from_str(include_str!(
        "../../../packages/protocol/schemas/change-events.v1.json"
    ))
    .unwrap();
    for (event_type, kind) in catalog["events"].as_object().unwrap() {
        assert_eq!(collection_change_kind(event_type), kind.as_str());
    }
    assert_eq!(collection_change_kind("future.event"), None);
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../packages/protocol/test/fixtures/collection-changes-v1.json"
    ))
    .unwrap();
    for provider in ["local", "hosted", "files"] {
        for value in fixture[provider].as_array().unwrap() {
            let event: CollectionChange = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(serde_json::to_value(&event).unwrap(), *value);
            let kind = collection_change_kind(&event.event_type).unwrap();
            let (name, parsed) = if kind.starts_with("record.") {
                (
                    "RecordChangePayload",
                    serde_json::to_value(
                        serde_json::from_value::<RecordChangePayload>(event.payload.clone())
                            .unwrap(),
                    )
                    .unwrap(),
                )
            } else if kind == "file.put" || kind == "file.removed" {
                (
                    "FileChangePayload",
                    serde_json::to_value(
                        serde_json::from_value::<FileChangePayload>(event.payload.clone()).unwrap(),
                    )
                    .unwrap(),
                )
            } else {
                (
                    "ResourceChangePayload",
                    serde_json::to_value(
                        serde_json::from_value::<ResourceChangePayload>(event.payload.clone())
                            .unwrap(),
                    )
                    .unwrap(),
                )
            };
            let expected = event
                .payload
                .as_object()
                .unwrap()
                .iter()
                .filter(|(key, value)| {
                    !value.is_null() && catalog["payloads"][name].get(*key).is_some()
                })
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect::<serde_json::Map<_, _>>();
            assert_eq!(parsed, Value::Object(expected));
        }
    }
}
