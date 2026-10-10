//! Trusted admission for NEW writes, never historical replay or recovery.
use mdbn_core::plan::admission::{RecordWriteAdmission, RecordWriteTooLarge};
use mdbn_wire::common::{Text, Value};
use mdbn_wire::intent::Op;

use super::Replica;
use crate::api::{ApiError, ErrorCode};
use crate::store::Store;

pub(super) fn record_too_large(e: RecordWriteTooLarge) -> ApiError {
    ErrorCode::InvalidRequest.err_with_reason(e.reason(), e.to_string())
}

impl<S: Store> Replica<S> {
    pub(super) fn record_write_admission(&self) -> RecordWriteAdmission {
        if self.local_only() {
            RecordWriteAdmission::LocalOnly
        } else {
            RecordWriteAdmission::Synced
        }
    }

    /// Inspect direct NEW source without resolving/cloning it. Historical bases
    /// are intentionally excluded: reducing an old oversized record is legal.
    pub(super) fn check_new_record_sources(&self, ops: &[Op]) -> Result<(), RecordWriteTooLarge> {
        let admission = self.record_write_admission();
        let check = |text: &Text| match text {
            Text::Inline(source) => admission.check_source(source),
            // Submit/capture's existing inline-only resolver rejects indices.
            Text::Index(_) => Ok(()),
        };
        for op in ops {
            match op {
                Op::Create(c) => {
                    if let Some(document) = &c.document {
                        check(document)?;
                    }
                    if let Some(body) = &c.body {
                        check(body)?;
                    }
                }
                Op::Update(u) => {
                    if let Some(body) = &u.body {
                        check(body)?;
                    }
                    if let Some(edits) = &u.body_edits {
                        for edit in edits {
                            admission.check_source(&edit.insert)?;
                        }
                    }
                }
                Op::Document(d) => {
                    if let Some(new) = &d.new {
                        check(&new.doc)?;
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }

    /// A refused observation stays unacknowledged: retain the user's bytes and
    /// evidence instead of silently reclassifying it or publishing confirmed text.
    pub(super) fn record_admission_incident(&mut self, e: RecordWriteTooLarge) {
        self.incident(
            mdbn_wire::client::IncidentKind::QuotaExceeded,
            Some(Value::Map(vec![
                ("reason".into(), Value::Text(e.reason().into())),
                ("message".into(), Value::Text(e.to_string())),
            ])),
        );
    }
}
