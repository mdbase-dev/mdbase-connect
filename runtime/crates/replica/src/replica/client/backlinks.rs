//! Backlinks: the records whose links resolve to a record, from Core's link
//! index over the local view (replica-client-api.md §4.2). Resolution is
//! Core's, the same that rename uses to rewrite links; nothing is re-derived
//! here.

use super::{Replica, Store, store_err};
use crate::api::{ApiError, ApiResult, Backlinks, ErrorCode, SessionId};
use crate::convert;
use crate::layer::LayerView;
use crate::plan::StoreView;
use mdbn_core::state::StateView;
use mdbn_wire::Wire;
use mdbn_wire::client::{Backlink, BacklinksResult, LinkKind, LinkResolution, LinkView};

const DEFAULT_LIMIT: u32 = 128;
/// Encoded referring-record views per page: the query hydration budget.
const MAX_PAGE_BYTES: usize = 1 << 20;

fn page_full() -> ApiError {
    ErrorCode::TooLarge.err_with_reason(
        "backlinks_budget_exceeded",
        "a referring record exceeds the backlinks page budget",
    )
}

impl<S: Store> Replica<S> {
    pub(super) fn backlinks_page(
        &mut self,
        session: SessionId,
        request: Backlinks,
    ) -> ApiResult<BacklinksResult> {
        self.require(session, crate::policy::capability::READ)?;
        let limit = request.limit.unwrap_or(DEFAULT_LIMIT);
        let (target, target_path) = {
            let base = StoreView::new(&self.store, self.catalog.clone());
            let lv = LayerView {
                base: &base,
                layer: &self.layer,
            };
            let found = self.resolve_target(&lv, &request.target).and_then(|id| {
                lv.record(&convert::uuid(&id))
                    .map(|record| (id, record.path))
            });
            if let Some(error) = base.error() {
                return Err(store_err(error));
            }
            found.ok_or_else(|| ErrorCode::NotFound.err("no such record"))?
        };
        let position = self.begin_backlinks_page(
            session,
            target,
            &request.include,
            limit,
            request.cursor.as_deref(),
        )?;
        let (backlinks, more) = {
            let base = StoreView::new(&self.store, self.catalog.clone());
            let lv = LayerView {
                base: &base,
                layer: &self.layer,
            };
            let resolution = LinkResolution {
                kind: LinkKind::Record,
                target: Some(target),
                path: Some(target_path),
                candidates: None,
            };
            let mut backlinks: Vec<Backlink> = Vec::new();
            let mut bytes = 0usize;
            let mut more = false;
            let mut refused = None;
            let core_target = convert::uuid(&target);
            mdbn_core::links::referrers_of(
                &lv,
                core_target,
                position.after.as_deref(),
                &mut |referrer| {
                    // A record's links to itself are not backlinks.
                    if referrer.id == core_target {
                        return true;
                    }
                    if backlinks.len() >= limit as usize {
                        more = true;
                        return false;
                    }
                    let id = convert::wuuid(&referrer.id);
                    let Some(record) = self.view_of(&lv, &id, &request.include, true) else {
                        return true;
                    };
                    let size =
                        mdbn_wire::cbor::encode(&record.to_cbor()).map_or(usize::MAX, |b| b.len());
                    match bytes.checked_add(size).filter(|n| *n <= MAX_PAGE_BYTES) {
                        Some(total) => bytes = total,
                        None if backlinks.is_empty() => {
                            refused = Some(page_full());
                            return false;
                        }
                        None => {
                            more = true;
                            return false;
                        }
                    }
                    let links = referrer
                        .links
                        .into_iter()
                        .map(|link| LinkView {
                            raw: link.raw,
                            embed: link.embed,
                            resolution: resolution.clone(),
                            field: link.field.map(|(field, _)| field),
                        })
                        .collect();
                    backlinks.push(Backlink { record, links });
                    true
                },
            );
            if let Some(error) = base.error() {
                return Err(store_err(error));
            }
            if let Some(error) = refused {
                return Err(error);
            }
            (backlinks, more)
        };
        let after = if more {
            backlinks.last().map(|b| b.record.path.clone())
        } else {
            None
        };
        let cursor = self.finish_backlinks_page(session, position, after)?;
        Ok(BacklinksResult {
            backlinks,
            cursor,
            complete: self.install.is_none(),
            as_of: self.view_version,
        })
    }
}
