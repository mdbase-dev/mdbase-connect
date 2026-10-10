use super::*;
use crate::access::CachedGrant;

fn entry(grant: &str, state: AccessState) -> AccessEntry {
    AccessEntry {
        grant: CachedGrant {
            grant: grant.to_owned(),
            account_id: None,
            collection: "collection".to_owned(),
            app_id: "test.app".to_owned(),
            app_name: "Example app".to_owned(),
            client_pk: "00".repeat(32),
            capabilities: vec!["records.read".to_owned()],
            folders: None,
            legacy_only: false,
        },
        state,
        first_seen_ms: 0,
        generation: 1,
        acknowledged: false,
        delisted: false,
    }
}

#[test]
fn only_displayed_pending_entries_can_request_native_review() {
    let mut model = CompanionModel::default();
    model.replace(&[
        entry("pending", AccessState::PendingApproval),
        entry("active", AccessState::Active),
        entry("denied", AccessState::Denied),
        entry("revoked", AccessState::RevokedLocally),
    ]);
    let request = model.review("pending").unwrap();
    assert_eq!(request.method(), Method::ACCESS_APPROVE);
    assert_eq!(request.params(), serde_json::json!({"grant": "pending"}));
    for id in ["active", "denied", "revoked", "missing"] {
        assert!(model.review(id).is_none());
    }
}

#[test]
fn disconnect_removes_every_actionable_row_and_notification() {
    let mut model = CompanionModel::default();
    let e = entry("pending", AccessState::PendingApproval);
    model.replace(std::slice::from_ref(&e));
    assert!(model.review("pending").is_some());
    model.disconnect();
    assert!(!model.connected());
    assert!(model.rows().is_empty());
    assert!(model.review("pending").is_none());
    assert!(
        model
            .notice(&AccessEvent::ApprovalRequested { entry: e })
            .is_none()
    );
}

#[test]
fn reconnect_replaces_rather_than_merges_prior_grants() {
    let mut model = CompanionModel::default();
    model.replace(&[entry("old", AccessState::PendingApproval)]);
    model.disconnect();
    model.replace(&[entry("new", AccessState::PendingApproval)]);
    assert!(model.review("old").is_none());
    assert!(model.review("new").is_some());
}

#[test]
fn snapshots_are_bounded_and_report_truncation() {
    let mut model = CompanionModel::default();
    let entries: Vec<_> = (0..100)
        .map(|n| entry(&format!("grant-{n}"), AccessState::PendingApproval))
        .collect();
    model.replace(&entries);
    assert_eq!(model.rows().len(), MAX_PREVIEWS);
    assert_eq!(model.omitted(), 100 - MAX_PREVIEWS);
    assert!(model.review("grant-99").is_none());
    model.replace(&[]);
    assert!(model.connected());
    assert!(model.rows().is_empty());
    assert_eq!(model.omitted(), 0);
}

#[test]
fn invalid_and_duplicate_ids_are_not_actionable() {
    let mut model = CompanionModel::default();
    let long = "x".repeat(MAX_ID_BYTES + 1);
    let entries: Vec<_> = ["", "../../escape", "grant\n", &long, "same", "same"]
        .into_iter()
        .map(|id| entry(id, AccessState::PendingApproval))
        .collect();
    model.replace(&entries);
    assert_eq!(model.rows().len(), 1);
    assert_eq!(model.omitted(), 5);
    assert_eq!(model.rows()[0].grant, "same");
}

#[test]
fn app_labels_cannot_inject_controls_bidi_or_menu_mnemonics() {
    let mut model = CompanionModel::default();
    let mut e = entry("pending", AccessState::PendingApproval);
    e.grant.app_name = format!("\u{202e}Bank\n&\u{2066}{}", "🙂".repeat(1000));
    model.replace(&[e]);
    let text = &model.rows()[0].label;
    assert!(text.starts_with("Bank"));
    assert_eq!(text.chars().count(), MAX_LABEL_CHARS);
    assert!(!text.contains(['\n', '&', '\u{202e}', '\u{2066}']));
    assert_eq!(
        label("\n&\u{202e}\u{061c}\u{200e}\u{200f}\u{2060}\u{feff}"),
        "Unnamed app"
    );
}

#[test]
fn notification_copy_never_contains_remote_app_or_collection_text() {
    let mut model = CompanionModel::default();
    let mut e = entry("pending", AccessState::PendingApproval);
    e.grant.app_name = "PRIVATE-NAME <script>secret</script>".to_owned();
    e.grant.collection = "PRIVATE-COLLECTION".to_owned();
    model.replace(std::slice::from_ref(&e));
    let events = [
        AccessEvent::NewAccess { entry: e.clone() },
        AccessEvent::ApprovalRequested { entry: e },
        AccessEvent::Revoked {
            grant: "pending".to_owned(),
            collection: "PRIVATE-COLLECTION".to_owned(),
            app_name: "PRIVATE-NAME".to_owned(),
        },
    ];
    for event in events {
        let body = model.notice(&event).unwrap().body();
        assert!(!body.contains("PRIVATE"));
        assert!(!body.contains("script"));
    }
}
