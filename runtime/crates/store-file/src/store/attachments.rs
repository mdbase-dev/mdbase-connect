//! Attachment-v1 files on disk (`intent.md` §3.9, replica T5): staging of
//! authenticated plaintext in the private directory, and conditional placement,
//! removal and moves of the user-visible file.
//!
//! Large files never pass through the inner store, the blob cache or a journaled
//! intent: memory is one chunk (the replica supplies it) or one
//! [`HASH_BYTES`] read while verifying.
//!
//! - **Staging** is `private/att/<file>-<manifest>`, written in order with
//!   `write_new` then `append`, flushed after every append, so its length is the
//!   resume point.
//! - **Never clobber.** Every operation first checks that the path holds the
//!   expected revision: from the store's known disk state when the file's
//!   metadata is unchanged (as observation does), otherwise by hashing it in
//!   bounded reads. A create is a no-replace rename. A replace swaps atomically
//!   where the platform can (`exchange`) and verifies the displaced bytes,
//!   swapping back if they are not the expected ones; elsewhere it moves the
//!   old file aside, verifies it, then renames the staging in.
//! - **Echo fence.** Each placement, removal or move records the path's new disk
//!   state (`ours`), so the store's next observation does not re-read or
//!   re-ingest the file.

use mdbn_replica::attachments::WholeFileHasher;
use mdbn_replica::store::{DiskResult, Expect as RExpect, StageKey, StoreError, StoreResult};
use mdbn_wire::common::{Hash, Uuid};

use std::rc::Rc;

use mdbn_replica::replica::AttachmentSource;

use super::{FileStore, db_err, fs_err};
use crate::codec::DiskState;
use crate::diskdb::{Change, DiskDb};
use crate::exec::{Timers, run_ready};
use crate::platform::{
    FileKind, FileMeta, FilePlatform, FlushScope, FsErrorKind, MAX_READ_AT, RangeHandle, RelPath,
    ReplaceStrategy,
};
use crate::publish::Names;
use mdbn_replica::store::Store;

/// A bounded positional reader over one opened file, for an attachment upload
/// (`intent.md` §3.9, T6): every read goes through the same platform handle (a
/// rename or replace of the path never retargets it), is at most
/// [`MAX_READ_AT`], must be complete, and is refused once the file's size or
/// modification time differs from when it was opened.
pub(crate) struct RangeSource<P: FilePlatform> {
    p: Rc<P>,
    timers: Timers,
    h: RangeHandle,
    meta: FileMeta,
}

impl<P: FilePlatform> RangeSource<P> {
    fn run<F: std::future::Future>(&self, f: F) -> Result<F::Output, String> {
        run_ready(&self.timers, f).ok_or_else(|| "platform suspended".to_string())
    }
}

impl<P: FilePlatform> AttachmentSource for RangeSource<P> {
    fn len(&self) -> u64 {
        self.meta.size
    }

    fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> Result<(), String> {
        let len = u32::try_from(buf.len())
            .ok()
            .filter(|n| *n <= MAX_READ_AT)
            .ok_or("read over 8 MiB")?;
        if offset
            .checked_add(u64::from(len))
            .is_none_or(|end| end > self.meta.size)
        {
            return Err("read past the end of the file".into());
        }
        let b = self
            .run(self.p.read_at(self.h, offset, len))?
            .map_err(|e| e.to_string())?;
        if b.len() != buf.len() {
            return Err("short read: the file changed".into());
        }
        match self.run(self.p.range_meta(self.h))? {
            Ok(m) if m.size == self.meta.size && m.mtime_ns == self.meta.mtime_ns => {}
            Ok(_) => return Err("the file changed while it was read".into()),
            Err(e) => return Err(e.to_string()),
        }
        buf.copy_from_slice(&b);
        Ok(())
    }
}

