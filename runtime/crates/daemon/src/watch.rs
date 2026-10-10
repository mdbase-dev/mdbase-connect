//! The native folder watcher of one collection runtime (`notify`: inotify on Linux,
//! FSEvents on macOS, ReadDirectoryChangesW on Windows).
//!
//! Events only queue paths; the file store re-reads after its quiescence window, so
//! a missed or merged event costs latency, never correctness. The periodic rescan
//! stays as the safety net.
//!
//! - **Confinement.** Only paths lexically under the collection root are queued, as
//!   root-relative paths with `/` separators; event paths are never canonicalized.
//!   The root itself is made absolute first (lexically; a relative root never
//!   matches the absolute paths `notify` reports), and its canonical form is
//!   accepted too (FSEvents reports resolved paths, e.g. `/private/var`).
//!   Anything else is dropped. Directory, unknown, lost-event and error notifications
//!   become one full rescan (with a wake). Renames mark both paths dirty.
//! - **Bounded.** At most [`MAX_QUEUED`] distinct paths wait for the runtime;
//!   beyond that the batch collapses into one rescan request.
//! - **Coalesced wake.** The runtime is woken once per batch (empty -> non-empty), not
//!   per event; the callback never blocks.
//! - **Stop.** Dropping the [`Watcher`] stops `notify`'s thread before returning.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use mdbn_store_file::platform::{FileEvent, FileEventKind, RelPath};
use notify::{EventKind, RecursiveMode, Watcher as _};

/// Distinct paths queued before the batch collapses into a rescan.
pub const MAX_QUEUED: usize = 4096;

#[derive(Default)]
struct Queue {
    paths: BTreeSet<(String, u8)>,
    overflow: bool,
}

/// A running watcher. Drop to stop.
pub struct Watcher {
    _inner: notify::RecommendedWatcher,
    queue: Arc<Mutex<Queue>>,
}

fn kind_code(k: FileEventKind) -> u8 {
    match k {
        FileEventKind::Changed => 0,
        FileEventKind::Created => 1,
        FileEventKind::Removed => 2,
        FileEventKind::RenamedFrom => 3,
        FileEventKind::RenamedTo => 4,
        FileEventKind::Rescan => 5,
    }
}

fn kind_of(code: u8) -> FileEventKind {
    match code {
        1 => FileEventKind::Created,
        2 => FileEventKind::Removed,
        3 => FileEventKind::RenamedFrom,
        4 => FileEventKind::RenamedTo,
        5 => FileEventKind::Rescan,
        _ => FileEventKind::Changed,
    }
}

