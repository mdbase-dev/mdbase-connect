//! The `doctor` `update` check: what the mdbase connect app last learned about
//! updates.
//!
//! The app update delivers this daemon (`docs/desktop-updates.md`), so whether a
//! newer release exists is the app's knowledge, not the daemon's. After each
//! successful check the app writes `<state>/updates/desktop.json`
//! (`apps/desktop/src/main/update-report.ts`); `<state>/updates/` belongs to
//! packaging (`crate::service`). The daemon only reads it, and only to explain.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};

use crate::control::Check;

/// The app checks every six hours while it runs and its timer every six hours
/// while it doesn't; three days without a check means neither is happening.
const STALE_AFTER: Duration = Duration::days(3);

fn report_path(state_dir: &Path) -> PathBuf {
    state_dir.join("updates").join("desktop.json")
}

/// Schema 1. Fields this daemon does not know are ignored.
#[derive(Debug, Deserialize)]
struct Report {
    schema_version: u32,
    app_version: String,
    checked_at: String,
    #[serde(default)]
    background: bool,
    available: Option<Available>,
}

#[derive(Debug, Deserialize)]
struct Available {
    version: String,
    install: Install,
    release_url: Option<String>,
    #[serde(default)]
    required: bool,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Install {
    /// Restart and update in the app (and in the background when `background`).
    Restart,
    /// A new package from the release page or the package manager.
    Package,
    Store,
    #[serde(other)]
    Other,
}

fn check(status: &str, detail: String, action: Option<String>) -> Check {
    Check {
        id: "update".into(),
        status: status.into(),
        detail,
        action,
    }
}

/// The `update` check for a daemon at `version` whose state directory is
/// `state_dir`: `ok` after a recent check that found nothing to install, else a
/// warning that says what to do.
pub fn doctor_check(version: &str, state_dir: &Path, now: OffsetDateTime) -> Check {
    let path = report_path(state_dir);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return check(
                "warn",
                format!("version {version}; mdbase connect has not reported an update check on this computer"),
                Some(
                    "Open mdbase connect so it checks for updates. Without the app, install new releases manually."
                        .into(),
                ),
            );
        }
        Err(e) => {
            return check(
                "warn",
                format!(
                    "version {version}; {} could not be read: {e}",
                    path.display()
                ),
                None,
            );
        }
    };
    let report = match serde_json::from_slice::<Report>(&bytes) {
        Ok(report) if report.schema_version == 1 => report,
        _ => {
            return check(
                "warn",
                format!(
                    "version {version}; {} is not an update report this version understands",
                    path.display()
                ),
                Some("Open mdbase connect so it checks for updates and writes it again.".into()),
            );
        }
    };
    let checked = OffsetDateTime::parse(&report.checked_at, &Rfc3339).ok();
    if checked.is_none_or(|at| now - at > STALE_AFTER) {
        return check(
            "warn",
            format!(
                "version {version}; mdbase connect last checked for updates at {}",
                report.checked_at
            ),
            Some(if report.background {
                "The background update has not run. See `systemctl --user status mdbase-connect-update`.".into()
            } else {
                "Open mdbase connect so it checks for updates.".into()
            }),
        );
    }
    let Some(available) = report.available else {
        let background = if report.background {
            "; updates install in the background"
        } else {
            ""
        };
        return check(
            "ok",
            format!(
                "version {version}; up to date (mdbase connect {} checked at {}{background})",
                report.app_version, report.checked_at
            ),
            None,
        );
    };
    let action = match (&available.install, report.background) {
        (Install::Restart, true) => {
            "It installs in the background while mdbase connect is closed, or choose Restart and update in the app now."
                .to_string()
        }
        (Install::Restart, false) => "Choose Restart and update in mdbase connect.".to_string(),
        (Install::Package, _) => match &available.release_url {
            Some(url) => format!("Install the new package: {url}"),
            None => "Install the new package.".to_string(),
        },
        (Install::Store, _) => "Update mdbase connect from the Microsoft Store.".to_string(),
        (Install::Other, _) => "Open mdbase connect to install it.".to_string(),
    };
    let unsupported = if available.required {
        "; this version is no longer supported"
    } else {
        ""
    };
    check(
        "warn",
        format!(
            "version {version}; mdbase connect {} is available (checked at {}){unsupported}",
            available.version, report.checked_at
        ),
        Some(action),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn with_report(json: Option<&str>) -> (Scratch, Check) {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "mdbn-update-report-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        if let Some(json) = json {
            std::fs::create_dir_all(dir.join("updates")).unwrap();
            std::fs::write(report_path(&dir), json).unwrap();
        }
        let now = OffsetDateTime::parse("2026-11-14T06:00:00Z", &Rfc3339).unwrap();
        let check = doctor_check("0.1.0-beta.185", &dir, now);
        (Scratch(dir), check)
    }

    #[test]
    fn no_report_says_nothing_has_checked() {
        let (_dir, c) = with_report(None);
        assert_eq!(c.id, "update");
        assert_eq!(c.status, "warn");
        assert!(
            c.detail.contains("has not reported an update check"),
            "{}",
            c.detail
        );
    }

    #[test]
    fn a_recent_check_without_a_release_is_up_to_date() {
        let (_dir, c) = with_report(Some(
            r#"{"schema_version":1,"app_version":"0.1.0-beta.185","checked_at":"2026-11-14T03:00:00.000Z","background":true,"future":1}"#,
        ));
        assert_eq!(c.status, "ok");
        assert_eq!(
            c.detail,
            "version 0.1.0-beta.185; up to date (mdbase connect 0.1.0-beta.185 checked at 2026-11-14T03:00:00.000Z; updates install in the background)"
        );
        assert_eq!(c.action, None);
    }

    #[test]
    fn an_available_release_names_the_version_and_how_it_installs() {
        let (_dir, c) = with_report(Some(
            r#"{"schema_version":1,"app_version":"0.1.0-beta.185","checked_at":"2026-11-14T03:00:00Z","background":true,
               "available":{"version":"0.1.0-beta.208","install":"restart"}}"#,
        ));
        assert_eq!(c.status, "warn");
        assert!(
            c.detail
                .contains("mdbase connect 0.1.0-beta.208 is available"),
            "{}",
            c.detail
        );
        assert!(
            c.action
                .unwrap()
                .starts_with("It installs in the background")
        );

        let (_dir, c) = with_report(Some(
            r#"{"schema_version":1,"app_version":"0.1.0-beta.185","checked_at":"2026-11-14T03:00:00Z",
               "available":{"version":"0.1.0-beta.208","install":"package","required":true,
                            "release_url":"https://github.com/mdbase-dev/mdbase-connect/releases/tag/v0.1.0-beta.208"}}"#,
        ));
        assert!(
            c.detail.ends_with("this version is no longer supported"),
            "{}",
            c.detail
        );
        assert_eq!(
            c.action.as_deref(),
            Some(
                "Install the new package: https://github.com/mdbase-dev/mdbase-connect/releases/tag/v0.1.0-beta.208"
            )
        );

        let (_dir, c) = with_report(Some(
            r#"{"schema_version":1,"app_version":"a","checked_at":"2026-11-14T03:00:00Z",
               "available":{"version":"b","install":"something-new"}}"#,
        ));
        assert_eq!(
            c.action.as_deref(),
            Some("Open mdbase connect to install it.")
        );
    }

    #[test]
    fn a_stale_or_unreadable_report_is_a_warning() {
        let (_dir, c) = with_report(Some(
            r#"{"schema_version":1,"app_version":"a","checked_at":"2026-11-10T00:00:00Z","background":true}"#,
        ));
        assert_eq!(c.status, "warn");
        assert!(
            c.detail
                .contains("last checked for updates at 2026-11-10T00:00:00Z")
        );
        assert!(c.action.unwrap().contains("mdbase-connect-update"));
        for bad in [
            "not json",
            r#"{"schema_version":2,"app_version":"a","checked_at":"2026-11-14T03:00:00Z"}"#,
            r#"{"schema_version":1}"#,
        ] {
            let (_dir, c) = with_report(Some(bad));
            assert_eq!(c.status, "warn");
            assert!(
                c.detail.contains("not an update report"),
                "{bad}: {}",
                c.detail
            );
        }
        let (_dir, c) = with_report(Some(
            r#"{"schema_version":1,"app_version":"a","checked_at":"yesterday"}"#,
        ));
        assert!(c.detail.contains("last checked for updates at yesterday"));
    }
}
