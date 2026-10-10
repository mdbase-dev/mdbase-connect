use crate::access::{AccessEntry, AccessEvent, AccessState};
use crate::control::Method;

/// Maximum access rows retained by the tray presentation (not an authority limit).
pub const MAX_PREVIEWS: usize = 32;
/// Maximum protected files (holds) the tray offers to resolve at once.
pub const MAX_HOLDS: usize = 8;
const MAX_LABEL_CHARS: usize = 80;
const MAX_ID_BYTES: usize = 128;

/// A bounded, non-authoritative presentation of one daemon-owned access entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccessPreview {
    /// Opaque daemon grant identifier; never interpreted as a path or command.
    pub grant: String,
    /// Sanitized plain-text application label, not a trusted identity.
    pub label: String,
    /// Current daemon-reported disposition.
    pub state: AccessState,
}

/// Static notification copy: do not disclose app, account or collection details
/// on a lock screen, or put remote-controlled text into a platform notification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Notice {
    /// A previously unseen grant is being served.
    NewAccess,
    /// A grant awaits the daemon's own final approval dialog.
    ApprovalRequested,
    /// The control plane removed access.
    Revoked,
    /// The replica kept an edit instead of overwriting it (Hold UX).
    Protected,
}

impl Notice {
    /// Fixed notification title.
    pub fn title(self) -> &'static str {
        match self {
            Self::Protected => "mdbase protected your edit",
            _ => "mdbase access changed",
        }
    }

    /// Fixed notification body, independent of all event-controlled strings.
    pub fn body(self) -> &'static str {
        match self {
            Self::NewAccess => "An app gained access on this computer. Review access in mdbase.",
            Self::ApprovalRequested => {
                "An app requested access. Review it in mdbase; the daemon asks for final approval."
            }
            Self::Revoked => "App access was removed on this computer.",
            Self::Protected => {
                "A file was kept instead of overwritten. Choose keep mine or take theirs from \
                 the mdbase menu; you can change it later."
            }
        }
    }
}

/// Why a file is held, from the daemon's `collection.holds` reason codes (the wire
/// `HoldReason` names). Unknown codes get neutral copy, never the raw string.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HoldCause {
    /// A concurrent change won.
    Conflict,
    /// The base is unknown.
    UnknownProvenance,
    /// Deleted elsewhere.
    DeletedElsewhere,
    /// Read-only member.
    ReadOnly,
    /// An editor holds unsaved changes.
    EditorBusy,
    /// Provenance could not be verified.
    SuspectWrite,
    /// A reason this companion does not know.
    Other,
}

impl HoldCause {
    /// From the control endpoint's snake_case code.
    pub fn from_code(code: &str) -> HoldCause {
        match code {
            "conflict" => Self::Conflict,
            "unknown_provenance" => Self::UnknownProvenance,
            "deleted_elsewhere" => Self::DeletedElsewhere,
            "read_only" => Self::ReadOnly,
            "editor_busy" => Self::EditorBusy,
            "suspect_write" => Self::SuspectWrite,
            _ => Self::Other,
        }
    }

    /// Plain-language cause, fixed copy.
    pub fn text(self) -> &'static str {
        match self {
            Self::Conflict => "another device changed it at the same time",
            Self::UnknownProvenance => "mdbase could not tell which version it was based on",
            Self::DeletedElsewhere => "it was deleted on another device",
            Self::ReadOnly => "you can only read this collection",
            Self::EditorBusy => "an editor still has unsaved changes",
            Self::SuspectWrite => "the write could not be verified",
            Self::Other => "mdbase kept your version to be safe",
        }
    }
}

/// What the tray offers for a protected file. Resolutions are reversible: the
/// other version stays in the log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HoldChoice {
    /// Keep this computer's version.
    KeepMine,
    /// Take the confirmed version.
    TakeTheirs,
    /// Open the app's side-by-side merge view.
    Compare,
}

