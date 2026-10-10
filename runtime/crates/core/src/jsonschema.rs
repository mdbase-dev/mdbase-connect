//! The JSON Schema 2020-12 profile (spec 06) used to validate persisted
//! frontmatter.
//!
//! [`compile`] turns a schema document plus an entry pointer into a
//! [`CompiledSchema`]; [`CompiledSchema::validate`] checks one instance and
//! returns [`SchemaIssue`]s with spec codes (`schema_<snake_keyword>`, and
//! `format_invalid` for the asserted formats).
//!
//! **Profile.**
//! - Keywords: `type`, `enum`, `const`, the numeric, string, array and object
//!   constraints, `allOf`/`anyOf`/`oneOf`/`not`, `if`/`then`/`else`,
//!   `prefixItems`/`items`, `properties`/`patternProperties`/
//!   `additionalProperties`, `$defs`/`definitions` and local `$ref` (sibling
//!   keywords apply too, as in 2020-12). Annotations and unknown keywords are
//!   ignored.
//! - `pattern` and `patternProperties` use the mdbase regex profile: the
//!   `regex-lite` engine, unanchored. `\p{..}`, `\P{..}`, backreferences and
//!   look-around make the schema invalid (`invalid_pattern`).
//! - `format` asserts `date`, `time` and `date-time` (RFC 3339; offsets are
//!   required). Other formats are annotations.
//! - Only fragment references (`#`, `#/...`) resolve. HTTP(S) references are
//!   `schema_ref_forbidden`; anything else is `schema_ref_unresolved`. Cycles
//!   that apply a schema to the same instance again (through `$ref` and the
//!   in-place applicators) are `schema_ref_cycle`.
//!
//! **Determinism.** Integers and floats compare exactly
//! ([`Number::cmp_numeric`]). `multipleOf` is decided on the shortest decimal
//! form of both numbers, with integer arithmetic. Issue order is fixed:
//! keywords evaluate in a fixed order and object members in instance order,
//! and [`CompiledSchema::validate`] then groups issues by top-level field in
//! the order the entry schema declares its `properties`. Root-level issues
//! come first; undeclared fields follow the declared ones, those present in
//! the instance in instance order, then missing ones (a `required` name the
//! schema does not declare). The sort is stable. That puts a
//! `then: {required: [x]}` failure next to the other issues about `x`.

use std::collections::{BTreeMap, BTreeSet};

use crate::value::{Map, Number, Value};

/// A problem compiling a schema: the type file is invalid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchemaLoadError {
    /// `invalid_schema`, `invalid_pattern`, `schema_ref_unresolved`,
    /// `schema_ref_forbidden` or `schema_ref_cycle`.
    pub code: &'static str,
    /// What is wrong.
    pub message: String,
    /// JSON Pointer into the schema document.
    pub location: String,
}

/// One validation failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchemaIssue {
    /// `schema_<snake_keyword>` (`schema_required`, `schema_min_length`, ...),
    /// or `format_invalid`.
    pub code: String,
    /// The JSON Schema keyword (`required`, `minLength`, ...).
    pub keyword: &'static str,
    /// RFC 6901 pointer into the instance; `""` is the root. For `required`,
    /// the missing property (`/title`).
    pub instance_path: String,
    /// Pointer to the failing keyword in the schema document.
    pub schema_path: String,
    /// Human-readable message (not stable).
    pub message: String,
}

/// A compiled schema, ready to validate instances.
#[derive(Debug, Clone)]
pub struct CompiledSchema {
    nodes: Vec<Node>,
    entry: u32,
}

#[derive(Debug, Clone)]
struct Node {
    /// Pointer of this schema in the document.
    location: String,
    kind: NodeKind,
}

