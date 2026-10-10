//! Discovery from resolved record-contract implementations, never extensions.
//! This per-record classifier does not prove complete inventory or grant reads.
use super::{EvaluationFailure, WorkBudget};
use crate::{
    contracts::Implementation,
    doc::Document,
    intent::OpClock,
    types::{Catalog, FieldStep, parse_field_ref, top_level_field},
    value::{Map, Value},
};
/// Canonical record contract, independent of type name, path and file extension.
pub const BASES_CONTRACT: &str = "obsidian.base";
/// Maximum saved views in one source before descriptor allocation.
pub const MAX_DISCOVERED_VIEWS: usize = 128;
/// Maximum resolved implementations on one record before capture allocation.
pub const MAX_BASE_IMPLEMENTATIONS: usize = 16;
/// Exact borrowed contract projection. An omitted mapping never falls back to
/// a similarly named raw field, an effective/read default or display metadata.
#[derive(Clone, Copy)]
pub struct BaseFields<'a> {
    /// Global filters, if exposed and present.
    pub filters: Option<&'a Value>,
    /// Formula library, if exposed and present.
    pub formulas: Option<&'a Value>,
    /// Property presentation metadata, if exposed.
    pub properties: Option<&'a Value>,
    /// Authoritative mapped views value.
    pub views: &'a Value,
}
/// A saved view descriptor, not an executable/admitted plan.
pub struct BaseView<'a> {
    /// Stable source ordinal, not its possibly duplicate name.
    pub index: u32,
    /// Exact rendering type. Unknown renderers are not execution support.
    pub view_type: &'a str,
    /// Exact optional user name; no guessed default.
    pub name: Option<&'a str>,
    /// Exact view mapping, preserving all user keys.
    pub raw: &'a Map,
}
/// Borrowed resolved implementations and descriptors for one known record.
/// Caller must bind to actual record identity, source revision and frozen state.
pub struct DiscoveredBase<'a> {
    /// Validated resolved implementations, not declarations.
    pub implementations: Vec<&'a Implementation>,
    /// Coalesced unambiguous contract projection.
    pub fields: BaseFields<'a>,
    /// Views in original declaration order.
    pub views: Vec<BaseView<'a>>,
}
fn fail<T>(budget: &mut WorkBudget, failure: EvaluationFailure) -> Result<T, EvaluationFailure> {
    budget.fail(failure);
    Err(budget.failure().expect("sticky discovery failure"))
}
fn work(budget: &mut WorkBudget, steps: u64, bytes: u64) -> Result<(), EvaluationFailure> {
    if budget.charge(steps, bytes) {
        Ok(())
    } else {
        Err(budget.failure().expect("discovery budget failure"))
    }
}
fn single<'a>(
    raw: &'a Map,
    reference: &str,
    budget: &mut WorkBudget,
) -> Result<Option<&'a Value>, EvaluationFailure> {
    if reference.len() > 1024 {
        return fail(
            budget,
            EvaluationFailure::BudgetExceeded("base_field_reference"),
        );
    }
    work(budget, reference.len() as u64, reference.len() as u64)?;
    let Some(steps) = parse_field_ref(reference) else {
        return fail(
            budget,
            EvaluationFailure::UnsupportedConstruct("base_field_reference"),
        );
    };
    if steps.len() > 32 {
        return fail(
            budget,
            EvaluationFailure::BudgetExceeded("base_field_reference"),
        );
    }
    let mut value = None;
    for (index, step) in steps.iter().enumerate() {
        work(budget, 1, 0)?;
        if matches!(step, FieldStep::Each) {
            return fail(
                budget,
                EvaluationFailure::UnsupportedConstruct("base_field_fanout"),
            );
        }
        value = if index == 0 {
            match step {
                FieldStep::Key(key) => raw.get(key),
                FieldStep::Index(n) => raw.get(&n.to_string()),
                FieldStep::Each => unreachable!(),
            }
        } else {
            match (value, step) {
                (Some(Value::Map(map)), FieldStep::Key(key)) => map.get(key),
                (Some(Value::Map(map)), FieldStep::Index(n)) => map.get(&n.to_string()),
                (Some(Value::List(list)), FieldStep::Index(n)) => {
                    usize::try_from(*n).ok().and_then(|n| list.get(n))
                }
                _ => None,
            }
        };
    }
    Ok(value)
}
fn projected<'a>(
    implementation: &Implementation,
    raw: &'a Map,
    name: &str,
    budget: &mut WorkBudget,
) -> Result<Option<&'a Value>, EvaluationFailure> {
    let mut selected = None;
    let mut mapped = false;
    for (contract, record) in &implementation.fields {
        work(budget, 1, 0)?;
        if top_level_field(contract).as_deref() == Some(name) {
            let candidate = single(raw, record, budget)?;
            if mapped {
                for value in [candidate, selected].into_iter().flatten() {
                    comparison_value(value, 0, budget)?;
                }
                if candidate != selected {
                    return fail(
                        budget,
                        EvaluationFailure::UnsupportedConstruct("ambiguous_base_contract_fields"),
                    );
                }
            }
            selected = candidate;
            mapped = true;
        }
    }
    Ok(selected)
}
fn fields<'a>(
    implementation: &Implementation,
    raw: &'a Map,
    budget: &mut WorkBudget,
) -> Result<BaseFields<'a>, EvaluationFailure> {
    let views = projected(implementation, raw, "views", budget)?.ok_or_else(|| {
        let e = EvaluationFailure::UnsupportedConstruct("base_views_missing");
        budget.fail(e);
        e
    })?;
    Ok(BaseFields {
        views,
        filters: projected(implementation, raw, "filters", budget)?,
        formulas: projected(implementation, raw, "formulas", budget)?,
        properties: projected(implementation, raw, "properties", budget)?,
    })
}
fn comparison_value(
    value: &Value,
    depth: usize,
    budget: &mut WorkBudget,
) -> Result<(), EvaluationFailure> {
    if depth > 32 {
        return fail(
            budget,
            EvaluationFailure::BudgetExceeded("base_projection_depth"),
        );
    }
    work(budget, 1, 0)?;
    match value {
        Value::Text(text) => work(budget, text.len() as u64, 0)?,
        Value::List(values) => {
            for value in values {
                comparison_value(value, depth + 1, budget)?;
            }
        }
        Value::Map(map) => {
            for (key, value) in map.iter() {
                work(budget, key.len() as u64, 0)?;
                comparison_value(value, depth + 1, budget)?;
            }
        }
        _ => {}
    }
    Ok(())
}
fn equivalent(
    a: BaseFields<'_>,
    b: BaseFields<'_>,
    budget: &mut WorkBudget,
) -> Result<bool, EvaluationFailure> {
    for value in [
        Some(a.views),
        a.filters,
        a.formulas,
        a.properties,
        Some(b.views),
        b.filters,
        b.formulas,
        b.properties,
    ]
    .into_iter()
    .flatten()
    {
        comparison_value(value, 0, budget)?;
    }
    Ok(a.views == b.views
        && a.filters == b.filters
        && a.formulas == b.formulas
        && a.properties == b.properties)
}
/// Classify one actual record using its raw Document and the captured membership
/// clock. No `.base` shortcut, include-path scan, side registry or resource kind.
/// `None` proves only this resolved record is not a Bases implementation; complete
/// discovery requires a fallible, bounded, trusted replica inventory around it.
pub fn discover_base_record<'a>(
    catalog: &'a Catalog,
    path: &str,
    document: &'a Document,
    clock: &OpClock,
    budget: &mut WorkBudget,
) -> Result<Option<DiscoveredBase<'a>>, EvaluationFailure> {
    work(budget, 1, 0)?;
    if document.source().len() > 1 << 20 {
        return fail(
            budget,
            EvaluationFailure::BudgetExceeded("base_record_bytes"),
        );
    }
    // Registered but no implementing type is a known empty implementation set.
    // Absent contract/catalog proof is not empty discovery.
    if !catalog.is_valid() {
        return fail(
            budget,
            EvaluationFailure::MetadataUnavailable("bases_catalog_invalid"),
        );
    }
    if !catalog
        .contracts()
        .iter()
        .any(|contract| contract.id == BASES_CONTRACT)
    {
        return fail(
            budget,
            EvaluationFailure::MetadataUnavailable("bases_contract_not_installed"),
        );
    }
    if catalog.types().len() > 4096 || catalog.implementations().len() > 4096 {
        return fail(
            budget,
            EvaluationFailure::BudgetExceeded("base_catalog_count"),
        );
    }
    work(
        budget,
        catalog.types().len() as u64,
        (catalog.types().len() as u64) * 128,
    )?;
    for ty in catalog.types() {
        work(budget, ty.name.len() as u64, ty.name.len() as u64)?;
    }
    let implementations = catalog
        .implementations()
        .iter()
        .filter(|implementation| implementation.contract == BASES_CONTRACT);
    if document.problem().is_some() {
        return fail(
            budget,
            EvaluationFailure::MetadataUnavailable("base_raw_frontmatter_unavailable"),
        );
    }
    work(budget, document.source().len() as u64, 0)?;
    let membership = catalog.membership_at(path, document.frontmatter(), Some(clock));
    if !membership.issues.is_empty() {
        return fail(
            budget,
            EvaluationFailure::MetadataUnavailable("record_types_unresolved"),
        );
    }
    let matched: Vec<_> = implementations
        .filter(|implementation| {
            membership
                .types
                .iter()
                .any(|name| name == &implementation.type_name)
        })
        .take(MAX_BASE_IMPLEMENTATIONS + 1)
        .collect();
    if matched.is_empty() {
        return Ok(None);
    }
    if matched.len() > MAX_BASE_IMPLEMENTATIONS {
        return fail(
            budget,
            EvaluationFailure::BudgetExceeded("base_implementations"),
        );
    }
    work(budget, matched.len() as u64, (matched.len() as u64) * 128)?;
    let mut projection = None;
    for implementation in &matched {
        let version = &implementation.version;
        if version.major != 1 || version.minor != 0 || version.patch != 0 || !version.pre.is_empty()
        {
            return fail(
                budget,
                EvaluationFailure::UnsupportedConstruct("base_contract_version"),
            );
        }
        work(budget, document.source().len() as u64, 0)?;
        let candidate = fields(implementation, document.frontmatter(), budget)?;
        if let Some(prior) = projection
            && !equivalent(prior, candidate, budget)?
        {
            return fail(
                budget,
                EvaluationFailure::UnsupportedConstruct("ambiguous_base_implementations"),
            );
        }
        projection = Some(candidate);
    }
    let fields = projection.expect("nonempty implementations");
    let Some(inputs) = fields.views.as_list() else {
        return fail(
            budget,
            EvaluationFailure::UnsupportedConstruct("base_views_shape"),
        );
    };
    if inputs.is_empty() {
        return fail(
            budget,
            EvaluationFailure::UnsupportedConstruct("base_views_empty"),
        );
    }
    if inputs.len() > MAX_DISCOVERED_VIEWS {
        return fail(
            budget,
            EvaluationFailure::BudgetExceeded("base_views_count"),
        );
    }
    work(budget, inputs.len() as u64, (inputs.len() as u64) * 128)?;
    let mut views = Vec::with_capacity(inputs.len());
    for (index, value) in inputs.iter().enumerate() {
        let Some(raw) = value.as_map() else {
            return fail(
                budget,
                EvaluationFailure::UnsupportedConstruct("base_view_shape"),
            );
        };
        let Some(view_type) = raw.get("type").and_then(Value::as_str) else {
            return fail(
                budget,
                EvaluationFailure::UnsupportedConstruct("base_view_type"),
            );
        };
        let name = match raw.get("name") {
            None => None,
            Some(Value::Text(s)) => Some(s.as_str()),
            _ => {
                return fail(
                    budget,
                    EvaluationFailure::UnsupportedConstruct("base_view_name"),
                );
            }
        };
        if view_type.len() > 1024 || name.is_some_and(|name| name.len() > 4096) {
            return fail(
                budget,
                EvaluationFailure::BudgetExceeded("base_view_descriptor_bytes"),
            );
        }
        views.push(BaseView {
            index: u32::try_from(index).expect("bounded view ordinal"),
            view_type,
            name,
            raw,
        });
    }
    Ok(Some(DiscoveredBase {
        implementations: matched,
        fields,
        views,
    }))
}
#[cfg(test)]
mod tests;
pub(crate) mod witness;
