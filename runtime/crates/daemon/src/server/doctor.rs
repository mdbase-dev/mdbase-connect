//! `doctor`: the daemon's self-checks, including adopt checks.

use super::*;

impl Daemon {
    pub(super) async fn doctor(&self) -> Vec<Check> {
        let mut checks = Vec::new();
        let r = self.readiness.borrow().clone();
        let inner = self.inner.lock().await;
        checks.push(Check {
            id: "readiness".into(),
            status: if r.ready { "ok" } else { "fail" }.into(),
            detail: if r.ready {
                format!("ready, version {}", r.binary_version)
            } else {
                format!(
                    "not ready: {}",
                    inner
                        .init_error
                        .clone()
                        .unwrap_or_else(|| format!("{:?}", r.safe_reason))
                )
            },
            action: (!r.ready).then(|| match r.safe_reason {
                Some(NotReady::CredentialStoreUnavailable) => {
                    "Unlock the OS keychain (or Secret Service on Linux), then open mdbase connect; \
                     the daemon retries when it connects. Do not delete daemon.json."
                        .into()
                }
                Some(NotReady::InitializationFailed) => format!(
                    "Inspect {} (it was left unchanged), restore a backup, then restart.",
                    self.profile.registry_file().display()
                ),
                _ => "Wait, then run `mdbase daemon status` again.".into(),
            }),
        });
        checks.push(Check {
            id: "secret_backend".into(),
            status: if self.secrets.backend() == "keychain" {
                "ok"
            } else {
                "warn"
            }
            .into(),
            detail: format!("secrets are stored in: {}", self.secrets.backend()),
            action: (self.secrets.backend() != "keychain")
                .then(|| "Test-only backend; never use it for real collections.".into()),
        });
        checks.push(match &self.trust {
            Some(t) => Check {
                id: "trust".into(),
                status: "ok".into(),
                detail: format!("synced collections trust the {} service", t.environment),
                action: None,
            },
            None => Check {
                id: "trust".into(),
                status: "fail".into(),
                detail: "this build has no authenticated trust for synced collections".into(),
                action: Some(
                    "Update mdbase. Until then collections stay on this computer only and \
                     turning on sync refuses; your files are not affected."
                        .into(),
                ),
            },
        });
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&self.profile.state_dir)
                .map(|m| m.permissions().mode() & 0o777)
                .unwrap_or(0);
            checks.push(Check {
                id: "state_dir_private".into(),
                status: if mode == 0o700 { "ok" } else { "fail" }.into(),
                detail: format!("{} has mode {mode:o}", self.profile.state_dir.display()),
                action: (mode != 0o700).then(|| "chmod 700 the state directory.".into()),
            });
        }
        for h in &inner.hosts {
            let s = h.status();
            checks.push(collection_check(&s));
            if let Some(c) = adopt_check(
                &self.profile.state_dir.join("collections"),
                h.entry(),
                self.trust.is_some(),
            ) {
                checks.push(c);
            }
        }
        let profile = self.profile.clone();
        checks.push(
            tokio::task::spawn_blocking(move || crate::service::doctor_check(&profile))
                .await
                .unwrap_or_else(|e| Check {
                    id: "service".into(),
                    status: "warn".into(),
                    detail: format!("service check failed: {e}"),
                    action: None,
                }),
        );
        let (version, state_dir) = (r.binary_version.clone(), self.profile.state_dir.clone());
        checks.push(
            tokio::task::spawn_blocking(move || {
                crate::update::doctor_check(&version, &state_dir, time::OffsetDateTime::now_utc())
            })
            .await
            .unwrap_or_else(|e| Check {
                id: "update".into(),
                status: "warn".into(),
                detail: format!("update check failed: {e}"),
                action: None,
            }),
        );
        checks
    }
}

/// A collection whose adopt is unfinished: what is happening and what to run.
fn adopt_check(
    collections: &std::path::Path,
    e: &crate::registry::Entry,
    trusted: bool,
) -> Option<Check> {
    let journal = crate::adopt::Journal::path(collections, &e.id);
    let pending = journal.exists();
    if e.mode != SyncMode::Local {
        return pending.then(|| Check {
            id: format!("adopt:{}", e.id),
            status: "warn".into(),
            detail: format!("{}: turning sync on, the folder is being adopted", e.name),
            action: Some("Keep the daemon running; it continues after a restart.".into()),
        });
    }
    if !pending {
        return None;
    }
    if !trusted {
        return Some(Check {
            id: format!("adopt:{}", e.id),
            status: "warn".into(),
            detail: format!(
                "{}: turning sync on was interrupted; this build cannot sync",
                e.name
            ),
            action: Some(
                "Update mdbase. The folder stays on this computer and your files are not affected."
                    .into(),
            ),
        });
    }
    Some(Check {
        id: format!("adopt:{}", e.id),
        status: "warn".into(),
        detail: format!("{}: turning sync on was interrupted", e.name),
        action: Some(format!("Run `mdbase sync enable {}` to finish.", e.id)),
    })
}