#[derive(Debug, Clone)]
enum NodeKind {
    Bool(bool),
    Schema(Box<Keywords>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum JsonType {
    Null,
    Boolean,
    Object,
    Array,
    Number,
    Integer,
    String,
}

impl JsonType {
    fn parse(s: &str) -> Option<JsonType> {
        Some(match s {
            "null" => JsonType::Null,
            "boolean" => JsonType::Boolean,
            "object" => JsonType::Object,
            "array" => JsonType::Array,
            "number" => JsonType::Number,
            "integer" => JsonType::Integer,
            "string" => JsonType::String,
            _ => return None,
        })
    }

    fn name(self) -> &'static str {
        match self {
            JsonType::Null => "null",
            JsonType::Boolean => "boolean",
            JsonType::Object => "object",
            JsonType::Array => "array",
            JsonType::Number => "number",
            JsonType::Integer => "integer",
            JsonType::String => "string",
        }
    }

    fn matches(self, v: &Value) -> bool {
        match (self, v) {
            (JsonType::Null, Value::Null)
            | (JsonType::Boolean, Value::Bool(_))
            | (JsonType::Object, Value::Map(_))
            | (JsonType::Array, Value::List(_))
            | (JsonType::String, Value::Text(_))
            | (JsonType::Number, Value::Int(_) | Value::Float(_))
            | (JsonType::Integer, Value::Int(_)) => true,
            (JsonType::Integer, Value::Float(f)) => f.fract() == 0.0,
            _ => false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Format {
    Date,
    Time,
    DateTime,
}

#[derive(Debug, Clone)]
struct Pattern {
    source: String,
    regex: crate::regex::Pattern,
}

#[derive(Debug, Clone, Default)]
struct Keywords {
    reference: Option<u32>,
    types: Option<Vec<JsonType>>,
    enumeration: Option<Vec<Value>>,
    constant: Option<Value>,
    minimum: Option<Number>,
    maximum: Option<Number>,
    exclusive_minimum: Option<Number>,
    exclusive_maximum: Option<Number>,
    multiple_of: Option<Number>,
    min_length: Option<u64>,
    max_length: Option<u64>,
    pattern: Option<Pattern>,
    format: Option<Format>,
    min_items: Option<u64>,
    max_items: Option<u64>,
    unique_items: bool,
    prefix_items: Vec<u32>,
    items: Option<u32>,
    required: Vec<String>,
    min_properties: Option<u64>,
    max_properties: Option<u64>,
    properties: Vec<(String, u32)>,
    pattern_properties: Vec<(Pattern, u32)>,
    additional_properties: Option<u32>,
    all_of: Vec<u32>,
    any_of: Vec<u32>,
    one_of: Vec<u32>,
    not: Option<u32>,
    if_: Option<u32>,
    then: Option<u32>,
    else_: Option<u32>,
}

/// Compile the schema at JSON Pointer `entry` (`""` for the root) of
/// `document`. Local `$ref`s resolve against `document`.
pub fn compile(document: &Value, entry: &str) -> Result<CompiledSchema, Vec<SchemaLoadError>> {
    let mut c = Compiler {
        document,
        nodes: Vec::new(),
        by_location: BTreeMap::new(),
        errors: Vec::new(),
    };
    let entry = match resolve_pointer(document, entry) {
        Some(_) => c.node(entry),
        None => {
            return Err(vec![SchemaLoadError {
                code: "schema_ref_unresolved",
                message: format!("the schema entry `{entry}` does not exist"),
                location: entry.to_owned(),
            }]);
        }
    };
    if c.errors.is_empty() {
        c.check_cycles();
    }
    if c.errors.is_empty() {
        Ok(CompiledSchema {
            nodes: c.nodes,
            entry,
        })
    } else {
        Err(c.errors)
    }
}

struct Compiler<'a> {
    document: &'a Value,
    nodes: Vec<Node>,
    by_location: BTreeMap<String, u32>,
    errors: Vec<SchemaLoadError>,
}

fn idx(i: u32) -> usize {
    // u32 always fits in usize on the 32- and 64-bit targets we build for.
    usize::try_from(i).unwrap_or(usize::MAX)
}

impl Compiler<'_> {
    fn err(&mut self, code: &'static str, location: &str, message: impl Into<String>) {
        self.errors.push(SchemaLoadError {
            code,
            message: message.into(),
            location: location.to_owned(),
        });
    }

    /// The node for the schema at `location` (compiled once).
    fn node(&mut self, location: &str) -> u32 {
        if let Some(&i) = self.by_location.get(location) {
            return i;
        }
        let i = u32::try_from(self.nodes.len()).unwrap_or(u32::MAX);
        self.nodes.push(Node {
            location: location.to_owned(),
            kind: NodeKind::Bool(true),
        });
        self.by_location.insert(location.to_owned(), i);
        let kind = match resolve_pointer(self.document, location) {
            Some(Value::Bool(b)) => NodeKind::Bool(*b),
            Some(Value::Map(m)) => {
                let m = m.clone();
                NodeKind::Schema(Box::new(self.keywords(&m, location)))
            }
            Some(_) => {
                self.err(
                    "invalid_schema",
                    location,
                    "a schema is an object or a boolean",
                );
                NodeKind::Bool(true)
            }
            None => {
                self.err(
                    "schema_ref_unresolved",
                    location,
                    "no schema at this location",
                );
                NodeKind::Bool(true)
            }
        };
        self.nodes[idx(i)].kind = kind;
        i
    }

    fn sub(&mut self, location: &str, key: &str) -> u32 {
        self.node(&format!("{location}/{}", escape(key)))
    }

    fn sub_list(&mut self, m: &Map, location: &str, key: &str) -> Vec<u32> {
        match m.get(key) {
            None => Vec::new(),
            Some(Value::List(items)) if !items.is_empty() => (0..items.len())
                .map(|i| self.node(&format!("{location}/{key}/{i}")))
                .collect(),
            Some(_) => {
                self.err(
                    "invalid_schema",
                    &format!("{location}/{key}"),
                    format!("`{key}` is a non-empty list of schemas"),
                );
                Vec::new()
            }
        }
    }

    fn number(&mut self, m: &Map, location: &str, key: &str) -> Option<Number> {
        let v = m.get(key)?;
        let n = v.as_number();
        if n.is_none() {
            self.err(
                "invalid_schema",
                &format!("{location}/{key}"),
                format!("`{key}` is a number"),
            );
        }
        n
    }

    fn count(&mut self, m: &Map, location: &str, key: &str) -> Option<u64> {
        let v = m.get(key)?;
        let n = v
            .as_number()
            .and_then(Number::as_i64)
            .and_then(|i| u64::try_from(i).ok());
        if n.is_none() {
            self.err(
                "invalid_schema",
                &format!("{location}/{key}"),
                format!("`{key}` is a non-negative integer"),
            );
        }
        n
    }

    fn pattern(&mut self, source: &str, location: &str) -> Option<Pattern> {
        match compile_pattern(source) {
            Ok(regex) => Some(Pattern {
                source: source.to_owned(),
                regex,
            }),
            Err(message) => {
                self.err("invalid_pattern", location, message);
                None
            }
        }
    }

    fn keywords(&mut self, m: &Map, loc: &str) -> Keywords {
        let mut k = Keywords::default();
        if let Some(r) = m.get("$ref") {
            match r.as_str() {
                Some(r) => k.reference = self.reference(r, &format!("{loc}/$ref")),
                None => self.err(
                    "invalid_schema",
                    &format!("{loc}/$ref"),
                    "`$ref` is a string",
                ),
            }
        }
        // Compile definitions eagerly so their errors are reported even when
        // nothing references them.
        for defs in ["$defs", "definitions"] {
            match m.get(defs) {
                None => {}
                Some(Value::Map(d)) => {
                    let names: Vec<String> = d.keys().map(str::to_owned).collect();
                    for n in names {
                        self.node(&format!("{loc}/{defs}/{}", escape(&n)));
                    }
                }
                Some(_) => self.err(
                    "invalid_schema",
                    &format!("{loc}/{defs}"),
                    "definitions are an object",
                ),
            }
        }
        match m.get("type") {
            None => {}
            Some(Value::Text(t)) => match JsonType::parse(t) {
                Some(t) => k.types = Some(vec![t]),
                None => self.err(
                    "invalid_schema",
                    &format!("{loc}/type"),
                    format!("unknown type `{t}`"),
                ),
            },
            Some(Value::List(ts)) => {
                let parsed: Option<Vec<JsonType>> = ts
                    .iter()
                    .map(|t| t.as_str().and_then(JsonType::parse))
                    .collect();
                match parsed {
                    Some(p) => k.types = Some(p),
                    None => self.err(
                        "invalid_schema",
                        &format!("{loc}/type"),
                        "`type` lists type names",
                    ),
                }
            }
            Some(_) => self.err(
                "invalid_schema",
                &format!("{loc}/type"),
                "`type` is a name or a list",
            ),
        }
        match m.get("enum") {
            None => {}
            Some(Value::List(vs)) => k.enumeration = Some(vs.clone()),
            Some(_) => self.err("invalid_schema", &format!("{loc}/enum"), "`enum` is a list"),
        }
        k.constant = m.get("const").cloned();
        k.minimum = self.number(m, loc, "minimum");
        k.maximum = self.number(m, loc, "maximum");
        k.exclusive_minimum = self.number(m, loc, "exclusiveMinimum");
        k.exclusive_maximum = self.number(m, loc, "exclusiveMaximum");
        k.multiple_of = self.number(m, loc, "multipleOf");
        if let Some(n) = k.multiple_of
            && n.cmp_numeric(Number::Int(0)) != std::cmp::Ordering::Greater
        {
            self.err(
                "invalid_schema",
                &format!("{loc}/multipleOf"),
                "`multipleOf` is greater than 0",
            );
            k.multiple_of = None;
        }
        k.min_length = self.count(m, loc, "minLength");
        k.max_length = self.count(m, loc, "maxLength");
        match m.get("pattern") {
            None => {}
            Some(Value::Text(p)) => k.pattern = self.pattern(p, &format!("{loc}/pattern")),
            Some(_) => self.err(
                "invalid_schema",
                &format!("{loc}/pattern"),
                "`pattern` is a string",
            ),
        }
        k.format = match m.get("format").and_then(Value::as_str) {
            Some("date") => Some(Format::Date),
            Some("time") => Some(Format::Time),
            Some("date-time") => Some(Format::DateTime),
            _ => None,
        };
        k.min_items = self.count(m, loc, "minItems");
        k.max_items = self.count(m, loc, "maxItems");
        match m.get("uniqueItems") {
            None => {}
            Some(Value::Bool(b)) => k.unique_items = *b,
            Some(_) => self.err(
                "invalid_schema",
                &format!("{loc}/uniqueItems"),
                "`uniqueItems` is a boolean",
            ),
        }
        k.prefix_items = self.sub_list(m, loc, "prefixItems");
        if m.contains_key("items") {
            k.items = Some(self.sub(loc, "items"));
        }
        match m.get("required") {
            None => {}
            Some(Value::List(rs)) => {
                let names: Option<Vec<String>> =
                    rs.iter().map(|r| r.as_str().map(str::to_owned)).collect();
                match names {
                    Some(n) => k.required = n,
                    None => self.err(
                        "invalid_schema",
                        &format!("{loc}/required"),
                        "`required` lists strings",
                    ),
                }
            }
            Some(_) => self.err(
                "invalid_schema",
                &format!("{loc}/required"),
                "`required` is a list",
            ),
        }
        k.min_properties = self.count(m, loc, "minProperties");
        k.max_properties = self.count(m, loc, "maxProperties");
        match m.get("properties") {
            None => {}
            Some(Value::Map(ps)) => {
                let names: Vec<String> = ps.keys().map(str::to_owned).collect();
                for n in names {
                    let i = self.node(&format!("{loc}/properties/{}", escape(&n)));
                    k.properties.push((n, i));
                }
            }
            Some(_) => self.err(
                "invalid_schema",
                &format!("{loc}/properties"),
                "`properties` is an object",
            ),
        }
        match m.get("patternProperties") {
            None => {}
            Some(Value::Map(ps)) => {
                let names: Vec<String> = ps.keys().map(str::to_owned).collect();
                for n in names {
                    let at = format!("{loc}/patternProperties/{}", escape(&n));
                    let i = self.node(&at);
                    if let Some(p) = self.pattern(&n, &at) {
                        k.pattern_properties.push((p, i));
                    }
                }
            }
            Some(_) => self.err(
                "invalid_schema",
                &format!("{loc}/patternProperties"),
                "`patternProperties` is an object",
            ),
        }
        if m.contains_key("additionalProperties") {
            k.additional_properties = Some(self.sub(loc, "additionalProperties"));
        }
        k.all_of = self.sub_list(m, loc, "allOf");
        k.any_of = self.sub_list(m, loc, "anyOf");
        k.one_of = self.sub_list(m, loc, "oneOf");
        if m.contains_key("not") {
            k.not = Some(self.sub(loc, "not"));
        }
        if m.contains_key("if") {
            k.if_ = Some(self.sub(loc, "if"));
            if m.contains_key("then") {
                k.then = Some(self.sub(loc, "then"));
            }
            if m.contains_key("else") {
                k.else_ = Some(self.sub(loc, "else"));
            }
        }
        k
    }

    fn reference(&mut self, r: &str, at: &str) -> Option<u32> {
        let lower = r.to_ascii_lowercase();
        if lower.starts_with("http://") || lower.starts_with("https://") {
            self.err(
                "schema_ref_forbidden",
                at,
                format!("network reference `{r}` is not allowed"),
            );
            return None;
        }
        let Some(fragment) = r.strip_prefix('#') else {
            self.err(
                "schema_ref_unresolved",
                at,
                format!("only fragment references resolve here: `{r}`"),
            );
            return None;
        };
        let Some(pointer) = percent_decode(fragment) else {
            self.err(
                "schema_ref_unresolved",
                at,
                format!("malformed reference `{r}`"),
            );
            return None;
        };
        if !pointer.is_empty() && !pointer.starts_with('/') {
            self.err(
                "schema_ref_unresolved",
                at,
                format!("anchor references are not supported: `{r}`"),
            );
            return None;
        }
        if resolve_pointer(self.document, &pointer).is_none() {
            self.err(
                "schema_ref_unresolved",
                at,
                format!("`{r}` does not resolve"),
            );
            return None;
        }
        Some(self.node(&pointer))
    }

    /// Reject cycles among in-place applicators: following them never
    /// reaches a different instance, so validation would not terminate.
    fn check_cycles(&mut self) {
        let n = self.nodes.len();
        // 0 = unvisited, 1 = on stack, 2 = done.
        let mut state = vec![0u8; n];
        for start in 0..n {
            if state[start] != 0 {
                continue;
            }
            let mut stack: Vec<(usize, Vec<u32>)> = vec![(start, self.in_place(start))];
            state[start] = 1;
            while let Some((node, edges)) = stack.last_mut() {
                let node = *node;
                match edges.pop() {
                    Some(next) => {
                        let next = idx(next);
                        match state[next] {
                            0 => {
                                state[next] = 1;
                                let e = self.in_place(next);
                                stack.push((next, e));
                            }
                            1 => {
                                let loc = self.nodes[node].location.clone();
                                self.err(
                                    "schema_ref_cycle",
                                    &loc,
                                    "this reference cycle never reaches a different value",
                                );
                                return;
                            }
                            _ => {}
                        }
                    }
                    None => {
                        state[node] = 2;
                        stack.pop();
                    }
                }
            }
        }
    }

    fn in_place(&self, node: usize) -> Vec<u32> {
        match &self.nodes[node].kind {
            NodeKind::Bool(_) => Vec::new(),
            NodeKind::Schema(k) => {
                let mut e: Vec<u32> = k.reference.into_iter().collect();
                e.extend(&k.all_of);
                e.extend(&k.any_of);
                e.extend(&k.one_of);
                e.extend(k.not);
                e.extend(k.if_);
                e.extend(k.then);
                e.extend(k.else_);
                e
            }
        }
    }
}

/// Compile a pattern under the mdbase regex profile (`crate::regex`).
fn compile_pattern(source: &str) -> Result<crate::regex::Pattern, String> {
    crate::regex::Pattern::new(source).map_err(|e| format!("invalid pattern `{source}`: {e:?}"))
}

/// Decode `%XX` escapes in a URI fragment.
fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Escape a key as an RFC 6901 token.
fn escape(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}

/// Resolve an RFC 6901 pointer (`""` is the whole document).
fn resolve_pointer<'v>(doc: &'v Value, pointer: &str) -> Option<&'v Value> {
    if pointer.is_empty() {
        return Some(doc);
    }
    let rest = pointer.strip_prefix('/')?;
    let mut cur = doc;
    for raw in rest.split('/') {
        let token = raw.replace("~1", "/").replace("~0", "~");
        cur = match cur {
            Value::Map(m) => m.get(&token)?,
            Value::List(l) => {
                if token.len() > 1 && token.starts_with('0') {
                    return None;
                }
                l.get(token.parse::<usize>().ok()?)?
            }
            _ => return None,
        };
    }
    Some(cur)
}

