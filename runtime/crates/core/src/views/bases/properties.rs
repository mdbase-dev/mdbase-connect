//! Bounded property IDs for display/sort/group metadata, not arbitrary filter
//! expressions. Bare IDs select raw note keys; labels never become property IDs.
use super::{Error, ErrorKind, Expr, Expression, Member, Profile, Program};
use crate::value::{Map, Value};
use std::collections::BTreeMap;

/// UTF-8 bytes in one property ID before parsing or copying.
pub const MAX_PROPERTY_SELECTOR_BYTES: usize = 1024;
/// Ordered sort terms admitted by this component decoder.
pub const MAX_SORT_TERMS: usize = 32;
/// Display metadata entries before normalization.
pub const MAX_PROPERTY_METADATA: usize = 256;
/// Cumulative property ID bytes before metadata normalization.
pub const MAX_PROPERTY_METADATA_BYTES: usize = 65_536;

/// Total metadata key/value text bytes before any values are cloned.
pub const MAX_PROPERTY_METADATA_VALUE_BYTES: usize = 1 << 20;
const MAX_METADATA_NODES: usize = 16_384;

fn metadata_value(
    value: &Value,
    depth: usize,
    nodes: &mut usize,
    bytes: &mut usize,
) -> Result<(), Error> {
    if depth > super::MAX_VALUE_DEPTH {
        return Err(limit("property_metadata_depth"));
    }
    *nodes = nodes
        .checked_add(1)
        .ok_or_else(|| limit("property_metadata_nodes"))?;
    if *nodes > MAX_METADATA_NODES {
        return Err(limit("property_metadata_nodes"));
    }
    match value {
        Value::Text(s) => metadata_text(s.len(), bytes)?,
        Value::List(values) => {
            for value in values {
                metadata_value(value, depth + 1, nodes, bytes)?;
            }
        }
        Value::Map(map) => {
            for (name, value) in map.iter() {
                metadata_text(name.len(), bytes)?;
                metadata_value(value, depth + 1, nodes, bytes)?;
            }
        }
        _ => {}
    }
    Ok(())
}
fn metadata_text(n: usize, bytes: &mut usize) -> Result<(), Error> {
    *bytes = bytes
        .checked_add(n)
        .ok_or_else(|| limit("property_metadata_value_bytes"))?;
    if *bytes > MAX_PROPERTY_METADATA_VALUE_BYTES {
        Err(limit("property_metadata_value_bytes"))
    } else {
        Ok(())
    }
}
/// Canonical property identity. Namespace and exact key spelling are semantic;
/// no trimming, case folding, defaults, labels or dotted-path guesses.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum PropertySelector {
    /// Exact raw frontmatter key.
    Note(String),
    /// Exact formula-library definition key.
    Formula(String),
    /// Captured file member; later capability admission remains mandatory.
    File(String),
}
fn invalid(detail: &'static str) -> Error {
    Error::new(ErrorKind::InvalidSource(detail), 0)
}
fn unsupported(detail: &'static str) -> Error {
    Error::new(ErrorKind::UnsupportedConstruct(detail), 0)
}
fn limit(detail: &'static str) -> Error {
    Error::new(ErrorKind::BudgetExceeded(detail), 0)
}
fn key(key: &str) -> Result<(), Error> {
    if key.is_empty() {
        return Err(invalid("empty_property_selector"));
    }
    if key.len() > MAX_PROPERTY_SELECTOR_BYTES {
        return Err(limit("property_selector_bytes"));
    }
    if key.chars().any(char::is_control) {
        return Err(unsupported("property_selector_control"));
    }
    Ok(())
}
impl PropertySelector {
    /// Normalize one property reference, independently of expression bindings.
    /// Static named/bracket namespace references and bare literal IDs qualify;
    /// dynamic/member-chain references visibly refuse rather than selecting the
    /// wrong raw property. Bare punctuation names use literal-key lookup.
    pub fn parse(source: &str) -> Result<Self, Error> {
        key(source)?;
        for namespace in ["note", "formula", "file"] {
            if let Some(name) = source.strip_prefix(&format!("{namespace}.")) {
                key(name)?;
                if name.contains('.') || name.contains('[') || name.contains(']') {
                    return Err(unsupported("nested_property_selector"));
                }
                return Ok(Self::in_namespace(namespace, name.to_owned()));
            }
            if source.starts_with(&format!("{namespace}[")) {
                let mut chars = source.chars();
                while let Some(ch) = chars.next() {
                    if ch == '\\'
                        && !chars.next().is_some_and(|next| {
                            matches!(next, '\\' | '\'' | '"' | 'n' | 'r' | 't' | 'b' | 'f')
                        })
                    {
                        return Err(unsupported("property_selector_escape"));
                    }
                }
                super::syntax::qualify_syntax(source)?;
                let expression = Expression::parse(source)?;
                let Expr::Member(root, Member::Computed(value)) = expression.ast() else {
                    return Err(unsupported("property_selector_expression"));
                };
                if !matches!(root.as_ref(),Expr::Identifier(name) if name==namespace) {
                    return Err(unsupported("property_selector_expression"));
                }
                let Expr::Literal(Value::Text(name)) = value.as_ref() else {
                    return Err(unsupported("dynamic_property_selector"));
                };
                key(name)?;
                return Ok(Self::in_namespace(namespace, name.clone()));
            }
        }
        Ok(Self::Note(source.to_owned()))
    }
    fn in_namespace(namespace: &str, key: String) -> Self {
        match namespace {
            "formula" => Self::Formula(key),
            "file" => Self::File(key),
            _ => Self::Note(key),
        }
    }
    /// Exact raw/formula/file member key, never a display label.
    pub fn key(&self) -> &str {
        match self {
            Self::Note(s) | Self::Formula(s) | Self::File(s) => s,
        }
    }
    /// Safe constant-member expression, with no interpolation of executable
    /// property names. The existing program still admits/refuses capabilities.
    pub fn compile(
        &self,
        formulas: &BTreeMap<String, String>,
        profile: Profile,
    ) -> Result<Program, Error> {
        key(self.key())?;
        let namespace = match self {
            Self::Note(_) => "note",
            Self::Formula(_) => "formula",
            Self::File(_) => "file",
        };
        let mut source = format!("{namespace}[\"");
        for ch in self.key().chars() {
            if ch == '\\' || ch == '"' {
                source.push('\\');
            }
            source.push(ch);
        }
        source.push_str("\"]");
        Program::compile_with_profile(&source, formulas, profile)
    }
}
/// Direction is independent of display column order. No comparator is supplied
/// by this syntax component; typed ordering is qualified separately.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SortDirection {
    /// Ascending semantic order.
    Asc,
    /// Descending semantic order.
    Desc,
}
/// One ordered sort term. `column` and legacy `property` share one normalization.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SortTerm {
    /// Canonical property identity.
    pub property: PropertySelector,
    /// Requested direction, never inferred from display column order.
    pub direction: SortDirection,
}
impl SortTerm {
    /// Decode one strict sort term, resolving only unambiguous key aliases.
    pub fn from_value(value: &Value) -> Result<Self, Error> {
        let object = value.as_map().ok_or_else(|| invalid("sort_term_shape"))?;
        if object
            .iter()
            .any(|(k, _)| !matches!(k, "column" | "property" | "direction"))
        {
            return Err(unsupported("sort_term_option"));
        }
        let selector = |field| {
            object
                .get(field)
                .map(|v| {
                    v.as_str()
                        .ok_or_else(|| invalid("sort_property_type"))
                        .and_then(PropertySelector::parse)
                })
                .transpose()
        };
        let column = selector("column")?;
        let property = selector("property")?;
        let property = match (column, property) {
            (Some(a), Some(b)) if a != b => return Err(invalid("ambiguous_sort_property")),
            (Some(a), _) | (_, Some(a)) => a,
            _ => return Err(invalid("missing_sort_property")),
        };
        let direction = match object.get("direction") {
            None => SortDirection::Asc,
            Some(Value::Text(s)) if s.eq_ignore_ascii_case("ASC") => SortDirection::Asc,
            Some(Value::Text(s)) if s.eq_ignore_ascii_case("DESC") => SortDirection::Desc,
            _ => return Err(invalid("sort_direction")),
        };
        Ok(Self {
            property,
            direction,
        })
    }
}
/// Bounded ordered terms; do not sort this list or replace it with a map.
pub fn decode_sort(value: &Value) -> Result<Vec<SortTerm>, Error> {
    let items = value.as_list().ok_or_else(|| invalid("sort_shape"))?;
    if items.len() > MAX_SORT_TERMS {
        return Err(limit("sort_terms"));
    }
    items.iter().map(SortTerm::from_value).collect()
}
/// Normalize display-metadata keys under the same property identity. Equal
/// aliases coalesce; conflicting aliases refuse rather than silently overwriting.
/// Values remain metadata only and never populate candidate-row properties.
pub fn normalize_property_metadata(
    properties: &Map,
) -> Result<BTreeMap<PropertySelector, Value>, Error> {
    if properties.len() > MAX_PROPERTY_METADATA {
        return Err(limit("property_metadata_count"));
    }
    let mut bytes = 0usize;
    for (name, _) in properties.iter() {
        bytes = bytes
            .checked_add(name.len())
            .ok_or_else(|| limit("property_metadata_bytes"))?;
        if bytes > MAX_PROPERTY_METADATA_BYTES {
            return Err(limit("property_metadata_bytes"));
        }
    }
    let mut nodes = 0;
    let mut value_bytes = bytes;
    for (_, value) in properties.iter() {
        metadata_value(value, 1, &mut nodes, &mut value_bytes)?;
    }
    let mut result = BTreeMap::new();
    for (name, value) in properties.iter() {
        let selector = PropertySelector::parse(name)?;
        if let Some(prior) = result.get(&selector) {
            if prior != value {
                return Err(invalid("ambiguous_property_metadata"));
            }
        } else {
            result.insert(selector, value.clone());
        }
    }
    Ok(result)
}
#[cfg(test)]
mod tests;
