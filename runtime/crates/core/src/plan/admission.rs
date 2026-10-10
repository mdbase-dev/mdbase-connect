//! Trusted NEW-write admission, deliberately separate from deterministic replay.
//! Replica selects this at capture/submit/ingest for a synced or local-only
//! collection. Never derive it from query profile or a client-controlled flag;
//! historical verification and acknowledged-intent restoration do not call it.
use super::{Effect, Planned};
use std::fmt;

/// Full UTF-8 record source limit, including frontmatter; not an ABI/batch limit.
pub const SYNCED_RECORD_MAX_BYTES: usize = 1024 * 1024;

/// Trusted collection write policy; synced desktops have the same limit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordWriteAdmission {
    /// Admit new synced record writes up to exactly one MiB of source bytes.
    Synced,
    /// Local-only writes are outside sync admission; reads are never changed.
    LocalOnly,
}
/// Whole-write refusal. No truncation, unmanaged-vault fallback or partial apply.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecordWriteTooLarge {
    /// UTF-8 source bytes presented or produced.
    pub actual_bytes: usize,
    /// Maximum synced record source bytes.
    pub max_bytes: usize,
}
impl RecordWriteTooLarge {
    /// Stable reason for mapping into the existing typed request error envelope.
    pub const fn reason(self) -> &'static str {
        "record_too_large"
    }
}
impl fmt::Display for RecordWriteTooLarge {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "record source is {} bytes; synced records are limited to {} bytes; store large content as an attachment",
            self.actual_bytes, self.max_bytes
        )
    }
}
impl std::error::Error for RecordWriteTooLarge {}
impl RecordWriteAdmission {
    /// Preflight direct document input BEFORE parsing/rewriting/allocating copies.
    /// Measures exact UTF-8 bytes (not characters, body-only or a declared size).
    pub fn check_source(self, source: &str) -> Result<(), RecordWriteTooLarge> {
        if self == Self::Synced && source.len() > SYNCED_RECORD_MAX_BYTES {
            return Err(RecordWriteTooLarge {
                actual_bytes: source.len(),
                max_bytes: SYNCED_RECORD_MAX_BYTES,
            });
        }
        Ok(())
    }
    /// Check complete canonical planned record sources BEFORE any publication or
    /// effect application. Covers generated defaults/lifecycle/backlink rewrites.
    /// Non-record effects have their own admission; no mutation occurs here.
    pub fn check_planned(self, planned: &Planned) -> Result<(), RecordWriteTooLarge> {
        for effect in &planned.effects {
            if let Effect::PutRecord { doc, .. } | Effect::ReindexOrdinaryFile { doc, .. } = effect
            {
                self.check_source(doc)?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::Uuid;
    use crate::plan::{Planned, Status};
    use crate::semantics::SEM;
    fn planned(doc: String) -> Planned {
        Planned {
            sem: SEM,
            status: Status::Applied,
            effects: vec![Effect::PutRecord {
                id: Uuid([1; 16]),
                path: "notes/a.md".into(),
                doc,
            }],
            conflicts: vec![],
            aliases: vec![],
            base_text_fills: vec![],
            issues: vec![],
            ends_batch: false,
            touches: vec![],
            link_rewrites: vec![],
            broken_links: vec![],
        }
    }
    #[test]
    fn exact_boundary_is_allowed_one_byte_over_has_typed_attachment_guidance() {
        let mut s = "a".repeat(SYNCED_RECORD_MAX_BYTES);
        assert!(RecordWriteAdmission::Synced.check_source(&s).is_ok());
        s.push('a');
        let e = RecordWriteAdmission::Synced.check_source(&s).unwrap_err();
        assert_eq!(e.actual_bytes, SYNCED_RECORD_MAX_BYTES + 1);
        assert_eq!(e.reason(), "record_too_large");
        assert!(e.to_string().contains("attachment"));
    }
    #[test]
    fn measures_utf8_and_frontmatter_not_character_or_body_counts() {
        let mut s = "é".repeat(SYNCED_RECORD_MAX_BYTES / 2);
        assert!(RecordWriteAdmission::Synced.check_source(&s).is_ok());
        s.push('é');
        assert_eq!(
            RecordWriteAdmission::Synced
                .check_source(&s)
                .unwrap_err()
                .actual_bytes,
            SYNCED_RECORD_MAX_BYTES + 2
        );
        let full = format!(
            "---\ntitle: A\n---\n{}",
            "x".repeat(SYNCED_RECORD_MAX_BYTES)
        );
        assert!(RecordWriteAdmission::Synced.check_source(&full).is_err());
    }
    #[test]
    fn local_only_source_and_planned_writes_are_not_sync_gated() {
        let s = "x".repeat(SYNCED_RECORD_MAX_BYTES + 1);
        assert!(RecordWriteAdmission::LocalOnly.check_source(&s).is_ok());
        assert!(
            RecordWriteAdmission::LocalOnly
                .check_planned(&planned(s))
                .is_ok()
        );
    }
    #[test]
    fn complete_generated_record_is_refused_before_any_effect_can_be_applied() {
        let p = planned("x".repeat(SYNCED_RECORD_MAX_BYTES + 1));
        let before = p.clone();
        assert!(RecordWriteAdmission::Synced.check_planned(&p).is_err());
        assert_eq!(p, before);
    }
}
