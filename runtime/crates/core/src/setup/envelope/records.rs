//! Bounded create-only starter choices inside the COMPLETE reviewed setup batch.
use super::*;
use std::collections::BTreeSet;
/// Caller supplies source/path only; the trusted installer assigns the record ID once.
#[derive(Debug, Clone, PartialEq)]
pub struct SetupStarterRecord {
    /// Installer-owned record ID, retained across review/apply.
    pub id: Uuid,
    /// A relative Markdown record path.
    pub path: String,
    /// Complete bounded source.
    pub document: String,
}
/// Review summary contains no record source or app-supplied authority.
#[derive(Debug, Clone, PartialEq)]
pub struct SetupStarterAssessment {
    /// Requested path.
    pub path: String,
    /// create or skip (occupied path, blocked or already-current setup).
    pub action: &'static str,
}
/// Reject malformed/duplicate/over-budget choices before any source IO.
pub fn validate_setup_starter_records(records: &[SetupStarterRecord]) -> Result<(), Box<Issue>> {
    if records.len() > 32 {
        return Err(limit());
    }
    let mut bytes = 0usize;
    let mut paths = BTreeSet::new();
    let mut ids = BTreeSet::new();
    for r in records {
        bytes = bytes
            .checked_add(r.path.len())
            .and_then(|n| n.checked_add(r.document.len()))
            .ok_or_else(limit)?;
        if bytes > 256 * 1024
            || r.path.len() > 1024
            || r.document.is_empty()
            || !r.path.to_ascii_lowercase().ends_with(".md")
            || crate::paths::check_path(&r.path).is_err()
            || !paths.insert(crate::paths::path_key(&r.path))
            || !ids.insert(r.id)
        {
            return Err(invalid());
        }
    }
    Ok(())
}
pub(super) fn append_starters(
    view: &dyn SetupStateView,
    clock: &OpClock,
    assessment: &mut CollectionSetupAssessment,
    records: &[SetupStarterRecord],
) -> Result<(), Box<Issue>> {
    validate_setup_starter_records(records)?;
    if records.is_empty() {
        return Ok(());
    }
    let runs = assessment.applicable && assessment.has_changes();
    let reserved: BTreeSet<_> = assessment
        .operations
        .iter()
        .filter_map(|op| match op {
            Op::ResourcePut(p) => Some(crate::paths::path_key(&p.path)),
            Op::OrdinaryFileToRecord(p) => Some(crate::paths::path_key(&p.path)),
            _ => None,
        })
        .collect();
    for r in records {
        let key = crate::paths::path_key(&r.path);
        let create = runs
            && view.state().at_path_key(&key).is_none()
            && view.state().resource(&r.path).is_none()
            && !reserved.contains(&key);
        assessment.records.push(SetupStarterAssessment {
            path: r.path.clone(),
            action: if create { "create" } else { "skip" },
        });
        if create {
            assessment
                .operations
                .push(Op::Create(crate::intent::Create {
                    id: r.id,
                    path: Some(r.path.clone()),
                    document: Some(r.document.clone()),
                    ..Default::default()
                }));
        }
    }
    // Full prospective resource/type changes and starter documents are admitted together.
    if assessment.applicable {
        validate_setup_operations(view.state(), clock, &assessment.operations)?;
    }
    assessment.assessment_digest = jcs_digest(&obj(vec![
        ("assessment", hash_value(assessment.assessment_digest)),
        (
            "records",
            Value::List(
                records
                    .iter()
                    .zip(&assessment.records)
                    .map(|(r, a)| {
                        obj(vec![
                            ("id", Value::string(r.id.to_string())),
                            ("path", Value::string(r.path.clone())),
                            ("source", hash_value(revision(&r.document))),
                            ("action", Value::string(a.action)),
                        ])
                    })
                    .collect(),
            ),
        ),
    ]));
    Ok(())
}
