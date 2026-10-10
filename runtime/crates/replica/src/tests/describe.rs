//! Actual Describe producer over catalog resources persisted in the test store.

use super::engine::{Node, node, settle};
use crate::api::{ClientApi, ErrorCode};
use crate::fake::FakeLogService;
use crate::mem::MemStore;
use crate::{Store, Tx};
use mdbn_wire::common::{DataMap, Value};

fn contract(version: &str) -> String {
    format!(
        "---\nkind: mdbase.contract\ncontract_type: record\nid: acme.task\nversion: {version}\nrecord_schema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    properties:\n      done: {{type: boolean}}\nbinding_schema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    properties:\n      workspace: {{type: string}}\n---\n"
    )
}
fn type_source(name: &str, version: &str, binding: bool) -> String {
    let binding = if binding {
        "    binding: {workspace: personal}\n"
    } else {
        ""
    };
    format!(
        "---\nkind: mdbase.type\nname: {name}\nschema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    properties:\n      completed: {{type: boolean}}\nimplements:\n  - contract: acme.task\n    version: '{version}'\n    fields: {{'/done': '/completed'}}\n{binding}---\n"
    )
}
fn configured(resources: Vec<(String, String)>) -> (FakeLogService, Node) {
    let svc = FakeLogService::new();
    let mut store = MemStore::new();
    store
        .commit(Tx {
            resources_put: resources,
            ..Tx::default()
        })
        .unwrap();
    let mut a = node(&svc, 1, store);
    settle(&mut [&mut a]);
    (svc, a)
}
fn resources() -> Vec<(String, String)> {
    vec![
        ("mdbase.yaml".into(), "spec_version: '0.3.0'\n".into()),
        (
            "_types/zebra.md".into(),
            type_source("Zebra", "1.0.0", false),
        ),
        (
            "_types/alpha.md".into(),
            type_source("alpha", "^1.0.0", true),
        ),
        ("_contracts/v2.md".into(), contract("2.0.0")),
        ("_contracts/v1.md".into(), contract("1.0.0")),
        ("_contracts/v12.md".into(), contract("1.2.0")),
    ]
}

#[test]
fn describe_projects_resolved_versions_fields_bindings_paths_and_exact_implementors() {
    let (svc, mut a) = configured(resources());
    assert!(a.r.catalog.is_valid(), "{:?}", a.r.catalog.issues());
    let d = a.r.describe(a.s).unwrap();
    assert_eq!(d.spec_version, "0.3.0");
    assert!(d.issues.is_empty());
    assert_eq!(
        d.types.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(),
        ["alpha", "Zebra"]
    );
    assert_eq!(d.types[0].path, "_types/alpha.md");
    let i = &d.types[0].implements[0];
    assert_eq!((&*i.contract, &*i.version), ("acme.task", "1.2.0"));
    assert_eq!(
        i.fields,
        DataMap(vec![("/done".into(), "/completed".into())])
    );
    assert_eq!(
        i.binding,
        Some(Value::Map(vec![(
            "workspace".into(),
            Value::Text("personal".into())
        )]))
    );
    assert_eq!(d.types[1].implements[0].version, "1.0.0");
    assert_eq!(d.types[1].implements[0].binding, None);
    assert_eq!(
        d.contracts
            .iter()
            .map(|c| c.version.as_str())
            .collect::<Vec<_>>(),
        ["1.0.0", "1.2.0", "2.0.0"]
    );
    assert_eq!(d.contracts[0].implemented_by, ["Zebra"]);
    assert_eq!(d.contracts[1].implemented_by, ["alpha"]);
    assert!(d.contracts[2].implemented_by.is_empty());
    for (summary, registered) in d.contracts.iter().zip(a.r.catalog.contracts()) {
        assert_eq!(summary.path, registered.source_path);
        assert_eq!(summary.digest, crate::convert::whash(&registered.digest));
        assert_eq!(summary.contract_type, "record");
    }
    // Reopen reconstructs summaries from persisted resources, not DTO/cache claims.
    let store = a.r.into_store();
    let mut reopened = node(&svc, 1, store);
    settle(&mut [&mut reopened]);
    assert_eq!(reopened.r.describe(reopened.s).unwrap(), d);
}

#[test]
fn describe_reports_catalog_issues_without_advertising_invalid_implementations() {
    let mut sources = resources();
    sources.push(("_types/bad.md".into(), type_source("bad", "^9.0.0", false)));
    let (_, mut a) = configured(sources);
    let d = a.r.describe(a.s).unwrap();
    assert!(
        d.issues
            .iter()
            .any(|i| i.code == "data_contract_version_mismatch")
    );
    assert!(
        d.types
            .iter()
            .find(|t| t.name == "bad")
            .unwrap()
            .implements
            .is_empty()
    );
    assert!(
        d.contracts
            .iter()
            .all(|c| !c.implemented_by.iter().any(|t| t == "bad"))
    );
}

#[test]
fn describe_empty_catalog_and_closed_session() {
    let (_, mut a) = configured(vec![(
        "mdbase.yaml".into(),
        "spec_version: '0.3.0'\n".into(),
    )]);
    let d = a.r.describe(a.s).unwrap();
    assert!(d.types.is_empty());
    assert!(d.contracts.is_empty());
    a.r.close(a.s);
    assert_eq!(
        a.r.describe(a.s).unwrap_err().code(),
        Some(ErrorCode::Unauthenticated)
    );
}
