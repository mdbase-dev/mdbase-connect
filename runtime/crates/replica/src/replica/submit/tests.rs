//! Planner diagnostics survive the existing Problem/Issue wire envelope.
use super::rejection_problem;
use mdbn_core::plan::{RejectCode, Rejection};
use mdbn_core::validate::{Issue, Severity, Tier};
use mdbn_core::value::Value;
use mdbn_wire::{Wire, client};

#[test]
fn nonempty_rejection_issues_keep_order_severity_messages_and_details() {
    let mut rejection = Rejection::new(
        RejectCode::InvalidRecord,
        Some("validation_failed"),
        "record invalid",
    );
    rejection.details = Some(Value::string("parent details"));
    rejection.issues = vec![
        Issue::new(
            "schema_violation",
            Severity::Error,
            Tier::SingleRecord,
            "required field missing",
        )
        .with_details(Value::string("field details")),
        Issue::new(
            "link_not_found",
            Severity::Warning,
            Tier::CrossRecord,
            "target missing",
        ),
    ];
    let problem = rejection_problem(&rejection);
    assert_eq!(problem.code, "invalid_record");
    assert_eq!(problem.reason.as_deref(), Some("validation_failed"));
    assert_eq!(problem.message, "record invalid");
    assert_eq!(
        problem.details,
        Some(mdbn_wire::common::Value::Text("parent details".into()))
    );
    let issues = problem.issues.as_ref().unwrap();
    assert_eq!(issues.len(), 2);
    assert_eq!(issues[0].code, "schema_violation");
    assert_eq!(issues[0].severity, client::Severity::Error);
    assert_eq!(issues[0].message, "required field missing");
    assert_eq!(
        issues[0].details,
        Some(mdbn_wire::common::Value::Text("field details".into()))
    );
    assert_eq!(issues[1].code, "link_not_found");
    assert_eq!(issues[1].severity, client::Severity::Warning);
    assert_eq!(issues[1].message, "target missing");
    assert_eq!(issues[1].details, None);
    assert_eq!(
        client::Problem::from_bytes(&problem.to_bytes().unwrap()).unwrap(),
        problem
    );
}

#[test]
fn global_catalog_issues_are_not_projected_into_a_submit_problem() {
    let mut rejection = Rejection::new(
        RejectCode::CollectionInvalid,
        None,
        "the collection configuration does not load",
    );
    rejection.issues = vec![
        Issue::new(
            "catalog_invalid",
            Severity::Error,
            Tier::Request,
            "catalog diagnostic",
        )
        .with_details(Value::string("catalog details")),
    ];
    let problem = rejection_problem(&rejection);
    assert_eq!(problem.code, "collection_invalid");
    assert_eq!(problem.message, rejection.message);
    assert_eq!(problem.issues, None);
    assert_eq!(problem.reason, None);
    assert_eq!(problem.details, None);
    assert_eq!(
        client::Problem::from_bytes(&problem.to_bytes().unwrap()).unwrap(),
        problem
    );
}

#[test]
fn empty_rejection_issues_keep_the_legacy_absent_optional_field() {
    let rejection = Rejection::new(RejectCode::InvalidRequest, None, "invalid request");
    let problem = rejection_problem(&rejection);
    assert_eq!(problem.issues, None);
    assert_eq!(problem.reason, None);
    assert_eq!(problem.details, None);
    assert_eq!(
        client::Problem::from_bytes(&problem.to_bytes().unwrap()).unwrap(),
        problem
    );
}

/// Store errors reach clients as their kind only,
/// never the adapter's text (SQL engine messages name tables, columns and
/// statements; I/O errors name paths).
#[test]
fn store_errors_reach_clients_as_their_kind_only() {
    use crate::store::StoreError as E;
    let secret = "no such column: st_field.secret_col in SELECT * FROM /home/u/vault";
    for e in [
        E::Io(secret.into()),
        E::Corrupt(secret.into()),
        E::CommitAborted(secret.into()),
    ] {
        let err = super::store_err(e);
        let p = err.problem();
        assert_eq!(p.code, "unavailable");
        assert!(!p.message.contains("st_field"), "{}", p.message);
        assert!(!p.message.contains("/home"), "{}", p.message);
    }
    let full = super::store_err(E::Full);
    assert_eq!(full.problem().code, "quota_exceeded");
}
