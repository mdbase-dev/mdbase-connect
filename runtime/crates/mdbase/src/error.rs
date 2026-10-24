//! Errors. One enum, every variant with a [`Error::help`] line that says what
//! to do; `Display` prints both.

use std::path::PathBuf;

use crate::record::Issue;

/// Everything that can go wrong. Non-exhaustive: match with a `_` arm.
#[derive(Debug)]
#[non_exhaustive]
pub enum Error {
    /// `root` has no `mdbase.yaml`.
    NotACollection {
        /// The folder.
        root: PathBuf,
    },
    /// Another process or app hosts the folder.
    AlreadyHosted {
        /// The folder.
        root: PathBuf,
        /// Who, when known.
        host: Option<mdbn_local_host::HostKind>,
        /// Whether the host's descriptor is stale (no refresh for a while).
        stale: bool,
    },
    /// The path is not a valid collection path.
    InvalidPath {
        /// The path.
        path: String,
        /// Why.
        reason: String,
    },
    /// No record at that path or ID.
    NotFound {
        /// The path or ID as given.
        target: String,
    },
    /// The engine refused the write: bad request or invalid record.
    Rejected {
        /// `invalid_request`, `invalid_record`, `forbidden`, ...
        code: String,
        /// Finer cause, when there is one.
        reason: Option<String>,
        /// Message from the engine.
        message: String,
        /// Validation issues (`invalid_record`).
        issues: Vec<Issue>,
    },
    /// A precondition failed: the revision changed, the path is taken, ...
    Conflict {
        /// `revision`, `path_taken`, `duplicate_value`, `renamed`, ...
        reason: String,
        /// Message from the engine.
        message: String,
    },
    /// The query is invalid.
    Query {
        /// `invalid_query`, `invalid_timezone`, `invalid_expression`, ...
        code: String,
        /// Message.
        message: String,
        /// The offending member (`where`, `order_by[1].field`, ...).
        location: Option<String>,
    },
    /// Any other engine error.
    Engine {
        /// Error code.
        code: String,
        /// Message.
        message: String,
    },
    /// The folder's store (index, platform) failed.
    Store(String),
    /// Plain I/O.
    Io(std::io::Error),
}

impl Error {
    /// A stable snake_case code for the variant (`not_a_collection`,
    /// `already_hosted`, ...), or the engine's own code.
    pub fn code(&self) -> &str {
        match self {
            Error::NotACollection { .. } => "not_a_collection",
            Error::AlreadyHosted { .. } => "already_hosted",
            Error::InvalidPath { .. } => "invalid_path",
            Error::NotFound { .. } => "not_found",
            Error::Rejected { code, .. }
            | Error::Query { code, .. }
            | Error::Engine { code, .. } => code,
            Error::Conflict { .. } => "conflict",
            Error::Store(_) => "store",
            Error::Io(_) => "io",
        }
    }

    /// What to do about it.
    pub fn help(&self) -> String {
        match self {
            Error::NotACollection { root } => format!(
                "Create one with `Collection::init({:?})`, or point at a folder that has an `mdbase.yaml`.",
                root
            ),
            Error::AlreadyHosted { host: Some(mdbn_local_host::HostKind::Daemon), .. } => {
                "The mdbase daemon hosts this folder. Talk to it instead (the Node package's `connectDaemon()`, or the daemon's replica socket), or stop the daemon for this folder."
                    .into()
            }
            Error::AlreadyHosted { host: Some(mdbn_local_host::HostKind::Obsidian), stale, .. } => {
                if *stale {
                    "Obsidian announced itself as the host and has not refreshed for a while. If it is closed, open with `Collection::builder(root).take_over(true)`.".into()
                } else {
                    "Obsidian hosts this folder. Close the vault there, or edit through the plugin.".into()
                }
            }
            Error::AlreadyHosted { host: None, .. } => {
                "Another process has this folder open, or its `.mdbase/host.json` is unreadable. Close that process; if nothing hosts the folder, open with `Collection::builder(root).take_over(true)`."
                    .into()
            }
            Error::AlreadyHosted { .. } => {
                "Another process has this folder open. Close it, or open through it."
                    .into()
            }
            Error::InvalidPath { .. } => {
                "Paths are relative to the collection root, use `/`, and cannot contain `..` or start with `/`."
                    .into()
            }
            Error::NotFound { .. } => "Check the path (it is exact and case-sensitive) or create the record.".into(),
            Error::Rejected { code, issues, .. } if code == "invalid_record" => format!(
                "Fix the record: {}",
                issues
                    .iter()
                    .map(|i| format!("{} ({})", i.message, i.code))
                    .collect::<Vec<_>>()
                    .join("; ")
            ),
            Error::Rejected { .. } => "Check the operation's arguments against the docs.".into(),
            Error::Conflict { reason, .. } if reason == "revision" => {
                "The record changed since you read it. Read it again and retry with the new revision, or drop the `if_revision` guard.".into()
            }
            Error::Conflict { reason, .. } if reason == "path_taken" => {
                "A record already holds that path. Pick another path or update that record.".into()
            }
            Error::Conflict { .. } => "Read the record again and retry.".into(),
            Error::Query { location: Some(l), .. } => format!("Fix the query member `{l}`."),
            Error::Query { .. } => "Fix the query object (see `Query` and spec 11).".into(),
            Error::Engine { .. } => "Unexpected engine error; report it with the code and message.".into(),
            Error::Store(_) => "The folder's `.mdbase/library` state is unreadable; check permissions and disk, or delete that directory to rebuild it.".into(),
            Error::Io(_) => "Check the path, permissions and disk.".into(),
        }
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::NotACollection { root } => {
                write!(
                    f,
                    "{} is not an mdbase collection (no mdbase.yaml)",
                    root.display()
                )?;
            }
            Error::AlreadyHosted { root, host, .. } => match host {
                Some(h) => write!(f, "{} is hosted by {h}", root.display())?,
                None => write!(f, "{} is hosted by another process", root.display())?,
            },
            Error::InvalidPath { path, reason } => write!(f, "invalid path {path:?}: {reason}")?,
            Error::NotFound { target } => write!(f, "no record at {target}")?,
            Error::Rejected { code, message, .. } => write!(f, "rejected ({code}): {message}")?,
            Error::Conflict { reason, message } => write!(f, "conflict ({reason}): {message}")?,
            Error::Query { code, message, .. } => write!(f, "invalid query ({code}): {message}")?,
            Error::Engine { code, message } => write!(f, "engine error ({code}): {message}")?,
            Error::Store(s) => write!(f, "store: {s}")?,
            Error::Io(e) => write!(f, "{e}")?,
        }
        write!(f, ". {}", self.help())
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Io(e) => Some(e),
            _ => None,
        }
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e)
    }
}

