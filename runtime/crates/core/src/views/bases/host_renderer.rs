//! Renderer-neutral admission. Presentation is opaque bounded source metadata;
//! only the separately compiled query slots affect computation or membership.
use super::filter::work_fail;
use super::{BaseView, EvaluationFailure, FilterAdmissionFailure, WorkBudget};
use crate::value::Value;

const MAX_RENDERER_BYTES: usize = 1024;
const MAX_PRESENTATION_BYTES: usize = 65_536;
const MAX_PRESENTATION_NODES: usize = 4096;
const MAX_PRESENTATION_DEPTH: usize = 16;

/// Renderer names are host metadata, not a closed engine capability registry.
/// A bounded name does not grant query support, record access or authority.
pub fn supports_host_renderer(view_type: &str) -> bool {
    !view_type.is_empty() && view_type.len() <= MAX_RENDERER_BYTES
}

pub(super) fn admit_options(
    view: &BaseView<'_>,
    work: &mut WorkBudget,
) -> Result<(), FilterAdmissionFailure> {
    if !supports_host_renderer(view.view_type) {
        return work_fail(
            work,
            EvaluationFailure::UnsupportedConstruct("bases_view_renderer"),
        );
    }
    let mut bounds = Bounds {
        bytes: view.view_type.len(),
        nodes: 0,
    };
    for (key, value) in view.raw.iter() {
        // These slots are interpreted and independently admitted by the query
        // compiler. Everything else is presentation, never an executable hook.
        if matches!(
            key,
            "type"
                | "name"
                | "filters"
                | "order"
                | "sort"
                | "groupBy"
                | "limit"
                | "summaries"
                | "summary_functions"
        ) {
            continue;
        }
        bounds.charge(key.len(), work)?;
        bounds.value(value, 1, work)?;
    }
    Ok(())
}
/// Preflight interpreted metadata before cloning or compiling any declarations.
pub(super) fn admit_computation_metadata(
    values: &[Option<&Value>],
    work: &mut WorkBudget,
) -> Result<(), FilterAdmissionFailure> {
    let mut bounds = Bounds { bytes: 0, nodes: 0 };
    for value in values.iter().flatten() {
        bounds.value(value, 1, work)?;
    }
    // Reserve parser/compiled-plan ownership conservatively before compilation.
    if !work.charge(bounds.bytes as u64, bounds.bytes as u64 * 32) {
        return Err(FilterAdmissionFailure::Work(
            work.failure().expect("query metadata"),
        ));
    }
    Ok(())
}
struct Bounds {
    bytes: usize,
    nodes: usize,
}
impl Bounds {
    fn charge(
        &mut self,
        bytes: usize,
        work: &mut WorkBudget,
    ) -> Result<(), FilterAdmissionFailure> {
        self.bytes = self.bytes.saturating_add(bytes).saturating_add(32);
        self.nodes = self.nodes.saturating_add(1);
        if self.bytes > MAX_PRESENTATION_BYTES || self.nodes > MAX_PRESENTATION_NODES {
            return work_fail(
                work,
                EvaluationFailure::BudgetExceeded("bases_presentation_metadata"),
            );
        }
        if !work.charge(bytes as u64 + 1, 0) {
            return Err(FilterAdmissionFailure::Work(
                work.failure().expect("presentation metadata"),
            ));
        }
        Ok(())
    }
    fn value(
        &mut self,
        value: &Value,
        depth: usize,
        work: &mut WorkBudget,
    ) -> Result<(), FilterAdmissionFailure> {
        if depth > MAX_PRESENTATION_DEPTH {
            return work_fail(
                work,
                EvaluationFailure::BudgetExceeded("bases_presentation_depth"),
            );
        }
        self.charge(value.as_str().map_or(8, str::len), work)?;
        match value {
            Value::List(values) => {
                for value in values {
                    self.value(value, depth + 1, work)?;
                }
            }
            Value::Map(map) => {
                for (key, value) in map.iter() {
                    self.charge(key.len(), work)?;
                    self.value(value, depth + 1, work)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
}