impl<P: FilePlatform> Drop for RangeSource<P> {
    fn drop(&mut self) {
        let _ = run_ready(&self.timers, self.p.close_range_read(self.h));
    }
}

/// Bytes per read while hashing a file.
pub(super) const HASH_BYTES: u32 = 1 << 20;

/// What a path holds, as far as a check can tell.
enum Holds {
    /// The expected revision.
    Expected,
    /// Something else.
    Other,
    /// Nothing.
    Missing,
}

impl<P: FilePlatform, M: Store, D: DiskDb> FileStore<P, M, D> {
    fn staging_dir(&self) -> StoreResult<RelPath> {
        self.p
            .capabilities()
            .private_dir
            .join("att")
            .map_err(|e| StoreError::Io(e.to_string()))
    }

    fn staging(&self, key: &StageKey) -> StoreResult<RelPath> {
        self.staging_dir()?
            .join(&format!("{}-{}", key.file.to_hex(), key.manifest.to_hex()))
            .map_err(|e| StoreError::Io(e.to_string()))
    }

    /// Open the regular file at `path` for an attachment upload, if it is still
    /// `size` bytes. `None` when it is gone or another size, or the platform
    /// cannot stream.
    pub(super) fn open_source(
        &mut self,
        path: &str,
        size: u64,
    ) -> StoreResult<Option<Box<dyn AttachmentSource>>>
    where
        P: 'static,
    {
        let rp = RelPath::new(path).map_err(|e| StoreError::Io(e.to_string()))?;
        if self.is_private(&rp) {
            return Ok(None);
        }
        let (h, meta) = match self.run(self.p.open_range_read(&rp))? {
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
        let source = RangeSource {
            p: self.p.clone(),
            timers: self.timers.clone(),
            h,
            meta,
        };
        if source.meta.size != size || source.meta.kind != FileKind::File {
            return Ok(None);
        }
        Ok(Some(Box::new(source)))
    }

    /// Whether the platform can stage and place attachment files at all.
    pub(super) fn attachments_supported(&self) -> bool {
        !matches!(
            self.strategy(),
            ReplaceStrategy::ReadOnly | ReplaceStrategy::GuardedInPlace
        )
    }

    /// SHA-256 of the file at `path` in bounded reads, with its length.
    fn hash_file(&self, path: &RelPath) -> StoreResult<Option<(Hash, u64)>> {
        let mut h = WholeFileHasher::default();
        let mut at = 0u64;
        loop {
            let b = match self.run(self.p.read_range(path, at, HASH_BYTES))? {
                Ok(b) => b,
                Err(e) if e.is_not_found() => return Ok(None),
                Err(e) => return Err(fs_err(e)),
            };
            h.update(&b);
            at += b.len() as u64;
            if (b.len() as u64) < u64::from(HASH_BYTES) {
                break;
            }
        }
        Ok(Some((h.finish(), at)))
    }

    /// Whether `path` holds revision `rev`. Trusts the known disk state when the
    /// file's metadata is unchanged, as observation does; otherwise hashes it.
    fn holds(&self, path: &RelPath, rev: Hash) -> StoreResult<Holds> {
        let meta = match self.run(self.p.stat(path))? {
            Ok(m) if m.kind == FileKind::File => m,
            Ok(_) => return Ok(Holds::Other),
            Err(e) if e.is_not_found() => return Ok(Holds::Missing),
            Err(e) => return Err(fs_err(e)),
        };
        if let Some(k) = self.disk.get(path.as_str())
            && Self::meta_unchanged(k, &meta)
        {
            return Ok(if k.rev == rev {
                Holds::Expected
            } else {
                Holds::Other
            });
        }
        Ok(match self.hash_file(path)? {
            Some((h, _)) if h == rev => Holds::Expected,
            Some(_) => Holds::Other,
            None => Holds::Missing,
        })
    }

    /// Record `path` as holding our `rev` (echo fence).
    fn record_ours(
        &mut self,
        changes: &mut Vec<Change>,
        path: &RelPath,
        id: Uuid,
        rev: Hash,
    ) -> StoreResult<()> {
        let st = match self.run(self.p.stat(path))? {
            Ok(m) if m.kind == FileKind::File => self.state_from(Some(id), rev, &m, true),
            _ => {
                // Unknown metadata: the next observation re-checks the file.
                self.dirty.insert(path.as_str().to_string(), self.now());
                DiskState {
                    id: Some(id),
                    rev,
                    size: u64::MAX,
                    mtime_ns: 0,
                    ctime_ns: None,
                    file_id: None,
                    ours: true,
                }
            }
        };
        self.set_disk(changes, path.as_str(), Some(st));
        Ok(())
    }

    fn sync_dir_of(&self, path: &RelPath) -> StoreResult<()> {
        self.run(self.p.flush(FlushScope::Dir(path.parent())))?
            .map_err(fs_err)
    }

    fn ensure_parent(&self, path: &RelPath) -> StoreResult<()> {
        let dir = path.parent();
        if dir.is_root() {
            return Ok(());
        }
        self.run(self.p.create_dir_all(&dir))?.map_err(fs_err)
    }

    pub(super) fn att_staged(&mut self, key: &StageKey) -> StoreResult<u64> {
        let s = self.staging(key)?;
        match self.run(self.p.stat(&s))? {
            Ok(m) if m.kind == FileKind::File => Ok(m.size),
            Ok(_) => Err(StoreError::Corrupt(
                "attachment staging is not a file".into(),
            )),
            Err(e) if e.is_not_found() => Ok(0),
            Err(e) => Err(fs_err(e)),
        }
    }

    pub(super) fn att_stage(
        &mut self,
        key: &StageKey,
        offset: u64,
        plain: &[u8],
    ) -> StoreResult<()> {
        let s = self.staging(key)?;
        if offset == 0 {
            self.run(self.p.create_dir_all(&self.staging_dir()?))?
                .map_err(fs_err)?;
            match self.run(self.p.remove_file(&s))? {
                Ok(()) => {}
                Err(e) if e.is_not_found() => {}
                Err(e) => return Err(fs_err(e)),
            }
            self.run(self.p.write_new(&s, plain, true))?
                .map_err(fs_err)?;
            return Ok(());
        }
        if self.att_staged(key)? != offset {
            return Err(StoreError::Io(
                "attachment staging is not contiguous".into(),
            ));
        }
        self.run(self.p.append(&s, plain))?.map_err(fs_err)?;
        self.run(self.p.flush(FlushScope::File(s)))?.map_err(fs_err)
    }

    pub(super) fn att_stage_read(
        &mut self,
        key: &StageKey,
        offset: u64,
        len: u32,
    ) -> StoreResult<Vec<u8>> {
        let s = self.staging(key)?;
        self.run(self.p.read_range(&s, offset, len))?
            .map_err(fs_err)
    }

    pub(super) fn att_unstage(&mut self, key: &StageKey) -> StoreResult<()> {
        let s = self.staging(key)?;
        match self.run(self.p.remove_file(&s))? {
            Ok(()) => Ok(()),
            Err(e) if e.is_not_found() => Ok(()),
            Err(e) => Err(fs_err(e)),
        }
    }

    /// A private name for a displaced or removed file.
    fn aside(&mut self, changes: &mut Vec<Change>) -> RelPath {
        let n = self.take_name(changes);
        Names::for_op(&self.p.capabilities().private_dir, n).stash
    }

    /// Keep a displaced user version for ingest (never deleted).
    fn preserve(
        &mut self,
        changes: &mut Vec<Change>,
        from: &RelPath,
        user_path: &str,
        base: Option<Hash>,
    ) -> StoreResult<()> {
        let n = self.take_name(changes);
        let held = Names::for_op(&self.p.capabilities().private_dir, n).held;
        self.run(self.p.rename_noreplace(from, &held))?
            .map_err(fs_err)?;
        self.add_evidence(changes, user_path, held, base, false);
        Ok(())
    }

    pub(super) fn att_publish(
        &mut self,
        key: &StageKey,
        rev: Hash,
        path: &str,
        expect: RExpect,
    ) -> DiskResult {
        let staged = self.staging(key)?;
        let rp = Self::rel(path)?;
        let mut changes = Vec::new();
        let drift = match expect {
            RExpect::Absent => {
                self.ensure_parent(&rp)?;
                match self.run(self.p.rename_noreplace(&staged, &rp))? {
                    Ok(()) => None,
                    Err(e) if e.kind == FsErrorKind::AlreadyExists => Some("changed"),
                    Err(e) => return Err(fs_err(e)),
                }
            }
            RExpect::Revision(old) => match self.holds(&rp, old)? {
                Holds::Missing => Some("missing"),
                Holds::Other => Some("changed"),
                Holds::Expected if self.strategy() == ReplaceStrategy::Exchange => {
                    self.replace_by_exchange(&mut changes, &staged, &rp, old)?
                }
                Holds::Expected => self.replace_by_rename(&mut changes, &staged, &rp, old)?,
            },
        };
        if drift.is_none() {
            self.sync_dir_of(&rp)?;
            self.record_ours(&mut changes, &rp, key.file, rev)?;
            self.stats.published += 1;
        } else {
            self.stats.drifted += 1;
            self.dirty.insert(path.to_string(), self.now());
        }
        self.db.apply(changes).map_err(db_err)?;
        Ok(drift.map(str::to_string))
    }

    /// Swap the staging in atomically, then verify what came out.
    fn replace_by_exchange(
        &mut self,
        changes: &mut Vec<Change>,
        staged: &RelPath,
        path: &RelPath,
        old: Hash,
    ) -> StoreResult<Option<&'static str>> {
        match self.run(self.p.exchange(staged, path))? {
            Ok(()) => {}
            Err(e) if e.is_not_found() => return Ok(Some("missing")),
            Err(e) => return Err(fs_err(e)),
        }
        // `staged` now holds what was at the path.
        match self.hash_file(staged)? {
            Some((h, _)) if h == old => {
                // The expected old version: unlink it.
                self.run(self.p.remove_file(staged))?.map_err(fs_err)?;
                Ok(None)
            }
            _ => {
                // The user wrote between the check and the swap: put theirs back,
                // and keep ours staged for a later attempt.
                match self.run(self.p.exchange(staged, path))? {
                    Ok(()) => {}
                    Err(e) => {
                        // Cannot swap back: theirs is preserved for ingest.
                        let _ = e;
                        self.preserve(changes, staged, path.as_str(), Some(old))?;
                    }
                }
                Ok(Some("changed"))
            }
        }
    }