impl CompiledSchema {
    /// Validate `instance`. Empty means valid. See the module docs for the
    /// issue order.
    pub fn validate(&self, instance: &Value) -> Vec<SchemaIssue> {
        let mut out = Vec::new();
        self.check(self.entry, instance, "", "", &mut out);
        // Group by top-level field: root issues, declared properties in
        // declaration order, then other fields in instance order.
        let declared = self.declared_order(self.entry);
        let instance_keys: Vec<&str> = instance
            .as_map()
            .map(|m| m.keys().collect())
            .unwrap_or_default();
        let rank = |issue: &SchemaIssue| -> (u8, usize) {
            let Some(rest) = issue.instance_path.strip_prefix('/') else {
                return (0, 0);
            };
            let first = rest
                .split('/')
                .next()
                .unwrap_or("")
                .replace("~1", "/")
                .replace("~0", "~");
            if let Some(i) = declared.iter().position(|d| *d == first) {
                return (1, i);
            }
            match instance_keys.iter().position(|k| *k == first) {
                Some(i) => (2, i),
                None => (3, 0),
            }
        };
        out.sort_by_key(|i| rank(i));
        out
    }

    /// Top-level property names, in declaration order, through `$ref` and
    /// `allOf`.
    fn declared_order(&self, node: u32) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        let mut seen = BTreeSet::new();
        self.collect_properties(node, &mut out, &mut seen);
        out
    }

    fn collect_properties(&self, node: u32, out: &mut Vec<String>, seen: &mut BTreeSet<u32>) {
        if !seen.insert(node) {
            return;
        }
        let NodeKind::Schema(k) = &self.nodes[idx(node)].kind else {
            return;
        };
        for (name, _) in &k.properties {
            if !out.contains(name) {
                out.push(name.clone());
            }
        }
        if let Some(r) = k.reference {
            self.collect_properties(r, out, seen);
        }
        for &a in &k.all_of {
            self.collect_properties(a, out, seen);
        }
    }

    /// Every top-level property name the entry schema declares (through
    /// `$ref` and `allOf`), sorted.
    pub fn top_level_properties(&self) -> Vec<String> {
        let mut v = self.declared_order(self.entry);
        v.sort();
        v
    }

    /// Top-level properties declared with `uniqueItems: true`, sorted.
    pub fn top_level_unique_items(&self) -> Vec<String> {
        let mut found = BTreeSet::new();
        let mut seen = BTreeSet::new();
        self.collect_unique(self.entry, &mut found, &mut seen);
        found.into_iter().collect()
    }

    fn collect_unique(&self, node: u32, found: &mut BTreeSet<String>, seen: &mut BTreeSet<u32>) {
        if !seen.insert(node) {
            return;
        }
        let NodeKind::Schema(k) = &self.nodes[idx(node)].kind else {
            return;
        };
        for (name, p) in &k.properties {
            if self.unique_items(*p, &mut BTreeSet::new()) {
                found.insert(name.clone());
            }
        }
        if let Some(r) = k.reference {
            self.collect_unique(r, found, seen);
        }
        for &a in &k.all_of {
            self.collect_unique(a, found, seen);
        }
    }

    fn unique_items(&self, node: u32, seen: &mut BTreeSet<u32>) -> bool {
        if !seen.insert(node) {
            return false;
        }
        match &self.nodes[idx(node)].kind {
            NodeKind::Bool(_) => false,
            NodeKind::Schema(k) => {
                k.unique_items
                    || k.reference.is_some_and(|r| self.unique_items(r, seen))
                    || k.all_of.iter().any(|&a| self.unique_items(a, seen))
            }
        }
    }

    fn is_valid(&self, node: u32, v: &Value) -> bool {
        let mut out = Vec::new();
        self.check(node, v, "", "", &mut out);
        out.is_empty()
    }

    /// Validate `v` (at `path`) against `node`, reached through `via`.
    fn check(
        &self,
        node: u32,
        v: &Value,
        path: &str,
        via: &'static str,
        out: &mut Vec<SchemaIssue>,
    ) {
        let n = &self.nodes[idx(node)];
        let k = match &n.kind {
            NodeKind::Bool(true) => return,
            NodeKind::Bool(false) => {
                let keyword = if via.is_empty() { "false" } else { via };
                out.push(issue(
                    keyword,
                    path,
                    &n.location,
                    "no value is allowed here",
                ));
                return;
            }
            NodeKind::Schema(k) => k,
        };
        let loc = n.location.as_str();
        let at = |kw: &str| format!("{loc}/{kw}");
        if let Some(r) = k.reference {
            self.check(r, v, path, "$ref", out);
        }
        if let Some(types) = &k.types
            && !types.iter().any(|t| t.matches(v))
        {
            let names: Vec<&str> = types.iter().map(|t| t.name()).collect();
            out.push(issue(
                "type",
                path,
                &at("type"),
                format!("expected {}, found {}", names.join(" or "), v.type_name()),
            ));
        }
        if let Some(e) = &k.enumeration
            && !e.iter().any(|x| x == v)
        {
            out.push(issue(
                "enum",
                path,
                &at("enum"),
                "the value is not one of the allowed values",
            ));
        }
        if let Some(c) = &k.constant
            && c != v
        {
            out.push(issue(
                "const",
                path,
                &at("const"),
                "the value differs from the required constant",
            ));
        }
        if let Some(x) = v.as_number() {
            self.check_number(k, x, path, loc, out);
        }
        if let Value::Text(s) = v {
            let len = u64::try_from(s.chars().count()).unwrap_or(u64::MAX);
            if let Some(min) = k.min_length
                && len < min
            {
                out.push(issue(
                    "minLength",
                    path,
                    &at("minLength"),
                    format!("shorter than {min} characters"),
                ));
            }
            if let Some(max) = k.max_length
                && len > max
            {
                out.push(issue(
                    "maxLength",
                    path,
                    &at("maxLength"),
                    format!("longer than {max} characters"),
                ));
            }
            if let Some(p) = &k.pattern
                && !p.regex.is_match(s)
            {
                out.push(issue(
                    "pattern",
                    path,
                    &at("pattern"),
                    format!("does not match `{}`", p.source),
                ));
            }
            if let Some(f) = k.format {
                let ok = match f {
                    Format::Date => is_date(s),
                    Format::Time => is_time(s),
                    Format::DateTime => is_date_time(s),
                };
                if !ok {
                    let name = match f {
                        Format::Date => "date",
                        Format::Time => "time",
                        Format::DateTime => "date-time",
                    };
                    out.push(SchemaIssue {
                        code: "format_invalid".into(),
                        keyword: "format",
                        instance_path: path.to_owned(),
                        schema_path: at("format"),
                        message: format!("not a valid RFC 3339 {name}"),
                    });
                }
            }
        }
        if let Value::List(items) = v {
            self.check_array(k, items, path, loc, out);
        }
        if let Value::Map(m) = v {
            self.check_object(k, m, path, loc, out);
        }
        for &a in &k.all_of {
            self.check(a, v, path, "allOf", out);
        }
        if !k.any_of.is_empty() && !k.any_of.iter().any(|&a| self.is_valid(a, v)) {
            out.push(issue(
                "anyOf",
                path,
                &at("anyOf"),
                "the value matches none of the alternatives",
            ));
        }
        if !k.one_of.is_empty() {
            let matched = k.one_of.iter().filter(|&&a| self.is_valid(a, v)).count();
            if matched != 1 {
                out.push(issue(
                    "oneOf",
                    path,
                    &at("oneOf"),
                    format!("the value matches {matched} alternatives, not exactly one"),
                ));
            }
        }
        if let Some(nt) = k.not
            && self.is_valid(nt, v)
        {
            out.push(issue(
                "not",
                path,
                &at("not"),
                "the value matches a forbidden schema",
            ));
        }
        if let Some(c) = k.if_ {
            if self.is_valid(c, v) {
                if let Some(t) = k.then {
                    self.check(t, v, path, "then", out);
                }
            } else if let Some(e) = k.else_ {
                self.check(e, v, path, "else", out);
            }
        }
    }

    fn check_number(
        &self,
        k: &Keywords,
        x: Number,
        path: &str,
        loc: &str,
        out: &mut Vec<SchemaIssue>,
    ) {
        use std::cmp::Ordering::{Greater, Less};
        let at = |kw: &str| format!("{loc}/{kw}");
        if let Some(m) = k.minimum
            && x.cmp_numeric(m) == Less
        {
            out.push(issue(
                "minimum",
                path,
                &at("minimum"),
                format!("less than {}", m.to_json()),
            ));
        }
        if let Some(m) = k.maximum
            && x.cmp_numeric(m) == Greater
        {
            out.push(issue(
                "maximum",
                path,
                &at("maximum"),
                format!("greater than {}", m.to_json()),
            ));
        }
        if let Some(m) = k.exclusive_minimum
            && x.cmp_numeric(m) != Greater
        {
            out.push(issue(
                "exclusiveMinimum",
                path,
                &at("exclusiveMinimum"),
                format!("not greater than {}", m.to_json()),
            ));
        }
        if let Some(m) = k.exclusive_maximum
            && x.cmp_numeric(m) != Less
        {
            out.push(issue(
                "exclusiveMaximum",
                path,
                &at("exclusiveMaximum"),
                format!("not less than {}", m.to_json()),
            ));
        }
        if let Some(m) = k.multiple_of
            && !is_multiple(x, m)
        {
            out.push(issue(
                "multipleOf",
                path,
                &at("multipleOf"),
                format!("not a multiple of {}", m.to_json()),
            ));
        }
    }

    fn check_array(
        &self,
        k: &Keywords,
        items: &[Value],
        path: &str,
        loc: &str,
        out: &mut Vec<SchemaIssue>,
    ) {
        let at = |kw: &str| format!("{loc}/{kw}");
        let len = u64::try_from(items.len()).unwrap_or(u64::MAX);
        if let Some(min) = k.min_items
            && len < min
        {
            out.push(issue(
                "minItems",
                path,
                &at("minItems"),
                format!("fewer than {min} items"),
            ));
        }
        if let Some(max) = k.max_items
            && len > max
        {
            out.push(issue(
                "maxItems",
                path,
                &at("maxItems"),
                format!("more than {max} items"),
            ));
        }
        if k.unique_items {
            let dup = items
                .iter()
                .enumerate()
                .any(|(i, a)| items[i + 1..].iter().any(|b| a == b));
            if dup {
                out.push(issue(
                    "uniqueItems",
                    path,
                    &at("uniqueItems"),
                    "the items are not unique",
                ));
            }
        }
        for (i, item) in items.iter().enumerate() {
            let child = format!("{path}/{i}");
            match k.prefix_items.get(i) {
                Some(&p) => self.check(p, item, &child, "prefixItems", out),
                None => {
                    if let Some(s) = k.items {
                        self.check(s, item, &child, "items", out);
                    }
                }
            }
        }
    }

    fn check_object(
        &self,
        k: &Keywords,
        m: &Map,
        path: &str,
        loc: &str,
        out: &mut Vec<SchemaIssue>,
    ) {
        let at = |kw: &str| format!("{loc}/{kw}");
        for r in &k.required {
            if !m.contains_key(r) {
                out.push(issue(
                    "required",
                    &format!("{path}/{}", escape(r)),
                    &at("required"),
                    format!("required property `{r}` is missing"),
                ));
            }
        }
        let len = u64::try_from(m.len()).unwrap_or(u64::MAX);
        if let Some(min) = k.min_properties
            && len < min
        {
            out.push(issue(
                "minProperties",
                path,
                &at("minProperties"),
                format!("fewer than {min} properties"),
            ));
        }
        if let Some(max) = k.max_properties
            && len > max
        {
            out.push(issue(
                "maxProperties",
                path,
                &at("maxProperties"),
                format!("more than {max} properties"),
            ));
        }
        for (key, value) in m.iter() {
            let child = format!("{path}/{}", escape(key));
            let mut covered = false;
            if let Some((_, p)) = k.properties.iter().find(|(n, _)| n == key) {
                covered = true;
                self.check(*p, value, &child, "properties", out);
            }
            for (pat, p) in &k.pattern_properties {
                if pat.regex.is_match(key) {
                    covered = true;
                    self.check(*p, value, &child, "patternProperties", out);
                }
            }
            if !covered && let Some(a) = k.additional_properties {
                match &self.nodes[idx(a)].kind {
                    NodeKind::Bool(false) => out.push(issue(
                        "additionalProperties",
                        &child,
                        &at("additionalProperties"),
                        format!("property `{key}` is not allowed"),
                    )),
                    _ => self.check(a, value, &child, "additionalProperties", out),
                }
            }
        }
    }
}