/// One protected file, as the tray shows it: a sanitized path and a fixed cause.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HoldPreview {
    /// Collection ID (opaque).
    pub collection: String,
    /// Record or file ID (opaque).
    pub id: String,
    /// Sanitized, bounded path for the label.
    pub path: String,
    /// Why it is held.
    pub cause: HoldCause,
}

impl HoldPreview {
    /// From the control endpoint's `HoldSummary`.
    pub fn from_summary(collection: &str, summary: &crate::control::HoldSummary) -> HoldPreview {
        HoldPreview {
            collection: collection.to_owned(),
            id: summary.id.clone(),
            path: label(&summary.path),
            cause: HoldCause::from_code(&summary.reason),
        }
    }
}

/// A request to the daemon (an approval review or a hold resolution) or a
/// hand-off to the app's compare view. Never a final approval answer. Only the
/// currently connected model can construct one, for a row it displays.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewRequest {
    kind: RequestKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum RequestKind {
    Review {
        grant: String,
    },
    Resolve {
        collection: String,
        id: String,
        how: &'static str,
    },
    Compare {
        collection: String,
        id: String,
    },
}

impl ReviewRequest {
    /// The existing daemon method; native confirmation is enforced by the server.
    /// For a compare hand-off there is no daemon call (see [`Self::compare_link`]).
    pub fn method(&self) -> &'static str {
        match self.kind {
            RequestKind::Review { .. } => Method::ACCESS_APPROVE,
            RequestKind::Resolve { .. } => Method::COLLECTION_RESOLVE_HOLD,
            RequestKind::Compare { .. } => "",
        }
    }

    /// The existing control request shape (no approval result, token or UI proof).
    pub fn params(&self) -> serde_json::Value {
        match &self.kind {
            RequestKind::Review { grant } => serde_json::json!({ "grant": grant }),
            RequestKind::Resolve {
                collection,
                id,
                how,
            } => serde_json::json!({ "collection": collection, "id": id, "how": how }),
            RequestKind::Compare { .. } => serde_json::Value::Null,
        }
    }

    /// Whether this resolves a hold (for the feedback copy).
    pub fn resolves_hold(&self) -> bool {
        matches!(self.kind, RequestKind::Resolve { .. })
    }

    /// The app deep link for a compare hand-off (clients' hold interface note);
    /// built from validated opaque IDs only. `None` for daemon requests.
    pub fn compare_link(&self) -> Option<String> {
        match &self.kind {
            RequestKind::Compare { collection, id } => Some(format!(
                "mdbase://hold/compare?collection={collection}&id={id}"
            )),
            _ => None,
        }
    }
}

/// Ephemeral tray state. Disconnect clears every actionable row; snapshots from
/// a new authenticated connection replace, never merge with, the old view.
#[derive(Debug, Clone, Default)]
pub struct CompanionModel {
    connected: bool,
    rows: Vec<AccessPreview>,
    omitted: usize,
    holds: Vec<HoldPreview>,
    holds_omitted: usize,
}

impl CompanionModel {
    /// Whether a successfully authenticated subscription is currently live.
    pub fn connected(&self) -> bool {
        self.connected
    }

    /// Rows of the latest snapshot. These cannot establish grant authority.
    pub fn rows(&self) -> &[AccessPreview] {
        &self.rows
    }

    /// Rows not displayed, so truncation is never presented as a complete list.
    pub fn omitted(&self) -> usize {
        self.omitted
    }

    /// Replace the presentation after authentication and a successful access.list.
    /// Invalid/duplicate IDs are omitted, never made into actionable menu entries.
    pub fn replace(&mut self, entries: &[AccessEntry]) {
        self.rows.clear();
        self.omitted = 0;
        for entry in entries {
            let grant = &entry.grant.grant;
            if !valid_id(grant)
                || self.rows.iter().any(|row| &row.grant == grant)
                || self.rows.len() == MAX_PREVIEWS
            {
                self.omitted = self.omitted.saturating_add(1);
                continue;
            }
            self.rows.push(AccessPreview {
                grant: grant.clone(),
                label: label(&entry.grant.app_name),
                state: entry.state,
            });
        }
        self.connected = true;
    }

