//! `EditorFence`: publishing through an open editor (open-editor publication).
//!
//! Obsidian's editor saves the whole buffer blindly about 2 s after the first
//! unsaved keystroke, so any write that lands in that window is reverted,
//! however atomically it was written (including `RENAME_EXCHANGE`).
//! When a file is open in an editor that can be fenced, the store hands the
//! change to the editor instead of writing the file, and the editor's own save
//! carries it to disk.
//!
//! Implementations:
//! - in the Obsidian runtime, the plugin itself (main thread, async);
//! - for the native daemon, an IPC client to the Obsidian plugin(s) running on
//!   the same vault;
//! - [`NoFence`] where nothing is fenced (no plugin installed; the store then
//!   uses a quiet-period fallback before publishing files it believes are open).
//!
//! Publishing through the fence is never a blind write: the editor applies the
//! difference `base → new` onto its current buffer with the rc.5 line-level
//! three-way merge (exported by `runtime.wasm`, so it is the same merge as
//! everywhere else), and reports a conflict instead of applying if any hunk
//! overlaps unsaved user edits.

use std::future::Future;

use crate::platform::RelPath;

/// What the editor side reports about a path.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum EditorState {
    /// No fenced editor has the path open: publish to the file.
    Closed,
    /// Open in at least one fenced editor.
    Open {
        /// The buffer has unsaved changes (`getValue() !== lastSavedData`).
        dirty: bool,
    },
    /// The fence cannot tell (plugin version without pinned private fields,
    /// IPC down). The store treats it as open and uses the quiet-period
    /// fallback.
    Unknown,
}

/// A change to apply through the editor.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct EditorEdit {
    /// The text the store believes the file holds (the base of the change).
    pub base: String,
    /// The text the store wants it to hold.
    pub new: String,
}

/// Outcome of [`EditorFence::apply`].
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum FenceOutcome {
    /// Applied to every open buffer as a minimal transaction. The publish is
    /// confirmed when ingest later reads bytes that contain the change.
    Applied,
    /// The change overlaps the user's unsaved typing. Nothing was applied; the
    /// store holds. Carries the current buffer.
    Conflict {
        /// The buffer at the time of the check.
        buffer: String,
    },
    /// The file is no longer open: publish to the file instead.
    NotOpen,
    /// The fence is unreachable: treat as [`EditorState::Unknown`].
    Unavailable,
}

/// Routes publishes of open files through the editor.
pub trait EditorFence {
    /// Whether `path` is open in a fenced editor.
    fn state(&self, path: &RelPath) -> impl Future<Output = EditorState>;

    /// Apply `edit` through every editor that has `path` open.
    fn apply(&self, path: &RelPath, edit: EditorEdit) -> impl Future<Output = FenceOutcome>;
}

/// No fenced editors anywhere.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoFence;

impl EditorFence for NoFence {
    fn state(&self, _path: &RelPath) -> impl Future<Output = EditorState> {
        std::future::ready(EditorState::Closed)
    }

    fn apply(&self, _path: &RelPath, _edit: EditorEdit) -> impl Future<Output = FenceOutcome> {
        std::future::ready(FenceOutcome::NotOpen)
    }
}
