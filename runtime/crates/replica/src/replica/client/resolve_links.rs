//! Resolve links where they are written (replica-client-api.md §4.3): Core
//! parses each occurrence and resolves it over the local view, exactly as the
//! link index, backlinks and rename do. Nothing is re-derived here.

use super::{Replica, Store, store_err};
use crate::api::{ApiResult, ErrorCode, ResolveLinks, SessionId};
use crate::convert;
use crate::layer::LayerView;
use crate::plan::StoreView;
use mdbn_core::links::{self, Resolution};
use mdbn_core::state::StateView;
use mdbn_wire::client::{LinkKind, LinkResolution, ResolveLinksResult};

fn unresolved(kind: LinkKind) -> LinkResolution {
    LinkResolution {
        kind,
        target: None,
        path: None,
        candidates: None,
    }
}

fn resolution(state: &dyn StateView, from: &str, raw: &str) -> LinkResolution {
    let Some(link) = links::parse_one(raw) else {
        return unresolved(LinkKind::Invalid);
    };
    let found = |kind, id, path| LinkResolution {
        kind,
        target: Some(convert::wuuid(&id)),
        path: Some(path),
        candidates: None,
    };
    match links::resolve(&link, from, state) {
        Resolution::Record(id) => match state.record(&id) {
            Some(record) => found(LinkKind::Record, id, record.path),
            None => unresolved(LinkKind::NotFound),
        },
        Resolution::File(id) => match state.file(&id) {
            Some(file) => found(LinkKind::File, id, file.path),
            None => unresolved(LinkKind::NotFound),
        },
        Resolution::Ambiguous(candidates) => LinkResolution {
            candidates: Some(candidates),
            ..unresolved(LinkKind::Ambiguous)
        },
        Resolution::NotFound => unresolved(LinkKind::NotFound),
        Resolution::Invalid => unresolved(LinkKind::Invalid),
    }
}

impl<S: Store> Replica<S> {
    pub(super) fn resolve_links_now(
        &mut self,
        session: SessionId,
        request: ResolveLinks,
    ) -> ApiResult<ResolveLinksResult> {
        self.require(session, crate::policy::capability::READ)?;
        if mdbn_core::paths::check_path(&request.from).is_err() {
            return Err(ErrorCode::InvalidRequest.err("from must be a collection path"));
        }
        let resolutions = {
            let base = StoreView::new(&self.store, self.catalog.clone());
            let lv = LayerView {
                base: &base,
                layer: &self.layer,
            };
            let resolutions: Vec<LinkResolution> = request
                .links
                .iter()
                .map(|raw| resolution(&lv, &request.from, raw))
                .collect();
            if let Some(error) = base.error() {
                return Err(store_err(error));
            }
            resolutions
        };
        Ok(ResolveLinksResult {
            resolutions,
            as_of: self.view_version,
            complete: self.install.is_none(),
        })
    }
}