fn issue(
    keyword: &'static str,
    path: &str,
    schema_path: &str,
    message: impl Into<String>,
) -> SchemaIssue {
    SchemaIssue {
        code: format!("schema_{}", snake(keyword)),
        keyword,
        instance_path: path.to_owned(),
        schema_path: schema_path.to_owned(),
        message: message.into(),
    }
}

/// `additionalProperties` → `additional_properties`; `$ref` → `ref`.
fn snake(keyword: &str) -> String {
    let mut s = String::with_capacity(keyword.len() + 4);
    for c in keyword.chars() {
        if c == '$' {
            continue;
        }
        if c.is_ascii_uppercase() {
            s.push('_');
            s.push(c.to_ascii_lowercase());
        } else {
            s.push(c);
        }
    }
    s
}

/// A number as an exact decimal `mantissa × 10^exponent`, from its shortest
/// round-trip text. `None` if the mantissa does not fit.
fn decimal(n: Number) -> Option<(i128, i32)> {
    let text = n.to_json();
    let (num, exp) = match text.split_once('e') {
        Some((a, b)) => (a, b.parse::<i32>().ok()?),
        None => (text.as_str(), 0),
    };
    let (neg, num) = match num.strip_prefix('-') {
        Some(r) => (true, r),
        None => (false, num),
    };
    let (int, frac) = num.split_once('.').unwrap_or((num, ""));
    let digits = format!("{int}{frac}");
    let mut mant: i128 = 0;
    for d in digits.bytes() {
        mant = mant
            .checked_mul(10)?
            .checked_add(i128::from(d.checked_sub(b'0')?))?;
    }
    let exp = exp.checked_sub(i32::try_from(frac.len()).ok()?)?;
    Some((if neg { -mant } else { mant }, exp))
}

