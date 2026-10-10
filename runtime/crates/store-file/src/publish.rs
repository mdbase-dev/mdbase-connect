//! The never-clobber publish protocol, one strategy per platform family.
//!
//! `publish(op)` makes `op.path` hold `op.new` (or removes it) **only if** it
//! holds what the store expects, and never loses bytes it did not expect:
//! anything displaced is verified to be the expected bytes, put back, or kept
//! as a *preserved* file for the store to ingest as an edit on the expected
//! base. A publish never deletes a file outright; displaced inodes are
//! *retained* in the private directory and settled later
//! ([`crate::stash`]), because editors can still write through fds opened
//! before the swap.
//!
//! The caller journals a [`crate::recover::Intent`] before calling and clears
//! it after, so a crash at any point is resolved by [`crate::recover`].
//!
//! | Strategy | Replace | Create | Delete |
//! |---|---|---|---|
//! | Exchange (Linux, macOS) | temp, copy metadata, swap, verify displaced, restore loop | temp + no-replace rename | no-replace rename into a stash, verify, put back on mismatch |
//! | LockedInPlace (Windows D) | lock, verify through the handle, overwrite in place | temp + no-replace rename | lock, verify, move aside by handle |
//! | GuardedInPlace (vault) | `guarded_replace` with the expected bytes | `guarded_create` | `guarded_trash` |

use mdbn_wire::common::Hash;
use mdbn_wire::hash::sha256;

use crate::platform::{
    FileId, FilePlatform, FlushScope, FsError, FsErrorKind, Guarded, LockShare, RelPath,
    ReplaceStrategy,
};

/// Revision of some bytes: plain SHA-256 (`docs/contracts`).
pub fn revision(bytes: &[u8]) -> Hash {
    sha256(bytes)
}

/// What the store believes is at the path.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Expect {
    /// Nothing: the publish is a create.
    Absent,
    /// A file with this revision.
    Rev(Hash),
    /// A file with exactly these bytes (needed by the guarded strategy and by
    /// torn-write recovery; implies the revision).
    Bytes(Vec<u8>),
}

impl Expect {
    /// True if `bytes` is what is expected (never for `Absent`).
    pub fn matches(&self, bytes: &[u8]) -> bool {
        match self {
            Expect::Absent => false,
            Expect::Rev(h) => revision(bytes) == *h,
            Expect::Bytes(b) => b == bytes,
        }
    }

    /// The expected revision, if a file is expected.
    pub fn rev(&self) -> Option<Hash> {
        match self {
            Expect::Absent => None,
            Expect::Rev(h) => Some(*h),
            Expect::Bytes(b) => Some(revision(b)),
        }
    }
}

/// One file operation to publish.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct PublishOp {
    /// The user-visible path.
    pub path: RelPath,
    /// What must be there for the publish to proceed.
    pub expect: Expect,
    /// The new content, or `None` to remove the file.
    pub new: Option<Vec<u8>>,
}

/// The private names one publish may use. Unique per publish and across
/// crashes: the caller derives them from a journaled counter.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Names {
    /// The temp holding the new bytes (and, after a swap, the displaced ones).
    pub tmp: RelPath,
    /// Where a displaced or removed file is retained until settled.
    pub stash: RelPath,
    /// Where an unexpected user version is preserved for ingest.
    pub held: RelPath,
}

impl Names {
    /// The names for publish number `n` under `private_dir`.
    pub fn for_op(private_dir: &RelPath, n: u64) -> Names {
        Self::for_retention(private_dir, n, false)
    }

    pub(crate) fn for_retention(private_dir: &RelPath, n: u64, nosync: bool) -> Names {
        let mk = |d: &str| {
            private_dir
                .join(&format!("{d}/{n}"))
                .expect("private dir and counter make a valid path")
        };
        Names {
            tmp: mk("tmp"),
            stash: mk(if nosync { "retained.nosync" } else { "stash" }),
            held: mk("held"),
        }
    }

    /// The private subdirectories every name lives in (created at open).
    pub fn dirs(private_dir: &RelPath) -> [RelPath; 3] {
        Self::retention_dirs(private_dir, false)
    }

    pub(crate) fn retention_dirs(private_dir: &RelPath, nosync: bool) -> [RelPath; 3] {
        [
            "tmp",
            if nosync { "retained.nosync" } else { "stash" },
            "held",
        ]
        .map(|d| private_dir.join(d).expect("valid"))
    }
}

