//! Primitive RuntimeValue port from mdbase-rs expression.rs (MIT, LICENSE.port).
//! Date intermediate values retain their typed payload and captured display.
//! File/link admission is deferred. Display-unavailable cells are not
//! expression values.

use std::collections::BTreeMap;

use super::{EvaluatedDate, EvaluatedDuration};
use crate::value::{Map, Value};

/// Typed intermediate values in the first evaluator port profile.
/// Numbers remain binary64, including arithmetic NaN/infinities. Ordinary
/// source errors are data here; admission/budget/cancellation failures are not.
#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub enum RuntimeValue {
    /// Missing and literal null have the legacy Bases Null value.
    Null,
    /// Boolean.
    Bool(bool),
    /// Binary64 number.
    Number(f64),
    /// Text, not implicitly a date.
    String(String),
    /// Typed validated date; display is precomputed under the request meter.
    Date(EvaluatedDate),
    /// Typed duration; qualified display is precomputed under the request meter.
    Duration(EvaluatedDuration),
    /// Ordered values.
    List(Vec<RuntimeValue>),
    /// Deterministically ordered properties.
    Object(BTreeMap<String, RuntimeValue>),
    /// An ordinary source error, never a resource/admission failure.
    Error(String),
}

impl RuntimeValue {
    /// Legacy Bases truthiness; empty lists/maps are truthy, source errors are not.
    pub fn is_truthy(&self) -> bool {
        match self {
            Self::Null | Self::Error(_) => false,
            Self::Bool(value) => *value,
            Self::Number(value) => *value != 0.0 && !value.is_nan(),
            Self::String(value) => !value.is_empty(),
            _ => true,
        }
    }

    /// Legacy Bases emptiness, distinct from truthiness and CEL's meanings.
    pub fn is_empty(&self) -> bool {
        match self {
            Self::Null => true,
            Self::String(value) => value.is_empty(),
            Self::Number(value) => value.is_nan(),
            Self::List(values) => values.is_empty(),
            Self::Object(values) => values.is_empty(),
            _ => false,
        }
    }

    /// The expression type name, not a JSON type or a renderer capability.
    pub fn type_name(&self) -> &'static str {
        match self {
            Self::Null => "Null",
            Self::Bool(_) => "Boolean",
            Self::Number(_) => "Number",
            Self::String(_) => "String",
            Self::Date(_) => "Date",
            Self::Duration(_) => "Duration",
            Self::List(_) => "List",
            Self::Object(_) => "Object",
            Self::Error(_) => "Error",
        }
    }

    /// Explicit public JSON collapse, after evaluation. Do not use it as an
    /// intermediate formula/cache/key representation. Nonfinite arithmetic
    /// numbers retain the legacy oracle's string encoding.
    pub fn to_plain(&self) -> Value {
        match self {
            Self::Null => Value::Null,
            Self::Bool(value) => Value::Bool(*value),
            Self::Number(value) => {
                Value::float(*value).unwrap_or_else(|| Value::string(number_string(*value)))
            }
            Self::String(value) => Value::string(value),
            Self::Date(value) => Value::string(value.display()),
            Self::Duration(value) => Value::string(value.display()),
            Self::List(values) => Value::List(values.iter().map(Self::to_plain).collect()),
            Self::Object(values) => Value::Map(
                values
                    .iter()
                    .map(|(k, v)| (k.clone(), v.to_plain()))
                    .collect(),
            ),
            Self::Error(message) => {
                Value::Map(Map::from_iter([("error".into(), Value::string(message))]))
            }
        }
    }

    pub(super) fn plain_string(&self) -> String {
        match self {
            Self::Null => String::new(),
            Self::Bool(value) => value.to_string(),
            Self::Number(value) => number_string(*value),
            Self::String(value) | Self::Error(value) => value.clone(),
            Self::Date(value) => value.display().to_owned(),
            Self::Duration(value) => value.display().to_owned(),
            Self::List(values) => values
                .iter()
                .map(Self::plain_string)
                .collect::<Vec<_>>()
                .join(","),
            Self::Object(_) => self.to_plain().to_json(),
        }
    }

    // Every child was bounded before a parent was built: at most 33 deep.
    pub(super) fn depth(&self) -> usize {
        1 + match self {
            Self::List(values) => values.iter().map(Self::depth).max().unwrap_or(0),
            Self::Object(values) => values.values().map(Self::depth).max().unwrap_or(0),
            _ => 0,
        }
    }
}

pub(super) fn number_string(value: f64) -> String {
    if value.is_nan() {
        "NaN".into()
    } else if value == f64::INFINITY {
        "Infinity".into()
    } else if value == f64::NEG_INFINITY {
        "-Infinity".into()
    } else {
        crate::value::format_float_es(value)
    }
}