/// Whether `x` is an integer multiple of `m` (`m > 0`), decided exactly on
/// decimal forms. When the decimals overflow, falls back to IEEE division,
/// which is correctly rounded and so identical on every platform.
fn is_multiple(x: Number, m: Number) -> bool {
    if let (Number::Int(a), Number::Int(b)) = (x, m) {
        return b != 0 && a.checked_rem(b).is_none_or(|r| r == 0);
    }
    if let (Some((xm, xe)), Some((mm, me))) = (decimal(x), decimal(m)) {
        let e = xe.min(me);
        let scale = |mant: i128, from: i32| -> Option<i128> {
            let shift = u32::try_from(from - e).ok()?;
            mant.checked_mul(10i128.checked_pow(shift)?)
        };
        if let (Some(a), Some(b)) = (scale(xm, xe), scale(mm, me))
            && b != 0
        {
            return a % b == 0;
        }
    }
    let q = x.as_f64() / m.as_f64();
    q.is_finite() && q.fract() == 0.0
}

fn digits(s: &str) -> Option<u32> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400) => {
            29
        }
        2 => 28,
        _ => 0,
    }
}

/// RFC 3339 `full-date`: `YYYY-MM-DD`.
fn is_date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let (Some(y), Some(m), Some(d)) = (digits(&s[..4]), digits(&s[5..7]), digits(&s[8..])) else {
        return false;
    };
    (1..=12).contains(&m) && d >= 1 && d <= days_in_month(y, m)
}