/// A file kept in the private directory until it has been stable for the
/// retention period. If it still holds `expect` then, it is removed; otherwise
/// a late write landed in it and it becomes a preserved file.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Retained {
    /// The private path.
    pub path: RelPath,
    /// The revision it should keep holding.
    pub expect: Hash,
}

/// Result of a publish.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Outcome {
    /// The path now holds the new bytes (or is gone, for a delete).
    Published {
        /// A displaced or removed inode to settle.
        retained: Option<Retained>,
    },
    /// The path did not hold what was expected. Nothing the user wrote was
    /// replaced. The store re-reads the path (ingest) and re-plans or holds.
    Drifted {
        /// Our own inode, swapped back out, to settle (never
        /// unlinked on the restore path).
        retained: Option<Retained>,
        /// A user version that was displaced and could not be put back because
        /// the path already holds a newer one: ingest it as an edit on the
        /// expected base, then remove it.
        preserved: Option<RelPath>,
    },
    /// The file is locked by another process (Windows). Retry later.
    Busy,
    /// An unexpected platform error. Nothing user-owned was lost; the intent
    /// stays journaled and recovery resolves it.
    Failed(FsError),
}

impl Outcome {
    fn drifted() -> Outcome {
        Outcome::Drifted {
            retained: None,
            preserved: None,
        }
    }
}

/// Knobs that depend on batching and platform.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Options {
    /// `fsync` each temp before it is published. False in a batch that issues
    /// one [`FlushScope::Barrier`] before its swaps.
    pub sync_temp: bool,
    /// `fsync` the directory after each rename. False in a batch that ends with
    /// [`FlushScope::Full`].
    pub sync_dir: bool,
    /// Sharing while locked (Windows D).
    pub share: LockShare,
    /// Restore-loop bound for the exchange strategy.
    pub max_restore_rounds: u32,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            sync_temp: true,
            sync_dir: true,
            share: LockShare::Read,
            max_restore_rounds: 8,
        }
    }
}

/// Publish one operation with the platform's strategy.
///
/// Precondition: the private directories exist (see [`Names::dirs`]) and the
/// temp name does not. For the exchange and locked strategies with
/// `op.new = Some`, the caller may have pre-written the temp (batched publish);
/// see [`publish_prewritten`].
pub async fn publish<P: FilePlatform>(
    p: &P,
    op: &PublishOp,
    names: &Names,
    opt: &Options,
) -> Outcome {
    match p.capabilities().replace {
        ReplaceStrategy::ReadOnly => {
            Outcome::Failed(FsError::unsupported("publish on a read-only volume"))
        }
        ReplaceStrategy::GuardedInPlace => guarded(p, op).await,
        strategy => {
            let Some(new) = &op.new else {
                return match strategy {
                    ReplaceStrategy::LockedInPlace => locked_delete(p, op, names, opt).await,
                    _ => rename_delete(p, op, names, opt).await,
                };
            };
            if op.expect == Expect::Absent || strategy == ReplaceStrategy::Exchange {
                if let Err(e) = ensure_parent(p, &op.path).await {
                    return Outcome::Failed(e);
                }
                let our = match p.write_new(&names.tmp, new, opt.sync_temp).await {
                    Ok(m) => m.id,
                    Err(e) => return Outcome::Failed(e),
                };
                publish_prewritten(p, op, names, opt, our).await
            } else {
                locked_replace(p, op, new, opt).await
            }
        }
    }
}

/// The exchange/create half of [`publish`] once `names.tmp` holds the new
/// bytes (`our` = its file ID). Batched publishing writes every temp, issues
/// one barrier, then calls this per file.
pub async fn publish_prewritten<P: FilePlatform>(
    p: &P,
    op: &PublishOp,
    names: &Names,
    opt: &Options,
    our: Option<FileId>,
) -> Outcome {
    if op.expect == Expect::Absent {
        return rename_create(p, op, names, opt).await;
    }
    exchange_replace(p, op, names, opt, our).await
}

async fn ensure_parent<P: FilePlatform>(p: &P, path: &RelPath) -> Result<(), FsError> {
    let dir = path.parent();
    if dir.is_root() {
        return Ok(());
    }
    p.create_dir_all(&dir).await
}

async fn sync_dir<P: FilePlatform>(p: &P, opt: &Options, dir: RelPath) -> Result<(), FsError> {
    if opt.sync_dir {
        p.flush(FlushScope::Dir(dir)).await
    } else {
        Ok(())
    }
}

