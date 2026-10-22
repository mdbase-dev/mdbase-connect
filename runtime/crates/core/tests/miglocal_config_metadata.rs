//! Toy-redacted beta126 local configuration: rule out an unsupported version
//! or the legacy display-name warning as the empty generation-zero cause.
use mdbn_core::types::Catalog;
use mdbn_core::validate::Severity;

#[test]
fn beta126_local_config_remains_valid_with_name_warning() {
    let source = "name: '[test] G1 Local'\nsettings:\n  timezone: UTC\nspec_version: 0.3.0\nx-mdbase-connect:\n  collection_id: 00000000-0000-4000-8000-000000000001\n";
    let catalog = Catalog::load([("mdbase.yaml", source)]);
    assert!(catalog.is_valid());
    assert_eq!(catalog.spec_version(), Some("0.3.0"));
    assert!(
        !catalog
            .issues()
            .iter()
            .any(|i| i.severity == Severity::Error)
    );
    assert!(
        catalog
            .issues()
            .iter()
            .any(|i| i.code == "unknown_config_key" && i.severity == Severity::Warning)
    );
}