/// The root-relative `/`-separated path of `p`, or `None` outside `root`.
fn relative(root: &Path, p: &Path) -> Option<String> {
    let rel = p.strip_prefix(root).ok()?;
    let mut parts = Vec::new();
    for c in rel.components() {
        match c {
            std::path::Component::Normal(s) => parts.push(s.to_str()?.to_string()),
            _ => return None,
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

impl Watcher {
    /// Watch `root` recursively. `wake` is called (from `notify`'s thread) when a
    /// batch becomes available; it must not block.
    pub fn start(root: &Path, wake: Box<dyn Fn() + Send>) -> notify::Result<Watcher> {
        // Event paths are matched lexically, never canonicalized. `notify` reports
        // absolute paths, so the root is made absolute (lexically) first; its
        // canonical form is the same directory, so it may match too.
        let root: PathBuf = std::path::absolute(root).map_err(notify::Error::io)?;
        let queue: Arc<Mutex<Queue>> = Arc::default();
        let q = queue.clone();
        let mut bases = vec![root.clone()];
        if let Ok(canonical) = std::fs::canonicalize(&root)
            && canonical != root
        {
            bases.push(canonical);
        }
        // Never descend into a symlinked folder. A link inside the
        // collection is not collection content (the platform refuses paths
        // through it too); following it would watch, and report, files
        // outside the root.
        let config = notify::Config::default().with_follow_symlinks(false);
        let mut inner = notify::RecommendedWatcher::new(
            move |res: notify::Result<notify::Event>| {
                let Ok(mut q) = q.lock() else { return };
                let was_empty = q.paths.is_empty() && !q.overflow;
                match res {
                    Err(_) => q.overflow = true,
                    Ok(ev) if ev.need_rescan() => q.overflow = true,
                    Ok(ev) => {
                        use notify::event::{CreateKind, RemoveKind};
                        let kind = match ev.kind {
                            EventKind::Access(_) => return,
                            // Directories, unknown and catch-all kinds: one full rescan.
                            EventKind::Create(CreateKind::Folder)
                            | EventKind::Remove(RemoveKind::Folder)
                            | EventKind::Any
                            | EventKind::Other => {
                                q.overflow = true;
                                FileEventKind::Rescan
                            }
                            EventKind::Create(_) => FileEventKind::Created,
                            EventKind::Remove(_) => FileEventKind::Removed,
                            // Renames carry both the old and the new path: both dirty.
                            _ => FileEventKind::Changed,
                        };
                        let paths = if kind == FileEventKind::Rescan {
                            &[][..]
                        } else {
                            &ev.paths[..]
                        };
                        for p in paths {
                            let Some(rel) = bases.iter().find_map(|b| relative(b, p)) else {
                                continue;
                            };
                            if q.paths.len() >= MAX_QUEUED {
                                q.overflow = true;
                                break;
                            }
                            q.paths.insert((rel, kind_code(kind)));
                        }
                    }
                }
                let now_empty = q.paths.is_empty() && !q.overflow;
                drop(q);
                if was_empty && !now_empty {
                    wake();
                }
            },
            config,
        )?;
        inner.watch(&root, RecursiveMode::Recursive)?;
        Ok(Watcher {
            _inner: inner,
            queue,
        })
    }

    /// Take the queued events. A collapsed batch is one root `Rescan`.
    pub fn take(&self) -> Vec<FileEvent> {
        let Ok(mut q) = self.queue.lock() else {
            return Vec::new();
        };
        let q = std::mem::take(&mut *q);
        if q.overflow {
            return vec![FileEvent {
                kind: FileEventKind::Rescan,
                path: RelPath::ROOT,
                id: None,
                cookie: None,
            }];
        }
        q.paths
            .into_iter()
            .filter_map(|(p, k)| {
                Some(FileEvent {
                    kind: kind_of(k),
                    path: RelPath::new(p).ok()?,
                    id: None,
                    cookie: None,
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("mdbn-watch-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn wait_for(w: &Watcher, want: &str) -> Vec<FileEvent> {
        let t = Instant::now();
        let mut seen = Vec::new();
        while t.elapsed() < Duration::from_secs(5) {
            seen.extend(w.take());
            if seen.iter().any(|e| e.path.as_str() == want) {
                return seen;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("never saw {want}: {seen:?}");
    }

    #[test]
    fn queues_root_relative_paths_and_wakes_once_per_batch() {
        let root = scratch("basic");
        // A directory created after the watch starts can race the recursive watch on
        // some platforms (the periodic rescan covers it); create it first here.
        std::fs::create_dir_all(root.join("sub")).unwrap();
        let wakes = Arc::new(AtomicUsize::new(0));
        let w2 = wakes.clone();
        let w = Watcher::start(
            &root,
            Box::new(move || {
                w2.fetch_add(1, Ordering::SeqCst);
            }),
        )
        .unwrap();
        std::fs::write(root.join("sub/note.md"), "x").unwrap();
        let seen = wait_for(&w, "sub/note.md");
        assert!(seen.iter().all(|e| !e.path.as_str().starts_with('/')));
        assert!(wakes.load(Ordering::SeqCst) >= 1);
        drop(w);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// sync_pair --dir with a relative path: events used to be dropped (only the
    /// 60 s rescan saw changes) because `notify` reports absolute paths.
    #[test]
    fn a_relative_root_still_queues_events() {
        let root = scratch("relative");
        let cwd = std::env::current_dir().unwrap();
        // `root` relative to the working directory, by `..` up to the common prefix.
        let common = cwd
            .ancestors()
            .find(|a| root.starts_with(a))
            .unwrap()
            .to_path_buf();
        let mut rel = PathBuf::new();
        for _ in cwd.strip_prefix(&common).unwrap().components() {
            rel.push("..");
        }
        rel.push(root.strip_prefix(&common).unwrap());
        assert!(rel.is_relative());
        let w = Watcher::start(&rel, Box::new(|| {})).unwrap();
        std::fs::write(root.join("note.md"), "x").unwrap();
        wait_for(&w, "note.md");
        drop(w);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_flood_collapses_into_one_rescan() {
        let root = scratch("flood");
        let w = Watcher::start(&root, Box::new(|| {})).unwrap();
        for i in 0..(MAX_QUEUED + 100) {
            std::fs::write(root.join(format!("f{i}.md")), "x").unwrap();
        }
        std::thread::sleep(Duration::from_millis(500));
        let got = w.take();
        assert!(
            got.len() == 1 && got[0].kind == FileEventKind::Rescan || got.len() <= MAX_QUEUED,
            "{} events",
            got.len()
        );
        drop(w);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A symlinked folder inside the root (to outside it, or to inside
    /// it) is never descended into: writes behind it queue no event.
    #[cfg(unix)]
    #[test]
    fn symlinked_folders_are_not_followed() {
        let root = scratch("links");
        let outside = scratch("links-outside");
        std::fs::create_dir_all(root.join("inside")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("shared")).unwrap();
        std::os::unix::fs::symlink(root.join("inside"), root.join("alias")).unwrap();
        let w = Watcher::start(&root, Box::new(|| {})).unwrap();
        std::fs::write(outside.join("secret.md"), "x").unwrap();
        std::fs::write(root.join("inside/real.md"), "x").unwrap();
        let mut seen = wait_for(&w, "inside/real.md");
        std::fs::write(root.join("control.md"), "x").unwrap();
        seen.extend(wait_for(&w, "control.md"));
        assert!(
            seen.iter().all(|e| !e.path.as_str().starts_with("shared/")
                && !e.path.as_str().starts_with("alias/")
                && e.kind != FileEventKind::Rescan),
            "followed a symlink: {seen:?}"
        );
        drop(w);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn paths_outside_the_root_are_dropped() {
        let root = PathBuf::from("/srv/notes");
        assert_eq!(
            relative(&root, Path::new("/srv/notes/a/b.md")).as_deref(),
            Some("a/b.md")
        );
        assert_eq!(relative(&root, Path::new("/srv/other/b.md")), None);
        assert_eq!(relative(&root, Path::new("/srv/notes")), None);
        assert_eq!(relative(&root, Path::new("/srv/notes/../x")), None);
    }
}
