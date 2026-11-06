//! Bounded actual-journal inventory. Continuations retain only a session-owned
//! order/expiry, never rows, private upload references or mutation authority.
use super::{Replica, Store};
use crate::api::{ApiResult, ErrorCode, PendingMutation, PendingPage, SessionId};
use crate::replica::submit::store_err;
use mdbn_wire::cbor;
use mdbn_wire::common::{B16, Uuid};

const SCAN_ROWS: u32 = 64;
const PAGE_BYTES: usize = 4 << 20;
const POSITIONS: usize = 16;
const TTL_MS: i64 = 300_000;

#[derive(Debug, Clone)]
pub(crate) struct Position {
    token: Uuid,
    after: u64,
    expires: i64,
}
fn invalid() -> crate::api::ApiError {
    ErrorCode::InvalidRequest.err_with_reason(
        "invalid_pending_cursor",
        "restart pending inventory from its first page",
    )
}
impl<S: Store> Replica<S> {
    pub(super) fn pending_page(
        &mut self,
        session: SessionId,
        cursor: Option<Uuid>,
    ) -> ApiResult<PendingPage> {
        // The same current authentication rules as durable receipt output; a
        // write-only client may recover its own captures, never another grant's.
        self.session(session)?;
        if !self.receipt_session_current(session) {
            return Err(ErrorCode::Unauthenticated
                .err("the pending inventory session is no longer current"));
        }
        let grant = self.session(session)?.grant();
        let now = self.now().max(self.clock_floor).max(self.log_time);
        let state = self.sessions.get_mut(&session).ok_or_else(invalid)?;
        state.pending_time_floor = state.pending_time_floor.max(now);
        let now = state.pending_time_floor;
        let after = cursor
            .map(|token| {
                self.sessions[&session]
                    .pending_cursors
                    .iter()
                    .find(|p| p.token == token && now < p.expires)
                    .map(|p| p.after)
                    .ok_or_else(invalid)
            })
            .transpose()?;
        // Indexed reads retain only one source row at a time, not 65 potentially
        // large mutations. At most 64 rows plus one lookahead are read.
        let mut page = PendingPage {
            pending: Vec::new(),
            next: None,
        };
        let mut bytes = 0usize;
        let mut last = after;
        let mut more = false;
        for scanned in 0..=SCAN_ROWS {
            let Some(row) = self
                .store
                .pending(last, 1)
                .map_err(store_err)?
                .into_iter()
                .next()
            else {
                break;
            };
            if scanned == SCAN_ROWS {
                more = true;
                break;
            }
            if grant.is_none() || row.grant == grant {
                let entry = PendingMutation {
                    receipt: self.pending_receipt(&row.mutation.id),
                    captured: row.mutation.clock.instant,
                    ops: row.mutation.ops,
                };
                let size = cbor::encode(&entry.to_cbor())
                    .map_err(|_| ErrorCode::Internal.err("pending journal encoding failed"))?
                    .len();
                if size > PAGE_BYTES {
                    return Err(ErrorCode::TooLarge.err_with_reason(
                        "pending_inventory_budget",
                        "one pending entry exceeds the inventory byte budget",
                    ));
                }
                if bytes + size > PAGE_BYTES {
                    more = true;
                    break;
                }
                bytes += size;
                page.pending.push(entry);
            }
            last = Some(row.order);
        }
        if more {
            let after =
                last.ok_or_else(|| ErrorCode::Internal.err("pending inventory made no progress"))?;
            let mut token = B16([0; 16]);
            let mut unique = false;
            // A position token must not collide with any live session token.
            for _ in 0..4 {
                self.host.entropy.fill(&mut token.0);
                if !self
                    .sessions
                    .values()
                    .any(|s| s.pending_cursors.iter().any(|p| p.token == token))
                {
                    unique = true;
                    break;
                }
            }
            if !unique {
                return Err(ErrorCode::Internal.err("pending cursor entropy collision"));
            }
            let positions = &mut self
                .sessions
                .get_mut(&session)
                .ok_or_else(invalid)?
                .pending_cursors;
            positions.retain(|p| now < p.expires);
            if positions.len() >= POSITIONS {
                positions.pop_front();
            }
            positions.push_back(Position {
                token,
                after,
                expires: now.saturating_add(TTL_MS),
            });
            page.next = Some(token);
        }
        Ok(page)
    }
}
