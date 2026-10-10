//! Contribution metadata only; never independent configuration installation.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use mdbn_core::ids::Hash;
use mdbn_core::setup::receipts::{Contributor, MAX_RECEIPT_BYTES, ProvisionLock};
use mdbn_core::value::Value;
fn contributor(app: &str, version: u8) -> Contributor {
    Contributor {
        application_id: app.into(),
        declaration_digest: Hash::of(&[version]),
        provision_digest: Hash::of(&[version, 1]),
        requirement: "base-extension".into(),
    }
}
#[test]
fn shared_contribution_keeps_other_apps_and_all_exact_versions() {
    let mut lock = ProvisionLock::default();
    let value = Value::string("base");
    let a = contributor("app.one", 1);
    assert!(
        lock.contribute("/settings/record_extensions", &value, a.clone())
            .unwrap()
    );
    assert!(
        !lock
            .contribute("/settings/record_extensions", &value, a)
            .unwrap()
    );
    lock.contribute(
        "/settings/record_extensions",
        &value,
        contributor("app.two", 1),
    )
    .unwrap();
    lock.contribute(
        "/settings/record_extensions",
        &value,
        contributor("app.one", 2),
    )
    .unwrap();
    assert_eq!(lock.contributions.len(), 1);
    assert_eq!(lock.contributions[0].contributors.len(), 3);
    assert_eq!(
        ProvisionLock::parse(&lock.render().unwrap())
            .unwrap()
            .to_value()
            .unwrap(),
        lock.to_value().unwrap()
    );
}
#[test]
fn canonical_scalar_groups_do_not_conflate_boolean_or_text() {
    let mut lock = ProvisionLock::default();
    for value in [
        Value::Int(1),
        Value::Float(1.0),
        Value::Bool(true),
        Value::string("1"),
    ] {
        lock.contribute("/x-app/values", &value, contributor("app.one", 1))
            .unwrap();
    }
    assert_eq!(lock.contributions.len(), 3);
}
#[test]
fn output_order_is_independent_of_contributor_insertion_order() {
    let mut a = ProvisionLock::default();
    let mut b = ProvisionLock::default();
    let cs = [contributor("app.one", 1), contributor("app.two", 1)];
    for c in &cs {
        a.contribute("/x-app/values", &Value::Int(1), c.clone())
            .unwrap();
    }
    for c in cs.iter().rev() {
        b.contribute("/x-app/values", &Value::Int(1), c.clone())
            .unwrap();
    }
    assert_eq!(a.render().unwrap(), b.render().unwrap());
}
#[test]
fn failed_contribution_does_not_mutate_existing_ledger() {
    let mut lock = ProvisionLock::default();
    lock.contribute("/x-app/values", &Value::Null, contributor("app.one", 1))
        .unwrap();
    let before = lock.clone();
    for (path, value) in [
        ("/settings/other", Value::Null),
        ("/x-app/values", Value::List(vec![])),
        ("/x-app/values", Value::Float(f64::NAN)),
    ] {
        assert!(
            lock.contribute(path, &value, contributor("app.two", 1))
                .is_err()
        );
        assert_eq!(lock, before);
    }
}
#[test]
fn mutable_fields_are_revalidated_and_empty_ledger_is_supported() {
    let mut lock = ProvisionLock::default();
    assert!(
        ProvisionLock::parse(&lock.render().unwrap())
            .unwrap()
            .contributions
            .is_empty()
    );
    lock.contribute("/x-app/values", &Value::Null, contributor("app.one", 1))
        .unwrap();
    let duplicate = lock.contributions[0].contributors[0].clone();
    lock.contributions[0].contributors.push(duplicate);
    assert!(lock.render().is_err());
}
#[test]
fn malformed_and_oversized_sources_have_private_safe_errors() {
    for s in [
        "SECRET: [",
        "{}",
        "kind: mdbase.provision-lock\nlock_version: 2\ncontributions: []\n",
        "kind: mdbase.provision-lock\nlock_version: 1\ncontributions: []\nextra: SECRET\n",
    ] {
        let error = ProvisionLock::parse(s).unwrap_err();
        assert!(!format!("{error:?}").contains("SECRET"));
    }
    let error = ProvisionLock::parse(&"x".repeat(MAX_RECEIPT_BYTES + 1)).unwrap_err();
    assert_eq!(error.code, "collection_setup_limit_exceeded");
}
