//! Settling retained files without discarding late editor writes.
//!
//! A displaced or removed inode is kept in the private directory for at least
//! [`MIN_RETENTION_MS`] and at least one quiescence window, because an editor
//! can be descheduled between `open(O_TRUNC)` and `write` and then write into
//! the inode we just displaced. After that, a retained file still holding what
//! it was retained with is removed; anything else is a late user write and is
//! handed to ingest as a preserved file.

use crate::platform::{FilePlatform, FsErrorKind, Holders, LockShare, ReplaceStrategy};
use crate::publish::{Retained, revision};

/// Minimum retention: seconds, not milliseconds, to cover delayed writes on a
/// slow host; a fixed interval alone is not a proof of safe release.
pub const MIN_RETENTION_MS: u64 = 2_000;

/// Result of settling one retained file.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Settled {
    /// It still held the retained revision and was removed.
    Released,
    /// It no longer exists (removed by an earlier settle before a crash).
    Gone,
    /// It holds other bytes: a late write. Ingest it as an edit, then remove it.
    LateWrite,
    /// Another process has it open (Windows lock, Linux lease). Try again later.
    Busy,
    /// A platform error; try again later.
    Error,
}

/// Settle `r`. The caller has waited out the retention period.
pub async fn settle<P: FilePlatform>(p: &P, r: &Retained) -> Settled {
    // On Windows an exclusive open proves no handle can still write into it.
    if p.capabilities().replace == ReplaceStrategy::LockedInPlace {
        match p.lock(&r.path, LockShare::None).await {
            Ok(h) => {
                let read = p.locked_read(h).await;
                let _ = p.unlock(h).await;
                match read {
                    Ok(b) if revision(&b.bytes) != r.expect => return Settled::LateWrite,
                    Ok(_) => {}
                    Err(_) => return Settled::Error,
                }
            }
            Err(e) if e.is_not_found() => return Settled::Gone,
            Err(e) if e.kind == FsErrorKind::Busy => return Settled::Busy,
            Err(_) => return Settled::Error,
        }
    } else {
        // Someone still has it open (an editor that opened it before the swap
        // and has not written yet): keep it (sim: Linux residual, class 2).
        match p.other_holders(&r.path).await {
            Ok(Holders::Some) => return Settled::Busy,
            Ok(Holders::None | Holders::Unknown) => {}
            Err(e) if e.is_not_found() => return Settled::Gone,
            Err(_) => return Settled::Error,
        }
        match p.read(&r.path).await {
            Ok(b) if revision(&b.bytes) != r.expect => return Settled::LateWrite,
            Ok(_) => {}
            Err(e) if e.is_not_found() => return Settled::Gone,
            Err(_) => return Settled::Error,
        }
    }
    match p.remove_file(&r.path).await {
        Ok(()) => Settled::Released,
        Err(e) if e.is_not_found() => Settled::Gone,
        Err(_) => Settled::Error,
    }
}
