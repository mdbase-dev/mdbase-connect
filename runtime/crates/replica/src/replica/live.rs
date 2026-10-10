//! Push: live queries and the change feed (`replica-client-api.md` §4).
//!
//! Live queries are state-based: every local-view change that touches a record in a
//! subscription's last result, or a record that now matches, produces one `diff`
//! with the records added, changed and removed (and the full order when it moved).
//! Diffs describe state, so coalescing them loses nothing.
//!
//! The change feed is an in-memory window of local-view versions. A cursor older
//! than the window (or from before a restart) gets `reset: true` and a fresh cursor.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use mdbn_core::state::StateView;
use mdbn_wire::client::{Change, ChangeKind, Include, QueryUpdate, UpdateKind};
use mdbn_wire::common::{B16, Hash, Value};

use super::Replica;
use crate::api::{ApiResult, ChangesResult, ErrorCode, Push, SessionId};
use crate::convert;
use crate::layer::LayerView;
use crate::plan::StoreView;
use crate::store::Store;

/// Changes kept for change-feed cursors.
const FEED_WINDOW: usize = 10_000;

/// One live query.
#[derive(Debug, Clone)]
pub(crate) struct Sub {
    pub(crate) session: SessionId,
    pub(crate) query: Value,
    pub(crate) include: Include,
    /// The last pushed result: IDs in order, with their revisions.
    pub(crate) last: Vec<(B16, Hash)>,
}

/// Push state.
#[derive(Debug, Clone, Default)]
pub(crate) struct Live {
    pub(crate) subs: BTreeMap<u64, Sub>,
    pub(crate) next_sub: u64,
    pub(crate) feed: VecDeque<Change>,
    /// Lowest version still in the feed window (exclusive cursor floor).
    pub(crate) feed_floor: u64,
    pub(crate) watchers: BTreeSet<SessionId>,
    /// This instance's cursor prefix: cursors from before a restart reset.
    pub(crate) instance: u64,
}

/// Record IDs named by touch keys (`"i:<hex>"`).
pub(crate) fn ids_from_keys<'a>(keys: impl IntoIterator<Item = &'a String>) -> BTreeSet<B16> {
    keys.into_iter()
        .filter_map(|k| k.strip_prefix("i:"))
        .filter_map(|h| {
            if h.len() != 32 {
                return None;
            }
            let mut b = [0u8; 16];
            for (i, byte) in b.iter_mut().enumerate() {
                *byte = u8::from_str_radix(h.get(2 * i..2 * i + 2)?, 16).ok()?;
            }
            Some(B16(b))
        })
        .collect()
}

/// Live queries one session may hold (each is re-run on every change).
pub const MAX_LIVE_SUBS_PER_SESSION: usize = 32;
/// Live queries one replica holds across all sessions.
pub const MAX_LIVE_SUBS: usize = 256;

