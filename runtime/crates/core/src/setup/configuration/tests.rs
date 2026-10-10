#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::*;

fn declaration(path: &str, value: Value) -> ConfigurationDeclaration {
    ConfigurationDeclaration {
        requirements: vec![ConfigurationRequirement {
            id: "base-extension".into(),
            path: path.into(),
            predicate: ConfigurationPredicate::Contains,
            value: value.clone(),
        }],
        provisions: vec![ConfigurationProvision {
            requirement: "base-extension".into(),
            path: path.into(),
            operation: ConfigurationOperation::SetAdd,
            value,
        }],
    }
}
fn base() -> ConfigurationDeclaration {
    declaration("/settings/record_extensions", Value::string("base"))
}
fn parsed(src: &str) -> Value {
    crate::yaml::parse_value(src).unwrap().unwrap()
}

#[test]
fn missing_settings_preserve_implicit_md() {
    for src in [
        None,
        Some(""),
        Some("spec_version: 0.3.0\n"),
        Some("settings: {validation: error}\n"),
    ] {
        let a = plan_configuration(src, &base()).unwrap();
        assert!(a.applicable());
        assert_eq!(a.configuration[0].action, "add");
        let output = a.document.unwrap();
        if src.is_none() {
            assert!(
                crate::types::Catalog::load([(crate::types::CONFIG_PATH, output.as_str())])
                    .is_valid(),
                "new configuration is loadable"
            );
        }
        assert_eq!(
            parsed(&output)
                .get("settings")
                .unwrap()
                .get("record_extensions")
                .unwrap(),
            &Value::List(vec![Value::string("md"), Value::string("base")])
        );
        let repeated = plan_configuration(Some(&output), &base()).unwrap();
        assert_eq!(repeated.configuration[0].action, "current");
        assert!(repeated.document.is_none());
    }
    let md = declaration("/settings/record_extensions", Value::string("md"));
    assert!(plan_configuration(None, &md).unwrap().document.is_none());
}

#[test]
fn append_order_preservation_and_idempotency() {
    let src = "# untouched\r\nspec_version: 0.3.0\r\nsettings: {record_extensions: [md, txt], validation: error}\r\nx-private: {secret: 'do not disclose'}\r\n";
    let a = plan_configuration(Some(src), &base()).unwrap();
    let out = a.document.as_deref().unwrap();
    assert!(out.starts_with("# untouched\r\n"));
    assert!(out.contains("x-private: {secret: 'do not disclose'}\r\n"));
    assert!(!out.replace("\r\n", "").contains('\n'));
    let after = parsed(out);
    assert_eq!(
        after
            .get("settings")
            .unwrap()
            .get("record_extensions")
            .unwrap(),
        &Value::List(vec![
            Value::string("md"),
            Value::string("txt"),
            Value::string("base")
        ])
    );
    assert_eq!(
        after.get("settings").unwrap().get("validation"),
        parsed(src).get("settings").unwrap().get("validation")
    );
    assert!(
        plan_configuration(Some(out), &base())
            .unwrap()
            .document
            .is_none()
    );
    assert_ne!(
        plan_configuration(None, &base()).unwrap().assessment_digest,
        plan_configuration(Some(""), &base())
            .unwrap()
            .assessment_digest,
        "absence differs from empty source"
    );
}

#[test]
fn known_membership_is_exact_not_extension_case_guessing() {
    let src = "settings: {record_extensions: [md, BASE, base]}\n";
    let a = plan_configuration(Some(src), &base()).unwrap();
    assert_eq!(a.configuration[0].action, "current");
    assert!(a.document.is_none());
    let src = "settings: {record_extensions: [BASE]}\n";
    let a = plan_configuration(Some(src), &base()).unwrap();
    assert_eq!(a.configuration[0].action, "add");
    assert_eq!(
        parsed(a.document.as_deref().unwrap())
            .get("settings")
            .unwrap()
            .get("record_extensions")
            .unwrap(),
        &Value::List(vec![Value::string("BASE"), Value::string("base")])
    );
}

#[test]
fn path_and_type_conflicts_never_replace_or_expose_values() {
    for (src, code, observed) in [
        (
            "settings: secret-token\n",
            "configuration_path_conflict",
            "string",
        ),
        ("settings: null\n", "configuration_path_conflict", "null"),
        ("settings: []\n", "configuration_path_conflict", "array"),
        (
            "settings: {record_extensions: secret-token}\n",
            "configuration_type_conflict",
            "string",
        ),
        (
            "settings: {record_extensions: false}\n",
            "configuration_type_conflict",
            "boolean",
        ),
    ] {
        let a = plan_configuration(Some(src), &base()).unwrap();
        assert!(!a.applicable());
        assert!(a.document.is_none());
        let c = a.configuration[0].conflict.as_ref().unwrap();
        assert_eq!((c.code, c.observed), (code, observed));
        assert!(!format!("{:?}", a.configuration).contains("secret-token"));
    }
    for src in [
        "[secret-token]",
        "{broken: [secret-token",
        "settings: 1\nsettings: 2\n",
    ] {
        let e = plan_configuration(Some(src), &base()).unwrap_err();
        assert_eq!(e.code, "configuration_type_conflict");
        assert!(!e.message.contains("secret-token"));
    }
}

