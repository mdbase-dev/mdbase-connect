//! Workflow input templates (runtime 0.2): only exact `$expr` objects evaluate.
//!
//! Strings and other scalars are literals; lists and mappings retain their
//! shape/order. Expressions see one immutable caller-supplied activation.

use super::Activation;
use crate::value::{Map, Value};

/// A workflow template error. Unlike query projections, errors abort input
/// evaluation; callers must not invoke a provider with a partial input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TemplateError {
    /// Compile, evaluation, invalid expression wrapper or resource-limit code.
    pub code: &'static str,
    /// Diagnostic message.
    pub message: String,
}

/// Evaluate a workflow action-input template using the shared CEL engine.
/// Exactly one `$expr` key denotes an expression; additional keys make a
/// literal mapping whose values are recursively evaluated. A plain string is
/// never compiled. CEL values outside the frontmatter model are errors.
///
/// Traversal is bounded by the CEL AST-depth and evaluation-step limits in
/// addition to each expression's own limits. No workflow state is mutated.
pub fn evaluate(template: &Value, activation: &Activation<'_>) -> Result<Value, TemplateError> {
    fn fail(code: &'static str, message: impl Into<String>) -> TemplateError {
        TemplateError {
            code,
            message: message.into(),
        }
    }
    fn go(
        value: &Value,
        activation: &Activation<'_>,
        depth: u32,
        remaining: &mut u64,
    ) -> Result<Value, TemplateError> {
        if depth > super::MAX_AST_DEPTH || *remaining == 0 {
            return Err(fail(
                "expression_evaluation_error",
                "workflow template limit exceeded",
            ));
        }
        *remaining -= 1;
        match value {
            Value::Map(map) if map.len() == 1 && map.contains_key("$expr") => {
                let source = map.get("$expr").and_then(Value::as_str).ok_or_else(|| {
                    fail("expression_compile_error", "`$expr` must be a CEL string")
                })?;
                let program = super::compile(source)
                    .map_err(|e| fail("expression_compile_error", e.to_string()))?;
                program
                    .evaluate(activation)
                    .map_err(|e| fail("expression_evaluation_error", e.message))?
                    .to_value()
                    .ok_or_else(|| {
                        fail(
                            "expression_evaluation_error",
                            "workflow input result cannot be represented as a value",
                        )
                    })
            }
            Value::Map(map) => {
                let mut out = Map::new();
                for (key, child) in map.iter() {
                    out.insert(key, go(child, activation, depth + 1, remaining)?);
                }
                Ok(Value::Map(out))
            }
            Value::List(list) => list
                .iter()
                .map(|child| go(child, activation, depth + 1, remaining))
                .collect::<Result<Vec<_>, _>>()
                .map(Value::List),
            other => Ok(other.clone()),
        }
    }
    let mut remaining = super::MAX_EVAL_STEPS;
    go(template, activation, 0, &mut remaining)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cel::CelValue;

    fn parsed(s: &str) -> Value {
        crate::yaml::parse_value(s).unwrap().unwrap()
    }

    #[test]
    fn only_exact_expression_objects_are_evaluated() {
        let mut activation = Activation::new();
        activation.bind(
            "event",
            CelValue::from_value(&parsed("{data: {path: 'tasks/a.md'}}")),
        );
        let input = parsed(
            "{path: {$expr: 'event.data.path'}, literal: 'event.data.path', list: [{$expr: '1 + 2'}, true], mixed: {$expr: '1 / 0', other: value}}",
        );
        let result = evaluate(&input, &activation).unwrap();
        assert_eq!(
            result,
            parsed(
                "{path: 'tasks/a.md', literal: 'event.data.path', list: [3, true], mixed: {$expr: '1 / 0', other: value}}"
            )
        );
        assert_eq!(
            input.get("path").unwrap().get("$expr").unwrap().as_str(),
            Some("event.data.path")
        );
    }

    #[test]
    fn failures_never_produce_partial_inputs() {
        let activation = Activation::new();
        for (source, code) in [
            (
                "{before: ok, after: {$expr: '1 / 0'}}",
                "expression_evaluation_error",
            ),
            ("{$expr: '1 +'}", "expression_compile_error"),
            ("{$expr: 42}", "expression_compile_error"),
            (
                "{$expr: '18446744073709551615u'}",
                "expression_evaluation_error",
            ),
        ] {
            assert_eq!(
                evaluate(&parsed(source), &activation).unwrap_err().code,
                code,
                "{source}"
            );
        }
    }

    #[test]
    fn traversal_has_a_depth_bound() {
        let activation = Activation::new();
        let mut input = Value::Null;
        for _ in 0..super::super::MAX_AST_DEPTH + 2 {
            input = Value::List(vec![input]);
        }
        assert!(
            evaluate(&input, &activation)
                .unwrap_err()
                .message
                .contains("limit")
        );
    }
}
