//! Primitive evaluator port from mdbase-rs expression.rs (MIT, LICENSE.port).
//! Original lazy branches, missing method behavior, scopes and folds are kept.
//! Deferred functions/overloads refuse; sticky host failures never become cells.

use std::cmp::Ordering;
use std::collections::BTreeMap;

use super::program::formula_name;
use super::{
    CapturedClock, DateValue, DurationValue, EvaluatedDate, EvaluatedDuration, EvaluationFailure,
    Expr, MAX_EVALUATION_DEPTH, MAX_VALUE_DEPTH, Member, Profile, Program, RuntimeValue,
    WorkBudget,
};
use crate::value::{Map, Value};

/// Borrowed raw-record bindings. Effective defaults, file graphs, clocks and
/// property registries are never synthesized from ambient host state.
#[derive(Clone, Copy)]
pub struct Bindings<'a> {
    note: &'a Map,
    property_types: Option<&'a BTreeMap<String, String>>,
    strict_captured_types: bool,
    clock: Option<CapturedClock>,
    file: Option<super::CapturedFileBindings<'a>>,
}

impl<'a> Bindings<'a> {
    /// Bind raw Core frontmatter, without effective/defaulted overlays.
    pub fn raw(note: &'a Map) -> Self {
        Self {
            note,
            property_types: None,
            strict_captured_types: false,
            clock: None,
            file: None,
        }
    }
    /// Supply captured property hints, never an ambient host registry. Calendar
    /// dates remain typed; primitive-profile dates and deferred links refuse.
    pub fn with_property_types(mut self, types: &'a BTreeMap<String, String>) -> Self {
        self.property_types = Some(types);
        self
    }
    pub(crate) fn with_captured_property_types(
        mut self,
        types: &'a BTreeMap<String, String>,
    ) -> Self {
        self.property_types = Some(types);
        self.strict_captured_types = true;
        self
    }
    /// Inspect a direct display-only raw property without converting unrelated
    /// fields. Semantic roots still use the ordinary fatal evaluator boundary.
    pub(super) fn unsupported_display_property(
        self,
        name: &str,
        budget: &mut WorkBudget,
    ) -> Option<&'static str> {
        let value = self.note.get(name)?;
        if self
            .property_types
            .and_then(|types| types.get(name))
            .is_some_and(|hint| hint == "link")
        {
            return Some(if self.strict_captured_types && value.is_null() {
                "typed_empty_property_unqualified"
            } else {
                "typed_property"
            });
        }
        unsupported_display_value(value, true, 1, budget)
    }

    /// Carry explicit immutable captured file facts through this row/formulas.
    /// Does not synthesize missing tags/stats or grant metadata authorization.
    pub fn with_file(mut self, file: super::CapturedFileBindings<'a>) -> Self {
        self.file = Some(file);
        self
    }

    /// Carry one immutable clock/zone capture through every row and formula.
    /// No missing-clock default or fresh per-row wall-clock observation.
    pub fn with_clock(mut self, clock: CapturedClock) -> Self {
        self.clock = Some(clock);
        self
    }
}

fn unsupported_display_value(
    value: &Value,
    property: bool,
    depth: usize,
    budget: &mut WorkBudget,
) -> Option<&'static str> {
    if depth > MAX_VALUE_DEPTH {
        budget.fail(EvaluationFailure::BudgetExceeded("value_depth"));
        return None;
    }
    if !budget.charge(1, 0) {
        return None;
    }
    match value {
        Value::Text(text) if property && text.starts_with("[[") && text.ends_with("]]") => {
            Some("link_property")
        }
        Value::List(values) => values
            .iter()
            .find_map(|value| unsupported_display_value(value, property, depth + 1, budget)),
        Value::Map(values) if values.get("type").and_then(Value::as_str) == Some("Link") => {
            Some("link_value")
        }
        // convert_core does not mark nested map text as a property. Preserve that
        // distinction, rather than guessing Markdown semantics for arbitrary maps.
        Value::Map(values) => values
            .iter()
            .find_map(|(_, value)| unsupported_display_value(value, false, depth + 1, budget)),
        _ => None,
    }
}

impl Program {
    /// Execute under a caller-owned request meter. Ordinary source Error values
    /// remain typed; admission/resource failures return Err and stay sticky.
    pub fn evaluate(
        &self,
        bindings: Bindings<'_>,
        budget: &mut WorkBudget,
    ) -> Result<RuntimeValue, EvaluationFailure> {
        self.evaluate_with_cancel(bindings, budget, &|| false)
    }