#[test]
fn one_conflict_suppresses_all_safe_additions() {
    let mut d = base();
    let mut bad = declaration(
        "/x-private/nested/items",
        Value::string("public-declaration"),
    );
    bad.requirements[0].id = "other".into();
    bad.provisions[0].requirement = "other".into();
    d.requirements.extend(bad.requirements);
    d.provisions.extend(bad.provisions);
    let a = plan_configuration(Some("x-private: {nested: private-secret}\n"), &d).unwrap();
    assert_eq!(
        a.configuration.iter().map(|x| x.action).collect::<Vec<_>>(),
        vec!["add", "conflict"]
    );
    assert!(a.document.is_none());
}

#[test]
fn canonical_scalar_membership_and_escaped_keys() {
    for (value, src) in [
        (Value::Int(1), "x-private: {items: [1.0]}"),
        (Value::Float(-0.0), "x-private: {items: [0]}"),
        (Value::Null, "x-private: {items: [null]}"),
        (Value::Bool(false), "x-private: {items: [false]}"),
    ] {
        let a = plan_configuration(Some(src), &declaration("/x-private/items", value)).unwrap();
        assert_eq!(a.configuration[0].action, "current");
        assert!(a.document.is_none());
    }
    let d = declaration("/x-private/escaped~1key/~0name", Value::Bool(true));
    let a = plan_configuration(None, &d).unwrap();
    assert_eq!(
        parsed(a.document.as_deref().unwrap())
            .get("x-private")
            .unwrap()
            .get("escaped/key")
            .unwrap()
            .get("~name"),
        Some(&Value::List(vec![Value::Bool(true)]))
    );
}

#[test]
fn declarations_are_bounded_confined_and_rechecked() {
    for path in [
        "/settings/timezone",
        "/settings/record_extensions/extra",
        "/runtime/events",
        "/x-private",
        "/x-private/-",
        "/x-private/0",
        "/x-private/bad~2escape",
        "/x-private//",
        "/x-private/\u{0085}",
    ] {
        assert_eq!(
            declaration(path, Value::string("base"))
                .validate()
                .unwrap_err()
                .code,
            "invalid_collection_setup",
            "{path}"
        );
    }
    for value in [
        Value::Null,
        Value::Bool(true),
        Value::string(".base"),
        Value::string("../base"),
        Value::List(vec![]),
        Value::Float(f64::NAN),
        Value::Float(f64::INFINITY),
    ] {
        assert!(
            declaration("/settings/record_extensions", value)
                .validate()
                .is_err()
        );
    }
    let mut d = base();
    d.provisions[0].value = Value::string("different");
    assert!(d.validate().is_err());
    let mut d = base();
    d.requirements.push(d.requirements[0].clone());
    assert!(d.validate().is_err());
    let mut d = base();
    d.provisions.push(d.provisions[0].clone());
    assert!(d.validate().is_err());
    let mut d = base();
    d.provisions.clear();
    assert!(d.validate().is_err());
    let mut d = base();
    d.provisions[0].requirement = "orphan".into();
    assert!(d.validate().is_err());
    let huge = declaration(
        "/x-private/items",
        Value::string("a".repeat(MAX_DECLARATION_BYTES)),
    );
    assert_eq!(
        huge.validate().unwrap_err().code,
        "collection_setup_limit_exceeded"
    );
    let huge = " ".repeat(MAX_CONFIG_BYTES + 1);
    assert_eq!(
        plan_configuration(Some(&huge), &base()).unwrap_err().code,
        "collection_setup_limit_exceeded"
    );
}

#[test]
fn digest_binds_actual_declarations_source_and_provision_order() {
    let a = plan_configuration(Some("settings: {record_extensions: [md]}\n"), &base()).unwrap();
    assert_eq!(
        a,
        plan_configuration(Some("settings: {record_extensions: [md]}\n"), &base()).unwrap()
    );
    assert_ne!(
        a.assessment_digest,
        plan_configuration(
            Some("settings: {record_extensions: [md]} # edit\n"),
            &base()
        )
        .unwrap()
        .assessment_digest
    );
    let mut d = base();
    d.requirements[0].id = "renamed".into();
    d.provisions[0].requirement = "renamed".into();
    assert_ne!(
        a.assessment_digest,
        plan_configuration(Some("settings: {record_extensions: [md]}\n"), &d)
            .unwrap()
            .assessment_digest
    );
    let mut second = declaration("/settings/record_extensions", Value::string("txt"));
    second.requirements[0].id = "txt-extension".into();
    second.provisions[0].requirement = "txt-extension".into();
    let mut d = base();
    d.requirements.extend(second.requirements);
    d.provisions.extend(second.provisions);
    let ordered = plan_configuration(None, &d).unwrap();
    d.provisions.reverse();
    let reverse = plan_configuration(None, &d).unwrap();
    assert_ne!(ordered.assessment_digest, reverse.assessment_digest);
    assert_ne!(ordered.document, reverse.document);
}

#[test]
fn carrier_decode_is_strict_and_roundtrips() {
    let value = base().to_value();
    assert_eq!(
        ConfigurationDeclaration::from_value(&value).unwrap(),
        base()
    );
    let mut v = value.as_map().unwrap().clone();
    v.insert("extra", Value::Bool(true));
    assert!(ConfigurationDeclaration::from_value(&Value::Map(v)).is_err());
    for changed in [
        value.to_json().replace("contains", "equals"),
        value.to_json().replace("set_add", "replace"),
        value.to_json().replace("\"base\"", "[]"),
    ] {
        assert!(ConfigurationDeclaration::from_value(&parsed(&changed)).is_err());
    }
}
