//! Shared presentation of actual Core assessments; never execution authority.
use super::{Assessment, ConfigurationPlan, Hash, Op, Value, obj};
use crate::packs::Action;
use std::collections::BTreeMap;

fn row(r: &crate::packs::PlannedResource, installed: bool, adopted: Option<&Hash>) -> Value {
    let action = if adopted.is_some() {
        "adopt"
    } else {
        r.action.as_str()
    };
    let mut fields = vec![
        ("target", Value::string(r.target.clone())),
        ("kind", Value::string(r.kind.clone())),
        (
            "mode",
            Value::string(match r.mode {
                crate::packs::Mode::Managed => "managed",
                crate::packs::Mode::Seed => "seed",
            }),
        ),
        ("action", Value::string(action)),
        ("installed", Value::Bool(installed)),
    ];
    if let Some(live) = adopted.or(r.live.as_ref()) {
        fields.push(("currentDigest", Value::string(live.to_string())));
    }
    if let Some(reason) = &r.reason {
        fields.push(("reason", Value::string(reason.clone())));
    }
    obj(fields)
}
fn pack_review(a: &Assessment, adopted: &BTreeMap<String, Hash>) -> Value {
    let installed = |target: &str| {
        a.current
            .as_ref()
            .is_some_and(|c| c.resources.iter().any(|e| e.target == target))
    };
    obj(vec![
        ("id", Value::string(a.pack.0.clone())),
        ("version", Value::string(a.pack.1.clone())),
        ("status", Value::string(a.status.as_str())),
        (
            "installedVersion",
            a.current
                .as_ref()
                .map_or(Value::Null, |c| Value::string(c.version.clone())),
        ),
        (
            "resources",
            Value::List(
                a.resources
                    .iter()
                    .filter(|r| r.action != Action::Unchanged)
                    .map(|r| row(r, installed(&r.target), adopted.get(&r.target)))
                    .collect(),
            ),
        ),
    ])
}
/// Reviewable setup presentation shared by native and Wasm installers: the
/// definition documents the setup would write (`staged`).
pub fn collection_setup_review(
    configuration: &ConfigurationPlan,
    type_packs: &[Assessment],
    ops: &[Op],
    adopted: &BTreeMap<String, Hash>,
) -> Value {
    let configuration = configuration
        .configuration
        .iter()
        .filter(|c| c.action != "current")
        .map(|c| {
            obj(vec![
                ("requirement", Value::string(c.requirement.clone())),
                ("path", Value::string(c.path.clone())),
                ("action", Value::string(c.action)),
                ("value", c.value.clone()),
            ])
        })
        .collect();
    let staged = ops
        .iter()
        .filter_map(|op| match op {
            Op::ResourcePut(r)
                if !matches!(
                    r.path.as_str(),
                    "mdbase.yaml" | crate::types::LOCK_PATH | "mdbase.provisions.yaml"
                ) =>
            {
                Some(obj(vec![
                    ("path", Value::string(r.path.clone())),
                    ("document", Value::string(r.doc.clone())),
                ]))
            }
            _ => None,
        })
        .collect();
    obj(vec![
        (
            "packs",
            Value::List(type_packs.iter().map(|a| pack_review(a, adopted)).collect()),
        ),
        ("configuration", Value::List(configuration)),
        ("staged", Value::List(staged)),
    ])
}

impl super::CollectionSetupAssessment {
    /// Whether the COMPLETE assessed plan changes resources, receipts or files.
    pub fn has_changes(&self) -> bool {
        !self.operations.is_empty()
    }
    /// Review actual components without returning private promotion source bytes.
    pub fn review_value(&self) -> Value {
        collection_setup_review(
            &self.configuration,
            &self.type_packs,
            &self.operations,
            &self.adopted,
        )
    }
}