/// RFC 3339 `full-time`: `HH:MM:SS[.frac](Z|±HH:MM)`. A leap second (`:60`)
/// is valid only at 23:59 UTC.
fn is_time(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() < 9 || b[2] != b':' || b[5] != b':' {
        return false;
    }
    let (Some(h), Some(mi), Some(sec)) = (digits(&s[..2]), digits(&s[3..5]), digits(&s[6..8]))
    else {
        return false;
    };
    let mut rest = &s[8..];
    if let Some(frac) = rest.strip_prefix('.') {
        let n = frac.bytes().take_while(u8::is_ascii_digit).count();
        if n == 0 {
            return false;
        }
        rest = &frac[n..];
    }
    let offset_minutes: i64 = if rest == "Z" || rest == "z" {
        0
    } else {
        let ob = rest.as_bytes();
        if ob.len() != 6 || !matches!(ob[0], b'+' | b'-') || ob[3] != b':' {
            return false;
        }
        let (Some(oh), Some(om)) = (digits(&rest[1..3]), digits(&rest[4..6])) else {
            return false;
        };
        if oh > 23 || om > 59 {
            return false;
        }
        let m = i64::from(oh * 60 + om);
        if ob[0] == b'-' { -m } else { m }
    };
    if h > 23 || mi > 59 || sec > 60 {
        return false;
    }
    if sec == 60 {
        let utc = (i64::from(h * 60 + mi) - offset_minutes).rem_euclid(24 * 60);
        return utc == 23 * 60 + 59;
    }
    true
}

