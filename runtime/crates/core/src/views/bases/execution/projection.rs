//! Exact source requirements for bounded raw pages, not candidate lowering.
use super::*;
use std::collections::BTreeSet;

/// Maximum distinct raw names in a projection, without a Core -> Replica edge.
pub const MAX_BASES_PROJECTION_FIELDS: usize = 64;
/// Maximum literal top-level raw-name UTF-8 bytes in this projection profile.
pub const MAX_BASES_PROJECTION_FIELD_BYTES: usize = 256;
/// Complete raw inputs needed by every reachable evaluable root of one plan.
/// This is a dependency declaration, never an authorization or SQL predicate.
#[derive(Debug, PartialEq, Eq)]
pub struct BasesProjectionRequirements {
    /// Sorted distinct literal top-level raw names; absence remains Missing.
    pub fields: Vec<String>,
    /// Capture qualified file tags, including unavailable versus known-empty.
    pub tags: bool,
}
struct Capture<'a> {
    program: &'a Program,
    fields: BTreeSet<String>,
    seen: BTreeSet<String>,
    tags: bool,
    budget: &'a mut WorkBudget,
}
impl Capture<'_> {
    fn fail<T>(&mut self, error: EvaluationFailure) -> Result<T, EvaluationFailure> {
        self.budget.fail(error);
        Err(self
            .budget
            .failure()
            .expect("sticky projection requirements"))
    }
    fn field(&mut self, name: &str) -> Result<(), EvaluationFailure> {
        if name.is_empty() || name.len() > MAX_BASES_PROJECTION_FIELD_BYTES {
            return self.fail(EvaluationFailure::MetadataUnavailable(
                "raw_property_projection_unqualified",
            ));
        }
        if self.fields.contains(name) {
            return Ok(());
        }
        if self.fields.len() >= MAX_BASES_PROJECTION_FIELDS {
            return self.fail(EvaluationFailure::BudgetExceeded(
                "raw_property_projection_count",
            ));
        }
        if !self
            .budget
            .charge(name.len() as u64 + 1, name.len() as u64 + 64)
        {
            return Err(self.budget.failure().expect("field copy"));
        }
        self.fields.insert(name.into());
        Ok(())
    }
    fn walk(&mut self, expr: &Expr, depth: usize) -> Result<(), EvaluationFailure> {
        if depth > MAX_AST_DEPTH {
            return self.fail(EvaluationFailure::BudgetExceeded("program_depth"));
        }
        if !self.budget.charge(1, 0) {
            return Err(self.budget.failure().expect("projection walk"));
        }
        match expr {
            Expr::Literal(_) | Expr::Regex(_, _) => Ok(()),
            // Materializing/enumerating note needs all keys/values, not a subset.
            Expr::Identifier(name) if name == "note" => self.fail(
                EvaluationFailure::MetadataUnavailable("raw_property_projection_unqualified"),
            ),
            Expr::Identifier(name) if name == "formula" => Ok(()),
            // Scoped value/index/acc can shadow raw names. Including their raw
            // counterpart is conservative, and never changes residual bindings.
            Expr::Identifier(name) => self.field(name),
            Expr::Array(values) => {
                for value in values {
                    self.walk(value, depth + 1)?;
                }
                Ok(())
            }
            Expr::Unary(_, value) => self.walk(value, depth + 1),
            Expr::Binary(_, left, right) => {
                self.walk(left, depth + 1)?;
                self.walk(right, depth + 1)
            }
            Expr::Member(operand, member) => {
                if let Some(name) = super::super::file_bindings::field_name(operand, member) {
                    self.tags |= name == "tags";
                    return Ok(());
                }
                if matches!(operand.as_ref(),Expr::Identifier(name) if name=="formula") {
                    let name = match member {
                        Member::Named(name) => name,
                        Member::Computed(key) => match key.as_ref() {
                            Expr::Literal(Value::Text(name)) => name,
                            _ => {
                                return self.fail(EvaluationFailure::MetadataUnavailable(
                                    "raw_property_projection_unqualified",
                                ));
                            }
                        },
                    };
                    if !self.seen.contains(name) {
                        if !self
                            .budget
                            .charge(name.len() as u64 + 1, name.len() as u64 + 48)
                        {
                            return Err(self.budget.failure().expect("formula memo"));
                        }
                        self.seen.insert(name.clone());
                        let Some(formula) = self.program.formulas.get(name) else {
                            return self.fail(EvaluationFailure::UnsupportedConstruct(
                                "unresolved_formula",
                            ));
                        };
                        self.walk(formula.ast(), depth + 1)?;
                    }
                    return Ok(());
                }
                if matches!(operand.as_ref(),Expr::Identifier(name) if name=="note") {
                    return match member {
                        Member::Named(name) => self.field(name),
                        Member::Computed(key) => match key.as_ref() {
                            Expr::Literal(Value::Text(name)) => self.field(name),
                            _ => self.fail(EvaluationFailure::MetadataUnavailable(
                                "raw_property_projection_unqualified",
                            )),
                        },
                    };
                }
                self.walk(operand, depth + 1)?;
                if let Member::Computed(key) = member {
                    self.walk(key, depth + 1)?;
                }
                Ok(())
            }
            Expr::Call(callee, args) => {
                match callee.as_ref() {
                    // Global function names are not property reads.
                    Expr::Identifier(_) => {}
                    Expr::Member(operand, Member::Named(method)) if matches!(operand.as_ref(),Expr::Identifier(name) if name=="file") =>
                    {
                        self.tags |= method == "hasTag" && !args.is_empty();
                        if method == "hasProperty" && args.len() == 1 {
                            let Expr::Literal(Value::Text(name)) = &args[0] else {
                                return self.fail(EvaluationFailure::MetadataUnavailable(
                                    "raw_property_projection_unqualified",
                                ));
                            };
                            self.field(name)?;
                        }
                    }
                    Expr::Member(operand, _) => self.walk(operand, depth + 1)?,
                    _ => self.walk(callee, depth + 1)?,
                }
                for arg in args {
                    self.walk(arg, depth + 1)?;
                }
                Ok(())
            }
        }
    }
}
impl AdmittedBasesView {
    /// Derive complete bounded raw-name/tag requirements from the admitted AST,
    /// visiting reachable formulas once and ignoring unavailable display roots.
    /// Whole-note/dynamic property access refuses; never counterfeit Missing.
    /// This profile leaves ordinary whole-source execution semantics unchanged.
    pub fn projection_requirements(
        &self,
        budget: &mut WorkBudget,
    ) -> Result<BasesProjectionRequirements, EvaluationFailure> {
        self.capture_projection_requirements(true, budget)
    }
    /// Literal raw inputs reachable from the exact filter/sort/group roots.
    /// Display requirements must be admitted independently before publication;
    /// this subset is not permission to fabricate missing display facts.
    pub fn semantic_projection_requirements(
        &self,
        budget: &mut WorkBudget,
    ) -> Result<BasesProjectionRequirements, EvaluationFailure> {
        self.capture_projection_requirements(false, budget)
    }
    fn capture_projection_requirements(
        &self,
        display: bool,
        budget: &mut WorkBudget,
    ) -> Result<BasesProjectionRequirements, EvaluationFailure> {
        let mut capture = Capture {
            program: &self.program,
            fields: BTreeSet::new(),
            seen: BTreeSet::new(),
            tags: false,
            budget,
        };
        let Expr::Array(roots) = self.program.expression.ast() else {
            return capture.fail(EvaluationFailure::UnsupportedConstruct(
                "base_view_program_shape",
            ));
        };
        let semantic = self.sort.len() + usize::from(self.group.is_some());
        let count = if display { roots.len() } else { semantic + 1 };
        for (index, root) in roots.iter().take(count).enumerate() {
            if index > semantic && self.unavailable[index - semantic - 1].is_some() {
                continue;
            }
            capture.walk(root, 1)?;
        }
        Ok(BasesProjectionRequirements {
            fields: capture.fields.into_iter().collect(),
            tags: capture.tags,
        })
    }
}
#[cfg(test)]
#[path = "projection/differential.rs"]
mod differential;
#[cfg(test)]
#[path = "projection/semantic.rs"]
mod semantic;
#[cfg(test)]
#[path = "projection/tests.rs"]
mod tests;
