//! Bases selector adapter over the existing bounded Core query reduction kernel.
//! Filters/formulas stay in Bases dialect; custom reductions use Core's CEL API.
use super::*;
use crate::query::{Query, QueryEnv, groups, indexed::TemporalHint};
use crate::value::Map;

#[path = "summaries/values.rs"]
mod values;

pub(super) fn compile(
    view: &BaseView<'_>,
    budget: &mut WorkBudget,
) -> Result<(Vec<groups::CompiledSummary>, Vec<PropertySelector>), FilterAdmissionFailure> {
    let declarations = view.raw.get("summaries");
    let functions = view.raw.get("summary_functions");
    super::super::host_renderer::admit_computation_metadata(&[declarations, functions], budget)?;
    let invalid =
        || FilterAdmissionFailure::Source(ErrorKind::UnsupportedConstruct("base_view_summaries"));
    let mut specs = match declarations {
        None => Vec::new(),
        Some(Value::List(items)) if items.len() <= groups::MAX_FIELDS => items.clone(),
        Some(Value::Map(items)) if items.len() <= groups::MAX_FIELDS => {
            let mut specs = Vec::new();
            for (field, function) in items.iter() {
                let function = function.as_str().ok_or_else(invalid)?;
                specs.push(Value::Map(Map::from_iter([
                    ("field".into(), Value::string(field)),
                    ("function".into(), Value::string(function)),
                    ("name".into(), Value::string(field)),
                ])));
            }
            specs
        }
        _ => return Err(invalid()),
    };
    let mut selectors = Vec::new();
    for spec in &mut specs {
        let map = spec.as_map().ok_or_else(invalid)?;
        if map
            .iter()
            .any(|(k, _)| !matches!(k, "field" | "function" | "name"))
        {
            return Err(invalid());
        }
        let field = map
            .get("field")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?;
        selectors.push(
            PropertySelector::parse(field).map_err(|e| FilterAdmissionFailure::Source(e.kind))?,
        );
        let mut map = map.clone();
        // Query fields and Bases selectors are distinct grammars. The Core
        // reducer only consumes positional inputs; install the exact field below.
        map.insert("field", Value::string("input"));
        let function = map
            .get("function")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?;
        let is_custom = functions
            .and_then(Value::as_map)
            .is_some_and(|map| map.get(function).is_some());
        let builtin = if is_custom {
            function
        } else {
            match function {
                "Count" => "count",
                "Sum" => "sum",
                "Average" => "average",
                "Min" | "Minimum" => "minimum",
                "Max" | "Maximum" => "maximum",
                "Earliest" => "earliest",
                "Latest" => "latest",
                "Empty" => "empty",
                "Filled" => "filled",
                name => name,
            }
        }
        .to_owned();
        let name = function.to_owned();
        if map.get("name").is_none() {
            map.insert("name", Value::string(name));
        }
        map.insert("function", Value::string(builtin));
        *spec = Value::Map(map);
    }
    let mut raw = Map::from_iter([("summaries".into(), Value::List(specs))]);
    if let Some(functions) = functions {
        raw.insert("summary_functions", functions.clone());
    }
    let query = Query::from_value(&Value::Map(raw)).map_err(|_| invalid())?;
    let mut compiled =
        groups::compile(&query.summaries, &query.summary_functions).map_err(|_| invalid())?;
    for (summary, selector) in compiled.iter_mut().zip(&selectors) {
        if summary.name.is_empty()
            || summary.name.len() > 1024
            || summary.name.chars().any(char::is_control)
        {
            return Err(invalid());
        }
        summary.field = match selector {
            PropertySelector::Note(key) => crate::query::FieldRef::Effective(vec![key.clone()]),
            PropertySelector::Formula(key) => crate::query::FieldRef::Projection(key.clone()),
            PropertySelector::File(key) if key == "path" => crate::query::FieldRef::Path,
            PropertySelector::File(key) => crate::query::FieldRef::File(key.clone()),
        };
    }
    Ok((compiled, selectors))
}

impl AdmittedBasesView {
    /// Whole-view reductions over the complete matching set in global order,
    /// BEFORE the source limit or display window. No partial/fake-null success.
    pub fn summarize<'a>(
        &self,
        rows: impl Iterator<Item = &'a BasesProjectedRow>,
        env: &QueryEnv,
        budget: &mut WorkBudget,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Vec<(String, RuntimeValue)>, EvaluationFailure> {
        if self.summaries.is_empty() {
            return Ok(Vec::new());
        }
        let mut metadata = groups::Budget::default();
        let mut staged = Vec::new();
        for row in rows {
            if cancelled() {
                return Err(EvaluationFailure::Cancelled);
            }
            if staged.len() >= groups::MAX_ROWS {
                return Err(EvaluationFailure::BudgetExceeded("view_summary_rows"));
            }
            if row.summary_inputs.len() != self.summaries.len() {
                return Err(EvaluationFailure::UnsupportedConstruct(
                    "view_summary_arity",
                ));
            }
            if !budget.charge(1, 64 + row.summary_inputs.len() as u64 * 128) {
                return Err(budget.failure().expect("summary row"));
            }
            let mut inputs = Vec::new();
            for value in &row.summary_inputs {
                let (value, native, hint) = values::input(value, 1, budget)?;
                inputs.push(
                    groups::Input::new(&value, native, hint, &mut metadata)
                        .map_err(kernel_failure)?,
                );
            }
            staged.push(groups::Row {
                keys: Vec::new(),
                inputs,
            });
        }
        let refs = staged.iter().collect::<Vec<_>>();
        // Charge the bounded kernel's complete worst-case scans; custom CEL has
        // its own fixed evaluation ceiling, also precharged to this request.
        let custom = self
            .summaries
            .iter()
            .filter(|s| matches!(s.function, groups::SummaryFn::Custom(_)))
            .count();
        let steps = (staged.len() as u64 + 1) * self.summaries.len() as u64 * 4
            + groups::MAX_NODES as u64 * 8
            + custom as u64 * crate::cel::MAX_EVAL_STEPS;
        if !budget.charge(steps, staged.len() as u64 * 32) {
            return Err(budget.failure().expect("summary kernel"));
        }
        let mut diagnostics = Vec::new();
        let reduced = groups::reduce(&[], &self.summaries, &refs, env, &mut diagnostics)
            .map_err(kernel_failure)?;
        if !diagnostics.is_empty() {
            return Err(EvaluationFailure::UnsupportedConstruct(
                "view_summary_evaluation",
            ));
        }
        if cancelled() {
            return Err(EvaluationFailure::Cancelled);
        }
        let group = reduced.and_then(|mut groups| groups.pop()).ok_or(
            EvaluationFailure::UnsupportedConstruct("view_summary_shape"),
        )?;
        let mut output = Vec::new();
        for summary in &self.summaries {
            let value = group.summaries.get(&summary.name).ok_or(
                EvaluationFailure::UnsupportedConstruct("view_summary_shape"),
            )?;
            if !budget.charge(
                summary.name.len() as u64 + 1,
                summary.name.len() as u64 + 64,
            ) {
                return Err(budget.failure().expect("summary name"));
            }
            output.push((summary.name.clone(), values::output(value, 1, budget)?));
        }
        Ok(output)
    }
}
fn kernel_failure(error: crate::query::QueryError) -> EvaluationFailure {
    if error.code == "query_budget_exceeded" {
        EvaluationFailure::BudgetExceeded("view_summary_metadata")
    } else {
        EvaluationFailure::UnsupportedConstruct("view_summary_evaluation")
    }
}
