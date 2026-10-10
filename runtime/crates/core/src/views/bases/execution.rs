//! One admitted whole-view program/library. Shared row evaluator/cache and meter.
use super::filter::{Lowered, source_fail, work_fail};
use super::*;
use crate::value::Value;
use std::collections::BTreeMap;
mod candidate;
mod projection;
pub use candidate::{BasesCandidate, BasesCandidateAtom, BasesCandidateCompare};
pub(crate) mod witness;
pub use projection::{
    BasesProjectionRequirements, MAX_BASES_PROJECTION_FIELD_BYTES, MAX_BASES_PROJECTION_FIELDS,
};
/// Bound displayed columns independently of sort keys or formula definitions.
pub const MAX_VIEW_COLUMNS: usize = 64;
/// Explicit absence of optional file-time facts from the frozen inventory.
#[derive(Clone, Copy)]
pub struct FileTimeAvailability {
    /// Every input row has authenticated creation provenance/time.
    pub created: bool,
    /// Every input row has captured modification time.
    pub modified: bool,
    /// Every input row has a qualified captured tag set (known-empty is valid).
    pub tags: bool,
}
/// Display cells remain in their original slot; unavailable is not Null.
pub enum BasesDisplayCell {
    /// Qualified raw value (including ordinary source Error values).
    Value(RuntimeValue),
    /// Visible unavailable display-only capability, never semantic fallback.
    Unavailable {
        /// Fixed public reason code.
        code: &'static str,
        /// Safe diagnostic detail.
        detail: &'static str,
    },
}
/// One projected row, only produced after matching and all semantic keys succeed.
pub struct BasesProjectedRow {
    /// Exact sort keys in source declaration order.
    pub sort: Vec<RuntimeValue>,
    /// Exact optional grouping scalar.
    pub group: Option<RuntimeValue>,
    /// One cell per original displayed column, including repeats/unavailable.
    pub cells: Vec<BasesDisplayCell>,
}
/// Admitted raw source declaration. Owns one AST and one formula library.
pub struct AdmittedBasesView {
    program: Program,
    sort: Vec<SortTerm>,
    group: Option<SortTerm>,
    columns: Vec<PropertySelector>,
    unavailable: Vec<Option<&'static str>>,
}
impl AdmittedBasesView {
    /// Admit every reachable filter/sort/group/display formula before any rows.
    /// Unsupported display-only capabilities retain visible unavailable slots;
    /// semantic roots always refuse unsupported/missing facts.
    pub fn compile(
        fields: &BaseFields<'_>,
        view: &BaseView<'_>,
        times: FileTimeAvailability,
        budget: &mut WorkBudget,
    ) -> Result<Self, FilterAdmissionFailure> {
        for (k, _) in view.raw.iter() {
            if !matches!(
                k,
                "type"
                    | "name"
                    | "filters"
                    | "order"
                    | "sort"
                    | "groupBy"
                    | "columnWidth"
                    | "hideEmptyColumns"
            ) {
                return work_fail(
                    budget,
                    EvaluationFailure::UnsupportedConstruct("base_view_option"),
                );
            }
        }
        let mut formulas: BTreeMap<String, String> = BTreeMap::new();
        if let Some(value) = fields.formulas {
            let Some(map) = value.as_map() else {
                return work_fail(
                    budget,
                    EvaluationFailure::UnsupportedConstruct("base_formula_shape"),
                );
            };
            if map.len() > MAX_FORMULAS {
                return work_fail(budget, EvaluationFailure::BudgetExceeded("formula_count"));
            }
            let mut bytes = 0usize;
            for (k, v) in map.iter() {
                let Some(source) = v.as_str() else {
                    return work_fail(
                        budget,
                        EvaluationFailure::UnsupportedConstruct("base_formula_shape"),
                    );
                };
                bytes = bytes.saturating_add(k.len() + source.len());
                if bytes > MAX_PROGRAM_SOURCE_BYTES {
                    return work_fail(
                        budget,
                        EvaluationFailure::BudgetExceeded("program_source_bytes"),
                    );
                }
                if !budget.charge(
                    (k.len() + source.len()) as u64,
                    (k.len() + source.len() + 128) as u64,
                ) {
                    return Err(FilterAdmissionFailure::Work(
                        budget.failure().expect("formula copy"),
                    ));
                }
                formulas.insert(k.into(), source.into());
            }
        }
        if let Some(value) = fields.properties {
            let Some(map) = value.as_map() else {
                return work_fail(
                    budget,
                    EvaluationFailure::UnsupportedConstruct("base_property_metadata_shape"),
                );
            };
            normalize_property_metadata(map).map_err(|e| FilterAdmissionFailure::Source(e.kind))?;
        }
        let sort = match view.raw.get("sort") {
            Some(value) => {
                decode_sort(value).map_err(|e| FilterAdmissionFailure::Source(e.kind))?
            }
            None => Vec::new(),
        };
        let group = view
            .raw
            .get("groupBy")
            .map(SortTerm::from_value)
            .transpose()
            .map_err(|e| FilterAdmissionFailure::Source(e.kind))?;
        let Some(Value::List(order)) = view.raw.get("order") else {
            return work_fail(
                budget,
                EvaluationFailure::UnsupportedConstruct("base_display_order_missing"),
            );
        };
        if order.len() > MAX_VIEW_COLUMNS {
            return work_fail(
                budget,
                EvaluationFailure::BudgetExceeded("base_display_columns"),
            );
        }
        if !budget.charge(
            (order.len() + sort.len() + 1) as u64,
            ((order.len() + sort.len() + 1) * 128) as u64,
        ) {
            return Err(FilterAdmissionFailure::Work(
                budget.failure().expect("view keys"),
            ));
        }
        let mut columns = Vec::with_capacity(order.len());
        for value in order {
            let Some(key) = value.as_str() else {
                return work_fail(
                    budget,
                    EvaluationFailure::UnsupportedConstruct("base_display_column_shape"),
                );
            };
            columns.push(
                PropertySelector::parse(key).map_err(|e| FilterAdmissionFailure::Source(e.kind))?,
            );
        }
        let mut lowered = Lowered {
            source: String::new(),
            nodes: 0,
            budget,
        };
        lowered.append("[(")?;
        lowered.filter(fields.filters, 1)?;
        lowered.append(") && (")?;
        lowered.filter(view.raw.get("filters"), 1)?;
        lowered.append(")")?;
        // All selected roots live in one bounded array AST. The row evaluator chooses
        // roots explicitly; nonmatching rows never read key/display nodes.
        for term in sort.iter().chain(group.iter()) {
            lowered.append(",")?;
            append_selector(&mut lowered, &term.property)?;
        }
        for column in &columns {
            lowered.append(",")?;
            append_selector(&mut lowered, column)?;
        }
        lowered.append("]")?;
        let bytes = formulas
            .iter()
            .map(|(k, v)| k.len() + v.len())
            .sum::<usize>();
        if !lowered.budget.charge(
            (bytes + formulas.len()) as u64,
            (bytes * 8 + formulas.len() * 128) as u64,
        ) {
            return Err(FilterAdmissionFailure::Work(
                lowered.budget.failure().expect("view library"),
            ));
        }
        let (program, unavailable) = match Program::compile_view(
            &lowered.source,
            &formulas,
            sort.len() + usize::from(group.is_some()),
            times,
        ) {
            Ok(p) => p,
            Err(e) if e.kind == ErrorKind::UnsupportedConstruct("file_time_not_captured") => {
                return work_fail(
                    lowered.budget,
                    EvaluationFailure::MetadataUnavailable("file_time_not_captured"),
                );
            }
            Err(e) => return source_fail(lowered.budget, e.kind),
        };
        Ok(Self {
            program,
            sort,
            group,
            columns,
            unavailable,
        })
    }
    /// Original normalized display selectors, retaining declaration order/repeats.
    pub fn columns(&self) -> &[PropertySelector] {
        &self.columns
    }
    /// Requested sort directions; comparator policy is captured separately.
    pub fn sort_directions(&self) -> Vec<SortDirection> {
        self.sort.iter().map(|t| t.direction).collect()
    }
    /// Original optional group direction.
    pub fn group_direction(&self) -> Option<SortDirection> {
        self.group.as_ref().map(|t| t.direction)
    }
    /// Indices of visible unavailable display slots and fixed safe detail.
    pub fn unavailable_columns(&self) -> impl Iterator<Item = (usize, &'static str)> + '_ {
        self.unavailable
            .iter()
            .enumerate()
            .filter_map(|(i, v)| v.map(|s| (i, s)))
    }
    /// Evaluate matching, semantic keys and display roots with one memoized DAG.
    pub fn project(
        &self,
        bindings: Bindings<'_>,
        budget: &mut WorkBudget,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Option<BasesProjectedRow>, EvaluationFailure> {
        self.project_mode(bindings, true, budget, cancelled)
    }
    /// Evaluate the exact filter/sort/group roots for a whole-view semantic
    /// scan, without evaluating display roots. The admitted program and its
    /// semantic failure domain are unchanged; cells are intentionally empty.
    pub fn project_semantic(
        &self,
        bindings: Bindings<'_>,
        budget: &mut WorkBudget,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Option<BasesProjectedRow>, EvaluationFailure> {
        self.project_mode(bindings, false, budget, cancelled)
    }
    fn project_mode(
        &self,
        bindings: Bindings<'_>,
        display: bool,
        budget: &mut WorkBudget,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Option<BasesProjectedRow>, EvaluationFailure> {
        let semantic = self.sort.len() + usize::from(self.group.is_some());
        // Bounded stack scratch, not a per-row cloned heap allocation. Runtime
        // display gaps are populated only AFTER matching and semantic keys.
        let mut unavailable = [None; MAX_VIEW_COLUMNS];
        let count = if display { self.columns.len() } else { 0 };
        let unavailable = &mut unavailable[..count];
        unavailable.copy_from_slice(&self.unavailable[..count]);
        let Some(mut values) = self.program.evaluate_view_roots(
            bindings,
            semantic,
            unavailable,
            &self.columns[..count],
            budget,
            cancelled,
        )?
        else {
            return Ok(None);
        };
        let display = values.split_off(semantic);
        let group = if self.group.is_some() {
            values.pop()
        } else {
            None
        };
        let cells = display
            .into_iter()
            .zip(unavailable.iter())
            .enumerate()
            .map(|(index, (value, missing))| match missing {
                Some(detail) => BasesDisplayCell::Unavailable {
                    code: if self.unavailable[index].is_some() {
                        "view_metadata_unavailable"
                    } else {
                        "view_unsupported_construct"
                    },
                    detail,
                },
                None => BasesDisplayCell::Value(value),
            })
            .collect();
        Ok(Some(BasesProjectedRow {
            sort: values,
            group,
            cells,
        }))
    }
}
fn selector_source(selector: &PropertySelector) -> String {
    let namespace = match selector {
        PropertySelector::Note(_) => "note",
        PropertySelector::Formula(_) => "formula",
        PropertySelector::File(_) => "file",
    };
    let mut out = format!("{namespace}[\"");
    for c in selector.key().chars() {
        if matches!(c, '\\' | '"') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push_str("\"]");
    out
}
fn append_selector(
    lowered: &mut Lowered<'_>,
    selector: &PropertySelector,
) -> Result<(), FilterAdmissionFailure> {
    lowered.append(&selector_source(selector))
}
