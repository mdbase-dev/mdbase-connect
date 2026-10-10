//! Incremental-driver accounting, distinct from the frozen cumulative port meter.
//! Scratch is discarded between rows; request work, source and output never are.
//! This is not publication authority. A driver must stage every returned row and
//! suppress the entire staged output until source/index/authority fences finish.
use super::{BasesDisplayCell, BasesProjectedRow, EvaluationFailure, RuntimeValue, WorkBudget};

/// Fixed bounded inventory profile covering the 50k extreme corpus.
pub const MAX_INCREMENTAL_ROWS: u64 = 65_536;
/// Aggregate authenticated source work, not simultaneously retained source bytes.
pub const MAX_INCREMENTAL_SOURCE_BYTES: u64 = 1 << 30;
/// Aggregate residual evaluator work across the complete request.
pub const MAX_INCREMENTAL_STEPS: u64 = 64_000_000;
/// Cumulative staged output estimate. Frames must additionally be bounded by the
/// consuming driver; this is not permission to buffer a whole vault in scratch.
pub const MAX_INCREMENTAL_OUTPUT_BYTES: u64 = 128 << 20;

/// Sticky request ledger. No setter, refund, failure reset or caller-raised cap.
#[derive(Default)]
pub struct IncrementalBasesBudget {
    rows: u64,
    source: u64,
    steps: u64,
    output: u64,
    active: bool,
    failure: Option<EvaluationFailure>,
}
impl IncrementalBasesBudget {
    /// Empty independent request ledger; legacy WorkBudget limits stay unchanged.
    pub fn new() -> Self {
        Self::default()
    }
    /// First fatal refusal; a failed/unfinished row poisons all future calls.
    pub fn failure(&self) -> Option<EvaluationFailure> {
        self.failure
    }
    fn fail<T>(&mut self, failure: EvaluationFailure) -> Result<T, EvaluationFailure> {
        self.failure.get_or_insert(failure);
        Err(self.failure.expect("sticky incremental failure"))
    }
    /// Account retained plan/identity/index ownership in the same fixed output
    /// ledger. This is an estimate, not serialized length or peak heap evidence.
    /// No refunds or caller-raised caps: discarded transient frames are separate.
    pub fn retain(&mut self, bytes: u64) -> Result<(), EvaluationFailure> {
        if let Some(failure) = self.failure {
            return Err(failure);
        }
        if self.active {
            return self.fail(EvaluationFailure::BudgetExceeded(
                "incremental_scratch_unfinished",
            ));
        }
        let Some(next) = self
            .output
            .checked_add(bytes)
            .filter(|n| *n <= MAX_INCREMENTAL_OUTPUT_BYTES)
        else {
            return self.fail(EvaluationFailure::BudgetExceeded("incremental_output"));
        };
        self.output = next;
        Ok(())
    }
    /// Admit trusted plan/page inspection under unchanged scratch ceilings and
    /// the SAME sticky aggregate steps as residual rows and final ordering.
    /// Caller accounts retained ownership with `retain` before allocation; this
    /// scope is not source or publication authority and cannot refund work.
    pub fn admit<T>(
        &mut self,
        evaluate: impl FnOnce(&mut WorkBudget) -> Result<T, EvaluationFailure>,
    ) -> Result<T, EvaluationFailure> {
        self.helper(evaluate)
    }
    /// Bounded transient helper work for final typed ordering, sharing the SAME
    /// sticky cumulative request steps while leaving source-row counts intact.
    pub(super) fn helper<T>(
        &mut self,
        evaluate: impl FnOnce(&mut WorkBudget) -> Result<T, EvaluationFailure>,
    ) -> Result<T, EvaluationFailure> {
        if let Some(failure) = self.failure {
            return Err(failure);
        }
        if self.active {
            return self.fail(EvaluationFailure::BudgetExceeded(
                "incremental_scratch_unfinished",
            ));
        }
        let mut scratch = WorkBudget::constrained(MAX_INCREMENTAL_STEPS - self.steps, 1 << 20);
        let before = scratch.remaining_steps();
        self.active = true;
        let result = evaluate(&mut scratch);
        self.active = false;
        self.steps += before - scratch.remaining_steps();
        if let Some(failure) = scratch.failure() {
            return self.fail(failure);
        }
        match result {
            Ok(value) => Ok(value),
            Err(failure) => self.fail(failure),
        }
    }
    /// Evaluate one admitted source row under the unchanged 1 MiB/2M scratch
    /// meter. Only transient row-local work may use this scope; retained plans,
    /// input pages and output frames require separate bounded driver ownership.
    /// Every child step is charged to this SAME request ledger even on failure.
    pub fn row(
        &mut self,
        source_bytes: u64,
        evaluate: impl FnOnce(&mut WorkBudget) -> Result<Option<BasesProjectedRow>, EvaluationFailure>,
    ) -> Result<Option<BasesProjectedRow>, EvaluationFailure> {
        if let Some(failure) = self.failure {
            return Err(failure);
        }
        if self.active {
            return self.fail(EvaluationFailure::BudgetExceeded(
                "incremental_scratch_unfinished",
            ));
        }
        let rows = self.rows.checked_add(1);
        let source = self.source.checked_add(source_bytes);
        if rows.is_none_or(|rows| rows > MAX_INCREMENTAL_ROWS)
            || source_bytes > 1 << 20
            || source.is_none_or(|bytes| bytes > MAX_INCREMENTAL_SOURCE_BYTES)
        {
            return self.fail(EvaluationFailure::BudgetExceeded("incremental_source"));
        }
        self.rows = rows.expect("checked row count");
        self.source = source.expect("checked source bytes");
        self.project_admitted(evaluate)
    }
    /// Reproject a previously admitted SAME source identity for a display
    /// window, after the driver verifies its path/revision/snapshot. Does not
    /// invent another inventory row or refund anything: SAME sticky steps,
    /// transient scratch and retained-output accounting still apply.
    pub fn project_admitted(
        &mut self,
        evaluate: impl FnOnce(&mut WorkBudget) -> Result<Option<BasesProjectedRow>, EvaluationFailure>,
    ) -> Result<Option<BasesProjectedRow>, EvaluationFailure> {
        let row = self.helper(evaluate)?;
        if let Some(row) = &row {
            let bytes = output_bytes(row, &mut self.steps);
            let bytes = match bytes {
                Ok(bytes) => bytes,
                Err(failure) => return self.fail(failure),
            };
            let next = self.output.checked_add(bytes);
            if next.is_none_or(|bytes| bytes > MAX_INCREMENTAL_OUTPUT_BYTES) {
                return self.fail(EvaluationFailure::BudgetExceeded("incremental_output"));
            }
            self.output = next.expect("checked staged output");
        }
        Ok(row)
    }
}
fn add(bytes: u64, extra: u64) -> Result<u64, EvaluationFailure> {
    bytes
        .checked_add(extra)
        .filter(|n| *n <= MAX_INCREMENTAL_OUTPUT_BYTES)
        .ok_or(EvaluationFailure::BudgetExceeded("incremental_output"))
}
fn step(steps: &mut u64) -> Result<(), EvaluationFailure> {
    *steps = steps
        .checked_add(1)
        .filter(|n| *n <= MAX_INCREMENTAL_STEPS)
        .ok_or(EvaluationFailure::BudgetExceeded("work"))?;
    Ok(())
}
fn output_bytes(row: &BasesProjectedRow, steps: &mut u64) -> Result<u64, EvaluationFailure> {
    step(steps)?;
    let mut bytes = 128u64;
    for value in row.sort.iter().chain(row.group.iter()) {
        bytes = add(bytes, value_bytes(value, 1, steps)?)?;
    }
    for cell in &row.cells {
        bytes = add(
            bytes,
            match cell {
                BasesDisplayCell::Value(value) => value_bytes(value, 1, steps)?,
                BasesDisplayCell::Unavailable { .. } => {
                    step(steps)?;
                    128
                }
            },
        )?;
    }
    Ok(bytes)
}
fn value_bytes(
    value: &RuntimeValue,
    depth: usize,
    steps: &mut u64,
) -> Result<u64, EvaluationFailure> {
    step(steps)?;
    if depth > super::MAX_VALUE_DEPTH {
        return Err(EvaluationFailure::BudgetExceeded("value_depth"));
    }
    let mut bytes = 128u64;
    match value {
        RuntimeValue::String(value) | RuntimeValue::Error(value) => {
            bytes = add(bytes, value.len() as u64)?
        }
        RuntimeValue::Date(value) => bytes = add(bytes, value.display().len() as u64)?,
        RuntimeValue::Duration(value) => bytes = add(bytes, value.display().len() as u64)?,
        RuntimeValue::List(values) => {
            for value in values {
                bytes = add(bytes, value_bytes(value, depth + 1, steps)?)?;
            }
        }
        RuntimeValue::Object(values) => {
            for (key, value) in values {
                bytes = add(
                    add(bytes, key.len() as u64)?,
                    value_bytes(value, depth + 1, steps)?,
                )?;
            }
        }
        _ => {}
    }
    Ok(bytes)
}
#[cfg(test)]
mod tests;
