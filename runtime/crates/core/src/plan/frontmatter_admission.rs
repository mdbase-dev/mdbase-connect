//! Trusted new-write preflight, separate from deterministic Head/recovery replay.
//! Hosts must also bound source bytes, complete planning allocations and request
//! residency; a per-document parse estimate is not an aggregate heap guarantee.
use super::{Effect, Planned};
use crate::{
    doc,
    yaml::budget::{Footprint, LimitExceeded},
};

/// Typed source/planned refusal, with the exact affected record path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrontmatterAdmissionError {
    /// Affected record, never silently omitted from the plan/query.
    pub path: String,
    /// First immutable structural/capacity limit that refused the parse.
    pub limit: LimitExceeded,
}
impl FrontmatterAdmissionError {
    /// Stable caller-facing reason.
    pub const fn reason(&self) -> &'static str {
        self.limit.reason()
    }
}
impl std::fmt::Display for FrontmatterAdmissionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.path, self.limit)
    }
}
impl std::error::Error for FrontmatterAdmissionError {}
/// Borrowed complete source, BEFORE copying or ordinary Core planning/parsing.
/// Full-source record-size admission remains a separate trusted-host check.
pub fn check_source(path: &str, source: &str) -> Result<Footprint, FrontmatterAdmissionError> {
    doc::check_frontmatter_at(path, source).map_err(|limit| FrontmatterAdmissionError {
        path: path.into(),
        limit,
    })
}
/// Check every complete generated/planned record BEFORE any effect application,
/// capture acknowledgement, publication or enqueue. Does not mutate the plan.
/// Hosts must not apply this new-write guard retrospectively to Head/history.
pub fn check_planned(planned: &Planned) -> Result<(), FrontmatterAdmissionError> {
    for effect in &planned.effects {
        if let Effect::PutRecord { path, doc, .. } | Effect::ReindexOrdinaryFile { path, doc, .. } =
            effect
        {
            check_source(path, doc)?;
        }
    }
    Ok(())
}