    /// Move the old version aside, verify it, rename the staging in.
    fn replace_by_rename(
        &mut self,
        changes: &mut Vec<Change>,
        staged: &RelPath,
        path: &RelPath,
        old: Hash,
    ) -> StoreResult<Option<&'static str>> {
        let aside = self.aside(changes);
        match self.run(self.p.rename_noreplace(path, &aside))? {
            Ok(()) => {}
            Err(e) if e.is_not_found() => return Ok(Some("missing")),
            Err(e) if e.kind == FsErrorKind::Busy => return Ok(Some("locked")),
            Err(e) => return Err(fs_err(e)),
        }
        if !matches!(self.hash_file(&aside)?, Some((h, _)) if h == old) {
            return self
                .put_back(changes, &aside, path, old)
                .map(|()| Some("changed"));
        }
        match self.run(self.p.rename_noreplace(staged, path))? {
            Ok(()) => {
                self.run(self.p.remove_file(&aside))?.map_err(fs_err)?;
                Ok(None)
            }
            Err(e) if e.kind == FsErrorKind::AlreadyExists => {
                // A new user file appeared in between: theirs stays; the old
                // version we moved aside is the expected one, so it goes.
                self.run(self.p.remove_file(&aside))?.map_err(fs_err)?;
                Ok(Some("changed"))
            }
            Err(e) => {
                let _ = self.put_back(changes, &aside, path, old);
                Err(fs_err(e))
            }
        }
    }

    /// Return a file moved aside to `path`, or preserve it if the path is taken.
    fn put_back(
        &mut self,
        changes: &mut Vec<Change>,
        aside: &RelPath,
        path: &RelPath,
        old: Hash,
    ) -> StoreResult<()> {
        match self.run(self.p.rename_noreplace(aside, path))? {
            Ok(()) => Ok(()),
            Err(e) if e.kind == FsErrorKind::AlreadyExists => {
                self.preserve(changes, aside, path.as_str(), Some(old))
            }
            Err(e) => Err(fs_err(e)),
        }
    }

    pub(super) fn att_remove(&mut self, _id: Uuid, path: &str, expect: Hash) -> DiskResult {
        let rp = Self::rel(path)?;
        let mut changes = Vec::new();
        let drift = match self.holds(&rp, expect)? {
            Holds::Missing => Some("missing"),
            Holds::Other => Some("changed"),
            Holds::Expected => {
                let aside = self.aside(&mut changes);
                match self.run(self.p.rename_noreplace(&rp, &aside))? {
                    Ok(()) => {
                        if matches!(self.hash_file(&aside)?, Some((h, _)) if h == expect) {
                            self.run(self.p.remove_file(&aside))?.map_err(fs_err)?;
                            self.sync_dir_of(&rp)?;
                            None
                        } else {
                            self.put_back(&mut changes, &aside, &rp, expect)?;
                            Some("changed")
                        }
                    }
                    Err(e) if e.is_not_found() => Some("missing"),
                    Err(e) if e.kind == FsErrorKind::Busy => Some("locked"),
                    Err(e) => return Err(fs_err(e)),
                }
            }
        };
        if drift.is_none() || drift == Some("missing") {
            self.set_disk(&mut changes, path, None);
        }
        if drift.is_some() {
            self.dirty.insert(path.to_string(), self.now());
        }
        self.db.apply(changes).map_err(db_err)?;
        Ok(drift.map(str::to_string))
    }

    pub(super) fn att_move(&mut self, id: Uuid, from: &str, to: &str, expect: Hash) -> DiskResult {
        let rf = Self::rel(from)?;
        let rt = Self::rel(to)?;
        let mut changes = Vec::new();
        let drift = match self.holds(&rf, expect)? {
            Holds::Missing => Some("missing"),
            Holds::Other => Some("changed"),
            Holds::Expected => {
                self.ensure_parent(&rt)?;
                match self.run(self.p.rename_noreplace(&rf, &rt))? {
                    Ok(()) => {
                        self.sync_dir_of(&rf)?;
                        if rf.parent() != rt.parent() {
                            self.sync_dir_of(&rt)?;
                        }
                        None
                    }
                    Err(e) if e.kind == FsErrorKind::AlreadyExists => Some("changed"),
                    Err(e) if e.is_not_found() => Some("missing"),
                    Err(e) if e.kind == FsErrorKind::Busy => Some("locked"),
                    Err(e) => return Err(fs_err(e)),
                }
            }
        };
        match drift {
            None => {
                // The bytes moved with the inode: carry the known state over.
                self.set_disk(&mut changes, from, None);
                self.record_ours(&mut changes, &rt, id, expect)?;
            }
            Some(_) => {
                self.dirty.insert(from.to_string(), self.now());
                self.dirty.insert(to.to_string(), self.now());
            }
        }
        self.db.apply(changes).map_err(db_err)?;
        Ok(drift.map(str::to_string))
    }
}
