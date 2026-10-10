//! Sticky request-wide evaluator meter, outside ordinary Bases Error values.

use super::RuntimeValue;

/// Maximum evaluator AST/helper steps in this unactivated port profile.
pub const MAX_WORK_STEPS: u64 = 2_000_000;
/// Cumulative allocation-estimate ceiling for this unactivated port profile.
/// This is not a measurement or proof of the replica query's peak heap.
pub const MAX_ALLOCATION_BYTES: u64 = 1_048_576;
/// Captured/generated value depth; bounds conversion, cloning and rendering.
pub const MAX_VALUE_DEPTH: usize = 32;
/// Recursive evaluator calls across AST, formulas and list callbacks together.
pub const MAX_EVALUATION_DEPTH: usize = 32;

/// A fatal evaluator refusal, never a falsey RuntimeValue::Error or display cell.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum EvaluationFailure {
    /// A fixed work/allocation/recursion limit was reached.
    BudgetExceeded(&'static str),
    /// Cooperative caller cancellation.
    Cancelled,
    /// A data capability outside the currently ported profile.
    UnsupportedConstruct(&'static str),
    /// An explicitly absent capture needed for semantic use. Never an
    /// expression value or a display-only unavailable cell.
    MetadataUnavailable(&'static str),
}

impl EvaluationFailure {
    /// Fixed, safe diagnostic identifier, never a property name or literal.
    pub fn detail(self) -> &'static str {
        match self {
            Self::BudgetExceeded(detail)
            | Self::UnsupportedConstruct(detail)
            | Self::MetadataUnavailable(detail) => detail,
            Self::Cancelled => "cancelled",
        }
    }

    /// Safe reason code; no new wire variant is introduced by this port.
    pub fn code(self) -> &'static str {
        match self {
            Self::BudgetExceeded(_) => "query_budget_exceeded",
            Self::Cancelled => "query_cancelled",
            Self::UnsupportedConstruct(_) => "view_unsupported_construct",
            Self::MetadataUnavailable(_) => "view_metadata_unavailable",
        }
    }
}

/// Caller-owned meter shared by every row/expression in a request. Once failed,
/// it stays failed and later calls refuse; the evaluator never resets it.
#[derive(Debug)]
pub struct WorkBudget {
    steps: u64,
    bytes: u64,
    failure: Option<EvaluationFailure>,
}

impl Default for WorkBudget {
    fn default() -> Self {
        Self::new()
    }
}

impl WorkBudget {
    /// Fixed port-profile ceilings, independent of wire/query execution profiles.
    pub fn new() -> Self {
        Self::constrained(MAX_WORK_STEPS, MAX_ALLOCATION_BYTES)
    }

    /// Reduce ceilings for a caller/test. Arguments can never raise the profile.
    pub fn constrained(steps: u64, bytes: u64) -> Self {
        Self {
            steps: steps.min(MAX_WORK_STEPS),
            bytes: bytes.min(MAX_ALLOCATION_BYTES),
            failure: None,
        }
    }

    /// Remaining semantic/helper work, without resetting it.
    pub fn remaining_steps(&self) -> u64 {
        self.steps
    }
    /// First fatal refusal, if any.
    pub fn failure(&self) -> Option<EvaluationFailure> {
        self.failure
    }

    pub(super) fn fail(&mut self, failure: EvaluationFailure) {
        if self.failure.is_none() {
            self.failure = Some(failure);
        }
    }

    pub(super) fn live(&self) -> bool {
        self.failure.is_none()
    }

    /// Consume caller-side capture/driver work and allocation estimates under
    /// the SAME sticky request meter. This can only tighten limits, never refund
    /// work, reset failure or increase the fixed evaluator ceilings.
    pub fn charge(&mut self, steps: u64, bytes: u64) -> bool {
        if !self.live() {
            return false;
        }
        let Some(next_steps) = self.steps.checked_sub(steps) else {
            self.fail(EvaluationFailure::BudgetExceeded("work"));
            return false;
        };
        let Some(next_bytes) = self.bytes.checked_sub(bytes) else {
            self.fail(EvaluationFailure::BudgetExceeded("allocation_estimate"));
            return false;
        };
        self.steps = next_steps;
        self.bytes = next_bytes;
        true
    }

    pub(super) fn text(&mut self, bytes: usize, multiplier: u64) -> bool {
        let bytes = u64::try_from(bytes)
            .ok()
            .and_then(|n| n.checked_mul(multiplier));
        match bytes {
            Some(bytes) => self.charge(1, bytes),
            None => {
                self.fail(EvaluationFailure::BudgetExceeded("allocation_estimate"));
                false
            }
        }
    }

    pub(super) fn vector(&mut self, len: usize) -> bool {
        // Conservative container-slot estimate, before capacity reservation.
        self.text(len, 128)
    }

    pub(super) fn value(&mut self, value: &RuntimeValue, depth: usize, render: bool) -> bool {
        if depth > MAX_VALUE_DEPTH {
            self.fail(EvaluationFailure::BudgetExceeded("value_depth"));
            return false;
        }
        if !self.charge(1, 128) {
            return false;
        }
        match value {
            RuntimeValue::String(s) | RuntimeValue::Error(s) => {
                self.text(s.len(), if render { 6 } else { 1 })
            }
            RuntimeValue::Date(value) => {
                self.text(value.display().len(), if render { 6 } else { 1 })
            }
            RuntimeValue::Duration(value) => {
                self.text(value.display().len(), if render { 6 } else { 1 })
            }
            RuntimeValue::List(values) => values.iter().all(|v| self.value(v, depth + 1, render)),
            RuntimeValue::Object(values) => values
                .iter()
                .all(|(k, v)| self.text(k.len(), 6) && self.value(v, depth + 1, render)),
            _ => true,
        }
    }
}
