//! Walking the tree: inclusion rules, file classification and streamed hashing.

use super::*;

impl<P: FilePlatform, M: Store, D: DiskDb> FileStore<P, M, D> {
    // ------------------------------------------------------------ observe

    pub(super) fn is_text(&self, path: &str) -> bool {
        let ext = path.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase());
        ext.is_some_and(|e| self.cfg.text_extensions.contains(&e))
    }

    pub(super) fn excluded(&self, path: &RelPath, settings: &Option<FileInclusion>) -> bool {
        self.is_private(path)
            || path.as_str().split('/').any(|seg| seg.starts_with('.'))
            || matches!(
                crate::platform::portable_violation(path.as_str()),
                Some("hidden_path" | "dependency_path")
            )
            || settings.as_ref().is_some_and(|s| {
                (!self.is_text(path.as_str())
                    && !s.include.contains(&MediaClass::of(path.as_str())))
                    || s.exclude.as_ref().is_some_and(|excluded| {
                        excluded.iter().any(|e| {
                            let e = e.trim_end_matches('/');
                            path.as_str() == e || path.as_str().starts_with(&format!("{e}/"))
                        })
                    })
            })
    }

    /// Whether the inclusion size cap leaves a file out. Text never is.
    pub(super) fn oversized(
        &self,
        path: &str,
        size: u64,
        settings: &Option<FileInclusion>,
    ) -> bool {
        !self.is_text(path)
            && settings
                .as_ref()
                .and_then(|s| s.max_size)
                .is_some_and(|max| size > max)
    }

    pub(super) fn unsupported_name(path: &str) -> Option<String> {
        use mdbn_core::paths::{PathViolation, check_path};
        let violation = check_path(path).err()?;
        Some(match violation {
            PathViolation::Hidden | PathViolation::Private | PathViolation::Dependency => {
                return None;
            }
            PathViolation::ReservedName => {
                "Filename uses a Windows reserved name; rename this file to sync it.".into()
            }
            PathViolation::ForbiddenCharacter(c) => {
                format!("Filename contains {c:?}; rename this file to sync it.")
            }
            other => format!(
                "Filename is not supported for sync: {}.",
                other.reason().replace('_', " ")
            ),
        })
    }

    pub(super) async fn walk(
        &self,
        dir: &RelPath,
        settings: &Option<FileInclusion>,
        out: &mut BTreeSet<String>,
        unsupported: &mut BTreeMap<String, String>,
    ) -> StoreResult<()> {
        let mut dirs = vec![dir.clone()];
        while let Some(dir) = dirs.pop() {
            let entries = match self.observe_io(|| self.p.list(&dir)).await? {
                Ok(e) => e,
                Err(e) if e.is_not_found() => continue,
                Err(e) => return Err(fs_err(e)),
            };
            for e in entries {
                if e.name.starts_with('.') || e.name == "Icon\r" {
                    continue;
                }
                let display_path = if dir.is_root() {
                    e.name.clone()
                } else {
                    format!("{dir}/{}", e.name)
                };
                if e.kind == FileKind::InvalidName {
                    unsupported.insert(
                        display_path,
                        "Filename is not valid UTF-8 (shown with replacement characters).".into(),
                    );
                    continue;
                }
                let Ok(p) = dir.join(&e.name) else {
                    let reason = Self::unsupported_name(&display_path).unwrap_or_else(|| {
                        "Filename contains unsupported separators or control characters.".into()
                    });
                    unsupported.insert(display_path, reason);
                    continue;
                };
                if self.excluded(&p, settings) {
                    continue;
                }
                if let Some(reason) = Self::unsupported_name(p.as_str()) {
                    unsupported.insert(p.as_str().into(), reason);
                    continue;
                }
                if let Some(reason) = Self::unsupported_kind(e.kind) {
                    unsupported.insert(p.as_str().into(), reason.into());
                } else if e.kind == FileKind::Dir {
                    dirs.push(p);
                } else {
                    out.insert(p.as_str().to_string());
                }
            }
        }
        Ok(())
    }

    pub(super) fn unsupported_kind(kind: FileKind) -> Option<&'static str> {
        match kind {
            FileKind::Symlink => Some("Symlink not followed."),
            FileKind::ReparsePoint => Some(
                "Windows redirected or online-only file is not followed; use a regular local file.",
            ),
            FileKind::Other => Some("Special file or path through a linked folder; not synced."),
            FileKind::File | FileKind::Dir | FileKind::InvalidName => None,
        }
    }

    pub(super) fn has_ext(path: &str, exts: &[String]) -> bool {
        let ext = path.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase());
        ext.is_some_and(|e| exts.contains(&e))
    }

    /// How a file of `size` bytes at `path` is observed: `None` reads it whole
    /// as text (records and resources up to the record cap for Markdown);
    /// otherwise it is an attachment, hashed and uploaded in bounded pieces.
    pub(super) fn attachment_class(&self, path: &str, size: u64) -> Option<AttachmentClass> {
        if !self.is_text(path) {
            return Some(AttachmentClass::Ordinary);
        }
        (Self::has_ext(path, &self.cfg.markdown_extensions) && size > RECORD_CAP_BYTES)
            .then_some(AttachmentClass::OversizedMarkdown)
    }

    /// SHA-256 of the file at `path` through a range handle, in pieces of at
    /// most [`MAX_READ_AT`], with the handle's metadata. `None`: it vanished,
    /// changed while being read, or the platform cannot stream (the store then
    /// does not ingest it).
    pub(super) async fn hash_streamed(
        &mut self,
        path: &RelPath,
    ) -> StoreResult<Option<(Hash, FileMeta)>> {
        let (h, meta) = match self.observe_io(|| self.p.open_range_read(path)).await? {
            Ok(x) => x,
            Err(e)
                if e.is_not_found()
                    || matches!(
                        e.kind,
                        FsErrorKind::Unsupported | FsErrorKind::WrongKind | FsErrorKind::Busy
                    ) =>
            {
                return Ok(None);
            }
            Err(e) => return Err(fs_err(e)),
        };
        let r = self.hash_handle(h, &meta).await;
        self.p.close_range_read(h).await.map_err(fs_err)?;
        self.stats.files_streamed += 1;
        Ok(r?.map(|rev| (rev, meta)))
    }

    async fn hash_handle(&self, h: RangeHandle, meta: &FileMeta) -> StoreResult<Option<Hash>> {
        let mut hasher = mdbn_replica::attachments::WholeFileHasher::default();
        let mut at = 0u64;
        while at < meta.size {
            let want =
                u32::try_from((meta.size - at).min(u64::from(MAX_READ_AT))).unwrap_or(MAX_READ_AT);
            let b = match self.observe_io(|| self.p.read_at(h, at, want)).await? {
                Ok(b) => b,
                Err(e) if e.kind == FsErrorKind::Busy => return Ok(None),
                Err(e) => return Err(fs_err(e)),
            };
            if b.len() != want as usize {
                return Ok(None);
            }
            hasher.update(&b);
            at += b.len() as u64;
        }
        match self.observe_io(|| self.p.range_meta(h)).await? {
            Ok(m) if m.size == meta.size && m.mtime_ns == meta.mtime_ns => {
                Ok(Some(hasher.finish()))
            }
            Ok(_) => Ok(None),
            Err(e) => Err(fs_err(e)),
        }
    }

    pub(super) fn observed(&self, path: &str, seen: &Seen) -> Observed {
        match &seen.body {
            Body::Bytes(bytes) => match std::str::from_utf8(bytes) {
                Ok(t) if self.is_text(path) => Observed::Text(t.to_string()),
                _ => Observed::Attachment {
                    digest: seen.rev,
                    size: bytes.len() as u64,
                    class: AttachmentClass::Ordinary,
                },
            },
            Body::Streamed(class) => Observed::Attachment {
                digest: seen.rev,
                size: seen.meta.size,
                class: *class,
            },
        }
    }

    pub(super) fn meta_unchanged(k: &DiskState, m: &FileMeta) -> bool {
        k.size == m.size
            && k.mtime_ns == m.mtime_ns
            && k.ctime_ns == m.ctime_ns
            && k.file_id == m.id
    }
}
