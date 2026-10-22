//! Contract-scoped single-record reads and write mapping over the local view.
use super::super::Replica;
use super::super::submit::{rejection_problem, store_err};
use crate::api::Target;
use crate::api::{
    ApiError, ApiResult, ContractRecordView, ContractSelection, ContractWritePlan,
    ContractWriteRequest, ErrorCode, SessionId,
};
use crate::layer::LayerView;
use crate::plan::StoreView;
use crate::{Store, convert};
use mdbn_core::plan::contract_records::{self, ContractSelector, RecordSource};
use mdbn_core::state::{StateView, StoredRecord};
use mdbn_wire::common::Uuid;
use mdbn_wire::intent::BaseField;

/// Most contract field removals one write may name.
const MAX_UNSET: usize = 256;

fn selector(s: ContractSelection) -> ApiResult<ContractSelector> {
    if s.contract.is_empty()
        || s.contract.len() > 1024
        || s.version.len() > 128
        || s.type_name
            .as_ref()
            .is_some_and(|t| t.is_empty() || t.len() > 1024)
    {
        return Err(ErrorCode::InvalidRequest.err("Invalid contract selection."));
    }
    Ok(ContractSelector {
        id: s.contract,
        version: s.version,
        type_name: s.type_name,
    })
}

fn rejected(r: mdbn_core::plan::Rejection) -> ApiError {
    ApiError::from(rejection_problem(&r))
}

impl<S: Store> Replica<S> {
    /// The live record at `target` in the local view.
    fn contract_target(
        &self,
        view: &dyn StateView,
        target: &Target,
    ) -> ApiResult<(Uuid, StoredRecord)> {
        let not_found = || ErrorCode::NotFound.err("no such record");
        let id = self.resolve_target(view, target).ok_or_else(not_found)?;
        let record = view.record(&convert::uuid(&id)).ok_or_else(not_found)?;
        Ok((id, record))
    }

    pub(super) fn contract_record_view(
        &mut self,
        session: SessionId,
        target: Target,
        selection: ContractSelection,
    ) -> ApiResult<ContractRecordView> {
        self.require(session, crate::policy::capability::READ)?;
        let selector = selector(selection)?;
        let base = StoreView::new(&self.store, self.catalog.clone());
        let local = LayerView {
            base: &base,
            layer: &self.layer,
        };
        let found = self.contract_target(&local, &target);
        let catalog = local.catalog();
        if let Some(e) = base.error() {
            return Err(store_err(e));
        }
        let (id, record) = found?;
        let view = contract_records::contract_record(
            &catalog,
            &selector,
            RecordSource {
                path: &record.path,
                source: &record.source,
            },
        )
        .map_err(rejected)?;
        Ok(ContractRecordView {
            id,
            path: record.path.clone(),
            revision: mdbn_wire::hash::sha256(record.source.as_bytes()),
            type_name: view.type_name,
            fields: convert::wmap(&view.fields),
            contract_digest: convert::whash(&view.contract_digest),
            implementation_digest: convert::whash(&view.implementation_digest),
        })
    }

    pub(super) fn contract_write_plan(
        &mut self,
        session: SessionId,
        request: ContractWriteRequest,
    ) -> ApiResult<ContractWritePlan> {
        self.require(session, crate::policy::capability::READ)?;
        let selector = selector(request.selection)?;
        if request.unset.len() > MAX_UNSET {
            return Err(ErrorCode::TooLarge.err("Too many contract field removals."));
        }
        let fields = match convert::value(&request.fields) {
            Ok(mdbn_core::value::Value::Map(m)) => m,
            _ => return Err(ErrorCode::InvalidRequest.err("Contract fields must be a map.")),
        };
        let base = StoreView::new(&self.store, self.catalog.clone());
        let local = LayerView {
            base: &base,
            layer: &self.layer,
        };
        let found = request
            .target
            .as_ref()
            .map(|t| self.contract_target(&local, t))
            .transpose();
        let catalog = local.catalog();
        if let Some(e) = base.error() {
            return Err(store_err(e));
        }
        let found = found?;
        let write = contract_records::contract_write_promoting(
            &catalog,
            &selector,
            found.as_ref().map(|(_, r)| RecordSource {
                path: &r.path,
                source: &r.source,
            }),
            &fields,
            &request.unset,
            request.promote,
        )
        .map_err(rejected)?;
        Ok(ContractWritePlan {
            type_name: write.type_name,
            patch: convert::wmap(&write.patch),
            unset: write.unset,
            base: write
                .base
                .iter()
                .map(|(key, observed)| BaseField {
                    key: key.clone(),
                    observed: observed.as_ref().map(convert::wvalue),
                })
                .collect::<Vec<_>>(),
            contract_digest: convert::whash(&write.contract_digest),
            implementation_digest: convert::whash(&write.implementation_digest),
            record: found.map(|(id, r)| {
                let revision = mdbn_wire::hash::sha256(r.source.as_bytes());
                (id, r.path, revision)
            }),
        })
    }
}
