//! Contract-scoped record reads and writes (spec 05A "Contract Views").
//!
//! A caller names an exact registered record contract (and, when several
//! types implement it, the implementing type). Reads project one record
//! through the resolved implementation's field mapping. Writes map contract
//! field values back to record fields through the same mapping; a contract
//! field the implementation does not map is refused, never written raw.
//! The would-be contract view is validated before anything is submitted.
use super::{RejectCode, Rejection};
use crate::contracts::{Contract, Implementation, Version};
use crate::ids::Hash;
use crate::types::{Catalog, FieldStep, parse_field_ref, select_one};
use crate::validate::Issue;
use crate::value::{Map, Value};

/// An exact contract version and, optionally, the implementing type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContractSelector {
    /// Registered contract ID.
    pub id: String,
    /// Exact version.
    pub version: String,
    /// The implementing type, required when several implement the contract.
    pub type_name: Option<String>,
}

/// One record's valid contract view.
#[derive(Debug, Clone, PartialEq)]
pub struct ContractRecord {
    /// The implementing type the view came through.
    pub type_name: String,
    /// The contract fields (missing optional mappings stay missing).
    pub fields: Map,
    /// The contract digest.
    pub contract_digest: Hash,
    /// The implementation digest.
    pub implementation_digest: Hash,
}

/// A record's current path and exact document.
#[derive(Debug, Clone, Copy)]
pub struct RecordSource<'a> {
    /// Current path.
    pub path: &'a str,
    /// Exact document.
    pub source: &'a str,
}

/// A contract-field write as top-level record-field changes.
#[derive(Debug, Clone, PartialEq)]
pub struct ContractWrite {
    /// The implementing type (a create's `type`).
    pub type_name: String,
    /// Top-level record fields to set.
    pub patch: Map,
    /// Top-level record fields to remove.
    pub unset: Vec<String>,
    /// Observed values of top-level fields whose new value was merged from
    /// the current record (nested mappings): `None` = the key was missing.
    pub base: Vec<(String, Option<Value>)>,
    /// The contract digest.
    pub contract_digest: Hash,
    /// The implementation digest.
    pub implementation_digest: Hash,
}

fn reject(code: RejectCode, reason: &str, message: impl Into<String>) -> Rejection {
    Rejection::new(code, Some(reason), message)
}

/// The single implementation `selector` names, among those `record_types`
/// (when given) has.
fn select<'c>(
    catalog: &'c Catalog,
    selector: &ContractSelector,
    record_types: Option<&[String]>,
) -> Result<(&'c Contract, &'c Implementation), Rejection> {
    if !catalog.is_valid() {
        return Err(Rejection::new(
            RejectCode::CollectionInvalid,
            None,
            "the contract catalog is invalid",
        ));
    }
    let version = Version::parse(&selector.version).ok_or_else(|| {
        Rejection::new(
            RejectCode::InvalidRequest,
            None,
            "an exact contract version is required",
        )
    })?;
    let contract = catalog
        .contract(&selector.id, &version)
        .filter(|c| c.contract_type == "record")
        .ok_or_else(|| {
            reject(
                RejectCode::NotFound,
                "data_contract_not_found",
                format!(
                    "no record contract `{}` {} is registered",
                    selector.id, selector.version
                ),
            )
        })?;
    let candidates: Vec<&Implementation> = catalog
        .implementations()
        .iter()
        .filter(|i| i.contract == selector.id && i.version == version)
        .filter(|i| {
            selector
                .type_name
                .as_deref()
                .is_none_or(|t| i.type_name.eq_ignore_ascii_case(t))
        })
        .filter(|i| record_types.is_none_or(|types| types.contains(&i.type_name)))
        .collect();
    match candidates.as_slice() {
        [one] => Ok((contract, one)),
        [] => Err(reject(
            RejectCode::NotFound,
            "data_contract_not_implemented",
            match record_types {
                Some(_) => "the record does not implement the selected contract",
                None => "no type implements the selected contract",
            },
        )),
        several => {
            let mut r = reject(
                RejectCode::InvalidRequest,
                "data_contract_ambiguous",
                "several types implement the contract; select one with `type`",
            );
            r.details = Some(Value::List(
                several
                    .iter()
                    .map(|i| Value::string(i.type_name.clone()))
                    .collect(),
            ));
            Err(r)
        }
    }
}

fn record_types(catalog: &Catalog, record: RecordSource<'_>) -> (Map, Vec<String>) {
    let doc = crate::doc::Document::parse_at(record.path, record.source);
    let frontmatter = doc.frontmatter().clone();
    let types = catalog.membership(record.path, &frontmatter).types;
    (frontmatter, types)
}

fn invalid_view(issues: Vec<Issue>) -> Rejection {
    let mut r = reject(
        RejectCode::InvalidRecord,
        "data_contract_record_invalid",
        "the record does not satisfy the selected contract",
    );
    r.issues = issues;
    r
}

