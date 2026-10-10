//! Resource source reads. No filesystem, catalog-summary or synthetic fallback.

use super::{Replica, Store, store_err};
use crate::api::{
    ApiResult, ErrorCode, ListResources, ResourceList, ResourceListEntry, ResourceView, SessionId,
};
use crate::layer::LayerView;
use crate::plan::StoreView;
use crate::store::{RESOURCE_PATH_BYTES, RESOURCE_SOURCE_BYTES, ResourcePathPage};
use mdbn_core::state::StateView;

/// Maximum returned source. This bounds output, not the existing Store's row
/// allocation or catalog compilation; bounded inventory paging is separate.
const MAX_RESOURCE_BYTES: usize = RESOURCE_SOURCE_BYTES;

fn resource_revision(source: &str) -> mdbn_wire::common::Hash {
    crate::convert::whash(&mdbn_core::ids::revision(source))
}

const MAX_PAGE_BYTES: usize = 2 * 1024 * 1024;
// Conservative CBOR headers, revision, state, size and page/cursor overhead.
const ROW_OVERHEAD: usize = 128;
const PAGE_OVERHEAD: usize = 128;

fn page_full() -> crate::api::ApiError {
    ErrorCode::TooLarge.err_with_reason(
        "resource_budget_exceeded",
        "resource page exceeds its fixed budget",
    )
}
fn inventory_error(error: crate::store::StoreError) -> crate::api::ApiError {
    if matches!(error, crate::store::StoreError::Full) {
        page_full()
    } else {
        ErrorCode::Unavailable.err_with_reason(
            "resource_inventory_unavailable",
            "resource inventory read failed",
        )
    }
}
fn invalid_path() -> crate::api::ApiError {
    ErrorCode::InvalidRequest.err_with_reason("invalid_path", "invalid resource path")
}

impl<S: Store> Replica<S> {
    pub(crate) fn require_resource_read(&self, session: SessionId) -> ApiResult<()> {
        self.require(session, crate::policy::capability::READ)?;
        if self.file_scope(session).is_some() {
            return Err(ErrorCode::Forbidden.err_with_reason(
                "resource_full_collection_required",
                "resource source requires an unrestricted collection READ session",
            ));
        }
        Ok(())
    }

    pub(crate) fn require_resource_inventory_read(&self, session: SessionId) -> ApiResult<()> {
        self.require_resource_read(session).map_err(|error| {
            if matches!(
                error.problem().reason.as_deref(),
                Some("apply_reopen_required" | "apply_recovering" | "hosted_rebuilding")
            ) {
                ErrorCode::Unavailable.err_with_reason(
                    "resource_inventory_unavailable",
                    "resource inventory is not ready",
                )
            } else {
                error
            }
        })
    }