/// Remove our temp. Only ever called while it provably holds our new bytes
/// and was never at the user path.
async fn drop_tmp<P: FilePlatform>(p: &P, names: &Names) {
    let _ = p.remove_file(&names.tmp).await;
}

async fn rename_create<P: FilePlatform>(
    p: &P,
    op: &PublishOp,
    names: &Names,
    opt: &Options,
) -> Outcome {
    match p.rename_noreplace(&names.tmp, &op.path).await {
        Ok(()) => match sync_dir(p, opt, op.path.parent()).await {
            Ok(()) => Outcome::Published { retained: None },
            Err(e) => Outcome::Failed(e),
        },
        // Occupied, including a case or normalization variant on an
        // insensitive volume (a path collision): the user's file stays.
        Err(e) if e.kind == FsErrorKind::AlreadyExists => {
            drop_tmp(p, names).await;
            Outcome::drifted()
        }
        Err(e) => {
            drop_tmp(p, names).await;
            Outcome::Failed(e)
        }
    }
}

/// Exchange strategy, replace (retained-inode restore and metadata carry-over).
async fn exchange_replace<P: FilePlatform>(
    p: &P,
    op: &PublishOp,
    names: &Names,
    opt: &Options,
    our: Option<FileId>,
) -> Outcome {
    let Some(our) = our else {
        drop_tmp(p, names).await;
        return Outcome::Failed(FsError::new(
            FsErrorKind::Unsupported,
            "exchange strategy needs file IDs",
        ));
    };
    let new = op.new.as_deref().unwrap_or_default();
    // A4: carry over xattrs/ACLs/mode/creation date onto the temp.
    match p.copy_metadata(&op.path, &names.tmp).await {
        Ok(()) => {}
        Err(e) if e.is_not_found() => {
            drop_tmp(p, names).await;
            return Outcome::drifted();
        }
        Err(e) if e.kind == FsErrorKind::Unsupported => {}
        Err(e) => {
            drop_tmp(p, names).await;
            return Outcome::Failed(e);
        }
    }
    match p.exchange(&names.tmp, &op.path).await {
        Ok(()) => {}
        // The user deleted or renamed it away.
        Err(e) if e.is_not_found() => {
            drop_tmp(p, names).await;
            return Outcome::drifted();
        }
        Err(e) => {
            drop_tmp(p, names).await;
            return Outcome::Failed(e);
        }
    }
    // From here `tmp` holds whatever was at the path: it is never removed.
    let displaced = match p.read(&names.tmp).await {
        Ok(r) => r.bytes,
        Err(e) => return Outcome::Failed(e),
    };
    if op.expect.matches(&displaced) {
        if let Err(e) = sync_dir(p, opt, op.path.parent()).await {
            return Outcome::Failed(e);
        }
        return match p.rename_noreplace(&names.tmp, &names.stash).await {
            Ok(()) => Outcome::Published {
                retained: Some(Retained {
                    path: names.stash.clone(),
                    expect: revision(&displaced),
                }),
            },
            Err(e) => Outcome::Failed(e),
        };
    }
    // The user wrote between our last look and the swap: `tmp` holds their
    // bytes D. Put them back, unless the path no longer holds our inode (the
    // user saved again over it, so the path already has their newest file).
    for _ in 0..opt.max_restore_rounds {
        let at_path = match p.stat(&op.path).await {
            Ok(m) => m.id,
            Err(_) => break,
        };
        if at_path != Some(our) {
            break;
        }
        match p.exchange(&names.tmp, &op.path).await {
            Ok(()) => {}
            Err(e) if e.is_not_found() => break,
            Err(e) => return Outcome::Failed(e),
        }
        let in_tmp = match p.stat(&names.tmp).await {
            Ok(m) => m.id,
            Err(e) => return Outcome::Failed(e),
        };
        if in_tmp == Some(our) {
            // Our inode is back in tmp and D is at the path.
            let ours = match p.read(&names.tmp).await {
                Ok(r) => r.bytes,
                Err(e) => return Outcome::Failed(e),
            };
            if ours == new {
                // A2: an editor may have opened our inode while it was at the
                // path; never unlink it here. Retain and settle it.
                if let Err(e) = sync_dir(p, opt, op.path.parent()).await {
                    return Outcome::Failed(e);
                }
                return match p.rename_noreplace(&names.tmp, &names.stash).await {
                    Ok(()) => Outcome::Drifted {
                        retained: Some(Retained {
                            path: names.stash.clone(),
                            expect: revision(new),
                        }),
                        preserved: None,
                    },
                    Err(e) => Outcome::Failed(e),
                };
            }
            // Someone wrote into our inode in place while it was at the path:
            // those are the user's newest bytes. Swap them back to the path;
            // tmp then holds the older D, preserved below.
            match p.exchange(&names.tmp, &op.path).await {
                Ok(()) => break,
                Err(e) if e.is_not_found() => break,
                Err(e) => return Outcome::Failed(e),
            }
        }
        // The path was replaced between our stat and the swap: undo, so the
        // path holds that newest file again, and look again.
        match p.exchange(&names.tmp, &op.path).await {
            Ok(()) => continue,
            Err(e) if e.is_not_found() => break,
            Err(e) => return Outcome::Failed(e),
        }
    }
    // The path holds a newer user file (or none); tmp holds an older user
    // version. Preserve it for folding on the expected base.
    match p.rename_noreplace(&names.tmp, &names.held).await {
        Ok(()) => Outcome::Drifted {
            retained: None,
            preserved: Some(names.held.clone()),
        },
        Err(e) => Outcome::Failed(e),
    }
}