/// `record`'s valid view under `selector`. Refuses a record that does not
/// implement it (`not_found`/`data_contract_not_implemented`), an ambiguous
/// selection (`invalid_request`/`data_contract_ambiguous`, details: the
/// types) and an invalid view (`invalid_record`/`data_contract_record_invalid`).
pub fn contract_record(
    catalog: &Catalog,
    selector: &ContractSelector,
    record: RecordSource<'_>,
) -> Result<ContractRecord, Rejection> {
    let (frontmatter, types) = record_types(catalog, record);
    let (contract, implementation) = select(catalog, selector, Some(&types))?;
    let effective = catalog.effective_frontmatter(&types, &frontmatter);
    let fields = implementation
        .view(contract, &effective)
        .map_err(invalid_view)?;
    Ok(ContractRecord {
        type_name: implementation.type_name.clone(),
        fields,
        contract_digest: contract.digest,
        implementation_digest: implementation.digest,
    })
}

fn same_step(a: &FieldStep, b: &FieldStep) -> bool {
    match (a, b) {
        (FieldStep::Key(x), FieldStep::Key(y)) => x == y,
        (FieldStep::Index(n), FieldStep::Index(m)) => n == m,
        (FieldStep::Key(k), FieldStep::Index(n)) | (FieldStep::Index(n), FieldStep::Key(k)) => {
            *k == n.to_string()
        }
        _ => false,
    }
}

fn same_ref(a: &[FieldStep], b: &[FieldStep]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| same_step(x, y))
}

fn pointer(steps: &[FieldStep]) -> String {
    steps
        .iter()
        .map(|s| match s {
            FieldStep::Key(k) => format!("/{}", k.replace('~', "~0").replace('/', "~1")),
            FieldStep::Index(n) => format!("/{n}"),
            FieldStep::Each => "/-".to_string(),
        })
        .collect()
}

/// The first value in `value` (at `at`) no mapped contract field covers.
fn first_unmapped(
    value: &Value,
    at: &mut Vec<FieldStep>,
    mapped: &[Vec<FieldStep>],
) -> Option<String> {
    if !at.is_empty() && mapped.iter().any(|m| same_ref(m, at)) {
        return None;
    }
    match value {
        Value::Map(m) if !m.is_empty() => {
            for (k, v) in m.iter() {
                at.push(FieldStep::Key(k.to_string()));
                let found = first_unmapped(v, at, mapped);
                at.pop();
                if found.is_some() {
                    return found;
                }
            }
            None
        }
        Value::List(l) if !l.is_empty() && !at.is_empty() => {
            for (i, v) in l.iter().enumerate() {
                at.push(FieldStep::Index(i as u64));
                let found = first_unmapped(v, at, mapped);
                at.pop();
                if found.is_some() {
                    return found;
                }
            }
            None
        }
        _ if at.is_empty() => None,
        _ => Some(pointer(at)),
    }
}

/// Map contract field values (`fields`) and removals (`unset`, contract field
/// references) to top-level record-field changes. With `record`, the write
/// updates it: the record must implement the selection and nested record
/// fields are merged with its current values (their observed values go in
/// `base`). Without, it is a create of the selected implementing type.
/// Refuses unmapped contract fields (`invalid_request`/
/// `data_contract_field_unmapped`, details: the contract field pointer) and a
/// write whose resulting contract view is invalid (`invalid_record`/
/// `data_contract_record_invalid`).
pub fn contract_write(
    catalog: &Catalog,
    selector: &ContractSelector,
    record: Option<RecordSource<'_>>,
    fields: &Map,
    unset: &[String],
) -> Result<ContractWrite, Rejection> {
    contract_write_promoting(catalog, selector, record, fields, unset, false)
}

