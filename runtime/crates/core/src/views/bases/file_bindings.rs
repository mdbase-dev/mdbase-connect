//! Borrowed immutable file facts for the explicit TaskSlice1 component profile.
//! No path -> metadata inference, ambient stat/graph or implicit empty tag list.
use super::{
    CapturedFile, EvaluationFailure, MAX_CAPTURE_ITEMS, MAX_CAPTURE_TEXT_BYTES, WorkBudget,
};
/// Captured file identity/facts and an explicitly known or unavailable tag set.
/// Pure host data: this value does not authorize reads or authenticate a replica.
#[derive(Clone, Copy)]
pub struct CapturedFileBindings<'a> {
    pub(super) file: &'a CapturedFile,
    pub(super) tags: Option<&'a [String]>,
}
impl<'a> CapturedFileBindings<'a> {
    /// Borrow once after checking all supplied tags. `None` is unavailable;
    /// `Some(&[])` is known-empty. Never derive tags from labels/defaults here.
    pub fn capture(
        file: &'a CapturedFile,
        tags: Option<&'a [String]>,
        budget: &mut WorkBudget,
    ) -> Result<Self, EvaluationFailure> {
        if !budget.charge(1, 0) {
            return Err(budget.failure().expect("file capture budget"));
        }
        if let Some(tags) = tags {
            if tags.len() > MAX_CAPTURE_ITEMS {
                return fail(budget, EvaluationFailure::BudgetExceeded("file_tag_count"));
            }
            let mut bytes = 0usize;
            for tag in tags {
                if tag.starts_with("##") {
                    return fail(
                        budget,
                        EvaluationFailure::UnsupportedConstruct("tag_prefix_unqualified"),
                    );
                }
                bytes = bytes.checked_add(tag.len()).ok_or_else(|| {
                    let e = EvaluationFailure::BudgetExceeded("file_tag_bytes");
                    budget.fail(e);
                    e
                })?;
                if tag.len() > MAX_CAPTURE_TEXT_BYTES || bytes > 65_536 {
                    return fail(budget, EvaluationFailure::BudgetExceeded("file_tag_bytes"));
                }
                if !budget.charge(tag.len() as u64, 0) {
                    return Err(budget.failure().expect("tag capture budget"));
                }
            }
        }
        Ok(Self { file, tags })
    }
}
pub(super) fn fail<T>(
    budget: &mut WorkBudget,
    e: EvaluationFailure,
) -> Result<T, EvaluationFailure> {
    budget.fail(e);
    Err(budget.failure().expect("sticky file binding failure"))
}
pub(super) fn field_name<'a>(operand: &super::Expr, member: &'a super::Member) -> Option<&'a str> {
    if !matches!(operand,super::Expr::Identifier(name) if name=="file") {
        return None;
    }
    match member {
        super::Member::Named(name) => Some(name),
        super::Member::Computed(expr) => match expr.as_ref() {
            super::Expr::Literal(crate::value::Value::Text(name)) => Some(name),
            _ => None,
        },
    }
}
#[cfg(test)]
mod tests;
pub(crate) mod witness;
