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
            let (status, action) = match s.reason.as_deref() {
                Some("folder_missing") => (
                    "fail",
                    Some(
                        "Reconnect the folder's drive, or `mdbase collection remove`.".to_string(),
                    ),
                ),
                Some("joining_sync" | "detached_sync") => (
                    "warn",
                    Some("Keep the folder editable; join proof is pending. Abandon/rejoin must be explicit.".into()),
                ),
                Some("runtime_pending") => ("warn", None),
                _ => ("ok", None),
            };
            checks.push(Check {
                id: format!("collection:{}", s.id),
                status: status.into(),
                detail: format!(
                    "{} at {}: {:?}{}",
                    s.name,
                    s.root.display(),
                    s.state,
                    s.reason.map(|r| format!(" ({r})")).unwrap_or_default()
                ),
                action,
            });
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
