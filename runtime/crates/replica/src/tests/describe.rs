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

fn contract_page(
    a: &mut Node,
    version: &str,
    cursor: Option<String>,
) -> crate::api::ApiResult<crate::api::ContractQueryResult> {
    a.r.query_contract(
        a.s,
        crate::api::ContractQuery {
            where_: None,
            contract: "acme.task".into(),
            version: version.into(),
            limit: 128,
            cursor,
        },
    )
}

#[test]
fn contract_query_uses_canonical_mapping_and_preserves_invalid_inspection_data() {
    let (_, mut a) = configured(resources());
    a.create(
        1,
        "rows/a.md",
        "---\ntype: Zebra\ncompleted: false\ndone: true\n---\n",
    );
    a.create(2, "rows/b.md", "---\ntype: Zebra\ncompleted: wrong\n---\n");
    a.create(3, "rows/c.md", "---\ntype: Zebra\ndone: true\n---\n");
    a.create(4, "rows/d.md", "---\ntype: alpha\ncompleted: true\n---\n");
    settle(&mut [&mut a]);
    let first = contract_page(&mut a, "1.0.0", None).unwrap();
    assert_eq!(first.page.records[0].path, "rows/a.md");
    assert_eq!(first.records[0].id, first.page.records[0].id);
    assert_eq!(
        first.records[0].implementations[0].fields,
        DataMap(vec![("done".into(), Value::Bool(false))])
    );
    assert!(first.records[0].implementations[0].issues.is_empty());
    assert_eq!(first.records.len(), 3);
    assert_eq!(
        first.records[1].implementations[0].fields,
        DataMap(vec![("done".into(), Value::Text("wrong".into()))])
    );
    assert_eq!(
        first.records[1].implementations[0].issues[0].code,
        "data_contract_record_invalid"
    );
    assert_eq!(first.page.records[2].path, "rows/c.md");
    // The similarly named raw field is not a mapping/default fallback.
    assert!(first.records[2].implementations[0].fields.0.is_empty());
    assert!(first.page.cursor.is_none());
}

fn pending_resources(a: &mut Node, resources: Vec<(&str, String)>) {
    a.r.planner = Box::new(crate::plan::CorePlanner);
    let receipts =
        a.r.submit(
            a.s,
            mdbn_wire::client::SubmitParams {
                ops: resources
                    .into_iter()
                    .map(|(path, doc)| {
                        mdbn_wire::intent::Op::ResourcePut(mdbn_wire::intent::ResourcePut {
                            path: path.into(),
                            doc: mdbn_wire::common::Text::Inline(doc),
                            base_revision: None,
                            must_not_exist: None,
                        })
                    })
                    .collect(),
                mutation_id: None,
                conflict_mode: None,
                timezone: None,
                allow_partial: None,
                mutation_ids: None,
                dry_run: None,
                include: None,
                wait: None,
            },
        )
        .unwrap();
    assert!(receipts.iter().all(|r| r.problem.is_none()), "{receipts:?}");
    assert!(a.r.layer.catalog().is_some());
}

#[test]
fn contract_query_pending_implementor_is_not_a_complete_empty_confirmed_inventory() {
    let (_, mut a) = configured(resources());
    let receipt = a.create(
        1,
        "rows/pending.md",
        "---\ntype: Zebra\ncompleted: true\n---\n",
    );
    assert!(receipt.problem.is_none(), "{receipt:?}");
    settle(&mut [&mut a]);
    assert!(
        contract_page(&mut a, "2.0.0", None)
            .unwrap()
            .records
            .is_empty()
    );
    pending_resources(
        &mut a,
        vec![("_types/zebra.md", type_source("Zebra", "2.0.0", false))],
    );
    let result = contract_page(&mut a, "2.0.0", None).unwrap();
    assert!(result.page.complete);
    assert_eq!(result.page.records.len(), 1);
    assert_eq!(result.page.records[0].path, "rows/pending.md");
    assert_eq!(
        result.records[0].implementations[0].fields,
        DataMap(vec![("done".into(), Value::Bool(true))])
    );
}

