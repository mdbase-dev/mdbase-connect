//! A short, local activity log: what changed on this computer (collections, app
//! access, the account), for people. `<state>/activity.jsonl`, newest last, the
//! last [`KEEP`] entries. Best effort: a failed write never fails the change it
//! describes. Names and app names only; no paths, keys or file contents.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::control::Method;
use crate::fsutil;

/// Entries kept (on disk and in memory).
pub const KEEP: usize = 200;

/// One thing that happened.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActivityEntry {
    /// When (ms since the epoch).
    pub at_ms: u64,
    /// What, snake_case: `collection_added`, `collection_removed`,
    /// `collection_updated`, `collection_paused`, `collection_resumed`,
    /// `collection_joined`, `collection_deleted`, `collection_taken_over`, `sync_enabled`, `sync_disabled`, `app_connected`,
    /// `app_requested`, `app_approved`, `app_declined`, `app_revoked`,
    /// `app_revoked_in_account`, `signed_in`, `signed_out`, `computer_renamed`.
    pub kind: String,
    /// Collection ID.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collection: Option<String>,
    /// Collection name at the time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collection_name: Option<String>,
    /// App name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_name: Option<String>,
    /// A short detail (sync mode, new computer name).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl ActivityEntry {
    /// A new entry stamped now.
    pub fn now(kind: &str) -> ActivityEntry {
        ActivityEntry {
            at_ms: fsutil::now_ms() as u64,
            kind: kind.into(),
            collection: None,
            collection_name: None,
            app_name: None,
            detail: None,
        }
    }
}

/// The entry a successful control call adds, if any. `prior_name` is the
/// collection's name before the call (a removed collection has none after it).
pub fn for_control_call(
    method: &str,
    params: &Value,
    result: &Value,
    prior_name: Option<String>,
) -> Option<ActivityEntry> {
    let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    let kind = match method {
        Method::COLLECTION_ADD => "collection_added",
        Method::COLLECTION_REMOVE => "collection_removed",
        Method::COLLECTION_DELETE => "collection_deleted",
        Method::COLLECTION_UPDATE => "collection_updated",
        Method::COLLECTION_PAUSE => "collection_paused",
        Method::COLLECTION_RESUME => "collection_resumed",
        Method::COLLECTION_JOIN => "collection_joined",
        Method::SYNC_ENABLE => "sync_enabled",
        Method::SYNC_DISABLE => "sync_disabled",
        Method::ACCESS_APPROVE => "app_approved",
        Method::ACCESS_DENY => "app_declined",
        Method::ACCESS_REVOKE => "app_revoked",
        Method::ACCOUNT_SIGN_OUT => "signed_out",
        Method::ACCOUNT_RENAME => "computer_renamed",
        _ => return None,
    };
    let mut e = ActivityEntry::now(kind);
    match method {
        Method::ACCESS_APPROVE | Method::ACCESS_DENY | Method::ACCESS_REVOKE => {
            e.collection = s(result, "collection");
            e.collection_name = prior_name;
            e.app_name = s(result, "app_name");
        }
        Method::ACCOUNT_SIGN_OUT => {}
        Method::ACCOUNT_RENAME => e.detail = s(result, "name"),
        _ => {
            e.collection = s(result, "id").or_else(|| s(params, "collection"));
            e.collection_name = s(result, "name").or(prior_name);
            if method == Method::SYNC_ENABLE {
                e.detail = s(result, "mode");
            }
        }
    }
    Some(e)
}

/// The log.
pub struct ActivityLog {
    path: PathBuf,
    entries: Mutex<VecDeque<ActivityEntry>>,
    /// Lines in the file beyond the kept entries; the file is rewritten when this
    /// reaches [`KEEP`].
    excess: Mutex<usize>,
}

impl ActivityLog {
    /// Load the last [`KEEP`] entries (unreadable lines are skipped).
    pub fn open(path: PathBuf) -> ActivityLog {
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        let all: Vec<ActivityEntry> = text
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect();
        let lines = text.lines().count();
        let entries: VecDeque<_> = all.into_iter().rev().take(KEEP).rev().collect();
        let excess = lines.saturating_sub(entries.len());
        ActivityLog {
            path,
            entries: Mutex::new(entries),
            excess: Mutex::new(excess),
        }
    }

    /// Add an entry.
    pub fn record(&self, entry: ActivityEntry) {
        let mut entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        let mut excess = self.excess.lock().unwrap_or_else(|p| p.into_inner());
        entries.push_back(entry.clone());
        if entries.len() > KEEP {
            entries.pop_front();
            *excess += 1;
        }
        let result = if *excess >= KEEP {
            let mut text = String::new();
            for e in entries.iter() {
                text.push_str(&serde_json::to_string(e).unwrap_or_default());
                text.push('\n');
            }
            fsutil::write_atomic(&self.path, text.as_bytes()).map(|()| *excess = 0)
        } else {
            append_line(
                &self.path,
                &serde_json::to_string(&entry).unwrap_or_default(),
            )
        };
        if let Err(e) = result {
            tracing::warn!(error = %e, "activity log not written");
        }
    }

    /// Newest first, at most `limit`.
    pub fn list(&self, limit: usize) -> Vec<ActivityEntry> {
        let entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        entries.iter().rev().take(limit).cloned().collect()
    }
}

fn append_line(path: &std::path::Path, line: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    writeln!(f, "{line}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Survives a restart, keeps only the newest entries, and names what changed
    /// without paths.
    #[test]
    fn keeps_the_newest_entries_across_restarts() {
        let dir = crate::testutil::TestDir::new("activity");
        let path = dir.path().join("activity.jsonl");
        let log = ActivityLog::open(path.clone());
        for i in 0..(KEEP * 2 + 5) {
            let mut e = ActivityEntry::now("collection_added");
            e.collection_name = Some(format!("n{i}"));
            log.record(e);
        }
        let reopened = ActivityLog::open(path.clone());
        let newest = reopened.list(KEEP + 10);
        assert_eq!(newest.len(), KEEP);
        assert_eq!(
            newest[0].collection_name.as_deref(),
            Some(&*format!("n{}", KEEP * 2 + 4))
        );
        assert!(std::fs::read_to_string(&path).unwrap().lines().count() < KEEP * 2);

        let removed = for_control_call(
            Method::COLLECTION_REMOVE,
            &json!({"collection": "c1"}),
            &json!({}),
            Some("Notes".into()),
        )
        .unwrap();
        assert_eq!(
            (
                removed.kind.as_str(),
                removed.collection.as_deref(),
                removed.collection_name.as_deref()
            ),
            ("collection_removed", Some("c1"), Some("Notes"))
        );
        let status =
            json!({"id": "c1", "name": "Notes", "root": "/home/u/Notes", "mode": "synced_e2e"});
        let enabled = for_control_call(Method::SYNC_ENABLE, &json!({}), &status, None).unwrap();
        assert_eq!(enabled.detail.as_deref(), Some("synced_e2e"));
        assert!(!serde_json::to_string(&enabled).unwrap().contains("/home/u"));
        assert!(for_control_call(Method::COLLECTION_LIST, &json!({}), &json!([]), None).is_none());
    }
}
