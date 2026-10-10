//! The semantics version registry (`00-overview.md` §6.3).
//!
//! `sem = [major, minor]` names the planner's behaviour: intent planning, merge,
//! lifecycle, path rules, link rewriting and the CEL and regex profiles, as far
//! as they affect what an entry records. Every entry payload carries the `sem`
//! its writer planned under; a verifier re-executes only entries whose `sem`
//! equals [`SEM`].
//!
//! Bump `minor` for fixes whose old and new behaviour may interleave in one log;
//! bump `major` for changes that must not interleave. Either bump needs a new row
//! in [`SEMANTICS`] and, if replay output changes, updated
//! `conformance/determinism/*.expected.json` in the same commit.

/// A semantics version.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Sem {
    /// Incompatible behaviour changes. Majors ratchet in a log.
    pub major: u64,
    /// Changes that may interleave with the previous minor.
    pub minor: u64,
}

/// One row of the registry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SemInfo {
    /// The version.
    pub sem: Sem,
    /// The spec version it implements.
    pub spec: &'static str,
    /// The tzdb release it embeds for time-zone conversions in replayed
    /// expressions, if any (`open-questions.md` Q6).
    pub tzdb: Option<&'static str>,
}

/// The semantics version this build plans under.
pub const SEM: Sem = Sem { major: 1, minor: 1 };

/// Every semantics version this crate has shipped, oldest first. Only the last
/// row has a planner; the rest are kept for diagnostics.
pub const SEMANTICS: &[SemInfo] = &[
    SemInfo {
        sem: Sem { major: 1, minor: 0 },
        spec: "0.3.0-rc.5",
        tzdb: None,
    },
    SemInfo {
        sem: SEM,
        spec: "0.3.0-rc.5",
        tzdb: Some(crate::cel::time::tzdb::RELEASE),
    },
];