#[test]
fn contract_query_pending_registration_uses_local_admission_instead_of_not_found() {
    let (_, mut a) = configured(vec![
        ("mdbase.yaml".into(), "spec_version: '0.3.0'\n".into()),
        ("_types/zebra.md".into(), "---\nkind: mdbase.type\nname: Zebra\nschema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    properties:\n      completed: {type: boolean}\n---\n".into()),
    ]);
    let receipt = a.create(1, "rows/new.md", "---\ntype: Zebra\ncompleted: true\n---\n");
    assert!(receipt.problem.is_none(), "{receipt:?}");
    settle(&mut [&mut a]);
    assert_eq!(
        contract_page(&mut a, "1.0.0", None).unwrap_err().code(),
        Some(ErrorCode::NotFound)
    );
    pending_resources(
        &mut a,
        vec![
            ("_contracts/new.md", contract("1.0.0")),
            ("_types/zebra.md", type_source("Zebra", "1.0.0", false)),
        ],
    );
    let result = contract_page(&mut a, "1.0.0", None).unwrap();
    assert!(result.page.complete);
    assert_eq!(result.page.records.len(), 1);
    assert_eq!(
        result.records[0].implementations[0].fields,
        DataMap(vec![("done".into(), Value::Bool(true))])
    );
}

#[test]
fn contract_query_pending_mapping_and_digest_match_the_same_record_read_catalog() {
    let (_, mut a) = configured(resources());
    a.create(
        1,
        "rows/mapped.md",
        "---\ntype: Zebra\ncompleted: false\nalternate: true\n---\n",
    );
    settle(&mut [&mut a]);
    let confirmed = contract_page(&mut a, "1.0.0", None).unwrap();
    assert_eq!(
        confirmed.records[0].implementations[0].fields,
        DataMap(vec![("done".into(), Value::Bool(false))])
    );
    pending_resources(
        &mut a,
        vec![
            (
                "_contracts/v1.md",
                contract("1.0.0").replace(
                    "done: {type: boolean}",
                    "done: {type: boolean, title: Pending}",
                ),
            ),
            (
                "_types/zebra.md",
                type_source("Zebra", "1.0.0", false)
                    .replace(
                        "completed: {type: boolean}",
                        "completed: {type: boolean}\n      alternate: {type: boolean}",
                    )
                    .replace("'/completed'", "'/alternate'"),
            ),
        ],
    );
    let catalog = a.r.layer.catalog().unwrap();
    assert!(catalog.is_valid(), "{:?}", catalog.issues());
    let expected = crate::convert::whash(
        &catalog
            .contract(
                "acme.task",
                &mdbn_core::contracts::Version::parse("1.0.0").unwrap(),
            )
            .unwrap()
            .digest,
    );
    let pending = contract_page(&mut a, "1.0.0", None).unwrap();
    assert_ne!(pending.contract_digest, confirmed.contract_digest);
    assert_eq!(pending.contract_digest, expected);
    assert_eq!(
        pending.records[0].implementations[0].fields,
        DataMap(vec![("done".into(), Value::Bool(true))])
    );
}

#[test]
fn contract_query_refuses_unindexed_full_windows_and_checks_session_and_selection() {
    let (_, mut a) = configured(resources());
    a.create(1, "rows/a.md", "---\ntype: Zebra\ncompleted: false\n---\n");
    a.create(2, "rows/b.md", "---\ntype: Zebra\ncompleted: true\n---\n");
    settle(&mut [&mut a]);
    assert_eq!(
        a.r.query_contract(
            a.s,
            crate::api::ContractQuery {
                where_: None,
                contract: "acme.task".into(),
                version: "1.0.0".into(),
                limit: 1,
                cursor: None,
            }
        )
        .unwrap_err()
        .problem()
        .reason
        .as_deref(),
        Some("contract_query_cursor_required")
    );
    assert_eq!(
        contract_page(
            &mut a,
            "1.2.0",
            Some("q1.00000000000000000000000000000000".into())
        )
        .unwrap_err()
        .code(),
        Some(ErrorCode::InvalidRequest)
    );
    assert_eq!(
        contract_page(&mut a, "9.0.0", None).unwrap_err().code(),
        Some(ErrorCode::NotFound)
    );
    assert_eq!(
        a.r.query_contract(
            a.s,
            crate::api::ContractQuery {
                where_: None,
                contract: "acme.task".into(),
                version: "1.0.0".into(),
                limit: 129,
                cursor: None
            }
        )
        .unwrap_err()
        .code(),
        Some(ErrorCode::InvalidRequest)
    );
    a.r.close(a.s);
    assert_eq!(
        contract_page(&mut a, "1.0.0", None).unwrap_err().code(),
        Some(ErrorCode::Unauthenticated)
    );
}