    pub(super) fn read_resource_page(
        &mut self,
        session: SessionId,
        params: ListResources,
    ) -> ApiResult<ResourceList> {
        self.require_resource_inventory_read(session)?;
        let limit = params.limit.unwrap_or(64);
        if limit == 0 {
            return Err(ErrorCode::InvalidRequest
                .err_with_reason("invalid_resource_params", "resource limit must be positive"));
        }
        if limit > 128 {
            return Err(page_full());
        }
        if let Some(folder) = &params.folder {
            if folder.len() > RESOURCE_PATH_BYTES {
                return Err(page_full());
            }
            mdbn_core::paths::check_path(folder).map_err(|_| invalid_path())?;
        }
        if params
            .cursor
            .as_ref()
            .is_some_and(|c| c.len() > RESOURCE_PATH_BYTES)
        {
            return Err(page_full());
        }
        let text = params.text.unwrap_or(false);
        let position = self.begin_resource_page(
            session,
            params.folder.as_deref(),
            text,
            limit,
            params.cursor.as_deref(),
        )?;
        let prefix = params.folder.as_ref().map(|s| format!("{s}/"));
        let paths = self
            .store
            .resource_paths_page(ResourcePathPage {
                after: position.after.as_deref(),
                prefix: prefix.as_deref(),
                limit: limit + 1,
            })
            .map_err(inventory_error)?;
        if paths.len() > limit as usize + 1 {
            return Err(ErrorCode::Unavailable.err_with_reason(
                "resource_inventory_unavailable",
                "resource path page is over-bound",
            ));
        }
        let mut previous = position.after.as_deref();
        for path in &paths {
            if path.len() > RESOURCE_PATH_BYTES {
                return Err(page_full());
            }
            mdbn_core::paths::check_path(path).map_err(|_| invalid_path())?;
            if previous.is_some_and(|p| path.as_str() <= p)
                || prefix.as_ref().is_some_and(|p| !path.starts_with(p))
            {
                return Err(ErrorCode::Unavailable.err_with_reason(
                    "resource_inventory_unavailable",
                    "resource path page is not ordered or selected",
                ));
            }
            previous = Some(path);
        }
        let base = StoreView::new(&self.store, self.catalog.clone());
        let mut resources = Vec::new();
        let mut used = PAGE_OVERHEAD;
        for path in paths.iter().take(limit as usize) {
            let row_bytes = path.len().checked_add(ROW_OVERHEAD).ok_or_else(page_full)?;
            let remaining = MAX_PAGE_BYTES
                .checked_sub(used)
                .and_then(|n| n.checked_sub(row_bytes))
                .ok_or_else(page_full)?;
            // Hash the complete bounded source even on metadata-only pages.
            // Text projection is capped BEFORE the Store owns/copies the body.
            let copy_limit = if text {
                remaining.min(RESOURCE_SOURCE_BYTES)
            } else {
                RESOURCE_SOURCE_BYTES
            };
            let source = base
                .resource_bounded(path, copy_limit)
                .map_err(inventory_error)?
                .ok_or_else(|| {
                    ErrorCode::Unavailable.err_with_reason(
                        "resource_inventory_unavailable",
                        "tracked resource source disappeared",
                    )
                })?;
            if source.size > RESOURCE_SOURCE_BYTES as u64 {
                return Err(ErrorCode::Unavailable.err_with_reason(
                    "resource_budget_exceeded",
                    "resource source exceeds the 1 MiB response budget",
                ));
            }
            let Some(source_text) = source.text else {
                if source.size <= copy_limit as u64 {
                    return Err(ErrorCode::Unavailable.err_with_reason(
                        "resource_inventory_unavailable",
                        "bounded resource source is inconsistent",
                    ));
                }
                // Do not consume this path: continuation starts after last EMITTED row.
                break;
            };
            if source_text.len() > copy_limit || source_text.len() as u64 != source.size {
                return Err(ErrorCode::Unavailable.err_with_reason(
                    "resource_inventory_unavailable",
                    "bounded resource source is inconsistent",
                ));
            }
            used = used
                .checked_add(row_bytes)
                .and_then(|n| n.checked_add(if text { source_text.len() } else { 0 }))
                .filter(|n| *n <= MAX_PAGE_BYTES)
                .ok_or_else(page_full)?;
            resources.push(ResourceListEntry {
                path: path.clone(),
                revision: resource_revision(&source_text),
                size: source.size,
                confirmed: true,
                text: text.then_some(source_text),
            });
        }
        let complete = resources.len() == paths.len();
        if !complete && resources.is_empty() {
            return Err(page_full());
        }
        let mut result = ResourceList {
            resources,
            complete,
            cursor: (!complete).then(|| "r1.00000000000000000000000000000000".into()),
        };
        // Conservative admission was before copies; this is the encoding oracle.
        let encoded = mdbn_wire::cbor::encode(&result.to_cbor()).map_err(|_| page_full())?;
        if encoded.len() > MAX_PAGE_BYTES {
            return Err(page_full());
        }
        let after = if complete {
            None
        } else {
            result.resources.last().map(|r| r.path.clone())
        };
        result.cursor = self.finish_resource_page(session, position, after)?;
        Ok(result)
    }

    pub(super) fn read_resource(
        &self,
        session: SessionId,
        path: String,
    ) -> ApiResult<ResourceView> {
        self.require_resource_read(session)?;
        mdbn_core::paths::check_path(&path).map_err(|_| {
            ErrorCode::InvalidRequest.err_with_reason("invalid_path", "invalid resource path")
        })?;
        let base = StoreView::new(&self.store, self.catalog.clone());
        let local = LayerView {
            base: &base,
            layer: &self.layer,
        };
        if !local.catalog().is_resource_path(&path) {
            return Err(ErrorCode::InvalidRequest.err_with_reason(
                "not_a_resource_path",
                "the path is not a definition resource",
            ));
        }
        let source = local.resource(&path);
        // StoreView records read errors; do not turn one into a missing resource.
        if let Some(error) = base.error() {
            return Err(store_err(error));
        }
        let source = source.ok_or_else(|| ErrorCode::NotFound.err("no such resource"))?;
        if source.len() > MAX_RESOURCE_BYTES {
            return Err(ErrorCode::Unavailable.err_with_reason(
                "resource_budget_exceeded",
                "resource source exceeds the 1 MiB response budget",
            ));
        }
        self.require_resource_read(session)?;
        Ok(ResourceView {
            path: path.clone(),
            revision: resource_revision(&source),
            size: source.len() as u64,
            confirmed: !self.layer.resource_known(&path),
            text: source.to_string(),
        })
    }
}
