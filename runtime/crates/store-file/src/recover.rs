//! Crash recovery for publishes.
//!
//! Before each publish the store journals an [`Intent`]; after the outcome is
//! recorded it clears it. At open, every intent still in the journal is
//! resolved here by looking at the disk. Recovery never removes a file unless
//! it provably holds our new bytes and was never at a user path; everything
//! else is retained (settled later) or preserved (ingested).
//!
//! Tables, per strategy:
//!
//! **Exchange** (write): by what the temp holds
//!
//! | temp | path | result |
//! |---|---|---|
//! | absent | new | Published |
//! | absent | expected (or absent for a create) | NotPublished |
//! | absent | other | Drifted |
//! | new bytes | any | swap never happened or was undone; temp retained; state from the path as above |
//! | expected bytes | new | swap happened: Published, temp retained |
//! | expected bytes | other | Drifted, temp retained |
//! | other (user) bytes | new, our inode | put the user's bytes back, retain ours: Drifted |
//! | other (user) bytes | other | preserve the user's bytes: Drifted |
//!
//! **LockedInPlace / GuardedInPlace** (write), guarded recovery: path holds new →
//! Published; expected → NotPublished; a torn mix of expected and new →
//! rewrite new, Published; missing or anything else → Drifted.
//!
//! **Deletes** (all strategies) by what the stash holds: expected → Published
//! (retained); other bytes → put back if the path is free, else preserved;
//! absent → judged from the path.
//!
//! A stash or held file left by the interrupted publish is retained or
//! preserved by the same rule: retained only if it holds the expected or new
//! bytes, preserved otherwise.

use crate::platform::{
    FilePlatform, FsError, FsErrorKind, FsResult, Guarded, LockShare, RelPath, ReplaceStrategy,
};
use crate::publish::{Expect, Names, PublishOp, Retained, is_torn_mix, revision};

/// A journaled publish.
///
/// For the locked and guarded strategies `op.expect` must be
/// [`Expect::Bytes`] when a file is expected: in-place writes destroy the old
/// bytes, so the journal is where they survive.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Intent {
    /// The strategy the publish used.
    pub strategy: ReplaceStrategy,
    /// What was being published.
    pub op: PublishOp,
    /// Its private names.
    pub names: Names,
}

/// What the interrupted publish amounts to.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum State {
    /// The path holds the new bytes (or is gone, for a delete).
    Published,
    /// Nothing changed at the path: the store may publish again.
    NotPublished,
    /// The path holds something else: ingest it.
    Drifted,
}

/// The resolution of one intent.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Recovered {
    /// The outcome.
    pub state: State,
    /// Files to settle after the retention period.
    pub retained: Vec<Retained>,
    /// User versions to ingest as edits on the expected base, then remove.
    pub preserved: Vec<RelPath>,
}

async fn read_opt<P: FilePlatform>(p: &P, path: &RelPath) -> FsResult<Option<Vec<u8>>> {
    match p.read(path).await {
        Ok(r) => Ok(Some(r.bytes)),
        Err(e) if e.is_not_found() => Ok(None),
        Err(e) => Err(e),
    }
}

fn judge(cur: Option<&[u8]>, op: &PublishOp) -> State {
    match (cur, &op.new) {
        (Some(c), Some(n)) if c == n.as_slice() => State::Published,
        (None, None) => State::Published,
        (None, Some(_)) if op.expect == Expect::Absent => State::NotPublished,
        (Some(c), _) if op.expect.matches(c) => State::NotPublished,
        _ => State::Drifted,
    }
}