#[test]
fn contract_query_projection_budget_is_charged_before_wide_mapping_clones() {
    let properties = (0..128)
        .map(|i| format!("      value{i}: {{type: boolean}}\n"))
        .collect::<String>();
    let fields = (0..128)
        .map(|i| format!("'/value{i}': '/completed'"))
        .collect::<Vec<_>>()
        .join(", ");
    let (_, mut a) = configured(vec![
        ("mdbase.yaml".into(), "spec_version: '0.3.0'\n".into()),
        (
            "_contracts/wide.md".into(),
            format!(
                "---\nkind: mdbase.contract\ncontract_type: record\nid: acme.task\nversion: 1.0.0\nrecord_schema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    properties:\n{properties}---\n"
            ),
        ),
        (
            "_types/wide.md".into(),
            format!(
                "---\nkind: mdbase.type\nname: wide\nschema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    properties:\n      completed: {{type: boolean}}\nimplements:\n  - contract: acme.task\n    version: 1.0.0\n    fields: {{{fields}}}\n---\n"
            ),
        ),
    ]);
    assert!(a.r.catalog.is_valid(), "{:?}", a.r.catalog.issues());
    a.create(
        1,
        "rows/wide.md",
        &format!(
            "---\ntype: wide\ncompleted: true\nunmapped: {}\n---\n",
            "x".repeat(12000)
        ),
    );
    settle(&mut [&mut a]);
    let error = contract_page(&mut a, "1.0.0", None).unwrap_err();
    assert_eq!(error.code(), Some(ErrorCode::TooLarge));
    assert_eq!(
        error.problem().reason.as_deref(),
        Some("contract_projection_budget")
    );
}

