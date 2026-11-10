//! The capability an op needs and the file paths it touches.

use super::*;

// ---------------------------------------------------------------- capabilities

/// State lookups a capability check needs at the planning position.
pub struct OpContext<'a> {
    /// The path key of a path (spec 02), from the core.
    pub path_key: &'a dyn Fn(&str) -> String,
    /// The current path of a live file, if it exists.
    pub file_path: &'a dyn Fn(&Uuid) -> Option<String>,
}

/// The capability an operation needs (`policy.md` §5).
///
/// Saved-view sources are records or files, so they are covered by the record
/// capabilities here; `views.manage` narrowing needs the catalog and is applied
/// by the replica's API layer, not at replay.
pub fn capability_for(op: &Op, ctx: &OpContext<'_>) -> &'static str {
    match op {
        Op::Create(_) => capability::CREATE,
        Op::Update(_) | Op::Rename(_) | Op::ConflictDismiss(_) | Op::FileMove(_) => {
            capability::EDIT
        }
        Op::Document(d) => match (&d.base, &d.new) {
            (_, None) => capability::DELETE,
            (None, Some(_)) => capability::CREATE,
            _ => capability::EDIT,
        },
        Op::Delete(_) | Op::FileDelete(_) => capability::DELETE,
        Op::ResourcePut(_) | Op::ResourceDelete(_) | Op::SyncSettings(_) => capability::DEFINITIONS,
        Op::FilePut(f) => {
            if (ctx.file_path)(&f.id).is_some() {
                capability::EDIT
            } else {
                capability::CREATE
            }
        }
    }
}

/// A legacy operation or an attachment-v1 `file_attach`, for authorization.
pub(super) enum AnyOp<'a> {
    Legacy(&'a Op),
    Attach(&'a mdbn_wire::attachment::FileAttach),
}

impl AnyOp<'_> {
    pub(super) fn capability(&self, ctx: &OpContext<'_>) -> &'static str {
        match self {
            AnyOp::Legacy(o) => capability_for(o, ctx),
            AnyOp::Attach(f) => {
                if (ctx.file_path)(&f.id).is_some() {
                    capability::EDIT
                } else {
                    capability::CREATE
                }
            }
        }
    }

    pub(super) fn file_paths(&self, ctx: &OpContext<'_>) -> Vec<String> {
        match self {
            AnyOp::Legacy(o) => file_paths(o, ctx),
            AnyOp::Attach(f) => {
                let mut v = vec![f.path.clone()];
                v.extend((ctx.file_path)(&f.id));
                v
            }
        }
    }
}

/// Paths in the file namespace an operation touches (its target and the file's
/// current path).
pub fn file_paths(op: &Op, ctx: &OpContext<'_>) -> Vec<String> {
    match op {
        Op::FilePut(f) => {
            let mut v = vec![f.path.clone()];
            v.extend((ctx.file_path)(&f.id));
            v
        }
        Op::FileMove(m) => {
            let mut v = vec![m.from.clone(), m.to.clone()];
            v.extend((ctx.file_path)(&m.id));
            v
        }
        Op::FileDelete(d) => (ctx.file_path)(&d.id).into_iter().collect(),
        _ => Vec::new(),
    }
}

/// Whether `path` is within one of `folders`, comparing path keys at segment
/// boundaries.
pub fn within_folders(path: &str, folders: &[String], path_key: &dyn Fn(&str) -> String) -> bool {
    let k = path_key(path);
    folders.iter().any(|f| {
        let fk = path_key(f.trim_end_matches('/'));
        fk.is_empty()
            || k.strip_prefix(fk.as_str())
                .is_some_and(|r| r.starts_with('/'))
    })
}