/// [`contract_write`], and with `promote`, an untyped `record` (no type
/// membership) is first given the selected implementing type through the
/// first `explicit_type_keys` key, in the same write (the key's observed
/// absence goes in `base`). A record that already implements the selection
/// is written as usual. Refuses a record with other types
/// (`invalid_request`/`data_contract_promote_typed`) and a collection with no
/// explicit type key (`data_contract_promote_unsupported`).
pub fn contract_write_promoting(
    catalog: &Catalog,
    selector: &ContractSelector,
    record: Option<RecordSource<'_>>,
    fields: &Map,
    unset: &[String],
    promote: bool,
) -> Result<ContractWrite, Rejection> {
    let current = record.map(|r| record_types(catalog, r));
    let untyped = current.as_ref().is_some_and(|(_, t)| t.is_empty());
    let promoting = promote && untyped;
    if promote
        && !untyped
        && let Some((_, types)) = &current
        && select(catalog, selector, Some(types)).is_err()
    {
        return Err(reject(
            RejectCode::InvalidRequest,
            "data_contract_promote_typed",
            "only a record without types can be promoted to a contract type",
        ));
    }
    let (contract, implementation) = select(
        catalog,
        selector,
        if promoting {
            None
        } else {
            current.as_ref().map(|(_, t)| t.as_slice())
        },
    )?;
    let type_key = if promoting {
        Some(
            catalog
                .settings()
                .explicit_type_keys
                .first()
                .cloned()
                .ok_or_else(|| {
                    reject(
                        RejectCode::InvalidRequest,
                        "data_contract_promote_unsupported",
                        "the collection has no explicit type key",
                    )
                })?,
        )
    } else {
        None
    };
    if record.is_none() && !unset.is_empty() {
        return Err(Rejection::new(
            RejectCode::InvalidRequest,
            None,
            "a contract create cannot unset fields",
        ));
    }
    let mapped: Vec<(Vec<FieldStep>, &str, &str)> = implementation
        .fields
        .iter()
        .filter_map(|(cf, rf)| parse_field_ref(cf).map(|steps| (steps, cf.as_str(), rf.as_str())))
        .collect();
    let refs: Vec<Vec<FieldStep>> = mapped.iter().map(|(s, _, _)| s.clone()).collect();
    if let Some(path) = first_unmapped(&Value::Map(fields.clone()), &mut Vec::new(), &refs) {
        let mut r = reject(
            RejectCode::InvalidRequest,
            "data_contract_field_unmapped",
            format!(
                "contract field `{path}` is not mapped by type `{}`",
                implementation.type_name
            ),
        );
        r.details = Some(Value::string(path));
        return Err(r);
    }
    let mut removals = Vec::new();
    for u in unset {
        let steps = parse_field_ref(u);
        let Some((_, cf, rf)) = mapped
            .iter()
            .find(|(s, _, _)| steps.as_deref().is_some_and(|u| same_ref(s, u)))
        else {
            let mut r = reject(
                RejectCode::InvalidRequest,
                "data_contract_field_unmapped",
                format!(
                    "contract field `{u}` is not mapped by type `{}`",
                    implementation.type_name
                ),
            );
            r.details = Some(Value::string(u.clone()));
            return Err(r);
        };
        if select_one(fields, cf).is_some() {
            return Err(Rejection::new(
                RejectCode::InvalidRequest,
                None,
                format!("contract field `{u}` is both set and unset"),
            ));
        }
        removals.push(*rf);
    }
    let before = current
        .as_ref()
        .map(|(fm, _)| fm.clone())
        .unwrap_or_default();
    let mut after = before.clone();
    let mut merged = Vec::new();
    if let Some(key) = &type_key {
        after.insert(key, Value::string(implementation.type_name.clone()));
    }
    let field_error = |m: String| {
        reject(
            RejectCode::InvalidRequest,
            "data_contract_field_conflict",
            m,
        )
    };
    for (_, cf, rf) in &mapped {
        if let Some(v) = select_one(fields, cf) {
            crate::lifecycle::set_field(&mut after, rf, Some(v.clone())).map_err(field_error)?;
            note_nested(rf, &mut merged);
        }
    }
    for rf in removals {
        crate::lifecycle::set_field(&mut after, rf, None).map_err(field_error)?;
        note_nested(rf, &mut merged);
    }
    // Validate the contract view the write would leave.
    let types = match (&current, record) {
        (Some(_), Some(r)) => {
            let types = catalog.membership(r.path, &after).types;
            if !types.contains(&implementation.type_name) {
                return Err(reject(
                    RejectCode::InvalidRequest,
                    "data_contract_not_implemented",
                    "the write would leave the record without the selected contract",
                ));
            }
            types
        }
        _ => vec![implementation.type_name.clone()],
    };
    let effective = catalog.effective_frontmatter(&types, &after);
    implementation
        .view(contract, &effective)
        .map_err(invalid_view)?;
    let mut patch = Map::new();
    for (k, v) in after.iter() {
        if before.get(k) != Some(v) {
            patch.insert(k, v.clone());
        }
    }
    let unset: Vec<String> = before
        .keys()
        .filter(|k| !after.contains_key(k))
        .map(str::to_string)
        .collect();
    let base = if record.is_some() {
        merged
            .into_iter()
            .chain(type_key)
            .filter(|k| patch.contains_key(k) || unset.contains(k))
            .map(|k| {
                let observed = before.get(&k).cloned();
                (k, observed)
            })
            .collect()
    } else {
        Vec::new()
    };
    Ok(ContractWrite {
        type_name: implementation.type_name.clone(),
        patch,
        unset,
        base,
        contract_digest: contract.digest,
        implementation_digest: implementation.digest,
    })
}

/// Record a nested record-field reference's top-level key.
fn note_nested(rf: &str, merged: &mut Vec<String>) {
    if let Some(steps) = parse_field_ref(rf)
        && steps.len() > 1
        && let Some(FieldStep::Key(k)) = steps.first()
        && !merged.contains(k)
    {
        merged.push(k.clone());
    }
}

#[cfg(test)]
mod tests;