    /// As evaluate, with a pure cooperative cancellation probe at every AST node.
    /// A superseded query's host owns this probe; no clock/thread is consulted.
    pub fn evaluate_with_cancel(
        &self,
        bindings: Bindings<'_>,
        budget: &mut WorkBudget,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<RuntimeValue, EvaluationFailure> {
        self.evaluate_mode(bindings, budget, cancelled, false)
    }

    /// Filter-only boundary: source Error values stop semantic evaluation before
    /// a Boolean wrapper or lazy parent can turn them into a non-matching row.
    pub(crate) fn evaluate_filter_with_cancel(
        &self,
        bindings: Bindings<'_>,
        budget: &mut WorkBudget,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<RuntimeValue, EvaluationFailure> {
        self.evaluate_mode(bindings, budget, cancelled, true)
    }

    pub(super) fn evaluate_view_roots(
        &self,
        bindings: Bindings<'_>,
        semantic: usize,
        unavailable: &mut [Option<&'static str>],
        columns: &[super::PropertySelector],
        budget: &mut WorkBudget,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Option<Vec<RuntimeValue>>, EvaluationFailure> {
        if self.requires_file && bindings.file.is_none() {
            budget.fail(EvaluationFailure::MetadataUnavailable(
                "file_metadata_not_captured",
            ));
        }
        if self.requires_clock && bindings.clock.is_none() {
            budget.fail(EvaluationFailure::UnsupportedConstruct(
                "clock_not_captured",
            ));
        }
        let Expr::Array(roots) = self.expression.ast() else {
            budget.fail(EvaluationFailure::UnsupportedConstruct(
                "base_view_program_shape",
            ));
            return Err(budget.failure().expect("view AST"));
        };
        let mut evaluator = Evaluator {
            program: self,
            bindings,
            budget,
            cancelled,
            cache: BTreeMap::new(),
            depth: 0,
            refuse_source_errors: true,
        };
        let matches = evaluator.evaluate(&roots[0], &BTreeMap::new());
        if let Some(failure) = evaluator.budget.failure() {
            return Err(failure);
        }
        if matches == RuntimeValue::Bool(false) {
            return Ok(None);
        }
        if matches != RuntimeValue::Bool(true) {
            evaluator
                .budget
                .fail(EvaluationFailure::UnsupportedConstruct(
                    "filter_result_shape",
                ));
            return Err(evaluator.budget.failure().expect("view match shape"));
        }
        let count = 1 + semantic + columns.len();
        if count > roots.len() || unavailable.len() != columns.len() {
            evaluator
                .budget
                .fail(EvaluationFailure::UnsupportedConstruct(
                    "base_view_program_shape",
                ));
            return Err(evaluator.budget.failure().expect("view root count"));
        }
        if !evaluator.budget.charge(
            count as u64,
            ((count - 1) * std::mem::size_of::<RuntimeValue>()) as u64,
        ) {
            return Err(evaluator.budget.failure().expect("view cells"));
        }
        let mut values = Vec::with_capacity(count - 1);
        for (index, root) in roots.iter().take(count).enumerate().skip(1) {
            evaluator.refuse_source_errors = index <= semantic;
            if index > semantic {
                let slot = index - semantic - 1;
                if unavailable[slot].is_none()
                    && let super::PropertySelector::Note(name) = &columns[slot]
                {
                    unavailable[slot] =
                        bindings.unsupported_display_property(name, evaluator.budget);
                }
            }
            let missing = index > semantic && unavailable[index - semantic - 1].is_some();
            let value = if missing {
                RuntimeValue::Null
            } else {
                evaluator.evaluate(root, &BTreeMap::new())
            };
            evaluator.budget.value(&value, 1, true);
            if let Some(failure) = evaluator.budget.failure() {
                return Err(failure);
            }
            values.push(value);
        }
        Ok(Some(values))
    }
    fn evaluate_mode(
        &self,
        bindings: Bindings<'_>,
        budget: &mut WorkBudget,
        cancelled: &dyn Fn() -> bool,
        refuse_source_errors: bool,
    ) -> Result<RuntimeValue, EvaluationFailure> {
        if self.requires_file && bindings.file.is_none() {
            budget.fail(EvaluationFailure::MetadataUnavailable(
                "file_metadata_not_captured",
            ));
        }
        if self.requires_clock && bindings.clock.is_none() {
            budget.fail(EvaluationFailure::UnsupportedConstruct(
                "clock_not_captured",
            ));
        }
        let mut evaluator = Evaluator {
            program: self,
            bindings,
            budget,
            cancelled,
            cache: BTreeMap::new(),
            depth: 0,
            refuse_source_errors,
        };
        let result = evaluator.evaluate(self.expression.ast(), &BTreeMap::new());
        // Reserve the public render boundary too; no partial success on failure.
        evaluator.budget.value(&result, 1, true);
        match evaluator.budget.failure() {
            Some(failure) => Err(failure),
            None => Ok(result),
        }
    }
}

type Scope = BTreeMap<String, RuntimeValue>;
struct Evaluator<'a, 'b> {
    program: &'a Program,
    bindings: Bindings<'a>,
    budget: &'b mut WorkBudget,
    cancelled: &'a dyn Fn() -> bool,
    cache: BTreeMap<String, RuntimeValue>,
    depth: usize,
    refuse_source_errors: bool,
}

impl Evaluator<'_, '_> {
    fn refuse(&mut self, detail: &'static str) -> RuntimeValue {
        self.budget
            .fail(EvaluationFailure::UnsupportedConstruct(detail));
        RuntimeValue::Null
    }

    fn clone_value(&mut self, value: &RuntimeValue) -> RuntimeValue {
        if self.budget.value(value, 1, false) {
            value.clone()
        } else {
            RuntimeValue::Null
        }
    }

    fn string(&mut self, value: &RuntimeValue) -> String {
        if self.budget.value(value, 1, true) {
            value.plain_string()
        } else {
            String::new()
        }
    }

    fn copy_scope(&mut self, scope: &Scope) -> Scope {
        let mut output = BTreeMap::new();
        for (name, value) in scope {
            if !self.budget.text(name.len(), 6) {
                break;
            }
            let value = self.clone_value(value);
            if !self.budget.live() {
                break;
            }
            output.insert(name.clone(), value);
        }
        output
    }

    fn convert_core(&mut self, value: &Value, property: bool, depth: usize) -> RuntimeValue {
        if depth > MAX_VALUE_DEPTH {
            self.budget
                .fail(EvaluationFailure::BudgetExceeded("value_depth"));
            return RuntimeValue::Null;
        }
        if !self.budget.charge(1, 128) {
            return RuntimeValue::Null;
        }
        match value {
            Value::Null => RuntimeValue::Null,
            Value::Bool(v) => RuntimeValue::Bool(*v),
            Value::Int(_) | Value::Float(_) => {
                let value = value.as_number().expect("number variant").as_f64();
                if value.is_finite() {
                    RuntimeValue::Number(value)
                } else {
                    self.refuse("non_json_input_number")
                }
            }
            Value::Text(v) => {
                if property && v.starts_with("[[") && v.ends_with("]]") {
                    return self.refuse("link_property");
                }
                if self.budget.text(v.len(), 1) {
                    RuntimeValue::String(v.clone())
                } else {
                    RuntimeValue::Null
                }
            }
            Value::List(values) => {
                if !self.budget.vector(values.len()) {
                    return RuntimeValue::Null;
                }
                let mut out = Vec::with_capacity(values.len());
                for v in values {
                    out.push(self.convert_core(v, property, depth + 1));
                    if !self.budget.live() {
                        break;
                    }
                }
                RuntimeValue::List(out)
            }
            Value::Map(values) => {
                if values.get("type").and_then(Value::as_str) == Some("Link") {
                    return self.refuse("link_value");
                }
                let mut out = BTreeMap::new();
                for (k, v) in values.iter() {
                    if !self.budget.text(k.len(), 6) {
                        break;
                    }
                    let value = self.convert_core(v, false, depth + 1);
                    if !self.budget.live() {
                        break;
                    }
                    out.insert(k.to_owned(), value);
                }
                RuntimeValue::Object(out)
            }
        }
    }

    fn note_property(&mut self, name: &str) -> RuntimeValue {
        let hint = self
            .bindings
            .property_types
            .and_then(|types| types.get(name));
        if hint.is_some_and(|hint| matches!(hint.as_str(), "date" | "datetime" | "link")) {
            // JS converts an explicit typed null date to Date; original
            // Calendar used Null. Captured raw bindings visibly refuse this
            // unqualified discrepancy rather than silently picking either.
            if self.bindings.strict_captured_types
                && self.bindings.note.get(name).is_some_and(Value::is_null)
            {
                return self.refuse("typed_empty_property_unqualified");
            }
            if self.program.profile == Profile::Primitive || hint.is_some_and(|hint| hint == "link")
            {
                return self.refuse("typed_property");
            }
            let Some(value) = self.bindings.note.get(name) else {
                return RuntimeValue::Null;
            };
            if value == &Value::Null {
                return RuntimeValue::Null;
            }
            let Some(text) = value.as_str() else {
                return self.refuse("date_property_type");
            };
            let Some(clock) = self.bindings.clock else {
                return self.refuse("clock_not_captured");
            };
            let date = clock.parse(text, self.budget);
            return self.date_value(date);
        }
        self.bindings
            .note
            .get(name)
            .map(|value| self.convert_core(value, true, 1))
            .unwrap_or(RuntimeValue::Null)
    }

    fn evaluate(&mut self, expression: &Expr, scope: &Scope) -> RuntimeValue {
        if !self.budget.live() {
            return RuntimeValue::Null;
        }
        if (self.cancelled)() {
            self.budget.fail(EvaluationFailure::Cancelled);
            return RuntimeValue::Null;
        }
        if self.depth == MAX_EVALUATION_DEPTH {
            self.budget
                .fail(EvaluationFailure::BudgetExceeded("evaluation_depth"));
            return RuntimeValue::Null;
        }
        if !self.budget.charge(1, 128) {
            return RuntimeValue::Null;
        }
        self.depth += 1;
        let value = self.evaluate_inner(expression, scope);
        self.depth -= 1;
        if self.refuse_source_errors && matches!(value, RuntimeValue::Error(_)) {
            self.budget.fail(EvaluationFailure::UnsupportedConstruct(
                "filter_expression_error",
            ));
        }
        if value.depth() > MAX_VALUE_DEPTH {
            self.budget
                .fail(EvaluationFailure::BudgetExceeded("value_depth"));
        }
        value
    }

    fn evaluate_inner(&mut self, expression: &Expr, scope: &Scope) -> RuntimeValue {
        match expression {
            Expr::Literal(value) => self.convert_core(value, false, 1),
            Expr::Identifier(name) => {
                if let Some(value) = scope.get(name) {
                    return self.clone_value(value);
                }
                match name.as_str() {
                    "note" => {
                        let mut out = BTreeMap::new();
                        for (name, _) in self.bindings.note.iter() {
                            if !self.budget.text(name.len(), 6) {
                                break;
                            }
                            let value = self.note_property(name);
                            if !self.budget.live() {
                                break;
                            }
                            out.insert(name.to_owned(), value);
                        }
                        RuntimeValue::Object(out)
                    }
                    "formula" => RuntimeValue::Object(BTreeMap::new()),
                    _ => self.note_property(name),
                }
            }
            Expr::Array(values) => {
                if !self.budget.vector(values.len()) {
                    return RuntimeValue::Null;
                }
                let mut out = Vec::with_capacity(values.len());
                for value in values {
                    out.push(self.evaluate(value, scope));
                    if !self.budget.live() {
                        break;
                    }
                }
                RuntimeValue::List(out)
            }
            Expr::Unary(op, operand) => {
                let value = self.evaluate(operand, scope);
                match op.as_str() {
                    "!" => RuntimeValue::Bool(!value.is_truthy()),
                    "-" => self
                        .number(&value)
                        .map(|v| RuntimeValue::Number(-v))
                        .unwrap_or_else(RuntimeValue::Error),
                    _ => self.refuse("unary_operator"),
                }
            }
            Expr::Binary(op, left, right) => self.binary(op, left, right, scope),
            Expr::Member(operand, member) => {
                if self.program.profile == Profile::TaskSlice1
                    && let Some(name) = super::file_bindings::field_name(operand, member)
                {
                    return self.file_property(name);
                }
                if let Some(name) =
                    formula_name(operand, member).expect("program admitted formula references")
                {
                    return self.formula(name);
                }
                if let Expr::Identifier(name) = operand.as_ref()
                    && name == "note"
                {
                    let key = match member {
                        Member::Named(name) => name.clone(),
                        Member::Computed(key) => {
                            let key = self.evaluate(key, scope);
                            self.string(&key)
                        }
                    };
                    return self.note_property(&key);
                }
                let value = self.evaluate(operand, scope);
                let key = match member {
                    Member::Named(name) => name.clone(),
                    Member::Computed(key) => {
                        let key = self.evaluate(key, scope);
                        self.string(&key)
                    }
                };
                self.property(value, &key)
            }
            Expr::Call(callee, arguments) => self.call(callee, arguments, scope),
            Expr::Regex(_, _) => self.refuse("regex_literal"),
        }
    }

    fn formula(&mut self, name: &str) -> RuntimeValue {
        if let Some(value) = self.cache.get(name) {
            return if self.budget.value(value, 1, false) {
                value.clone()
            } else {
                RuntimeValue::Null
            };
        }
        let expression = self.program.formulas.get(name).expect("admitted formula");
        let value = self.evaluate(expression.ast(), &BTreeMap::new());
        let cached = self.clone_value(&value);
        if self.budget.live() && self.budget.text(name.len(), 6) {
            self.cache.insert(name.to_owned(), cached);
        }
        value
    }

    fn number(&mut self, value: &RuntimeValue) -> Result<f64, String> {
        match value {
            RuntimeValue::Number(v) => Ok(*v),
            RuntimeValue::Bool(v) => Ok(if *v { 1.0 } else { 0.0 }),
            RuntimeValue::Date(value) => Ok(value.millis() as f64),
            RuntimeValue::Duration(value) => self.duration_number(value),
            RuntimeValue::Null => Ok(0.0),
            RuntimeValue::String(v) => {
                // Legacy Rust/JS disagree on empty/whitespace/nonfinite spellings;
                // refuse those unqualified conversions instead of approximating.
                if v.is_empty() || v.trim() != v {
                    self.refuse("string_number_coercion");
                    return Err(String::new());
                }
                match v.parse::<f64>() {
                    Ok(n) if n.is_finite() => Ok(n),
                    Ok(_) => {
                        self.refuse("non_finite_string_number");
                        Err(String::new())
                    }
                    Err(_) => {
                        if self.budget.text(v.len(), 6) {
                            Err(format!("Unable to parse {v:?} as a number."))
                        } else {
                            Err(String::new())
                        }
                    }
                }
            }
            value => Err(format!("Cannot convert {} to number", value.type_name())),
        }
    }

    fn equals(&mut self, left: &RuntimeValue, right: &RuntimeValue) -> bool {
        if unqualified_equality(left) || unqualified_equality(right) {
            self.refuse("non_finite_comparison");
            return false;
        }
        if let (RuntimeValue::Date(a), RuntimeValue::Date(b)) = (left, right) {
            return a.millis() == b.millis();
        }
        // Preserve the legacy JSON equality boundary, with precharged conversion.
        if !self.budget.value(left, 1, true) || !self.budget.value(right, 1, true) {
            return false;
        }
        left.to_plain() == right.to_plain()
    }

    fn binary(&mut self, op: &str, left: &Expr, right: &Expr, scope: &Scope) -> RuntimeValue {
        let left = self.evaluate(left, scope);
        if op == "&&" {
            return RuntimeValue::Bool(left.is_truthy() && self.evaluate(right, scope).is_truthy());
        }
        if op == "||" {
            return RuntimeValue::Bool(left.is_truthy() || self.evaluate(right, scope).is_truthy());
        }
        let right = self.evaluate(right, scope);
        if matches!(left, RuntimeValue::Error(_)) {
            return left;
        }
        if matches!(right, RuntimeValue::Error(_)) {
            return right;
        }
        if matches!(
            self.program.profile,
            Profile::Duration | Profile::Slice1 | Profile::TaskSlice1
        ) && let Some(value) = self.duration_binary(op, &left, &right)
        {
            return value;
        }
        // Frozen Calendar profile keeps its original date-arithmetic refusal.
        if matches!(op, "+" | "-") && matches!(left, RuntimeValue::Date(_)) {
            return self.refuse("date_arithmetic");
        }
        if op == "+"
            && (matches!(left, RuntimeValue::String(_)) || matches!(right, RuntimeValue::String(_)))
        {
            let a = self.string(&left);
            let b = self.string(&right);
            if !self.budget.text(a.len().saturating_add(b.len()), 1) {
                return RuntimeValue::Null;
            }
            return RuntimeValue::String(format!("{a}{b}"));
        }
        if op == "==" {
            return RuntimeValue::Bool(self.equals(&left, &right));
        }
        if op == "!=" {
            return RuntimeValue::Bool(!self.equals(&left, &right));
        }
        if matches!(op, ">" | "<" | ">=" | "<=") {
            let ordering =
                if let (RuntimeValue::String(a), RuntimeValue::String(b)) = (&left, &right) {
                    if non_bmp(a) || non_bmp(b) {
                        return self.refuse("non_bmp_string_order");
                    }
                    a.cmp(b)
                } else {
                    let a = self.number(&left);
                    let b = self.number(&right);
                    match (a, b) {
                        (Ok(a), Ok(b)) if a.is_finite() && b.is_finite() => {
                            a.partial_cmp(&b).unwrap_or(Ordering::Equal)
                        }
                        (Ok(_), Ok(_)) => return self.refuse("non_finite_comparison"),
                        (Err(error), _) | (_, Err(error)) => return RuntimeValue::Error(error),
                    }
                };
            return RuntimeValue::Bool(match op {
                ">" => ordering.is_gt(),
                "<" => ordering.is_lt(),
                ">=" => !ordering.is_lt(),
                _ => !ordering.is_gt(),
            });
        }
        let a = self.number(&left);
        let b = self.number(&right);
        match (a, b) {
            (Ok(a), Ok(b)) => RuntimeValue::Number(match op {
                "+" => a + b,
                "-" => a - b,
                "*" => a * b,
                "/" => a / b,
                "%" => a % b,
                _ => return self.refuse("binary_operator"),
            }),
            (Err(error), _) | (_, Err(error)) => RuntimeValue::Error(error),
        }
    }

    fn call(&mut self, callee: &Expr, arguments: &[Expr], scope: &Scope) -> RuntimeValue {
        match callee {
            Expr::Identifier(name) if name == "if" => {
                let condition = arguments
                    .first()
                    .map(|v| self.evaluate(v, scope))
                    .unwrap_or(RuntimeValue::Null);
                let branch = if condition.is_truthy() { 1 } else { 2 };
                arguments
                    .get(branch)
                    .map(|v| self.evaluate(v, scope))
                    .unwrap_or(RuntimeValue::Null)
            }
            Expr::Identifier(name) => {
                let args = self.arguments(arguments, scope);
                let first = args
                    .first()
                    .map(|v| self.clone_value(v))
                    .unwrap_or(RuntimeValue::Null);
                match name.as_str() {
                    "list" => match first {
                        RuntimeValue::List(_) | RuntimeValue::Null => first,
                        value => {
                            if !self.budget.vector(1) {
                                return RuntimeValue::Null;
                            }
                            RuntimeValue::List(vec![value])
                        }
                    },
                    "date" | "now" | "today" => {
                        let Some(clock) = self.bindings.clock else {
                            return self.refuse("clock_not_captured");
                        };
                        let date = match name.as_str() {
                            "now" => clock.now(self.budget),
                            "today" => clock.today(self.budget),
                            _ => {
                                let text = self.string(&first);
                                clock.parse(&text, self.budget)
                            }
                        };
                        self.date_value(date)
                    }
                    "duration" => {
                        let text = self.string(&first);
                        let value = DurationValue::parse(&text, self.budget);
                        self.duration_value(value)
                    }
                    "number" => self
                        .number(&first)
                        .map(RuntimeValue::Number)
                        .unwrap_or_else(RuntimeValue::Error),
                    "max" | "min" => {
                        let mut result = if name == "max" {
                            f64::NEG_INFINITY
                        } else {
                            f64::INFINITY
                        };
                        for value in &args {
                            match self.number(value) {
                                Ok(v) => {
                                    result = if name == "max" {
                                        result.max(v)
                                    } else {
                                        result.min(v)
                                    }
                                }
                                Err(error) => return RuntimeValue::Error(error),
                            }
                        }
                        RuntimeValue::Number(result)
                    }
                    _ => self.refuse("global_function"),
                }
            }
            Expr::Member(operand, Member::Named(method)) => {
                if self.program.profile == Profile::TaskSlice1
                    && matches!(operand.as_ref(),Expr::Identifier(name) if name=="file")
                {
                    return self.file_method(method, arguments, scope);
                }
                let receiver = self.evaluate(operand, scope);
                self.method(receiver, method, arguments, scope)
            }
            _ => self.refuse("call_target"),
        }
    }

    fn date_value(&mut self, date: Result<DateValue, EvaluationFailure>) -> RuntimeValue {
        match date.and_then(|date| EvaluatedDate::new(date, self.budget)) {
            Ok(date) => RuntimeValue::Date(date),
            Err(failure) => {
                self.budget.fail(failure);
                RuntimeValue::Null
            }
        }
    }

    fn arguments(&mut self, arguments: &[Expr], scope: &Scope) -> Vec<RuntimeValue> {
        if !self.budget.vector(arguments.len()) {
            return Vec::new();
        }
        let mut out = Vec::with_capacity(arguments.len());
        for v in arguments {
            out.push(self.evaluate(v, scope));
            if !self.budget.live() {
                break;
            }
        }
        out
    }

    fn property(&mut self, receiver: RuntimeValue, key: &str) -> RuntimeValue {
        if !self.budget.text(key.len(), 6) {
            return RuntimeValue::Null;
        }
        match receiver {
            RuntimeValue::Null => RuntimeValue::Null,
            RuntimeValue::String(value) if key == "length" => {
                if non_bmp(&value) {
                    self.refuse("non_bmp_string_index")
                } else {
                    count(value.chars().count())
                }
            }
            RuntimeValue::Date(date) => match date.value().property(key, self.budget) {
                Ok(value) => RuntimeValue::Number(value as f64),
                Err(failure) => {
                    self.budget.fail(failure);
                    RuntimeValue::Null
                }
            },
            RuntimeValue::List(values) if key == "length" => count(values.len()),
            RuntimeValue::List(values) => key
                .parse::<i64>()
                .ok()
                .and_then(|i| index(values.len(), i))
                .and_then(|i| values.get(i))
                .map(|v| self.clone_value(v))
                .unwrap_or_else(|| member_error("List", key)),
            RuntimeValue::Object(values) => values
                .get(key)
                .map(|v| self.clone_value(v))
                .unwrap_or(RuntimeValue::Null),
            RuntimeValue::Error(error) => RuntimeValue::Error(error),
            value => member_error(value.type_name(), key),
        }
    }

    fn method(
        &mut self,
        receiver: RuntimeValue,
        name: &str,
        arguments: &[Expr],
        scope: &Scope,
    ) -> RuntimeValue {
        if matches!(receiver, RuntimeValue::Error(_)) {
            return receiver;
        }
        match name {
            "isTruthy" => return RuntimeValue::Bool(receiver.is_truthy()),
            "isEmpty" => return RuntimeValue::Bool(receiver.is_empty()),
            "toString" => return RuntimeValue::String(self.string(&receiver)),
            "isType" => {
                let expected = arguments
                    .first()
                    .map(|v| self.evaluate(v, scope))
                    .unwrap_or(RuntimeValue::Null);
                return RuntimeValue::Bool(
                    receiver
                        .type_name()
                        .eq_ignore_ascii_case(&self.string(&expected)),
                );
            }
            _ => {}
        }
        match receiver {
            RuntimeValue::Null => RuntimeValue::Null,
            RuntimeValue::Date(date) => {
                let args = self.arguments(arguments, scope);
                match name {
                    "date" => {
                        let value = date.value().date(self.budget);
                        self.date_value(value)
                    }
                    "format" | "time" => {
                        let pattern = if name == "time" {
                            "HH:mm:ss".into()
                        } else {
                            args.first()
                                .map(|value| self.string(value))
                                .unwrap_or_default()
                        };
                        let formatted = if matches!(
                            self.program.profile,
                            Profile::Slice1 | Profile::TaskSlice1
                        ) {
                            date.value().format_slice1(&pattern, self.budget)
                        } else {
                            date.value().format(&pattern, self.budget)
                        };
                        match formatted {
                            Ok(value) => RuntimeValue::String(value),
                            Err(failure) => {
                                self.budget.fail(failure);
                                RuntimeValue::Null
                            }
                        }
                    }
                    _ => method_error("Date", name),
                }
            }
            RuntimeValue::List(values) => self.list_method(&values, name, arguments, scope),
            RuntimeValue::String(value) => {
                let args = self.arguments(arguments, scope);
                self.string_method(&value, name, &args)
            }
            RuntimeValue::Number(value) => {
                // Retain legacy eager argument evaluation even when these
                // particular numeric methods ignore their argument values.
                let args = self.arguments(arguments, scope);
                match name {
                    "abs" => RuntimeValue::Number(value.abs()),
                    "ceil" => RuntimeValue::Number(value.ceil()),
                    "floor" => RuntimeValue::Number(value.floor()),
                    "round"
                        if matches!(
                            self.program.profile,
                            Profile::Slice1 | Profile::TaskSlice1
                        ) =>
                    {
                        let digits = match args.first().map(|v| self.number(v)).unwrap_or(Ok(0.0)) {
                            Ok(d) => d,
                            Err(e) => return RuntimeValue::Error(e),
                        };
                        match super::round_number(value, digits, self.budget) {
                            Ok(n) => RuntimeValue::Number(n),
                            Err(f) => {
                                self.budget.fail(f);
                                RuntimeValue::Null
                            }
                        }
                    }
                    _ => method_error("Number", name),
                }
            }
            RuntimeValue::Object(values) => match name {
                "keys" => {
                    if !self.budget.vector(values.len()) {
                        return RuntimeValue::Null;
                    }
                    let mut out = Vec::new();
                    for k in values.keys() {
                        if !self.budget.text(k.len(), 1) {
                            break;
                        }
                        out.push(RuntimeValue::String(k.clone()));
                    }
                    RuntimeValue::List(out)
                }
                "values" => {
                    if !self.budget.vector(values.len()) {
                        return RuntimeValue::Null;
                    }
                    RuntimeValue::List(values.values().map(|v| self.clone_value(v)).collect())
                }
                _ => method_error("Object", name),
            },
            value => method_error(value.type_name(), name),
        }
    }

    fn string_method(
        &mut self,
        value: &str,
        name: &str,
        arguments: &[RuntimeValue],
    ) -> RuntimeValue {
        let first = arguments.first().unwrap_or(&RuntimeValue::Null);
        match name {
            "contains" => RuntimeValue::Bool(value.contains(&self.string(first))),
            "containsAll" | "containsAny" => {
                let mut found = name == "containsAll";
                for arg in arguments {
                    let matched = value.contains(&self.string(arg));
                    if name == "containsAll" && !matched {
                        found = false;
                        break;
                    }
                    if name == "containsAny" && matched {
                        found = true;
                        break;
                    }
                }
                RuntimeValue::Bool(found)
            }
            "endsWith" => RuntimeValue::Bool(value.ends_with(&self.string(first))),
            "startsWith" => RuntimeValue::Bool(value.starts_with(&self.string(first))),
            "lower" => {
                if !self.budget.text(value.len(), 3) {
                    return RuntimeValue::Null;
                }
                RuntimeValue::String(value.to_lowercase())
            }
            "trim" => {
                if value
                    .chars()
                    .any(|c| (c.is_whitespace() && !c.is_ascii()) || c == '\u{feff}')
                {
                    return self.refuse("non_ascii_whitespace");
                }
                if !self.budget.text(value.len(), 1) {
                    return RuntimeValue::Null;
                }
                RuntimeValue::String(value.trim().to_owned())
            }
            "replace" => {
                let needle = self.string(first);
                let replacement = arguments.get(1).map(|v| self.string(v)).unwrap_or_default();
                let occurrences = if needle.is_empty() {
                    value.chars().count().saturating_add(1)
                } else {
                    value.matches(&needle).count()
                };
                let Some(size) = occurrences
                    .checked_mul(replacement.len())
                    .and_then(|n| n.checked_add(value.len()))
                else {
                    self.budget
                        .fail(EvaluationFailure::BudgetExceeded("allocation_estimate"));
                    return RuntimeValue::Null;
                };
                if !self.budget.text(size, 1) {
                    return RuntimeValue::Null;
                }
                if needle.is_empty() && non_bmp(value) {
                    return self.refuse("non_bmp_string_index");
                }
                RuntimeValue::String(value.replace(&needle, &replacement))
            }
            "repeat" => {
                let n = match self.number(first).ok().and_then(integer) {
                    Some(n) => n.max(0),
                    None => return self.refuse("repeat_count"),
                };
                let Ok(n) = usize::try_from(n) else {
                    return self.refuse("repeat_count");
                };
                let Some(size) = value.len().checked_mul(n) else {
                    self.budget
                        .fail(EvaluationFailure::BudgetExceeded("allocation_estimate"));
                    return RuntimeValue::Null;
                };
                if !self.budget.text(size, 1) {
                    return RuntimeValue::Null;
                }
                RuntimeValue::String(value.repeat(n))
            }
            "reverse" => {
                if non_bmp(value) {
                    return self.refuse("non_bmp_string_index");
                }
                if !self.budget.text(value.len(), 1) {
                    return RuntimeValue::Null;
                }
                RuntimeValue::String(value.chars().rev().collect())
            }
            "slice" => {
                if non_bmp(value) {
                    return self.refuse("non_bmp_string_index");
                }
                let start = self.number(first).ok().and_then(integer).unwrap_or(0);
                let end = arguments
                    .get(1)
                    .and_then(|v| self.number(v).ok())
                    .and_then(integer);
                if !self.budget.text(value.len(), 1) {
                    return RuntimeValue::Null;
                }
                let len = value.chars().count();
                let (a, b) = bounds(len, start, end);
                RuntimeValue::String(value.chars().skip(a).take(b - a).collect())
            }
            "split" => {
                let separator = self.string(first);
                if separator.is_empty() && non_bmp(value) {
                    return self.refuse("non_bmp_string_index");
                }
                let limit = arguments
                    .get(1)
                    .and_then(|v| self.number(v).ok())
                    .and_then(integer)
                    .and_then(|n| usize::try_from(n).ok());
                let upper = value.len().saturating_add(1);
                if !self.budget.vector(upper.min(limit.unwrap_or(upper)))
                    || !self.budget.text(value.len(), 1)
                {
                    return RuntimeValue::Null;
                }
                let iter: Box<dyn Iterator<Item = &str> + '_> = if separator.is_empty() {
                    Box::new(value.split("").filter(|s| !s.is_empty()))
                } else {
                    Box::new(value.split(&separator))
                };
                RuntimeValue::List(
                    iter.take(limit.unwrap_or(usize::MAX))
                        .map(|s| RuntimeValue::String(s.to_owned()))
                        .collect(),
                )
            }
            _ => method_error("String", name),
        }
    }

    fn list_method(
        &mut self,
        values: &[RuntimeValue],
        name: &str,
        arguments: &[Expr],
        scope: &Scope,
    ) -> RuntimeValue {
        match name {
            "contains" | "containsAll" | "containsAny" => {
                let args = if name == "contains" {
                    &arguments[..arguments.len().min(1)]
                } else {
                    arguments
                };
                let mut found = name == "containsAll";
                if name == "contains" && args.is_empty() {
                    return RuntimeValue::Bool(
                        values.iter().any(|v| self.equals(v, &RuntimeValue::Null)),
                    );
                }
                for arg in args {
                    let needle = self.evaluate(arg, scope);
                    let mut matched = false;
                    for value in values {
                        if self.equals(value, &needle) {
                            matched = true;
                            break;
                        }
                        if !self.budget.live() {
                            break;
                        }
                    }
                    if name == "containsAll" && !matched {
                        found = false;
                        break;
                    }
                    if name != "containsAll" && matched {
                        found = true;
                        break;
                    }
                    if !self.budget.live() {
                        break;
                    }
                }
                RuntimeValue::Bool(found)
            }
            "map" | "filter" => {
                if !self.budget.vector(values.len()) {
                    return RuntimeValue::Null;
                }
                let mut out = Vec::with_capacity(values.len());
                for (i, value) in values.iter().enumerate() {
                    let mut nested = self.copy_scope(scope);
                    let value_copy = self.clone_value(value);
                    self.budget.charge(1, 256);
                    nested.insert("value".into(), value_copy);
                    nested.insert("index".into(), count(i));
                    let result = arguments
                        .first()
                        .map(|v| self.evaluate(v, &nested))
                        .unwrap_or(RuntimeValue::Null);
                    if !self.budget.live() {
                        break;
                    }
                    if name == "map" {
                        out.push(result);
                    } else if result.is_truthy() {
                        out.push(self.clone_value(value));
                    }
                }
                RuntimeValue::List(out)
            }
            "reduce" => {
                let mut acc = arguments
                    .get(1)
                    .map(|v| self.evaluate(v, scope))
                    .unwrap_or(RuntimeValue::Null);
                for (i, value) in values.iter().enumerate() {
                    let mut nested = self.copy_scope(scope);
                    let value = self.clone_value(value);
                    self.budget.charge(1, 384);
                    nested.insert("value".into(), value);
                    nested.insert("index".into(), count(i));
                    nested.insert("acc".into(), acc);
                    acc = arguments
                        .first()
                        .map(|v| self.evaluate(v, &nested))
                        .unwrap_or(RuntimeValue::Null);
                    if !self.budget.live() {
                        break;
                    }
                }
                acc
            }
            "flat" => {
                let len = values.iter().try_fold(0usize, |n, v| {
                    n.checked_add(if let RuntimeValue::List(v) = v {
                        v.len()
                    } else {
                        1
                    })
                });
                let Some(len) = len else {
                    self.budget
                        .fail(EvaluationFailure::BudgetExceeded("allocation_estimate"));
                    return RuntimeValue::Null;
                };
                if !self.budget.vector(len) {
                    return RuntimeValue::Null;
                }
                let mut out = Vec::with_capacity(len);
                for value in values {
                    match value {
                        RuntimeValue::List(items) => {
                            for v in items {
                                out.push(self.clone_value(v));
                                if !self.budget.live() {
                                    break;
                                }
                            }
                        }
                        v => out.push(self.clone_value(v)),
                    }
                    if !self.budget.live() {
                        break;
                    }
                }
                RuntimeValue::List(out)
            }
            "join" => {
                let separator = arguments
                    .first()
                    .map(|v| self.evaluate(v, scope))
                    .unwrap_or(RuntimeValue::Null);
                let separator = self.string(&separator);
                let mut out = String::new();
                for (i, value) in values.iter().enumerate() {
                    let text = self.string(value);
                    if !self
                        .budget
                        .text(text.len().saturating_add(separator.len()), 2)
                    {
                        break;
                    }
                    if i != 0 {
                        out.push_str(&separator);
                    }
                    out.push_str(&text);
                }
                RuntimeValue::String(out)
            }
            "reverse" => {
                if !self.budget.vector(values.len()) {
                    return RuntimeValue::Null;
                }
                RuntimeValue::List(values.iter().rev().map(|v| self.clone_value(v)).collect())
            }
            "slice" => {
                let first = arguments
                    .first()
                    .map(|v| self.evaluate(v, scope))
                    .unwrap_or(RuntimeValue::Null);
                let start = self.number(&first).ok().and_then(integer).unwrap_or(0);
                let end = arguments
                    .get(1)
                    .map(|v| self.evaluate(v, scope))
                    .and_then(|v| self.number(&v).ok())
                    .and_then(integer);
                let (a, b) = bounds(values.len(), start, end);
                if !self.budget.vector(b - a) {
                    return RuntimeValue::Null;
                }
                RuntimeValue::List(values[a..b].iter().map(|v| self.clone_value(v)).collect())
            }
            "unique" => {
                if !self.budget.vector(values.len()) {
                    return RuntimeValue::Null;
                }
                let mut seen = std::collections::BTreeSet::new();
                let mut out = Vec::new();
                for value in values {
                    if unqualified_equality(value) {
                        return self.refuse("non_finite_comparison");
                    }
                    if !self.budget.value(value, 1, true) {
                        break;
                    }
                    let key = value.to_plain().to_json();
                    if seen.insert(key) {
                        out.push(self.clone_value(value));
                    }
                    if !self.budget.live() {
                        break;
                    }
                }
                RuntimeValue::List(out)
            }
            "sum" | "mean" => {
                if name == "mean" && values.is_empty() {
                    return RuntimeValue::Null;
                }
                let mut sum = 0.0;
                for value in values {
                    if !self.budget.charge(1, 0) {
                        break;
                    }
                    match self.number(value) {
                        Ok(v) => sum += v,
                        Err(error) => return RuntimeValue::Error(error),
                    }
                }
                RuntimeValue::Number(if name == "mean" {
                    sum / count_number(values.len())
                } else {
                    sum
                })
            }
            _ => method_error("List", name),
        }
    }
}

fn unqualified_equality(value: &RuntimeValue) -> bool {
    match value {
        RuntimeValue::Number(v) => !v.is_finite(),
        RuntimeValue::Error(_) => true,
        RuntimeValue::List(values) => values.iter().any(unqualified_equality),
        RuntimeValue::Object(values) => values.values().any(unqualified_equality),
        _ => false,
    }
}

fn member_error(kind: &str, key: &str) -> RuntimeValue {
    RuntimeValue::Error(format!("Cannot find {key:?} on type {kind}"))
}
fn method_error(kind: &str, name: &str) -> RuntimeValue {
    RuntimeValue::Error(format!("Cannot find function {name:?} on type {kind}"))
}
fn non_bmp(value: &str) -> bool {
    value.chars().any(|c| u32::from(c) > 0xffff)
}
#[allow(clippy::cast_precision_loss)]
fn count_number(value: usize) -> f64 {
    value as f64
} // in-memory bounded counters, never serialized usize
fn count(value: usize) -> RuntimeValue {
    RuntimeValue::Number(count_number(value))
}
fn integer(value: f64) -> Option<i64> {
    if !value.is_finite()
        || !(-9_223_372_036_854_775_808.0..9_223_372_036_854_775_808.0).contains(&value)
    {
        return None;
    }
    #[allow(clippy::cast_possible_truncation)]
    Some(value.trunc() as i64)
}
fn index(len: usize, value: i64) -> Option<usize> {
    let len = i64::try_from(len).ok()?;
    let value = if value < 0 {
        len.checked_add(value)?
    } else {
        value
    };
    (0..len)
        .contains(&value)
        .then(|| usize::try_from(value).expect("nonnegative bounded index"))
}
fn bounds(len: usize, start: i64, end: Option<i64>) -> (usize, usize) {
    let n = i64::try_from(len).expect("bounded vector length");
    let normalize = |v: i64| {
        usize::try_from(if v < 0 {
            n.saturating_add(v).max(0)
        } else {
            v.min(n)
        })
        .expect("bounded slice")
    };
    let start = normalize(start);
    (start, normalize(end.unwrap_or(n)).max(start))
}

#[cfg(test)]
mod calendar_tests;
mod duration_operations;
#[cfg(test)]
mod duration_tests;
mod file;
#[cfg(test)]
mod tests;