    /// Protected files of the latest snapshot (bounded, content-free).
    pub fn holds(&self) -> &[HoldPreview] {
        &self.holds
    }

    /// Protected files not displayed.
    pub fn holds_omitted(&self) -> usize {
        self.holds_omitted
    }

    /// Replace the protected files after a successful `collection.holds` read.
    /// Invalid or duplicate IDs are omitted, never made into actionable rows.
    pub fn replace_holds(&mut self, holds: &[HoldPreview]) {
        self.holds.clear();
        self.holds_omitted = 0;
        for hold in holds {
            if !valid_id(&hold.collection)
                || !valid_id(&hold.id)
                || self
                    .holds
                    .iter()
                    .any(|h| h.collection == hold.collection && h.id == hold.id)
                || self.holds.len() == MAX_HOLDS
            {
                self.holds_omitted = self.holds_omitted.saturating_add(1);
                continue;
            }
            self.holds.push(HoldPreview {
                collection: hold.collection.clone(),
                id: hold.id.clone(),
                path: label(&hold.path),
                cause: hold.cause,
            });
        }
    }

    /// Resolve (or compare) a currently displayed protected file. The daemon
    /// applies the resolution as the hosting app; the UI never carries content.
    pub fn resolve(&self, collection: &str, id: &str, choice: HoldChoice) -> Option<ReviewRequest> {
        self.connected
            .then_some(())
            .and_then(|()| {
                self.holds
                    .iter()
                    .find(|h| h.collection == collection && h.id == id)
            })
            .map(|hold| ReviewRequest {
                kind: match choice {
                    HoldChoice::KeepMine => RequestKind::Resolve {
                        collection: hold.collection.clone(),
                        id: hold.id.clone(),
                        how: "keep_mine",
                    },
                    HoldChoice::TakeTheirs => RequestKind::Resolve {
                        collection: hold.collection.clone(),
                        id: hold.id.clone(),
                        how: "take_theirs",
                    },
                    HoldChoice::Compare => RequestKind::Compare {
                        collection: hold.collection.clone(),
                        id: hold.id.clone(),
                    },
                },
            })
    }

    /// Disconnects and subscription errors must remove stale actionable state.
    pub fn disconnect(&mut self) {
        self.connected = false;
        self.rows.clear();
        self.omitted = 0;
        self.holds.clear();
        self.holds_omitted = 0;
    }

    /// Produce fixed privacy-preserving notification copy for a live stream.
    /// Historical snapshots do not replay notifications.
    pub fn notice(&self, event: &AccessEvent) -> Option<Notice> {
        self.connected.then_some(match event {
            AccessEvent::NewAccess { .. } => Notice::NewAccess,
            AccessEvent::ApprovalRequested { .. } => Notice::ApprovalRequested,
            AccessEvent::Revoked { .. } => Notice::Revoked,
        })
    }

    /// Request review of a currently displayed pending grant. The UI cannot
    /// construct confirmation answers, alter terms or bypass the daemon dialog.
    pub fn review(&self, grant: &str) -> Option<ReviewRequest> {
        self.connected
            .then_some(())
            .and_then(|()| self.rows.iter().find(|row| row.grant == grant))
            .filter(|row| row.state == AccessState::PendingApproval)
            .map(|row| ReviewRequest {
                kind: RequestKind::Review {
                    grant: row.grant.clone(),
                },
            })
    }
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ID_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn label(value: &str) -> String {
    let text: String = value
        .chars()
        .filter(|c| {
            !c.is_control()
                && !matches!(c, '\u{061c}' | '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}'
                    | '\u{2060}'..='\u{206f}' | '\u{feff}' | '&')
        })
        .take(MAX_LABEL_CHARS)
        .collect();
    if text.trim().is_empty() {
        "Unnamed app".to_owned()
    } else {
        text
    }
}

#[cfg(test)]
mod tests;
