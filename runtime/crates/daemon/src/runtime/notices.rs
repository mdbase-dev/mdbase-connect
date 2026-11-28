//! File notices: unsupported entries, refused uploads and held files, bounded for status.

use super::*;

/// Local notices reuse the store's scan and the replica's holds/upload failures.
pub(super) fn file_notices(rep: &Replica<Store>) -> Vec<crate::control::Notice> {
    use mdbn_replica::store::Store as _;
    use mdbn_wire::client::HoldReason;
    let unsupported = &rep.store().inner().stats.unsupported_paths;
    let failures = rep.attachment_ingest_failures();
    let edits = rep.refused_files();
    let (mut holds, error) = match rep.store().holds() {
        Ok(holds) => (holds, None),
        Err(_) => (
            Vec::new(),
            Some(crate::control::Notice {
                path: None,
                code: "file_status_unavailable".into(),
                message: "Could not read held files; file notices may be incomplete.".into(),
            }),
        ),
    };
    holds.sort_by_key(|hold| hold.reason != HoldReason::UnknownProvenance);
    let total = unsupported.len()
        + failures.len()
        + edits.len()
        + holds.len()
        + usize::from(error.is_some());
    let skipped = unsupported
        .iter()
        .map(|(path, reason)| crate::control::Notice {
            path: Some(path.clone()),
            code: "unsupported_entry".into(),
            message: reason.clone(),
        });
    let refused = failures.map(|(path, problem)| crate::control::Notice {
        path: Some(path.into()),
        code: problem
            .reason
            .clone()
            .unwrap_or_else(|| problem.code.clone()),
        message: problem.message.clone(),
    });
    let edits = edits.map(|(path, problem, deleted)| edit_refused_notice(path, problem, deleted));
    let held = holds.into_iter().map(|hold| {
        let collision = rep
            .store()
            .record(&hold.id)
            .ok()
            .flatten()
            .filter(|record| {
                hold.reason == HoldReason::UnknownProvenance
                    && record.path != hold.path
                    && mdbn_core::paths::path_key(&record.path)
                        == mdbn_core::paths::path_key(&hold.path)
            });
        let code = if collision.is_some() {
            "name_collision"
        } else {
            "file_held"
        };
        let reason = if let Some(record) = collision {
            format!(
                "Case or Unicode name collision with {:?}; file held.",
                record.path
            )
        } else {
            match hold.reason {
                HoldReason::Conflict => "Changed here and elsewhere; file held.",
                HoldReason::UnknownProvenance => {
                    "Changed by a program mdbase does not recognise; file held."
                }
                HoldReason::DeletedElsewhere => "Deleted on another device; file held.",
                HoldReason::ReadOnly => "Changed while read-only; file held.",
                HoldReason::EditorBusy => "Open in an editor; file held.",
                HoldReason::SuspectWrite => "Looked like an accidental overwrite; file held.",
            }
            .into()
        };
        crate::control::Notice {
            path: Some(hold.path),
            code: code.into(),
            message: format!("{reason} Resolve it in mdbase."),
        }
    });
    limited_file_notices(
        error
            .into_iter()
            .chain(skipped)
            .chain(refused)
            .chain(edits)
            .chain(held),
        total,
    )
}

/// A file whose change was rejected; the disk keeps what was written there.
fn edit_refused_notice(
    path: &str,
    problem: &mdbn_wire::client::Problem,
    deleted: bool,
) -> crate::control::Notice {
    let why = match (problem.code.as_str(), problem.reason.as_deref()) {
        (_, Some("refs")) => "it refers to too many files",
        (_, Some("attachment_objects_missing")) => "a file it attaches could not be uploaded",
        ("too_large", _) => "it is too large",
        _ => "it is not a valid change",
    };
    let message = if deleted {
        format!(
            "This deletion could not be synced ({why}). The file is deleted on this \
             device only and still exists elsewhere. Put the file back to sync it again."
        )
    } else {
        format!(
            "This change could not be synced ({why}). The content is kept in the file. \
             Edit the file to try again."
        )
    };
    crate::control::Notice {
        path: Some(path.into()),
        code: "edit_refused".into(),
        message,
    }
}

fn limited_file_notices(
    notices: impl Iterator<Item = crate::control::Notice>,
    total: usize,
) -> Vec<crate::control::Notice> {
    let mut shown = Vec::new();
    let mut bytes = 0;
    // Bound actor work as well as JSON size; long names count against the byte budget.
    for notice in notices.take(50) {
        let size = serde_json::to_vec(&notice)
            .expect("notice is serializable")
            .len();
        if bytes + size <= 16 * 1024 {
            bytes += size;
            shown.push(notice);
        }
    }
    let omitted = total - shown.len();
    if omitted > 0 {
        shown.push(crate::control::Notice {
            path: None,
            code: "file_notices_omitted".into(),
            message: format!("{omitted} additional file notices are not shown."),
        });
    }
    shown
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_refused_edit_is_noticed_on_its_file() {
        let problem = mdbn_replica::api::ErrorCode::TooLarge
            .problem_with_reason("item_bytes", "the log refused this change");
        let notice = super::edit_refused_notice("notes/big.md", &problem, false);
        assert_eq!(notice.path.as_deref(), Some("notes/big.md"));
        assert_eq!(notice.code, "edit_refused");
        assert_eq!(
            notice.message,
            "This change could not be synced (it is too large). The content is kept in \
             the file. Edit the file to try again."
        );
        let missing = mdbn_replica::api::ErrorCode::NotFound
            .problem_with_reason("attachment_objects_missing", "upload it again");
        let notice = super::edit_refused_notice("media/a.png", &missing, false);
        assert!(
            notice
                .message
                .contains("(a file it attaches could not be uploaded)")
        );
        let invalid = mdbn_replica::api::ErrorCode::InvalidRequest.problem("refused");
        let notice = super::edit_refused_notice("notes/gone.md", &invalid, true);
        assert_eq!(
            notice.message,
            "This deletion could not be synced (it is not a valid change). The file is \
             deleted on this device only and still exists elsewhere. Put the file back to \
             sync it again."
        );
    }

    #[test]
    fn file_notices_bound_work_and_bytes_without_hiding_the_omitted_count() {
        let mapped = std::cell::Cell::new(0);
        let notices = (0..10_000).map(|n| {
            mapped.set(mapped.get() + 1);
            crate::control::Notice {
                path: Some(format!("media/{n}-{}.png", "x".repeat(4096))),
                code: "quota_exceeded".into(),
                message: "Storage is full; this file has not synced.".into(),
            }
        });
        let shown = super::limited_file_notices(notices, 10_000);
        assert_eq!(mapped.get(), 50, "do not read every held record for status");
        let count = shown.iter().filter(|notice| notice.path.is_some()).count();
        assert!(count > 0 && count < 50);
        assert!(
            shown
                .last()
                .unwrap()
                .message
                .starts_with(&(10_000 - count).to_string())
        );
        assert!(serde_json::to_vec(&shown).unwrap().len() < 17 * 1024);
    }
}