/// RFC 3339 `date-time`: `full-date "T" full-time`.
fn is_date_time(s: &str) -> bool {
    match s.get(10..11) {
        Some("T" | "t") => is_date(&s[..10]) && is_time(&s[11..]),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::yaml::parse_value;

    fn v(src: &str) -> Value {
        parse_value(src).unwrap().unwrap()
    }

    fn codes(schema: &str, instance: &str) -> Vec<(String, String)> {
        let s = compile(&v(schema), "").unwrap();
        s.validate(&v(instance))
            .into_iter()
            .map(|i| (i.code, i.instance_path))
            .collect()
    }

    fn ok(schema: &str, instance: &str) -> bool {
        codes(schema, instance).is_empty()
    }

    fn load_err(schema: &str) -> Vec<&'static str> {
        compile(&v(schema), "")
            .unwrap_err()
            .into_iter()
            .map(|e| e.code)
            .collect()
    }

    fn pair(c: &str, p: &str) -> (String, String) {
        (c.to_owned(), p.to_owned())
    }

    #[test]
    fn types() {
        assert!(ok("type: integer", "3"));
        assert!(ok("type: integer", "3.0"));
        assert!(!ok("type: integer", "3.5"));
        assert!(ok("type: number", "3"));
        assert!(ok("type: [string, 'null']", "null"));
        assert_eq!(codes("type: string", "3"), [pair("schema_type", "")]);
        assert!(ok("type: object", "{a: 1}"));
        assert!(!ok("type: array", "{}"));
        assert!(ok("true", "1"));
        assert_eq!(codes("false", "1"), [pair("schema_false", "")]);
    }

    #[test]
    fn enum_const() {
        assert!(ok("enum: [a, 1]", "1.0"));
        assert_eq!(codes("enum: [a, b]", "c"), [pair("schema_enum", "")]);
        assert!(ok("const: {x: [1, 2]}", "{x: [1, 2.0]}"));
        assert_eq!(codes("const: x", "y"), [pair("schema_const", "")]);
    }

    #[test]
    fn numbers() {
        assert!(!ok("minimum: 0", "-1"));
        assert!(ok("minimum: 0", "0"));
        assert!(!ok("maximum: 10", "10.5"));
        assert!(!ok("exclusiveMinimum: 0", "0"));
        assert!(ok("exclusiveMinimum: 0", "0.1"));
        assert!(!ok("exclusiveMaximum: 1", "1.0"));
        assert!(ok("minimum: 9007199254740993", "9007199254740993"));
        assert!(!ok("minimum: 9007199254740993", "9007199254740992"));
        assert!(ok("multipleOf: 2", "4"));
        assert_eq!(
            codes("multipleOf: 2", "3"),
            [pair("schema_multiple_of", "")]
        );
        assert!(ok("multipleOf: 0.1", "0.3"));
        assert!(ok("multipleOf: 0.0001", "0.0075"));
        assert!(!ok("multipleOf: 0.1", "0.35"));
        assert!(ok("multipleOf: 0.5", "4"));
        assert!(ok("multipleOf: 2", "4.0"));
        assert!(ok("multipleOf: 1e-30", "3e-29"));
        assert_eq!(load_err("multipleOf: 0"), ["invalid_schema"]);
        assert_eq!(load_err("minimum: x"), ["invalid_schema"]);
    }

    #[test]
    fn strings() {
        assert!(ok("minLength: 2", "é!"));
        assert!(!ok("minLength: 3", "é!"));
        assert!(!ok("maxLength: 2", "abc"));
        assert!(ok("pattern: '[0-9]'", "a1b"));
        assert!(!ok("pattern: '^[0-9]+$'", "a1b"));
        assert!(!ok("pattern: '^\\w+$'", "é"));
        assert!(ok("minLength: 5", "3"));
        assert_eq!(load_err("pattern: '\\p{L}'"), ["invalid_pattern"]);
        assert_eq!(load_err("pattern: '(a)\\1'"), ["invalid_pattern"]);
        assert_eq!(load_err("pattern: '(?=a)'"), ["invalid_pattern"]);
        assert_eq!(load_err("pattern: '(?<!a)b'"), ["invalid_pattern"]);
        assert_eq!(load_err("pattern: '('"), ["invalid_pattern"]);
        assert_eq!(
            load_err("patternProperties: {'\\P{L}': true}"),
            ["invalid_pattern"]
        );
        assert!(ok("pattern: '\\\\p'", "\\p"));
    }

    #[test]
    fn formats() {
        let date = "format: date";
        assert!(ok(date, "'2024-02-29'"));
        assert!(!ok(date, "'2023-02-29'"));
        assert!(!ok(date, "'2023-13-01'"));
        assert!(!ok(date, "'2023-04-31'"));
        assert!(!ok(date, "'2023-4-01'"));
        assert!(ok("format: date", "3"));
        assert!(ok("format: email", "nope"));
        let time = "format: time";
        assert!(ok(time, "'12:34:56+10:00'"));
        assert!(ok(time, "'12:34:56.789Z'"));
        assert!(!ok(time, "'12:34:56'"));
        assert!(!ok(time, "'24:00:00Z'"));
        assert!(!ok(time, "'12:34:56.Z'"));
        assert!(ok(time, "'23:59:60Z'"));
        assert!(ok(time, "'15:59:60-08:00'"));
        assert!(!ok(time, "'12:59:60Z'"));
        let dt = "format: date-time";
        assert!(ok(dt, "'2026-07-16T12:34:56+10:00'"));
        assert!(ok(dt, "'2026-07-16t12:34:56z'"));
        assert!(!ok(dt, "'2026-07-16T12:34:56'"));
        assert!(!ok(dt, "'2026-07-16 12:34:56Z'"));
        assert_eq!(codes(dt, "'x'"), [pair("format_invalid", "")]);
    }

    #[test]
    fn arrays() {
        assert!(!ok("minItems: 1", "[]"));
        assert!(!ok("maxItems: 1", "[1, 2]"));
        assert!(!ok("uniqueItems: true", "[1, 1.0]"));
        assert!(ok("uniqueItems: true", "[1, '1']"));
        assert_eq!(
            codes("items: {type: string}", "[a, 3, b, 4]"),
            [pair("schema_type", "/1"), pair("schema_type", "/3")]
        );
        assert_eq!(
            codes(
                "{prefixItems: [{type: integer}], items: {type: string}}",
                "[a, b]"
            ),
            [pair("schema_type", "/0")]
        );
        assert_eq!(codes("items: false", "[1]"), [pair("schema_items", "/0")]);
    }

    #[test]
    fn objects() {
        let s = "{required: [a, b], properties: {a: {type: string}}, additionalProperties: false}";
        assert_eq!(
            codes(s, "{a: 1, c: 2}"),
            // `b` and `c` are undeclared: present fields first, then missing ones.
            [
                pair("schema_type", "/a"),
                pair("schema_additional_properties", "/c"),
                pair("schema_required", "/b")
            ]
        );
        assert!(ok(
            "{patternProperties: {'^x': {type: integer}}, additionalProperties: false}",
            "{x1: 1}"
        ));
        assert!(!ok(
            "{patternProperties: {'^x': {type: integer}}}",
            "{x1: a}"
        ));
        assert!(!ok("additionalProperties: {type: integer}", "{a: b}"));
        assert!(!ok("minProperties: 1", "{}"));
        assert!(!ok("maxProperties: 0", "{a: 1}"));
        assert_eq!(
            codes("required: ['a/b']", "{}"),
            [pair("schema_required", "/a~1b")]
        );
    }

    #[test]
    fn combinators() {
        assert_eq!(
            codes("anyOf: [{type: string}, {type: number}]", "false"),
            [pair("schema_any_of", "")]
        );
        assert!(ok("anyOf: [{type: string}, {type: number}]", "1"));
        assert_eq!(
            codes("oneOf: [{type: number}, {type: integer}]", "1"),
            [pair("schema_one_of", "")]
        );
        assert!(ok("oneOf: [{type: number}, {type: integer}]", "1.5"));
        assert_eq!(
            codes(
                "allOf: [{type: string}, {minLength: 3, pattern: '^[a-z]+$'}]",
                "X"
            ),
            [pair("schema_min_length", ""), pair("schema_pattern", "")]
        );
        assert_eq!(codes("not: {type: string}", "a"), [pair("schema_not", "")]);
        let cond = "{if: {properties: {k: {const: x}}, required: [k]}, then: {required: [a]}, else: {required: [b]}}";
        assert_eq!(codes(cond, "{k: x}"), [pair("schema_required", "/a")]);
        assert_eq!(codes(cond, "{k: y}"), [pair("schema_required", "/b")]);
        assert!(ok("then: {required: [a]}", "{}"));
    }

    #[test]
    fn refs() {
        let s =
            "{$defs: {t: {type: string, pattern: '^tok_'}}, properties: {x: {$ref: '#/$defs/t'}}}";
        assert_eq!(codes(s, "{x: bad}"), [pair("schema_pattern", "/x")]);
        assert_eq!(
            codes(
                "{$defs: {t: {type: string}}, $ref: '#/$defs/t', minLength: 2}",
                "a"
            ),
            [pair("schema_min_length", "")]
        );
        // Recursion through a property makes progress.
        let tree = "{type: object, properties: {kids: {type: array, items: {$ref: '#'}}, n: {type: integer}}}";
        assert!(ok(tree, "{kids: [{n: 1, kids: []}]}"));
        assert_eq!(
            codes(tree, "{kids: [{n: a}]}"),
            [pair("schema_type", "/kids/0/n")]
        );
        assert_eq!(load_err("$ref: '#'"), ["schema_ref_cycle"]);
        assert_eq!(
            load_err("{$defs: {a: {$ref: '#/$defs/b'}, b: {allOf: [{$ref: '#/$defs/a'}]}}}"),
            ["schema_ref_cycle"]
        );
        assert_eq!(
            load_err("$ref: '#/$defs/missing'"),
            ["schema_ref_unresolved"]
        );
        assert_eq!(load_err("$ref: 'other.json'"), ["schema_ref_unresolved"]);
        assert_eq!(
            load_err("$ref: 'https://example.com/s.json'"),
            ["schema_ref_forbidden"]
        );
        assert_eq!(
            load_err("{$defs: {bad: {pattern: '\\p{L}'}}}"),
            ["invalid_pattern"]
        );
        assert!(ok(
            "{$defs: {'a b': {type: string}}, $ref: '#/$defs/a%20b'}",
            "x"
        ));
    }

    #[test]
    fn entry_pointer() {
        let doc = v(
            "{$defs: {r: {type: object, required: [code], properties: {code: {$ref: '#/$defs/c'}}}, c: {pattern: '^[A-Z]{3}$'}}}",
        );
        let s = compile(&doc, "/$defs/r").unwrap();
        assert!(s.validate(&v("{code: ABC}")).is_empty());
        assert_eq!(s.validate(&v("{code: abc}"))[0].code, "schema_pattern");
        assert!(compile(&doc, "/$defs/nope").is_err());
    }

    #[test]
    fn introspection() {
        let s = compile(
            &v("{properties: {tags: {type: array}, b: {uniqueItems: true}, a: {$ref: '#/$defs/u'}}, allOf: [{properties: {z: {}}}], $defs: {u: {uniqueItems: true}}}"),
            "",
        )
        .unwrap();
        assert_eq!(s.top_level_properties(), ["a", "b", "tags", "z"]);
        assert_eq!(s.top_level_unique_items(), ["a", "b"]);
    }

    #[test]
    fn issues_group_by_declared_property() {
        // Mirrors the spec fixture: a `then` failure sorts with its field.
        let s = "{properties: {a: {type: string}, extra: {type: string}, z: {type: string}}, if: {required: [a]}, then: {required: [extra]}}";
        assert_eq!(
            codes(s, "{a: 1, z: 2}"),
            [
                pair("schema_type", "/a"),
                pair("schema_required", "/extra"),
                pair("schema_type", "/z")
            ]
        );
    }

    #[test]
    fn snake_codes() {
        assert_eq!(snake("additionalProperties"), "additional_properties");
        assert_eq!(snake("exclusiveMinimum"), "exclusive_minimum");
        assert_eq!(snake("$ref"), "ref");
    }

    #[test]
    fn spec_fixture_profile_constraints() {
        // core-collection.yaml `core.json_schema_profile_constraints`.
        let schema = r##"
type: object
required: [type, marker, label, minimum_value, maximum_value, multiple, exclusive_min, exclusive_max, choice, variant, any_value, values, conditional, token]
additionalProperties: false
properties:
  type: { const: schema_features }
  marker: { const: fixed }
  label:
    allOf:
      - { type: string }
      - { minLength: 3, maxLength: 8, pattern: "^[a-z]+$" }
    title: Lowercase label
    default: valid
  minimum_value: { type: number, minimum: 0 }
  maximum_value: { type: number, maximum: 10 }
  multiple: { type: number, multipleOf: 2 }
  exclusive_min: { type: number, exclusiveMinimum: 0 }
  exclusive_max: { type: number, exclusiveMaximum: 1 }
  choice: { enum: [alpha, beta] }
  variant:
    oneOf:
      - { type: string }
      - { type: integer }
  any_value:
    anyOf:
      - { type: string }
      - { type: number }
  values:
    type: array
    minItems: 1
    maxItems: 3
    uniqueItems: true
    items: { type: string }
  conditional: { enum: [basic, extended] }
  basic_value: { type: string }
  extra: { type: string }
  token: { $ref: "#/$defs/token" }
if:
  properties:
    conditional: { const: extended }
  required: [conditional]
then:
  required: [extra]
else:
  required: [basic_value]
$defs:
  token:
    type: string
    pattern: "^tok_[a-z]+$"
"##;
        let instance = r#"
type: schema_features
marker: wrong
label: X
minimum_value: -1
maximum_value: 11
multiple: 3
exclusive_min: 0
exclusive_max: 1
choice: gamma
variant: true
any_value: false
values: [a, a, 3, d]
conditional: extended
token: invalid
"#;
        let got: Vec<String> = codes(schema, instance)
            .into_iter()
            .map(|(c, p)| format!("{c} {p}"))
            .collect();
        assert_eq!(
            got,
            [
                "schema_const /marker",
                "schema_min_length /label",
                "schema_pattern /label",
                "schema_minimum /minimum_value",
                "schema_maximum /maximum_value",
                "schema_multiple_of /multiple",
                "schema_exclusive_minimum /exclusive_min",
                "schema_exclusive_maximum /exclusive_max",
                "schema_enum /choice",
                "schema_one_of /variant",
                "schema_any_of /any_value",
                "schema_max_items /values",
                "schema_unique_items /values",
                "schema_type /values/2",
                "schema_required /extra",
                "schema_pattern /token",
            ]
        );
        let edges = instance
            .replace("marker: wrong", "marker: fixed")
            .replace("label: X", "label: toolongname")
            .replace("minimum_value: -1", "minimum_value: 0")
            .replace("maximum_value: 11", "maximum_value: 10")
            .replace("multiple: 3", "multiple: 4")
            .replace("exclusive_min: 0\n", "exclusive_min: 0.1\n")
            .replace("exclusive_max: 1\n", "exclusive_max: 0.9\n")
            .replace("choice: gamma", "choice: beta")
            .replace("variant: true", "variant: 2")
            .replace("any_value: false", "any_value: ok")
            .replace("values: [a, a, 3, d]", "values: []")
            .replace("conditional: extended", "conditional: basic")
            .replace("token: invalid", "token: tok_valid");
        let got: Vec<String> = codes(schema, &edges)
            .into_iter()
            .map(|(c, p)| format!("{c} {p}"))
            .collect();
        assert_eq!(
            got,
            [
                "schema_max_length /label",
                "schema_min_items /values",
                "schema_required /basic_value",
            ]
        );
    }
}
