//! Configuration-component replay, not a setup install/authorization endpoint.
use super::*;

/// Fixed replay dispatch used by the native/WASM differential harness.
pub(crate) fn replay(args: &Map) -> Value {
    let result = args
        .get("declaration")
        .ok_or_else(invalid)
        .and_then(ConfigurationDeclaration::from_value)
        .and_then(|d| {
            let source = match args.get("source") {
                None | Some(Value::Null) => None,
                Some(Value::Text(s)) => Some(s.as_str()),
                _ => return Err(invalid()),
            };
            plan_configuration(source, &d)
        });
    match result {
        Err(e) => object([("error", Value::string(e.code))]),
        Ok(p) => object([
            ("applicable", Value::Bool(p.applicable())),
            ("document", p.document.map_or(Value::Null, Value::string)),
            (
                "source_digest",
                p.source_digest
                    .map_or(Value::Null, |h| Value::string(h.to_string())),
            ),
            (
                "assessment_digest",
                Value::string(p.assessment_digest.to_string()),
            ),
            (
                "configuration",
                Value::List(
                    p.configuration
                        .into_iter()
                        .map(|a| {
                            object([
                                ("requirement", Value::string(a.requirement)),
                                ("path", Value::string(a.path)),
                                ("value", a.value),
                                ("action", Value::string(a.action)),
                                (
                                    "conflict",
                                    a.conflict.map_or(Value::Null, |c| {
                                        object([
                                            ("code", Value::string(c.code)),
                                            ("path", Value::string(c.path)),
                                            ("expected", Value::string(c.expected)),
                                            ("observed", Value::string(c.observed)),
                                        ])
                                    }),
                                ),
                            ])
                        })
                        .collect(),
                ),
            ),
        ]),
    }
}