impl From<mdbn_replica::StoreError> for Error {
    fn from(e: mdbn_replica::StoreError) -> Self {
        Error::Store(format!("{e:?}"))
    }
}

impl From<mdbn_local_host::Error> for Error {
    fn from(e: mdbn_local_host::Error) -> Self {
        match e {
            mdbn_local_host::Error::Io(e) => Error::Io(e),
            other => Error::Store(other.to_string()),
        }
    }
}

/// A `Problem` from the engine as an [`Error`].
pub(crate) fn from_problem(p: &mdbn_wire::client::Problem, target: Option<&str>) -> Error {
    let mut issues: Vec<Issue> = p
        .issues
        .iter()
        .flatten()
        .map(crate::record::Issue::from_wire)
        .collect();
    // Some rejections carry their diagnostics in `details.issues`.
    if issues.is_empty()
        && let Some(mdbn_wire::common::Value::Map(m)) = &p.details
        && let Some((_, mdbn_wire::common::Value::List(list))) =
            m.iter().find(|(k, _)| k == "issues")
    {
        for v in list {
            if let mdbn_wire::common::Value::Map(i) = v {
                let get = |k: &str| i.iter().find(|(kk, _)| kk == k).map(|(_, v)| v);
                let text = |k: &str| match get(k) {
                    Some(mdbn_wire::common::Value::Text(s)) => Some(s.clone()),
                    _ => None,
                };
                issues.push(Issue {
                    code: text("code").unwrap_or_default(),
                    severity: if text("severity").as_deref() == Some("warning") {
                        crate::record::Severity::Warning
                    } else {
                        crate::record::Severity::Error
                    },
                    message: text("message").unwrap_or_default(),
                    location: text("location")
                        .or_else(|| text("field"))
                        .or_else(|| text("path")),
                    type_name: text("type"),
                    details: get("details").map(crate::value::to_json),
                });
            }
        }
    }
    match p.code.as_str() {
        "not_found" => Error::NotFound {
            target: target.unwrap_or("?").to_owned(),
        },
        "conflict" => Error::Conflict {
            reason: p.reason.clone().unwrap_or_else(|| "conflict".into()),
            message: p.message.clone(),
        },
        "invalid_request" if p.reason.as_deref() == Some("invalid_query") => Error::Query {
            code: "invalid_query".into(),
            message: p.message.clone(),
            location: None,
        },
        "invalid_request" | "invalid_record" | "forbidden" | "too_large" | "quota_exceeded" => {
            Error::Rejected {
                code: p.code.clone(),
                reason: p.reason.clone(),
                message: p.message.clone(),
                issues,
            }
        }
        _ => Error::Engine {
            code: p.code.clone(),
            message: p.message.clone(),
        },
    }
}

impl From<mdbn_replica::api::ApiError> for Error {
    fn from(e: mdbn_replica::api::ApiError) -> Self {
        from_problem(e.problem(), None)
    }
}

/// `Result` with [`Error`].
pub type Result<T, E = Error> = std::result::Result<T, E>;