/// Exchange and create-by-rename strategies, delete.
async fn rename_delete<P: FilePlatform>(
    p: &P,
    op: &PublishOp,
    names: &Names,
    opt: &Options,
) -> Outcome {
    if op.expect == Expect::Absent {
        return Outcome::Published { retained: None };
    }
    match p.rename_noreplace(&op.path, &names.stash).await {
        Ok(()) => {}
        Err(e) if e.is_not_found() => return Outcome::drifted(),
        Err(e) => return Outcome::Failed(e),
    }
    let moved = match p.read(&names.stash).await {
        Ok(r) => r.bytes,
        Err(e) => return Outcome::Failed(e),
    };
    if op.expect.matches(&moved) {
        return match sync_dir(p, opt, op.path.parent()).await {
            Ok(()) => Outcome::Published {
                retained: Some(Retained {
                    path: names.stash.clone(),
                    expect: revision(&moved),
                }),
            },
            Err(e) => Outcome::Failed(e),
        };
    }
    // Not what we expected: put it back, unless the user recreated the path.
    match p.rename_noreplace(&names.stash, &op.path).await {
        Ok(()) => Outcome::drifted(),
        Err(e) if e.kind == FsErrorKind::AlreadyExists => {
            match p.rename_noreplace(&names.stash, &names.held).await {
                Ok(()) => Outcome::Drifted {
                    retained: None,
                    preserved: Some(names.held.clone()),
                },
                Err(e) => Outcome::Failed(e),
            }
        }
        Err(e) => Outcome::Failed(e),
    }
}

/// Windows protocol D, replace: lock, verify through the handle, overwrite in
/// place. The path never disappears and the file keeps its identity, ADS, ACLs
/// and creation time. The journaled intent carries the expected and new bytes
/// so a torn overwrite is recoverable.
async fn locked_replace<P: FilePlatform>(
    p: &P,
    op: &PublishOp,
    new: &[u8],
    opt: &Options,
) -> Outcome {
    let h = match p.lock(&op.path, opt.share).await {
        Ok(h) => h,
        Err(e) if e.kind == FsErrorKind::Busy => return Outcome::Busy,
        Err(e) if e.is_not_found() => return Outcome::drifted(),
        Err(e) => return Outcome::Failed(e),
    };
    let result = async {
        let cur = p.locked_read(h).await?;
        if !op.expect.matches(&cur.bytes) {
            return Ok(Outcome::drifted());
        }
        p.locked_overwrite(h, new, opt.sync_temp).await?;
        Ok(Outcome::Published { retained: None })
    }
    .await;
    let _ = p.unlock(h).await;
    result.unwrap_or_else(Outcome::Failed)
}