/// Resolve one intent against the disk.
pub async fn recover<P: FilePlatform>(p: &P, it: &Intent) -> FsResult<Recovered> {
    let mut out = Recovered {
        state: State::Drifted,
        retained: Vec::new(),
        preserved: Vec::new(),
    };
    let op = &it.op;
    let names = &it.names;
    // Leftovers in the held slot are user bytes already set aside.
    if read_opt(p, &names.held).await?.is_some() {
        out.preserved.push(names.held.clone());
    }
    let new = op.new.as_deref();
    let is_ours = |b: &[u8]| op.expect.matches(b) || new == Some(b);

    if new.is_none() {
        // Delete: by what the stash holds.
        let stash = read_opt(p, &names.stash).await?;
        let cur = read_opt(p, &op.path).await?;
        match stash {
            Some(s) if op.expect.matches(&s) => {
                out.retained.push(Retained {
                    path: names.stash.clone(),
                    expect: revision(&s),
                });
                out.state = if cur.is_none() {
                    State::Published
                } else {
                    State::Drifted
                };
            }
            Some(_) => {
                if cur.is_none() {
                    match p.rename_noreplace(&names.stash, &op.path).await {
                        Ok(()) => {}
                        Err(e) if e.kind == FsErrorKind::AlreadyExists => {
                            out.preserved.push(names.stash.clone())
                        }
                        Err(e) => return Err(e),
                    }
                } else {
                    out.preserved.push(names.stash.clone());
                }
                out.state = State::Drifted;
            }
            None => out.state = judge(cur.as_deref(), op),
        }
        return Ok(out);
    }
    let new = new.unwrap_or_default();

    // Any stash from this publish (exchange: the displaced expected bytes or
    // our inode after a restore).
    if let Some(s) = read_opt(p, &names.stash).await? {
        if is_ours(&s) {
            out.retained.push(Retained {
                path: names.stash.clone(),
                expect: revision(&s),
            });
        } else {
            out.preserved.push(names.stash.clone());
        }
    }

    let creates_by_rename =
        op.expect == Expect::Absent && it.strategy != ReplaceStrategy::GuardedInPlace;
    if it.strategy == ReplaceStrategy::Exchange || creates_by_rename {
        let tmp = read_opt(p, &names.tmp).await?;
        let cur = read_opt(p, &op.path).await?;
        match tmp {
            None => out.state = judge(cur.as_deref(), op),
            Some(t) if t == new => {
                out.retained.push(Retained {
                    path: names.tmp.clone(),
                    expect: revision(&t),
                });
                out.state = judge(cur.as_deref(), op);
            }
            Some(t) if op.expect.matches(&t) => {
                out.retained.push(Retained {
                    path: names.tmp.clone(),
                    expect: revision(&t),
                });
                out.state = if cur.as_deref() == Some(new) {
                    State::Published
                } else {
                    State::Drifted
                };
            }
            // A create never exchanges: its temp was never at a user path, so
            // whatever it holds (a write torn by the crash) is ours. Not started
            // or not finished; retain the temp and judge the path rather than
            // assuming that a torn create displaced user bytes.
            Some(t) if op.expect == Expect::Absent => {
                out.retained.push(Retained {
                    path: names.tmp.clone(),
                    expect: revision(&t),
                });
                out.state = judge(cur.as_deref(), op);
            }
            Some(_) => {
                // User bytes were displaced into the temp.
                let ours_at_path = cur.as_deref() == Some(new);
                if ours_at_path && p.exchange(&names.tmp, &op.path).await.is_ok() {
                    // Our inode is in tmp now; retain it.
                    out.retained.push(Retained {
                        path: names.tmp.clone(),
                        expect: revision(new),
                    });
                } else {
                    out.preserved.push(names.tmp.clone());
                }
                out.state = State::Drifted;
            }
        }
        return Ok(out);
    }

    // In-place strategies (Windows D, vault).
    let cur = read_opt(p, &op.path).await?;
    let state = judge(cur.as_deref(), op);
    let old: &[u8] = match &op.expect {
        Expect::Bytes(b) => b,
        Expect::Absent => &[],
        Expect::Rev(_) => {
            // Without the old bytes a torn file cannot be told from an edit.
            out.state = state;
            return Ok(out);
        }
    };
    out.state = state;
    if state == State::Drifted
        && let Some(c) = cur
        && is_torn_mix(&c, old, new)
    {
        out.state = if rewrite(p, it, &c, new).await? {
            State::Published
        } else {
            State::Drifted
        };
    }
    Ok(out)
}

/// Rewrite `new` over a torn file that still holds exactly `torn`.
async fn rewrite<P: FilePlatform>(p: &P, it: &Intent, torn: &[u8], new: &[u8]) -> FsResult<bool> {
    let path = &it.op.path;
    match it.strategy {
        ReplaceStrategy::LockedInPlace => {
            let h = match p.lock(path, LockShare::Read).await {
                Ok(h) => h,
                Err(e) if e.kind == FsErrorKind::Busy || e.is_not_found() => return Ok(false),
                Err(e) => return Err(e),
            };
            let r = async {
                if p.locked_read(h).await?.bytes != torn {
                    return Ok::<bool, FsError>(false);
                }
                p.locked_overwrite(h, new, true).await?;
                Ok(true)
            }
            .await;
            let _ = p.unlock(h).await;
            r
        }
        ReplaceStrategy::GuardedInPlace => Ok(matches!(
            p.guarded_replace(path, torn, new).await?,
            Guarded::Done
        )),
        _ => Ok(false),
    }
}
