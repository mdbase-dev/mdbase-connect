//! `doctor`: the daemon's self-checks, including takeover, mirror-join and adopt checks.

use super::*;

impl Daemon {
    pub(super) fn takeover_check(&self, registry: &Registry) -> Option<Check> {
        use crate::takeover::record::{CollectionState, Record, State};
        let record = match Record::load(&self.takeover_paths().record) {
            Ok(Some(r)) => r,
            Ok(None) => {
                let (detail, action) = crate::takeover::waiting_check_text(
                    *self
                        .takeover
                        .waiting_reason
                        .lock()
                        .unwrap_or_else(|p| p.into_inner()),
                );
                return self
                    .takeover
                    .waiting_for_batch
                    .load(std::sync::atomic::Ordering::Relaxed)
                    .then(|| Check {
                        id: "takeover".into(),
                        status: "warn".into(),
                        detail: detail.into(),
                        action: Some(action.into()),
                    });
            }
            Err(e) => {
                return Some(Check {
                    id: "takeover".into(),
                    status: "fail".into(),
                    detail: format!("the takeover record is unreadable: {e}"),
                    action: Some(
                        "Inspect takeover.json in the state directory; it was left unchanged."
                            .into(),
                    ),
                });
            }
        };
        let revived = self
            .takeover
            .revived
            .load(std::sync::atomic::Ordering::Relaxed);
        let waiting: Vec<String> = record
            .collections
            .iter()
            .filter(|(_, c)| !c.state.settled() && c.state != CollectionState::RolledBack)
            .map(|(id, c)| format!("{id} ({})", c.reason.as_deref().unwrap_or("pending")))
            .collect();
        let held = record.held_interrupted_writes();
        // Latched incidents, plus a live read (the record is only updated by runs).
        let paths = self.takeover_paths();
        let registered = registered_roots(registry);
        let evidence = |id: &str| {
            crate::takeover::adapter::Evidence::load(&paths.legacy, id)
                .ok()
                .flatten()
        };
        // Folders the user registered again as another collection: nothing to report.
        let superseded: std::collections::BTreeSet<&String> = record
            .collections
            .keys()
            .filter(|id| {
                evidence(id).is_some_and(|e| crate::takeover::superseded(id, &e.root, &registered))
            })
            .collect();
        let incidents: Vec<&String> = record
            .collections
            .iter()
            .filter(|(id, _)| !superseded.contains(id))
            .filter(|(id, c)| {
                c.marker_incident
                    || (matches!(c.state, CollectionState::Complete | CollectionState::Held)
                        && c.reason.as_deref() != Some("folder_missing")
                        && evidence(id).is_some_and(|e| {
                            !crate::takeover::marker_is_ours(&e.root, id, &paths.store_ids)
                                .unwrap_or(false)
                        }))
            })
            .map(|(id, _)| id)
            .collect();
        let unregistered: Vec<String> = record
            .collections
            .iter()
            .filter(|(id, c)| {
                c.state.settled()
                    && !c.registered
                    && c.reason.as_deref() != Some("folder_missing")
                    && !superseded.contains(id)
            })
            .map(|(id, c)| format!("{id} ({})", c.reason.as_deref().unwrap_or("pending")))
            .collect();
        let overlapping = record.collections.values().any(|c| {
            !c.registered && c.reason.as_deref() == Some("registration_pending:overlapping_root")
        });
        let ok = !revived
            && waiting.is_empty()
            && held == 0
            && unregistered.is_empty()
            && incidents.is_empty();
        let mut detail = format!("takeover {:?}", record.state).to_lowercase();
        if self
            .takeover
            .waiting_for_batch
            .load(std::sync::atomic::Ordering::Relaxed)
        {
            let (waiting, _) = crate::takeover::waiting_check_text(
                *self
                    .takeover
                    .waiting_reason
                    .lock()
                    .unwrap_or_else(|p| p.into_inner()),
            );
            detail.push_str("; ");
            detail.push_str(waiting);
        }
        if revived {
            detail.push_str("; old_connector_revived");
        }
        if !incidents.is_empty() {
            detail.push_str(&format!(
                "; marker_incident: {}",
                incidents
                    .iter()
                    .map(|s| s.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        if !waiting.is_empty() {
            detail.push_str(&format!("; waiting: {}", waiting.join(", ")));
        }
        if held > 0 {
            detail.push_str(&format!(
                "; {held} interrupted legacy write/delete intent(s) held"
            ));
        }
        if !unregistered.is_empty() {
            detail.push_str(&format!(
                "; not registered yet: {}",
                unregistered.join(", ")
            ));
        }
        Some(Check {
            id: "takeover".into(),
            status: if !incidents.is_empty() {
                "fail"
            } else if ok || record.state == State::RolledBack {
                "ok"
            } else {
                "warn"
            }
            .into(),
            detail,
            action: (!ok).then(|| {
                if !incidents.is_empty() {
                    "A taken-over folder lost its .mdbase/connect-role.json claim (or it was changed). \
                     Do not recreate it by hand: check whether the old mdbase Connect is running, then \
                     contact support with `mdbase migrate status --json`."
                        .into()
                } else if revived {
                    "The old mdbase Connect daemon is running again: quit or uninstall it, then run `mdbase migrate start`.".into()
                } else if overlapping {
                    "A taken-over folder contains, or sits inside, a registered collection's folder, \
                     and collections cannot nest. Choose one: keep the registered collection and leave \
                     the taken-over folder unserved (this check keeps reporting it), or unregister the \
                     other collection (`mdbase collection remove <id>`, files untouched) or move one \
                     folder, then run `mdbase migrate start`."
                        .into()
                } else {
                    "Run `mdbase migrate status` for details; sign in if collections are waiting to register.".into()
                }
            }),
        })
    }

    /// Old hosted mirrors whose captured unsent edits wait because their
    /// collection could not be joined here (`takeover::mirror_join`).
    pub(super) fn mirror_join_checks(&self) -> Vec<Check> {
        use crate::takeover::{mirror_import::Capture, mirror_join};
        let legacy = self.takeover_paths().legacy;
        let ids = crate::takeover::mirror_import::captured(&legacy).unwrap_or_default();
        ids.into_iter()
            .filter_map(|id| {
                let join = mirror_join::JoinState::load(&legacy, &id).ok()?;
                if join.phase != mirror_join::Phase::Pending {
                    return None;
                }
                let reason = join.last_error?;
                let capture = Capture::load(&legacy, &id).ok()??;
                let root = capture.mirror_root.display();
                let action = match reason.as_str() {
                    "not_signed_in" => {
                        "Sign in (`mdbase account sign-in`); the join is retried automatically."
                            .to_owned()
                    }
                    "not_found" => format!(
                        "Your account has no hosted collection {id}; it may have been deleted. \
                         The edits are still in {root}, which mdbase never changes: copy what \
                         you need into another collection. The join is retried every 30 minutes \
                         in case the collection becomes available again."
                    ),
                    _ => format!(
                        "The join is retried automatically. The edits are still in {root}, \
                         which mdbase never changes. See `mdbase migrate status --json`."
                    ),
                };
                Some(Check {
                    id: format!("mirror_import:{id}"),
                    status: "warn".into(),
                    detail: format!(
                        "{} unsent edit(s) from the old hosted mirror at {root} are waiting: \
                         the hosted collection could not be joined ({reason})",
                        capture.edits.len()
                    ),
                    action: Some(action),
                })
            })
            .collect()
    }

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
                self.auto_private.failure(&s.id),
                self.trust.is_some(),
            ) {
                checks.push(c);
            }
            if let Some(diagnostic) = h.mirror_diagnostic() {
                checks.push(Check {
                    id: format!("mirror_join:{}", s.id),
                    status: "warn".into(),
                    detail: diagnostic.message(),
                    action: None,
                });
            }
        }
        checks.extend(self.takeover_check(&inner.registry));
        checks.extend(self.mirror_join_checks());
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
        checks.push(crate::update::doctor_check(
            &r.binary_version,
            &self.profile.state_dir,
            time::OffsetDateTime::now_utc(),
        ));
        if self.profile.target == crate::paths::Target::InstalledService {
            use crate::takeover::record::Record;
            let fenced = Record::load(&self.takeover_paths().record)
                .ok()
                .flatten()
                .is_some_and(|rec| rec.state.fences_old_service());
            checks.push(loopback_check(fenced, CONNECTOR_LOOPBACK).await);
        }
        if let Some(retirement) = self
            .takeover
            .retirement
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
        {
            let retired = retirement["retired"] == true;
            checks.push(Check {
                id: "legacy_retirement".into(),
                status: if retired { "ok" } else { "warn" }.into(),
                detail: if retired { "legacy connector retirement confirmed".into() }
                    else { format!("legacy connector retirement pending ({})", retirement["reason"].as_str().unwrap_or("not_confirmed")) },
                action: (!retired).then(|| "Retirement is retried after a successful takeover run; it requires the exact full inventory and Connect endpoint availability.".into()),
            });
        }
        checks
    }
}

/// The old connector's browser port. The daemon serves it only after the takeover
/// fenced the old service, and never binds another port in its place.
const CONNECTOR_LOOPBACK: std::net::SocketAddr = std::net::SocketAddr::V4(
    std::net::SocketAddrV4::new(std::net::Ipv4Addr::LOCALHOST, 28485),
);

/// The `doctor` `loopback_port` check: a connect-only probe (never a bind, which could
/// race the port's owner). Held after the takeover fenced the old service means
/// something else, usually a revived old app, has it: `loopback_port_busy`.
pub(super) async fn loopback_check(fenced: bool, addr: std::net::SocketAddr) -> Check {
    let held = matches!(
        tokio::time::timeout(
            Duration::from_millis(500),
            tokio::net::TcpStream::connect(addr)
        )
        .await,
        Ok(Ok(_))
    );
    let (status, detail, action) = match (held, fenced) {
        (true, true) => (
            "warn",
            format!("loopback_port_busy: {addr} is held by another process"),
            Some(format!(
                "Quit whatever holds port {} (usually the old mdbase Connect app); the daemon never serves browser apps on another port.",
                addr.port()
            )),
        ),
        (true, false) => (
            "ok",
            format!("{addr} is in use, as expected while today's mdbase Connect runs"),
            None,
        ),
        (false, _) => ("ok", format!("{addr} is free"), None),
    };
    Check {
        id: "loopback_port".into(),
        status: status.into(),
        detail,
        action,
    }
}

/// A taken-over collection still waiting for Private sync (turned on by itself,
/// see `auto_private`; `failure` is its last attempt's refusal), or one whose
/// adopt is unfinished: what is happening and what to run.
fn adopt_check(
    collections: &std::path::Path,
    e: &crate::registry::Entry,
    failure: Option<String>,
    trusted: bool,
) -> Option<Check> {
    let journal = crate::adopt::Journal::path(collections, &e.id);
    let pending = journal.exists();
    let migrated = e.origin == crate::registry::Origin::MigratedLocal;
    if e.mode != SyncMode::Local {
        return pending.then(|| Check {
            id: format!("adopt:{}", e.id),
            status: "warn".into(),
            detail: format!("{}: turning sync on, the folder is being adopted", e.name),
            action: Some("Keep the daemon running; it continues after a restart.".into()),
        });
    }
    let why = failure
        .as_deref()
        .map(|r| format!(" ({}: {r})", crate::auto_private::explain(r)))
        .unwrap_or_default();
    // Without trust, `mdbase sync enable` refuses too: do not recommend it.
    if !trusted && (pending || (migrated && !e.paused)) {
        return Some(Check {
            id: format!("adopt:{}", e.id),
            status: "warn".into(),
            detail: if pending {
                format!(
                    "{}: turning sync on was interrupted; this build cannot sync{why}",
                    e.name
                )
            } else {
                format!(
                    "{}: taken over from mdbase Connect; Private sync is not on yet because this build cannot sync{why}",
                    e.name
                )
            },
            action: Some(
                "Update mdbase; it then turns on Private sync by itself. The folder stays on this \
                 computer and your files are not affected."
                    .into(),
            ),
        });
    }
    if pending {
        return Some(Check {
            id: format!("adopt:{}", e.id),
            status: "warn".into(),
            detail: format!("{}: turning sync on was interrupted{why}", e.name),
            action: Some(if migrated {
                format!(
                    "mdbase finishes it on its own when it starts and after sign-in; \
                     to finish now, run `mdbase sync enable {}`.",
                    e.id
                )
            } else {
                format!("Run `mdbase sync enable {}` to finish.", e.id)
            }),
        });
    }
    if !migrated {
        return None;
    }
    if e.paused {
        return Some(Check {
            id: format!("adopt:{}", e.id),
            status: "warn".into(),
            detail: format!("{}: taken over from mdbase Connect and paused", e.name),
            action: Some(
                "Resume it; mdbase then turns on Private sync so apps can reach it.".into(),
            ),
        });
    }
    Some(Check {
        id: format!("adopt:{}", e.id),
        status: "warn".into(),
        detail: format!(
            "{}: taken over from mdbase Connect; Private sync is not on yet{why}",
            e.name
        ),
        action: Some(format!(
            "mdbase turns it on by itself so apps that used it keep working, and retries \
             when it starts and after sign-in. To try now, run `mdbase sync enable {}`.",
            e.id
        )),
    })
}