/// Windows protocol D, delete: lock, verify, move aside by handle.
async fn locked_delete<P: FilePlatform>(
    p: &P,
    op: &PublishOp,
    names: &Names,
    opt: &Options,
) -> Outcome {
    if op.expect == Expect::Absent {
        return Outcome::Published { retained: None };
    }
    let h = match p.lock(&op.path, opt.share).await {
        Ok(h) => h,
        Err(e) if e.kind == FsErrorKind::Busy => return Outcome::Busy,
        Err(e) if e.is_not_found() => return Outcome::drifted(),
        Err(e) => return Outcome::Failed(e),
    };
    let result = async {
        let cur = p.locked_read(h).await?;
        if !op.expect.matches(&cur.bytes) {
            return Ok(Outcome::drifted());
        }
        p.locked_move_aside(h, &names.stash).await?;
        Ok(Outcome::Published {
            retained: Some(Retained {
                path: names.stash.clone(),
                expect: revision(&cur.bytes),
            }),
        })
    }
    .await;
    let _ = p.unlock(h).await;
    match result {
        Ok(o @ Outcome::Published { .. }) => match sync_dir(p, opt, op.path.parent()).await {
            Ok(()) => o,
            Err(e) => Outcome::Failed(e),
        },
        Ok(o) => o,
        Err(e) => Outcome::Failed(e),
    }
}

/// The Obsidian vault (guarded closed-file route). The editor route, quiet
/// gate and read-back verification are the store's job.
async fn guarded<P: FilePlatform>(p: &P, op: &PublishOp) -> Outcome {
    // The guard compares bytes. With only a revision, read and check first,
    // then guard on exactly those bytes.
    let expect_bytes = match &op.expect {
        Expect::Absent => None,
        Expect::Bytes(b) => Some(b.clone()),
        Expect::Rev(h) => match p.read(&op.path).await {
            Ok(r) if revision(&r.bytes) == *h => Some(r.bytes),
            Ok(_) => return Outcome::drifted(),
            Err(e) if e.is_not_found() => return Outcome::drifted(),
            Err(e) => return Outcome::Failed(e),
        },
    };
    let r = match (&op.new, expect_bytes) {
        (Some(new), None) => p.guarded_create(&op.path, new).await,
        (Some(new), Some(exp)) => p.guarded_replace(&op.path, &exp, new).await,
        (None, Some(exp)) => p.guarded_trash(&op.path, &exp).await,
        (None, None) => return Outcome::Published { retained: None },
    };
    match r {
        Ok(Guarded::Done) => Outcome::Published { retained: None },
        Ok(_) => Outcome::drifted(),
        Err(e) if e.kind == FsErrorKind::Busy => Outcome::Busy,
        Err(e) => Outcome::Failed(e),
    }
}

/// True if `x` is what an interrupted in-place overwrite of `old` with `new`
/// can leave: a prefix of `new` written over `old`, where every byte after the
/// written prefix is either `old`'s byte at that offset (not yet overwritten,
/// or left past the end before `SetEndOfFile`) or zero (an extent allocated but
/// not written before power loss). Includes the empty file. `x == old` and
/// `x == new` are not torn; the caller handles them first.
///
/// Recovery rewrites `new` over a torn file. That loses nothing the user wrote
/// because `old` (the expected bytes) is journaled with the intent, and on
/// Windows the lock kept other writers out while the overwrite ran.
pub fn is_torn_mix(x: &[u8], old: &[u8], new: &[u8]) -> bool {
    if x == old || x == new {
        return false;
    }
    let max_len = old.len().max(new.len());
    if x.len() > max_len {
        return false;
    }
    let k = x.iter().zip(new).take_while(|(a, b)| a == b).count();
    (0..=k).any(|j| {
        x[j..]
            .iter()
            .enumerate()
            .all(|(i, &t)| t == 0 || old.get(j + i) == Some(&t))
    })
}

#[cfg(test)]
mod torn_tests {
    use super::is_torn_mix;

    #[test]
    fn torn_shapes() {
        let old = b"hello world, old text";
        let new = b"HELLO";
        assert!(is_torn_mix(b"", old, new));
        assert!(is_torn_mix(b"HEL", old, new));
        assert!(is_torn_mix(b"HELlo world, old text", old, new));
        assert!(is_torn_mix(b"HELLO world, old text", old, new));
        assert!(is_torn_mix(b"HE\0\0\0", old, new));
        assert!(!is_torn_mix(old, old, new));
        assert!(!is_torn_mix(new, old, new));
        assert!(!is_torn_mix(b"HELLO world, NEW text", old, new));
        assert!(!is_torn_mix(b"user rewrote it", old, new));
        // Longer new over shorter old.
        assert!(!is_torn_mix(b"abcdeXY", b"XY", b"abcdefghij"));
        assert!(is_torn_mix(b"abcde\0\0", b"XY", b"abcdefghij"));
        assert!(is_torn_mix(b"aY", b"XY", b"abcdefghij"));
    }
}
