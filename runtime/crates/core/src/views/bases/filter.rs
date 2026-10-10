//! Bounded global/local Bases filter admission. No CEL, SQL, discovery or I/O:
//! callers provide the actual raw contract-projected filter values.
use super::syntax::qualify_syntax;
use super::{
    Bindings, ErrorKind, EvaluationFailure, Expression, MAX_SOURCE_BYTES, Profile, Program,
    RuntimeValue, WorkBudget,
};
use crate::value::Value;
use std::collections::BTreeMap;
const MAX_FILTER_NODES: usize = 256;
/// Safe admission refusal, preserving parser/formula-cycle classifications.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FilterAdmissionFailure {
    /// Original fixed parser/capability/formula-cycle refusal.
    Source(ErrorKind),
    /// Sticky admission work/allocation/availability failure.
    Work(EvaluationFailure),
}
impl FilterAdmissionFailure {
    /// Fixed safe reason code, independent of user source text.
    pub fn code(self) -> &'static str {
        match self {
            Self::Source(e) => e.code(),
            Self::Work(e) => e.code(),
        }
    }
    /// Fixed safe detail, never a formula name or expression literal.
    pub fn detail(self) -> &'static str {
        match self {
            Self::Source(e) => e.detail(),
            Self::Work(e) => e.detail(),
        }
    }
}
/// One admitted combined filter, owning just one formula library. Lowered source
/// is private; original record bytes are never edited. No view authority.
pub struct AdmittedBasesFilter {
    program: Program,
}
impl AdmittedBasesFilter {
    /// Admit every global/local branch before any rows, including lazy branches.
    /// Absence is known-true; explicit malformed/unknown shapes visibly refuse.
    pub fn compile(
        shared: Option<&Value>,
        local: Option<&Value>,
        formulas: &BTreeMap<String, String>,
        profile: Profile,
        budget: &mut WorkBudget,
    ) -> Result<Self, FilterAdmissionFailure> {
        let mut lowered = Lowered {
            source: String::new(),
            nodes: 0,
            budget,
        };
        lowered.append("(")?;
        lowered.filter(shared, 1)?;
        lowered.append(") && (")?;
        lowered.filter(local, 1)?;
        lowered.append(")")?;
        let Some(bytes) = formulas.iter().try_fold(0usize, |n, (k, v)| {
            n.checked_add(k.len()).and_then(|n| n.checked_add(v.len()))
        }) else {
            return work_fail(
                lowered.budget,
                EvaluationFailure::BudgetExceeded("filter_formula_bytes"),
            );
        };
        if formulas.len() > super::MAX_FORMULAS || bytes > super::MAX_PROGRAM_SOURCE_BYTES {
            return work_fail(
                lowered.budget,
                EvaluationFailure::BudgetExceeded("filter_formula_bytes"),
            );
        }
        // Reserve names/source/AST estimate before parsing/copying the one library.
        if !lowered.budget.charge(
            (bytes + formulas.len()) as u64,
            (bytes * 8 + formulas.len() * 128) as u64,
        ) {
            return Err(FilterAdmissionFailure::Work(
                lowered.budget.failure().expect("filter library budget"),
            ));
        }
        let program = match Program::compile_with_profile(&lowered.source, formulas, profile) {
            Ok(p) => p,
            Err(e) => return source_fail(lowered.budget, e.kind),
        };
        Ok(Self { program })
    }
    /// Execute with the same sticky request meter and cooperative cancellation.
    /// A source Error is neither truthy success nor a silently excluded row.
    pub fn matches(
        &self,
        bindings: Bindings<'_>,
        budget: &mut WorkBudget,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<bool, EvaluationFailure> {
        let result = self
            .program
            .evaluate_filter_with_cancel(bindings, budget, cancelled)?;
        match result {
            RuntimeValue::Bool(value) => Ok(value),
            RuntimeValue::Error(_) => {
                budget.fail(EvaluationFailure::UnsupportedConstruct(
                    "filter_expression_error",
                ));
                Err(budget.failure().expect("filter source error"))
            }
            _ => {
                budget.fail(EvaluationFailure::UnsupportedConstruct(
                    "filter_result_shape",
                ));
                Err(budget.failure().expect("filter shape error"))
            }
        }
    }
}
pub(super) struct Lowered<'a> {
    pub(super) source: String,
    pub(super) nodes: usize,
    pub(super) budget: &'a mut WorkBudget,
}
impl Lowered<'_> {
    pub(super) fn append(&mut self, text: &str) -> Result<(), FilterAdmissionFailure> {
        if self.source.len().saturating_add(text.len()) > MAX_SOURCE_BYTES {
            return work_fail(
                self.budget,
                EvaluationFailure::BudgetExceeded("filter_expression_bytes"),
            );
        }
        if !self
            .budget
            .charge(text.len() as u64, (text.len() * 2) as u64)
        {
            return Err(FilterAdmissionFailure::Work(
                self.budget.failure().expect("filter source budget"),
            ));
        }
        self.source.push_str(text);
        Ok(())
    }
    pub(super) fn filter(
        &mut self,
        value: Option<&Value>,
        depth: usize,
    ) -> Result<(), FilterAdmissionFailure> {
        self.nodes += 1;
        if depth > 32 || self.nodes > MAX_FILTER_NODES {
            return work_fail(
                self.budget,
                EvaluationFailure::BudgetExceeded("filter_nodes"),
            );
        }
        if !self.budget.charge(1, 0) {
            return Err(FilterAdmissionFailure::Work(
                self.budget.failure().expect("filter tree budget"),
            ));
        }
        match value {
            None => self.append("true"),
            Some(Value::Text(source)) => {
                if source.len() > MAX_SOURCE_BYTES {
                    return work_fail(
                        self.budget,
                        EvaluationFailure::BudgetExceeded("filter_expression_bytes"),
                    );
                }
                if !self
                    .budget
                    .charge(source.len() as u64, (source.len() * 8) as u64)
                {
                    return Err(FilterAdmissionFailure::Work(
                        self.budget.failure().expect("filter leaf budget"),
                    ));
                }
                // Validate standalone syntax before embedding; malformed fragments cannot
                // become valid by closing the wrapper or injecting another expression.
                if let Err(e) =
                    qualify_syntax(source).and_then(|()| Expression::parse(source).map(|_| ()))
                {
                    return source_fail(self.budget, e.kind);
                }
                self.append("(")?;
                self.append(source)?;
                self.append(").isTruthy()")
            }
            Some(Value::Map(map)) if map.len() == 1 => {
                let (op, operand) = map.iter().next().expect("one operator");
                if !matches!(op, "and" | "or" | "not") {
                    return work_fail(
                        self.budget,
                        EvaluationFailure::UnsupportedConstruct("base_filter_operator"),
                    );
                }
                let values = match operand {
                    Value::List(values) => values.as_slice(),
                    _ => std::slice::from_ref(operand),
                };
                self.append("(")?;
                if values.is_empty() {
                    self.append(if op == "or" { "false" } else { "true" })?;
                }
                for (index, value) in values.iter().enumerate() {
                    if index > 0 {
                        self.append(if op == "or" { " || " } else { " && " })?;
                    }
                    if op == "not" {
                        self.append("!(")?;
                    }
                    self.filter(Some(value), depth + 1)?;
                    if op == "not" {
                        self.append(")")?;
                    }
                }
                self.append(")")
            }
            _ => work_fail(
                self.budget,
                EvaluationFailure::UnsupportedConstruct("base_filter_shape"),
            ),
        }
    }
}
pub(super) fn work_fail<T>(
    budget: &mut WorkBudget,
    e: EvaluationFailure,
) -> Result<T, FilterAdmissionFailure> {
    budget.fail(e);
    Err(FilterAdmissionFailure::Work(
        budget.failure().expect("sticky filter work failure"),
    ))
}
pub(super) fn source_fail<T>(
    budget: &mut WorkBudget,
    e: ErrorKind,
) -> Result<T, FilterAdmissionFailure> {
    // The request meter cannot represent parser/cycle codes. Keep its sticky stop
    // bit while returning the original safe source classification to the caller.
    let stop = match e {
        ErrorKind::BudgetExceeded(detail) => EvaluationFailure::BudgetExceeded(detail),
        _ => EvaluationFailure::UnsupportedConstruct(e.detail()),
    };
    if budget.failure().is_some() {
        return Err(FilterAdmissionFailure::Work(
            budget.failure().expect("prior filter failure"),
        ));
    }
    budget.fail(stop);
    Err(FilterAdmissionFailure::Source(e))
}
#[cfg(test)]
mod file_tests;
#[cfg(test)]
mod tests;
pub(crate) mod witness;
