//! Raw document/property-registry bindings. Never bind effective/read-default
//! projections or synthesize missing metadata from schema/defaults.
use super::{Bindings, EvaluationFailure, WorkBudget};
use crate::doc::Document;
use std::collections::BTreeMap;

/// Maximum captured registry entries per request, not per evaluated row.
pub const MAX_PROPERTY_TYPE_HINTS: usize = 4096;
/// Cumulative UTF-8 name/type bytes before admitting a borrowed registry.
pub const MAX_PROPERTY_TYPE_HINT_BYTES: usize = 65_536;
/// Whole record source limit before admitting raw bindings (inclusive).
pub const MAX_RAW_RECORD_BYTES: usize = 1 << 20;

/// Explicit immutable property-typing capture; empty means known untyped, not
/// unavailable. No schema-derived defaults or case/name normalization.
#[derive(Clone, Copy)]
pub struct CapturedPropertyTypes<'a> {
    hints: &'a BTreeMap<String, String>,
}
fn fail<T>(budget: &mut WorkBudget, failure: EvaluationFailure) -> Result<T, EvaluationFailure> {
    budget.fail(failure);
    Err(budget.failure().expect("sticky capture failure"))
}
impl<'a> CapturedPropertyTypes<'a> {
    /// Capture the actual host registry once for a request. Unknown registry
    /// spellings are retained; this layer does not coerce YAML values to hints.
    pub fn capture(
        hints: &'a BTreeMap<String, String>,
        budget: &mut WorkBudget,
    ) -> Result<Self, EvaluationFailure> {
        if let Some(error) = budget.failure() {
            return Err(error);
        }
        if hints.len() > MAX_PROPERTY_TYPE_HINTS {
            return fail(
                budget,
                EvaluationFailure::BudgetExceeded("property_type_count"),
            );
        }
        let mut bytes = 0usize;
        for (key, kind) in hints {
            if !budget.charge(1, 0) {
                return Err(budget.failure().expect("registry work failure"));
            }
            bytes = bytes
                .checked_add(key.len())
                .and_then(|n| n.checked_add(kind.len()))
                .ok_or_else(|| {
                    budget.fail(EvaluationFailure::BudgetExceeded("property_type_bytes"));
                    budget.failure().expect("sticky registry failure")
                })?;
            if bytes > MAX_PROPERTY_TYPE_HINT_BYTES {
                return fail(
                    budget,
                    EvaluationFailure::BudgetExceeded("property_type_bytes"),
                );
            }
        }
        Ok(Self { hints })
    }
    /// Bind a bounded exact raw projection without constructing or reparsing a
    /// whole Document. The consuming driver must prove source/frame coverage
    /// using the admitted plan's projection requirements and snapshot fences.
    /// Preserves strict captured hints, including typed-empty refusals; never
    /// applies defaults or turns unavailable source metadata into an empty map.
    pub fn projected_bindings(
        self,
        raw: &'a crate::value::Map,
        budget: &mut WorkBudget,
    ) -> Result<Bindings<'a>, EvaluationFailure> {
        if let Some(error) = budget.failure() {
            return Err(error);
        }
        if raw.len() > super::MAX_BASES_PROJECTION_FIELDS {
            return fail(
                budget,
                EvaluationFailure::BudgetExceeded("raw_property_projection_count"),
            );
        }
        for (name, _) in raw.iter() {
            if name.is_empty() || name.len() > super::MAX_BASES_PROJECTION_FIELD_BYTES {
                return fail(
                    budget,
                    EvaluationFailure::MetadataUnavailable("raw_property_projection_unqualified"),
                );
            }
            if !budget.charge(1, 0) {
                return Err(budget.failure().expect("raw projection bindings"));
            }
        }
        Ok(Bindings::raw(raw).with_captured_property_types(self.hints))
    }
}
/// Borrowed exact parsed raw frontmatter, with explicitly captured typing.
/// A missing/invalid document or registry cannot become an empty/defaulted row.
#[derive(Clone, Copy)]
pub struct RawFrontmatter<'a> {
    document: &'a Document,
    types: CapturedPropertyTypes<'a>,
}
impl<'a> RawFrontmatter<'a> {
    /// Bind the exact document's parsed mapping, not Catalog::effective_frontmatter.
    /// The host must apply source bounds before loading/parsing document bytes.
    pub fn capture(
        document: &'a Document,
        types: Option<CapturedPropertyTypes<'a>>,
        budget: &mut WorkBudget,
    ) -> Result<Self, EvaluationFailure> {
        if let Some(error) = budget.failure() {
            return Err(error);
        }
        if !budget.charge(1, 0) {
            return Err(budget.failure().expect("raw capture work failure"));
        }
        if document.source().len() > MAX_RAW_RECORD_BYTES {
            return fail(
                budget,
                EvaluationFailure::BudgetExceeded("raw_record_bytes"),
            );
        }
        if document.problem().is_some() {
            return fail(
                budget,
                EvaluationFailure::MetadataUnavailable("raw_frontmatter_unavailable"),
            );
        }
        let Some(types) = types else {
            return fail(
                budget,
                EvaluationFailure::MetadataUnavailable("property_types_not_captured"),
            );
        };
        Ok(Self { document, types })
    }
    /// Borrowed bindings for the qualified evaluator. Caller supplies any clock
    /// with Bindings::with_clock; no epoch/local-time fallback is added here.
    pub fn bindings(self) -> Bindings<'a> {
        Bindings::raw(self.document.frontmatter()).with_captured_property_types(self.types.hints)
    }
}
#[cfg(test)]
mod tests;
pub(crate) mod witness;
