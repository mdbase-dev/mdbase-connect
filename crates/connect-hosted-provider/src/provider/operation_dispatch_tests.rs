use super::{collection_setup_assessment, retryable_hosted_database_mutation};

#[test]
fn rejected_collection_upgrade_is_a_review_conflict_not_an_internal_error() {
    let result = mdbase::v03::OperationResult {
        valid: false,
        result: serde_json::json!({}),
        diagnostics: vec![mdbase::v03::Diagnostic::error(
            "invalid_type_pack",
            "Type 'task' still implements the previous exact contract version.",
            Some("_types/task.md".to_string()),
        )],
    };
    let outcome = mdbase::runtime::CanonicalOperationOutcome::try_from_v03(
        mdbase::runtime::OperationKind::AssessCollectionSetup,
        result,
    )
    .unwrap();
    let error = collection_setup_assessment(&outcome).unwrap_err();
    assert_eq!(error.status, axum::http::StatusCode::CONFLICT);
    assert_eq!(error.code, "type_pack_review_required");
    assert!(error.message.contains("previous exact contract version"));
}

#[test]
fn retries_only_transactional_hosted_database_mutations() {
    for operation in [
        "create",
        "update",
        "delete",
        "rename",
        "create_type",
        "update_type",
        "apply_type_pack",
        "apply_collection_setup",
        "create_view_source",
        "update_view_source",
        "delete_view_source",
    ] {
        assert!(retryable_hosted_database_mutation(operation), "{operation}");
    }
    for operation in ["query", "read", "put_timer", "cancel_timer"] {
        assert!(
            !retryable_hosted_database_mutation(operation),
            "{operation}"
        );
    }
}