#[test]
fn contract_query_empty_implementation_set_is_complete_without_raw_record_inference() {
    let (_, mut a) = configured(resources());
    let result = contract_page(&mut a, "2.0.0", None).unwrap();
    assert!(result.page.complete && result.records.is_empty());
    assert_eq!(result.page.total_count, Some(0));
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

#[test]
fn describe_carries_revisions_digests_and_definitions_on_request_over_the_local_view() {
    let (_, mut a) = configured(resources());
    let d = a.r.describe(a.s).unwrap();
    let alpha = &d.types[0];
    let source = a.r.get_resource(a.s, alpha.path.clone()).unwrap();
    assert_eq!(alpha.revision, Some(source.revision));
    assert!(alpha.definition.is_none() && alpha.schema.is_none());
    let catalog = a.r.catalog.clone();
    let implementation = catalog
        .implementations()
        .iter()
        .find(|i| i.type_name == "alpha")
        .unwrap();
    assert_eq!(
        alpha.implements[0].digest,
        Some(crate::convert::whash(&implementation.digest))
    );
    assert!(d.contracts.iter().all(|c| c.schemas.is_none()));

    let full = a.r.describe_definitions(a.s).unwrap();
    let Some(Value::Map(definition)) = &full.types[0].definition else {
        panic!("definition missing: {:?}", full.types[0]);
    };
    assert!(definition.contains(&("name".into(), Value::Text("alpha".into()))));
    let Some(Value::Map(schema)) = &full.types[0].schema else {
        panic!("schema missing");
    };
    assert!(schema.contains(&("type".into(), Value::Text("object".into()))));
    let schemas = full.contracts[0].schemas.as_ref().unwrap();
    assert_eq!(
        schemas
            .0
            .iter()
            .map(|(m, _)| m.as_str())
            .collect::<Vec<_>>(),
        ["binding_schema", "record_schema"]
    );

    // A locally pending type is described with the revision get_resource returns.
    let pending = "---\nkind: mdbase.type\nname: beta\nversion: 3\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object}\n---\n".to_string();
    pending_resources(&mut a, vec![("_types/beta.md", pending.clone())]);
    let d = a.r.describe(a.s).unwrap();
    let beta = d.types.iter().find(|t| t.name == "beta").unwrap();
    assert_eq!(beta.version, Some(3));
    assert_eq!(
        beta.revision,
        Some(crate::convert::whash(&mdbn_core::ids::revision(&pending)))
    );
}

#[test]
fn new_type_file_derives_the_path_from_the_local_catalog() {
    let mut sources = resources();
    sources.push(("_types/gamma.md".into(), "no frontmatter\n".into()));
    let (_, mut a) = configured(sources);
    let source = |name: &str| {
        format!(
            "---\nkind: mdbase.type\nname: {name}\nschema:\n  dialect: json-schema-2020-12\n  value: {{type: object}}\n---\n"
        )
    };
    let created = a.r.new_type_file(a.s, source("beta")).unwrap();
    assert_eq!(
        (created.name.as_str(), created.path.as_str()),
        ("beta", "_types/beta.md")
    );
    let problem = |e: crate::api::ApiError| {
        let p = e.problem().clone();
        (p.code, p.reason.unwrap_or_default())
    };
    assert_eq!(
        problem(a.r.new_type_file(a.s, source("zebra")).unwrap_err()),
        ("conflict".into(), "type_conflict".into())
    );
    assert_eq!(
        problem(a.r.new_type_file(a.s, source("a/b")).unwrap_err()),
        ("invalid_record".into(), "invalid_type_definition".into())
    );
    // An occupied path holding no valid type is taken; so is a pending type's name.
    assert_eq!(
        problem(a.r.new_type_file(a.s, source("gamma")).unwrap_err()),
        ("conflict".into(), "path_taken".into())
    );
    pending_resources(&mut a, vec![("_types/beta.md", source("beta"))]);
    assert_eq!(
        problem(a.r.new_type_file(a.s, source("Beta")).unwrap_err()),
        ("conflict".into(), "type_conflict".into())
    );
}

#[test]
fn contract_records_read_and_map_writes_through_the_local_catalog() {
    use crate::api::Target;
    use crate::api::{ContractSelection, ContractWriteRequest};
    let (_, mut a) = configured(resources());
    a.r.planner = Box::new(crate::plan::CorePlanner);
    a.create(1, "rows/a.md", "---\ntype: Zebra\ncompleted: false\n---\n");
    a.create(2, "rows/b.md", "---\nother: 1\n---\n");
    let selection = || ContractSelection {
        contract: "acme.task".into(),
        version: "1.0.0".into(),
        type_name: None,
    };
    let view =
        a.r.get_contract(a.s, Target::Path("rows/a.md".into()), selection())
            .unwrap();
    assert_eq!(view.type_name, "Zebra");
    assert_eq!(
        view.fields,
        DataMap(vec![("done".into(), Value::Bool(false))])
    );

    let plan =
        a.r.map_contract_write(
            a.s,
            ContractWriteRequest {
                selection: selection(),
                target: Some(Target::Id(view.id)),
                fields: Value::Map(vec![("done".into(), Value::Bool(true))]),
                unset: vec![],
                promote: false,
            },
        )
        .unwrap();
    assert_eq!(
        plan.patch,
        DataMap(vec![("completed".into(), Value::Bool(true))])
    );
    assert_eq!(plan.record.as_ref().map(|r| r.2), Some(view.revision));
    let receipts =
        a.r.submit(
            a.s,
            mdbn_wire::client::SubmitParams {
                ops: vec![mdbn_wire::intent::Op::Update(mdbn_wire::intent::Update {
                    id: view.id,
                    patch: Some(plan.patch),
                    unset: None,
                    add: None,
                    remove: None,
                    body: None,
                    body_edits: None,
                    body_base: None,
                    body_base_text: None,
                    base: Some(plan.base),
                    if_revision: None,
                })],
                mutation_id: None,
                conflict_mode: None,
                timezone: None,
                allow_partial: None,
                mutation_ids: None,
                dry_run: None,
                include: None,
                wait: None,
            },
        )
        .unwrap();
    assert!(receipts.iter().all(|r| r.problem.is_none()), "{receipts:?}");
    let after =
        a.r.get_contract(a.s, Target::Path("rows/a.md".into()), selection())
            .unwrap();
    assert_eq!(
        after.fields,
        DataMap(vec![("done".into(), Value::Bool(true))])
    );

    let missing =
        a.r.get_contract(a.s, Target::Path("rows/b.md".into()), selection());
    let p = missing.unwrap_err().problem().clone();
    assert_eq!(
        (p.code.as_str(), p.reason.as_deref()),
        ("not_found", Some("data_contract_not_implemented"))
    );
}

#[test]
fn contract_query_filters_on_contract_fields() {
    let (_, mut a) = configured(resources());
    a.create(1, "rows/a.md", "---\ntype: Zebra\ncompleted: true\n---\n");
    a.create(
        2,
        "rows/b.md",
        "---\ntype: Zebra\ncompleted: false\ndone: true\n---\n",
    );
    a.create(3, "rows/c.md", "---\ntype: Zebra\ncompleted: true\n---\n");
    settle(&mut [&mut a]);
    let page = |a: &mut Node, where_: &str, limit, cursor: Option<String>| {
        a.r.query_contract(
            a.s,
            crate::api::ContractQuery {
                where_: Some(where_.into()),
                contract: "acme.task".into(),
                version: "1.0.0".into(),
                limit,
                cursor,
            },
        )
    };
    // `done` is the contract field (mapped from `completed`), not the raw key.
    let result = page(&mut a, "done == true", 128, None).unwrap();
    let paths: Vec<_> = result
        .page
        .records
        .iter()
        .map(|r| r.path.as_str())
        .collect();
    assert_eq!(paths, ["rows/a.md", "rows/c.md"]);
    assert_eq!(result.records.len(), 2);
    assert_eq!(result.page.total_count, None);
    assert_eq!(
        page(&mut a, "done ==", 128, None)
            .unwrap_err()
            .problem()
            .reason
            .as_deref(),
        Some("invalid_query")
    );
}