impl<S: Store> Replica<S> {
    /// The local view changed for `ids`: bump the version, extend the feed and push
    /// to watchers and live queries.
    pub(crate) fn notify(&mut self, ids: &BTreeSet<B16>) {
        self.close_revoked_sessions();
        self.view_version += 1;
        if ids.is_empty() {
            return;
        }
        let version = self.view_version;
        let changes: Vec<Change> = {
            let view = StoreView::new(&self.store, self.catalog.clone());
            let lv = LayerView {
                base: &view,
                layer: &self.layer,
            };
            ids.iter()
                .map(|id| {
                    let cid = convert::uuid(id);
                    if let Some(r) = lv.record(&cid) {
                        Change {
                            id: *id,
                            path: r.path,
                            kind: ChangeKind::Put,
                            version,
                        }
                    } else if let Some(f) = lv.file(&cid) {
                        Change {
                            id: *id,
                            path: f.path,
                            kind: ChangeKind::Put,
                            version,
                        }
                    } else {
                        let path = match lv.tombstone(&cid) {
                            Some(mdbn_core::state::Tombstone::Record { path, .. })
                            | Some(mdbn_core::state::Tombstone::File { path, .. }) => path,
                            None => String::new(),
                        };
                        Change {
                            id: *id,
                            path,
                            kind: ChangeKind::Remove,
                            version,
                        }
                    }
                })
                .collect()
        };
        for c in &changes {
            self.live.feed.push_back(c.clone());
        }
        while self.live.feed.len() > FEED_WINDOW {
            if let Some(c) = self.live.feed.pop_front() {
                self.live.feed_floor = c.version;
            }
        }
        let watchers: Vec<SessionId> = self.live.watchers.iter().copied().collect();
        for w in watchers {
            if self.require(w, crate::policy::capability::READ).is_err() {
                continue;
            }
            let visible: Vec<Change> = changes
                .iter()
                .filter(|c| self.change_visible(w, c))
                .cloned()
                .collect();
            if visible.is_empty() {
                continue;
            }
            self.pushes.push((
                w,
                Push::Changes(ChangesResult {
                    changes: visible,
                    cursor: format!("{}:{version}", self.live.instance),
                    reset: false,
                }),
            ));
        }
        let subs: Vec<u64> = self.live.subs.keys().copied().collect();
        for id in subs {
            self.refresh_sub(id, Some(ids));
        }
    }

    /// Recompute a live query and push the diff (or the snapshot when `ids` is None).
    pub(crate) fn refresh_sub(&mut self, sub: u64, ids: Option<&BTreeSet<B16>>) {
        let Some(s) = self.live.subs.get(&sub).cloned() else {
            return;
        };
        if self
            .require(s.session, crate::policy::capability::READ)
            .is_err()
        {
            return;
        }
        let result = match self.run_query(&s.query, &s.include) {
            Ok(r) => r,
            Err(_) => {
                self.pushes.push((
                    s.session,
                    Push::QueryUpdate(QueryUpdate {
                        sub,
                        kind: UpdateKind::Reset,
                        added: None,
                        changed: None,
                        removed: None,
                        order: None,
                        complete: true,
                        as_of: self.view_version,
                        metadata: None,
                    }),
                ));
                return;
            }
        };
        let now: Vec<(B16, Hash)> = result.records.iter().map(|r| (r.id, r.revision)).collect();
        let update = match ids {
            None => QueryUpdate {
                sub,
                kind: UpdateKind::Snapshot,
                added: Some(result.records.clone()),
                changed: None,
                removed: None,
                order: None,
                complete: result.complete,
                as_of: result.as_of,
                metadata: None,
            },
            Some(ids) => {
                let old: BTreeMap<B16, Hash> = s.last.iter().copied().collect();
                let new: BTreeMap<B16, Hash> = now.iter().copied().collect();
                let added: Vec<_> = result
                    .records
                    .iter()
                    .filter(|r| !old.contains_key(&r.id))
                    .cloned()
                    .collect();
                let changed: Vec<_> = result
                    .records
                    .iter()
                    .filter(|r| {
                        old.get(&r.id).is_some_and(|h| *h != r.revision)
                            || (ids.contains(&r.id)
                                && old.contains_key(&r.id)
                                && old.get(&r.id) != Some(&r.revision))
                    })
                    .cloned()
                    .collect();
                let removed: Vec<B16> = s
                    .last
                    .iter()
                    .map(|(i, _)| *i)
                    .filter(|i| !new.contains_key(i))
                    .collect();
                let old_order: Vec<B16> = s
                    .last
                    .iter()
                    .map(|(i, _)| *i)
                    .filter(|i| new.contains_key(i))
                    .collect();
                let new_order: Vec<B16> = now
                    .iter()
                    .map(|(i, _)| *i)
                    .filter(|i| old.contains_key(i))
                    .collect();
                if added.is_empty()
                    && changed.is_empty()
                    && removed.is_empty()
                    && old_order == new_order
                {
                    if let Some(x) = self.live.subs.get_mut(&sub) {
                        x.last = now;
                    }
                    return;
                }
                let reordered = !added.is_empty() || old_order != new_order;
                QueryUpdate {
                    sub,
                    kind: UpdateKind::Diff,
                    added: (!added.is_empty()).then_some(added),
                    changed: (!changed.is_empty()).then_some(changed),
                    removed: (!removed.is_empty()).then_some(removed),
                    order: reordered.then(|| now.iter().map(|(i, _)| *i).collect()),
                    complete: result.complete,
                    as_of: result.as_of,
                    metadata: None,
                }
            }
        };
        if let Some(x) = self.live.subs.get_mut(&sub) {
            x.last = now;
        }
        self.pushes.push((s.session, Push::QueryUpdate(update)));
    }