/// A collection's doctor check, graded by its state: one that is not served
/// never reads `ok`. The action is the collection's own notice for its reason
/// when it has one (for `sync_integrity`, when it reopens and how to retry now).
pub(super) fn collection_check(s: &CollectionStatus) -> Check {
    let notice = || {
        s.notices
            .iter()
            .find(|n| Some(n.code.as_str()) == s.reason.as_deref())
            .map(|n| n.message.clone())
    };
    let (status, action) = match (s.state, s.reason.as_deref()) {
        (_, Some("folder_missing")) => (
            "fail",
            Some("Reconnect the folder's drive, or `mdbase collection remove`.".to_string()),
        ),
        (_, Some("joining_sync" | "detached_sync")) => (
            "warn",
            Some("Keep the folder editable; join proof is pending. Abandon/rejoin must be explicit.".into()),
        ),
        (_, Some("runtime_pending")) => ("warn", None),
        (crate::control::CollectionState::Failed, _) => (
            "fail",
            Some(notice().unwrap_or_else(|| {
                "Apps cannot use it. `mdbase logs` has the details; `mdbase collection resume` retries."
                    .into()
            })),
        ),
        (crate::control::CollectionState::Unavailable, _) => ("warn", notice()),
        _ => ("ok", None),
    };
    Check {
        id: format!("collection:{}", s.id),
        status: status.into(),
        detail: format!(
            "{} at {}: {:?}{}",
            s.name,
            s.root.display(),
            s.state,
            s.reason
                .as_ref()
                .map(|r| format!(" ({r})"))
                .unwrap_or_default()
        ),
        action,
    }
}

#[cfg(test)]
mod collection_check_tests {
    use super::collection_check;
    use crate::control::CollectionStatus;

    /// A status as `mdbase --json status` prints it.
    fn status(state: &str, reason: Option<&str>, notices: serde_json::Value) -> CollectionStatus {
        serde_json::from_value(serde_json::json!({
            "id": "900c5d48-4901-4a3a-9bdb-eb4b02c9930f",
            "name": "Notes (Reader)",
            "root": "/home/u/notes-reader",
            "mode": "synced_e2e",
            "origin": "migrated_local",
            "log": "hosted",
            "state": state,
            "reason": reason,
            "notices": notices,
        }))
        .unwrap()
    }

    #[test]
    fn a_failed_collection_fails_with_its_own_notice() {
        let notice = "Sync stopped after a consistency check failed; mdbase reopens it automatically in about 5 minutes (attempt 3).";
        let c = collection_check(&status(
            "failed",
            Some("sync_integrity"),
            serde_json::json!([
                {"code": "app_access_added", "message": "Reader can now use this collection"},
                {"code": "sync_integrity", "message": notice},
            ]),
        ));
        assert_eq!(c.status, "fail", "{}", c.detail);
        assert!(c.detail.contains("Failed (sync_integrity)"), "{}", c.detail);
        assert_eq!(c.action.as_deref(), Some(notice));

        let c = collection_check(&status(
            "failed",
            Some("open_failed"),
            serde_json::json!([]),
        ));
        assert_eq!(c.status, "fail");
        assert!(c.action.unwrap().contains("mdbase logs"));

        let notice = "Sync stopped: this collection's storage on this computer failed the same way after 3 automatic reopens (x). Check this computer's disk, free space and keychain, then run `mdbase collection resume 900c5d48`.";
        let c = collection_check(&status(
            "failed",
            Some(crate::collections::STORAGE_FAULT),
            serde_json::json!([{"code": "storage_fault", "message": notice}]),
        ));
        assert_eq!(c.status, "fail");
        assert_eq!(c.action.as_deref(), Some(notice));
    }

    #[test]
    fn unavailable_warns_and_serving_or_paused_is_ok() {
        let c = collection_check(&status(
            "unavailable",
            Some("old_connector_running"),
            serde_json::json!([{"code": "old_connector_running", "message": "Quit the old mdbase Connect."}]),
        ));
        assert_eq!(c.status, "warn");
        assert_eq!(c.action.as_deref(), Some("Quit the old mdbase Connect."));
        for state in ["ready", "syncing", "opening", "paused"] {
            assert_eq!(
                collection_check(&status(state, None, serde_json::json!([]))).status,
                "ok",
                "{state}"
            );
        }
        assert_eq!(
            collection_check(&status(
                "opening",
                Some("runtime_pending"),
                serde_json::json!([])
            ))
            .status,
            "warn"
        );
    }
}