    pub(crate) fn subscribe_query(
        &mut self,
        session: SessionId,
        query: Value,
        include: Include,
    ) -> ApiResult<u64> {
        // Every live query is re-run on every change,
        // so their number is bounded per session and per replica.
        let mine = self
            .live
            .subs
            .values()
            .filter(|s| s.session == session)
            .count();
        if mine >= MAX_LIVE_SUBS_PER_SESSION || self.live.subs.len() >= MAX_LIVE_SUBS {
            return Err(ErrorCode::TooLarge.err_with_reason(
                "subscription_limit",
                "too many live queries; unsubscribe one first",
            ));
        }
        // Validate first, so a bad query is an error, not a reset.
        self.run_query(&query, &include)?;
        self.live.next_sub += 1;
        let id = self.live.next_sub;
        self.live.subs.insert(
            id,
            Sub {
                session,
                query,
                include,
                last: Vec::new(),
            },
        );
        self.refresh_sub(id, None);
        Ok(id)
    }

    pub(crate) fn unsubscribe_query(&mut self, session: SessionId, sub: u64) -> ApiResult<()> {
        match self.live.subs.get(&sub) {
            Some(s) if s.session == session => {
                self.live.subs.remove(&sub);
                Ok(())
            }
            _ => Err(ErrorCode::NotFound.err("no such subscription")),
        }
    }

    pub(crate) fn feed_changes(
        &mut self,
        session: SessionId,
        cursor: Option<String>,
        limit: Option<u32>,
        watch: bool,
    ) -> ApiResult<ChangesResult> {
        if watch {
            self.live.watchers.insert(session);
        }
        let now = self.view_version;
        let inst = self.live.instance;
        let fresh = format!("{inst}:{now}");
        let Some(c) = cursor else {
            return Ok(ChangesResult {
                changes: Vec::new(),
                cursor: fresh,
                reset: false,
            });
        };
        let parsed = c
            .split_once(':')
            .filter(|(i, _)| i.parse::<u64>().ok() == Some(inst))
            .and_then(|(_, v)| v.parse::<u64>().ok());
        let at: u64 = match parsed {
            Some(v) if v <= now && v >= self.live.feed_floor => v,
            _ => {
                return Ok(ChangesResult {
                    changes: Vec::new(),
                    cursor: fresh,
                    reset: true,
                });
            }
        };
        let limit = limit.unwrap_or(1000) as usize;
        let changes: Vec<Change> = self
            .live
            .feed
            .iter()
            .filter(|c| c.version > at)
            .filter(|c| self.change_visible(session, c))
            .take(limit)
            .cloned()
            .collect();
        let cursor = changes.last().map(|c| c.version).unwrap_or(now);
        let cursor = if changes.len() < limit {
            now.max(cursor)
        } else {
            cursor
        };
        Ok(ChangesResult {
            changes,
            cursor: format!("{inst}:{cursor}"),
            reset: false,
        })
    }

    /// Drop a closed session's push state.
    pub(crate) fn drop_session_live(&mut self, session: SessionId) {
        self.live.subs.retain(|_, s| s.session != session);
        self.live.watchers.remove(&session);
    }
}
