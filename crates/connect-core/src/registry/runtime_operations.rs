use super::*;

pub(super) struct RuntimeExecution {
    /// Authoritative semantic result. The v0.3 envelope is produced only by
    /// `operation_response_value` at the Connect compatibility boundary.
    pub(super) operation: mdbase::runtime::CanonicalOperationOutcome,
    pub(super) outcome: Option<mdbase::runtime::ExecutionOutcome>,
}

pub(super) fn v03_operation_result(
    operation: &mdbase::runtime::CanonicalOperationOutcome,
) -> mdbase::v03::OperationResult {
    operation.to_v03()
}

pub(super) fn operation_response_value(
    operation: &mdbase::runtime::CanonicalOperationOutcome,
) -> Result<Value, ConnectError> {
    serde_json::to_value(v03_operation_result(operation)).map_err(Into::into)
}

struct ScopedRuntimePlan {
    request: mdbase::runtime::OperationRequest,
    projection: Option<(ContractScope, Option<ContractSelector>)>,
    ensure_result_scope: bool,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ScopedPreflightEvent {
    BeforeRecordRead,
    AfterAuthorization,
}

#[cfg(test)]
type ScopedPreflightHook = Arc<dyn Fn(ScopedPreflightEvent, &str) + Send + Sync>;

#[cfg(test)]
static SCOPED_PREFLIGHT_HOOK: std::sync::Mutex<Option<ScopedPreflightHook>> =
    std::sync::Mutex::new(None);

#[cfg(test)]
pub(super) fn set_scoped_preflight_hook(hook: Option<ScopedPreflightHook>) {
    *SCOPED_PREFLIGHT_HOOK.lock().unwrap() = hook;
}

#[cfg(test)]
fn scoped_preflight_event(event: ScopedPreflightEvent, path: &str) {
    let hook = SCOPED_PREFLIGHT_HOOK.lock().unwrap().clone();
    if let Some(hook) = hook {
        hook(event, path);
    }
}

enum QueryCursorAction<'a> {
    Ordinary,
    Open,
    Page(&'a str),
    Release(&'a str),
}

pub(super) fn operation_context(
    cancellation: &mdbase::OperationCancellation,
) -> mdbase::runtime::OperationContext {
    mdbase::runtime::OperationContext::new(
        cancellation,
        mdbase::runtime::OperationDeadline::after(std::time::Duration::from_secs(24 * 60 * 60)),
    )
}

pub(super) fn execute_runtime_request(
    runtime: &FilesystemRuntime,
    request: &mdbase::runtime::OperationRequest,
    claim: Option<&mdbase::runtime::HostClaimId>,
    context: &mdbase::runtime::OperationContext,
) -> Result<RuntimeExecution, ConnectError> {
    if !request.operation.is_mutation() {
        let outcome = runtime.execute_typed_with_context(request, context)?;
        return Ok(RuntimeExecution {
            operation: outcome.operation.clone(),
            outcome: Some(outcome),
        });
    }
    let generated;
    let claim = match claim {
        Some(claim) => claim,
        None => {
            generated = mdbase::runtime::HostClaimId::generate();
            &generated
        }
    };
    if let Some((commit_id, state)) = runtime.resolve_claim(claim, context)? {
        return resolve_runtime_execution(runtime, claim, commit_id, state, context);
    }
    match runtime.prepare_typed(request, claim, context)? {
        mdbase::runtime::PreparationOutcome::NoMutation(outcome) => Ok(RuntimeExecution {
            operation: outcome.operation.clone(),
            outcome: Some(outcome),
        }),
        mdbase::runtime::PreparationOutcome::Prepared(prepared) => {
            finish_commit_attempt(runtime.commit(&prepared, context)?)
        }
    }
}

pub(super) fn execute_runtime_read(
    executor: &CollectionExecutor,
    request: &mdbase::runtime::OperationRequest,
    input: &Value,
    scope_binding: &str,
    context: &mdbase::runtime::OperationContext,
) -> Result<RuntimeExecution, ConnectError> {
    match query_cursor_action(request.operation, input)? {
        QueryCursorAction::Ordinary => executor.with_foreground(context, |runtime| {
            let outcome = require_runtime(runtime)?.execute_typed_with_context(request, context)?;
            Ok(RuntimeExecution {
                operation: outcome.operation.clone(),
                outcome: Some(outcome),
            })
        }),
        QueryCursorAction::Open => {
            let mut request = request.clone();
            if let Some(input) = request.input.as_object_mut() {
                input.remove("pagination");
                input.remove("cursor");
                input.remove("release_cursor");
                input.remove("snapshot");
            }
            let page = executor.open_read(&request, scope_binding, context)?;
            Ok(RuntimeExecution {
                operation: read_page_operation(page.operation, page.next),
                outcome: None,
            })
        }
        QueryCursorAction::Page(cursor) => {
            let page = executor.read_page(cursor, scope_binding, context)?;
            Ok(RuntimeExecution {
                operation: read_page_operation(page.operation, page.next),
                outcome: None,
            })
        }
        QueryCursorAction::Release(cursor) => {
            executor.release_read(cursor, scope_binding, context)?;
            Ok(RuntimeExecution {
                operation: mdbase::runtime::CanonicalOperationOutcome {
                    valid: true,
                    value: mdbase::runtime::CanonicalOperationValue::WireOnly(
                        mdbase::runtime::WireOnlyOperationValue::Validation(json!({
                            "released": true,
                            "results": [],
                            "meta": {"total_count": 0, "has_more": false}
                        })),
                    ),
                    diagnostics: Vec::new(),
                },
                outcome: None,
            })
        }
    }
}

fn query_cursor_action(
    operation: mdbase::runtime::OperationKind,
    input: &Value,
) -> Result<QueryCursorAction<'_>, ConnectError> {
    if operation != mdbase::runtime::OperationKind::Query {
        return Ok(QueryCursorAction::Ordinary);
    }
    let cursor = input.get("cursor").and_then(Value::as_str);
    let release = input.get("release_cursor").and_then(Value::as_str);
    if cursor.is_some() && release.is_some() {
        return Err(ConnectError::InvalidInput(
            "query cursor and release_cursor are mutually exclusive".to_string(),
        ));
    }
    if let Some(release) = release {
        return Ok(QueryCursorAction::Release(release));
    }
    if let Some(cursor) = cursor {
        return Ok(QueryCursorAction::Page(cursor));
    }
    if input.get("pagination").and_then(Value::as_str) == Some("cursor") {
        return Ok(QueryCursorAction::Open);
    }
    Ok(QueryCursorAction::Ordinary)
}

fn read_page_operation(
    mut operation: mdbase::runtime::CanonicalOperationOutcome,
    next: Option<String>,
) -> mdbase::runtime::CanonicalOperationOutcome {
    if let mdbase::runtime::CanonicalOperationValue::Query(Some(query)) = &mut operation.value {
        if let Some(meta) = query.meta.as_object_mut() {
            match next {
                Some(cursor) => {
                    meta.insert("cursor".to_string(), Value::String(cursor));
                }
                None => {
                    meta.remove("cursor");
                }
            }
        }
    }
    operation
}

pub(super) fn scope_binding(scope: &GrantScope) -> Result<String, ConnectError> {
    let encoded = serde_json::to_vec(scope)?;
    Ok(format!("sha256:{:x}", Sha256::digest(encoded)))
}

fn resolve_runtime_execution(
    runtime: &FilesystemRuntime,
    claim: &mdbase::runtime::HostClaimId,
    commit_id: mdbase::runtime::CommitId,
    mut state: mdbase::runtime::DurableCommitState,
    context: &mdbase::runtime::OperationContext,
) -> Result<RuntimeExecution, ConnectError> {
    loop {
        match state {
            mdbase::runtime::DurableCommitState::Prepared => {
                let prepared = runtime.attach_prepared(claim, context)?.ok_or_else(|| {
                    ConnectError::Provider(mdbase::runtime::ProviderError::Transaction {
                        code: "prepared_claim_missing",
                        message: "durable host claim no longer has its prepared mutation"
                            .to_string(),
                    })
                })?;
                return finish_commit_attempt(runtime.commit(&prepared, context)?);
            }
            mdbase::runtime::DurableCommitState::Committing => {
                context.check()?;
                std::thread::sleep(std::time::Duration::from_millis(10));
                state = runtime
                    .resolve_commit(&commit_id, context)?
                    .ok_or_else(|| {
                        ConnectError::Provider(mdbase::runtime::ProviderError::Transaction {
                            code: "commit_resolution_missing",
                            message: "durable commit resolution disappeared".to_string(),
                        })
                    })?;
            }
            mdbase::runtime::DurableCommitState::Committed { outcome } => {
                return Ok(RuntimeExecution {
                    operation: outcome.operation.clone(),
                    outcome: Some(outcome),
                });
            }
            mdbase::runtime::DurableCommitState::RejectedBeforeCommit { rejection } => {
                return Ok(RuntimeExecution {
                    operation: rejection.operation,
                    outcome: None,
                });
            }
            mdbase::runtime::DurableCommitState::CancelledBeforeCommit => {
                return Err(ConnectError::Provider(
                    mdbase::runtime::ProviderError::Transaction {
                        code: "commit_cancelled_before_start",
                        message: "prepared mutation was durably cancelled before commit"
                            .to_string(),
                    },
                ));
            }
            mdbase::runtime::DurableCommitState::NeedsManualRecovery => {
                return Err(manual_recovery_error(&commit_id));
            }
        }
    }
}

fn finish_commit_attempt(
    attempt: mdbase::runtime::CommitAttempt,
) -> Result<RuntimeExecution, ConnectError> {
    match attempt {
        mdbase::runtime::CommitAttempt::Committed(outcome) => Ok(RuntimeExecution {
            operation: outcome.operation.clone(),
            outcome: Some(outcome),
        }),
        mdbase::runtime::CommitAttempt::RejectedBeforeCommit { rejection } => {
            Ok(RuntimeExecution {
                operation: rejection.operation,
                outcome: None,
            })
        }
        mdbase::runtime::CommitAttempt::SettlementPending { commit_id } => Err(
            ConnectError::Provider(mdbase::runtime::ProviderError::Transaction {
                code: "outcome_unknown",
                message: format!(
                    "mutation settlement is pending for commit {}",
                    commit_id.as_str()
                ),
            }),
        ),
        mdbase::runtime::CommitAttempt::NeedsManualRecovery { commit_id } => {
            Err(manual_recovery_error(&commit_id))
        }
    }
}

fn bind_preflight_revision(
    request: &mut mdbase::runtime::OperationRequest,
    revision: &mdbase::api::Revision,
) -> Result<(), ConnectError> {
    let input = request.input.as_object_mut().ok_or_else(|| {
        ConnectError::InvalidInput("The scoped mutation input must be an object.".to_string())
    })?;
    if !input.contains_key("if_revision") {
        input.insert("if_revision".to_string(), serde_json::to_value(revision)?);
    }
    Ok(())
}

fn manual_recovery_error(commit_id: &mdbase::runtime::CommitId) -> ConnectError {
    ConnectError::Provider(mdbase::runtime::ProviderError::Transaction {
        code: "manual_recovery_required",
        message: format!(
            "mutation requires manual recovery for commit {}",
            commit_id.as_str()
        ),
    })
}

impl CollectionRegistry {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn scoped_runtime_operation(
        &self,
        registered: &CollectionSummary,
        executor: &CollectionExecutor,
        operation: &str,
        input: &Value,
        scope: &GrantScope,
        cancellation: &mdbase::OperationCancellation,
        claim: Option<&mdbase::runtime::HostClaimId>,
    ) -> Result<Value, ConnectError> {
        let context = operation_context(cancellation);
        let provider = executor.provider();
        let sync_store = crate::LocalSyncStore::for_registry(self);
        sync_store.assert_authority_available(registered.id)?;

        if matches!(operation, "describe" | "changes") {
            return executor.with_foreground(&context, |_| {
                provider.with_collection_read(|collection| {
                    self.scoped_operation_loaded(
                        registered,
                        collection,
                        operation,
                        input,
                        scope,
                        cancellation,
                    )
                })
            });
        }

        // Mapping, selector/path checks, and control-field authorization happen
        // before a record read or acquisition of the mutation gate.
        let mut plan = provider.with_collection_read(|collection| {
            self.scoped_runtime_plan(registered, collection, operation, input, scope)
        })?;
        let serialized_scoped_preflight =
            plan.projection.is_some() && matches!(operation, "update" | "delete" | "rename");
        let execution = if plan.request.operation.is_mutation() {
            sync_store.assert_mutation_allowed(registered.id)?;
            executor.with_mutation(&context, |runtime| {
                let runtime = require_runtime(runtime)?;
                let local_claim = (serialized_scoped_preflight && claim.is_none())
                    .then(mdbase::runtime::HostClaimId::generate);
                let execution_claim = claim.or(local_claim.as_ref());
                if serialized_scoped_preflight {
                    let (resolved_scope, selector) = plan
                        .projection
                        .as_ref()
                        .expect("scoped preflight has a projection");
                    let path = match operation {
                        "update" | "delete" => required_string(&plan.request.input, "path")?,
                        "rename" => required_string(&plan.request.input, "from")?,
                        _ => unreachable!(),
                    };
                    #[cfg(test)]
                    scoped_preflight_event(ScopedPreflightEvent::BeforeRecordRead, path);
                    let preflight = runtime.execute_typed_with_context(
                        &runtime_operation_request("read", &json!({"path": path}))?,
                        &context,
                    )?;
                    let current = operation_record(&preflight.operation).ok_or_else(|| {
                        ConnectError::AccessDenied(
                            "The connector could not verify the record's type scope.".to_string(),
                        )
                    })?;
                    provider.with_collection_read(|collection| {
                        authorize_scoped_mutation_preflight(
                            collection,
                            operation,
                            &plan.request.input,
                            resolved_scope,
                            selector.as_ref(),
                            current,
                        )
                    })?;
                    #[cfg(test)]
                    scoped_preflight_event(ScopedPreflightEvent::AfterAuthorization, path);
                    bind_preflight_revision(&mut plan.request, &current.revision)?;
                }
                let execution =
                    execute_runtime_request(runtime, &plan.request, execution_claim, &context)?;
                if let Some(local_claim) = local_claim.as_ref() {
                    if let Some((commit_id, _)) = runtime.resolve_claim(local_claim, &context)? {
                        runtime.ack_commit_resolution(&commit_id, &context)?;
                    }
                }
                Ok(execution)
            })?
        } else {
            execute_runtime_read(
                executor,
                &plan.request,
                input,
                &scope_binding(scope)?,
                &context,
            )?
        };
        debug_assert!(execution
            .outcome
            .as_ref()
            .is_none_or(|outcome| outcome.operation == execution.operation));
        let Some((resolved_scope, selector)) = plan.projection else {
            return operation_response_value(&execution.operation);
        };
        if plan.ensure_result_scope && input.get("release_cursor").is_none() {
            ensure_operation_in_scope(&execution.operation, &resolved_scope.allowed_types)?;
        }
        // Contract authorization has observed the authoritative typed records.
        // Projection below is the final compatibility serialization step.
        let result = operation_response_value(&execution.operation)?;
        resolved_scope
            .project_result(result, selector.as_ref())
            .map_err(contract_scope_error)
    }

    pub fn scoped_operation_with_host_claim(
        &self,
        id: Uuid,
        operation: &str,
        input: &Value,
        scope: &GrantScope,
        claim: &mdbase::runtime::HostClaimId,
        cancellation: &mdbase::OperationCancellation,
    ) -> Result<Value, ConnectError> {
        let registered = self.get(id)?;
        if !registered.enabled {
            return Err(ConnectError::AccessDenied(
                "This collection is disabled on its computer.".to_string(),
            ));
        }
        if !registered.spec_version.starts_with("0.3") {
            return Err(ConnectError::UnsupportedOperation(format!(
                "durable runtime claims require a v0.3 collection ({operation})"
            )));
        }
        let executor = self.executor_for(&registered)?;
        self.scoped_runtime_operation(
            &registered,
            &executor,
            operation,
            input,
            scope,
            cancellation,
            Some(claim),
        )
    }

    /// Cancel only while the provider still durably owns a prepared mutation.
    /// `false` means commit/rejection settlement already owns the outcome.
    pub fn cancel_runtime_host_claim(
        &self,
        id: Uuid,
        claim: &mdbase::runtime::HostClaimId,
    ) -> Result<bool, ConnectError> {
        let registered = self.get(id)?;
        let executor = self.executor_for(&registered)?;
        let context = operation_context(&mdbase::OperationCancellation::new());
        executor.with_mutation(&context, |runtime| {
            let runtime = require_runtime(runtime)?;
            let Some((_, state)) = runtime.resolve_claim(claim, &context)? else {
                return Ok(true);
            };
            match state {
                mdbase::runtime::DurableCommitState::CancelledBeforeCommit => return Ok(true),
                mdbase::runtime::DurableCommitState::Prepared => {}
                mdbase::runtime::DurableCommitState::Committing
                | mdbase::runtime::DurableCommitState::Committed { .. }
                | mdbase::runtime::DurableCommitState::RejectedBeforeCommit { .. }
                | mdbase::runtime::DurableCommitState::NeedsManualRecovery => return Ok(false),
            }
            let Some(prepared) = runtime.attach_prepared(claim, &context)? else {
                return Ok(true);
            };
            Ok(matches!(
                runtime.cancel(&prepared, &context)?,
                mdbase::runtime::CancelOutcome::CancelledBeforeCommit
            ))
        })
    }

    pub fn runtime_host_claim_evidence(
        &self,
        id: Uuid,
        claim: &mdbase::runtime::HostClaimId,
    ) -> Result<Option<Value>, ConnectError> {
        let registered = self.get(id)?;
        let executor = self.executor_for(&registered)?;
        let context = operation_context(&mdbase::OperationCancellation::new());
        executor.with_foreground(&context, |runtime| {
            let runtime = require_runtime(runtime)?;
            let Some((commit_id, state)) = runtime.resolve_claim(claim, &context)? else {
                return Ok(None);
            };
            let (state_name, generation) = match state {
                mdbase::runtime::DurableCommitState::Prepared => ("prepared", None),
                mdbase::runtime::DurableCommitState::Committing => ("committing", None),
                mdbase::runtime::DurableCommitState::Committed { outcome } => (
                    "committed",
                    Some(json!({
                        "epoch": outcome.generation.runtime_epoch(),
                        "sequence": outcome.generation.sequence(),
                    })),
                ),
                mdbase::runtime::DurableCommitState::RejectedBeforeCommit { .. } => {
                    ("rejected_before_commit", None)
                }
                mdbase::runtime::DurableCommitState::CancelledBeforeCommit => {
                    ("cancelled_before_commit", None)
                }
                mdbase::runtime::DurableCommitState::NeedsManualRecovery => {
                    ("needs_manual_recovery", None)
                }
            };
            Ok(Some(json!({
                "provider_state": state_name,
                "commit_id": commit_id.as_str(),
                "generation": generation,
            })))
        })
    }

    pub fn acknowledge_runtime_host_claim(
        &self,
        id: Uuid,
        claim: &mdbase::runtime::HostClaimId,
    ) -> Result<(), ConnectError> {
        let registered = self.get(id)?;
        let executor = self.executor_for(&registered)?;
        let context = operation_context(&mdbase::OperationCancellation::new());
        executor.with_background(&context, |runtime| {
            let runtime = require_runtime(runtime)?;
            if let Some((commit_id, _)) = runtime.resolve_claim(claim, &context)? {
                runtime.ack_commit_resolution(&commit_id, &context)?;
            }
            Ok(())
        })
    }

    fn scoped_runtime_plan(
        &self,
        registered: &CollectionSummary,
        collection: &Collection,
        operation: &str,
        input: &Value,
        scope: &GrantScope,
    ) -> Result<ScopedRuntimePlan, ConnectError> {
        let Some(resolved_scope) = self.resolve_operation_contract_scope_loaded(
            registered, collection, scope, operation, input,
        )?
        else {
            return Ok(ScopedRuntimePlan {
                request: runtime_operation_request(operation, input)?,
                projection: None,
                ensure_result_scope: false,
            });
        };
        let allowed_types = &resolved_scope.allowed_types;
        let (runtime_input, selector, ensure_result_scope) = match operation {
            "query" => {
                let (input, selector) = resolved_scope
                    .query_input(input)
                    .map_err(contract_scope_error)?;
                (input, selector, true)
            }
            "read" => {
                let (input, selector) = resolved_scope
                    .read_input(input)
                    .map_err(contract_scope_error)?;
                (input, selector, true)
            }
            "create" => {
                let (input, selector) = resolved_scope
                    .map_write_input(input, true)
                    .map_err(contract_scope_error)?;
                let frontmatter = input
                    .get("frontmatter")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let path = input.get("path").and_then(Value::as_str);
                let mut prospective_types =
                    collection.determine_types_for_path(&frontmatter, path);
                if let Some(requested_type) = input.get("type").and_then(Value::as_str) {
                    prospective_types.push(requested_type.to_lowercase());
                }
                ensure_types_in_scope(&prospective_types, allowed_types)?;
                ensure_no_new_out_of_scope_types(
                    &prospective_types,
                    &BTreeSet::new(),
                    allowed_types,
                )?;
                (input, Some(selector), true)
            }
            "update" => {
                let (input, selector) = resolved_scope
                    .map_write_input(input, false)
                    .map_err(contract_scope_error)?;
                required_string(&input, "path")?;
                (input, Some(selector), false)
            }
            "delete" => {
                let (mut input, selector) = resolved_scope
                    .identity_input(input)
                    .map_err(contract_scope_error)?;
                required_string(&input, "path")?;
                if let Some(object) = input.as_object_mut() {
                    object.insert("check_backlinks".to_string(), Value::Bool(false));
                }
                (input, selector, false)
            }
            "rename" => {
                let (mut input, selector) = resolved_scope
                    .identity_input(input)
                    .map_err(contract_scope_error)?;
                required_string(&input, "from")?;
                required_string(&input, "to")?;
                if input.get("update_refs").and_then(Value::as_bool) == Some(true) {
                    return Err(ConnectError::AccessDenied(
                        "Reference updates can affect records outside this application's scope."
                            .to_string(),
                    ));
                }
                if let Some(object) = input.as_object_mut() {
                    object.insert("update_refs".to_string(), Value::Bool(false));
                }
                (input, selector, false)
            }
            "list_views"
            | "execute_view"
            | "read_view_source"
            | "create_view_source"
            | "update_view_source"
            | "delete_view_source" => {
                return Err(ConnectError::AccessDenied(
                    "Saved views require full collection access because their source may select any record type."
                        .to_string(),
                ))
            }
            "validate" => {
                return Err(ConnectError::AccessDenied(
                    "Collection-wide validation is unavailable to a contract-scoped application."
                        .to_string(),
                ))
            }
            "batch" => {
                return Err(ConnectError::AccessDenied(
                    "Batch operations require full collection access.".to_string(),
                ))
            }
            "list_types"
            | "read_type"
            | "create_type"
            | "update_type"
            | "assess_type_pack"
            | "apply_type_pack"
            | "assess_collection_setup"
            | "apply_collection_setup" => {
                return Err(ConnectError::AccessDenied(
                    "Collection schemas can only be managed by an application with full collection access."
                        .to_string(),
                ))
            }
            other => return Err(ConnectError::UnsupportedOperation(other.to_string())),
        };
        validate_scoped_mutation_request(operation, &runtime_input)?;
        Ok(ScopedRuntimePlan {
            request: runtime_operation_request(operation, &runtime_input)?,
            projection: Some((resolved_scope, selector)),
            ensure_result_scope,
        })
    }

    pub fn sync_operation_synchronized(
        &self,
        id: Uuid,
        input: &Value,
        replica: crate::LocalReplica,
        scope: &GrantScope,
        synchronize: impl FnOnce() -> Result<(), ConnectError>,
    ) -> Result<Value, ConnectError> {
        self.sync_operation_synchronized_cancellable(
            id,
            input,
            replica,
            scope,
            &mdbase::OperationCancellation::new(),
            synchronize,
        )
    }

    pub fn sync_operation_synchronized_cancellable(
        &self,
        id: Uuid,
        input: &Value,
        mut replica: crate::LocalReplica,
        scope: &GrantScope,
        cancellation: &mdbase::OperationCancellation,
        synchronize: impl FnOnce() -> Result<(), ConnectError>,
    ) -> Result<Value, ConnectError> {
        cancellation
            .check()
            .map_err(|_| ConnectError::OperationCancelled)?;
        if scope.access == mdbase_connect_protocol::ApplicationAccess::Contract {
            return Err(ConnectError::AccessDenied(
                "Contract-scoped replicas are not available because the sync document format contains whole records. Use projected read/query/create/update operations, or request explicit full-collection access."
                    .to_string(),
            ));
        }
        let registered = self.get(id)?;
        if !registered.enabled {
            return Err(ConnectError::AccessDenied(
                "This collection is disabled on its computer.".to_string(),
            ));
        }
        let action = input.get("action").and_then(Value::as_str).ok_or_else(|| {
            ConnectError::AccessDenied("Sync request action is required.".to_string())
        })?;
        let store = crate::LocalSyncStore::for_registry(self);
        if action == "mutate" {
            store.assert_mutation_allowed(id)?;
        } else {
            store.assert_authority_available(id)?;
        }
        let executor = self.executor_for(&registered)?;
        let provider = executor.provider();
        let context = operation_context(cancellation);
        if action == "mutate" {
            return executor.with_background(&context, |_| {
                cancellation
                    .check()
                    .map_err(|_| ConnectError::OperationCancelled)?;
                store.assert_mutation_allowed(id)?;
                let before = provider.snapshot_with_context(&context)?;
                store.reconcile(id, &before, &HashMap::new())?;
                store.ensure_replica(id, &replica)?;
                let mutation: SyncMutation =
                    serde_json::from_value(input.get("mutation").cloned().ok_or_else(|| {
                        ConnectError::AccessDenied("Sync mutation body is required.".to_string())
                    })?)?;
                let plan = store.plan_mutation(id, replica.id, &mutation)?;
                let crate::local_sync::MutationPlan::Apply {
                    operation,
                    input: operation_input,
                    preferred_path,
                } = plan
                else {
                    let crate::local_sync::MutationPlan::Return(receipt) = plan else {
                        unreachable!()
                    };
                    store.store_receipt(replica.id, &receipt)?;
                    return serde_json::to_value(receipt).map_err(Into::into);
                };
                let result = self.scoped_runtime_operation(
                    &registered,
                    &executor,
                    operation,
                    &operation_input,
                    scope,
                    cancellation,
                    None,
                )?;
                if result.get("valid").and_then(Value::as_bool) != Some(true) {
                    let receipt = SyncMutationReceipt::Rejected {
                        mutation_id: mutation.mutation_id,
                        error: mdbase_connect_protocol::SyncMutationError {
                            code: result
                                .pointer("/diagnostics/0/code")
                                .and_then(Value::as_str)
                                .unwrap_or("mutation_rejected")
                                .to_string(),
                            message: error_message(&result, "The mutation was rejected."),
                        },
                    };
                    store.store_receipt(replica.id, &receipt)?;
                    return serde_json::to_value(receipt).map_err(Into::into);
                }
                synchronize()?;
                let after = provider.snapshot_with_context(&context)?;
                let preferred = preferred_path
                    .map(|path| HashMap::from([(path, mutation.record_id)]))
                    .unwrap_or_default();
                store.reconcile(id, &after, &preferred)?;
                let receipt = store.applied_receipt(id, &mutation)?;
                store.store_receipt(replica.id, &receipt)?;
                serde_json::to_value(receipt).map_err(Into::into)
            });
        }
        let execute = |collection: &Collection| -> Result<Value, ConnectError> {
            cancellation
                .check()
                .map_err(|_| ConnectError::OperationCancelled)?;
            store.assert_authority_available(id)?;
            replica.allowed_types = self
                .resolve_scope_types_loaded(&registered, collection, scope)?
                .unwrap_or_default();
            let snapshot = collection.snapshot()?;
            cancellation
                .check()
                .map_err(|_| ConnectError::OperationCancelled)?;
            store.reconcile(id, &snapshot, &HashMap::new())?;
            let files = self.reconcile_files_loaded(&registered, collection, &snapshot)?;
            cancellation
                .check()
                .map_err(|_| ConnectError::OperationCancelled)?;
            let result = match action {
                "open_session" => {
                    let description = self.describe_loaded(&registered, collection)?;
                    let resources = sync_resources(&snapshot, description, &replica.allowed_types);
                    serde_json::to_value(
                        store.open_session(id, &replica, resources, &snapshot, &files)?,
                    )
                    .map_err(Into::into)
                }
                "snapshot" => {
                    store.ensure_replica(id, &replica)?;
                    let snapshot_id = required_uuid(input, "snapshot_id")?;
                    let page = input.get("page").and_then(Value::as_str);
                    serde_json::to_value(store.snapshot(id, replica.id, snapshot_id, page)?)
                        .map_err(Into::into)
                }
                "file_snapshot" => {
                    store.ensure_replica(id, &replica)?;
                    let snapshot_id = required_uuid(input, "snapshot_id")?;
                    let page = input.get("page").and_then(Value::as_str);
                    serde_json::to_value(store.file_snapshot(id, replica.id, snapshot_id, page)?)
                        .map_err(Into::into)
                }
                "changes" => {
                    store.ensure_replica(id, &replica)?;
                    let after = input.get("after").and_then(Value::as_u64).ok_or_else(|| {
                        ConnectError::AccessDenied("Sync changes cursor is required.".to_string())
                    })?;
                    let limit = input
                        .get("limit")
                        .and_then(Value::as_u64)
                        .unwrap_or(200)
                        .clamp(1, 500) as usize;
                    serde_json::to_value(store.changes(id, replica.id, after, limit)?)
                        .map_err(Into::into)
                }
                other => Err(ConnectError::InvalidInput(format!(
                    "Unsupported sync action: {other}"
                ))),
            };
            if result.is_ok() {
                cancellation
                    .check()
                    .map_err(|_| ConnectError::OperationCancelled)?;
            }
            result
        };
        executor.with_background(&context, |_| provider.with_collection_read(execute))
    }
}

pub(super) fn require_runtime(
    runtime: Option<&FilesystemRuntime>,
) -> Result<&FilesystemRuntime, ConnectError> {
    runtime.ok_or_else(|| {
        ConnectError::UnsupportedOperation(
            "the legacy collection has no coordinated runtime".to_string(),
        )
    })
}

#[cfg(test)]
mod typed_boundary_tests {
    use super::*;

    #[test]
    fn canonical_query_serializes_to_the_exact_existing_connect_envelope() {
        let operation = mdbase::runtime::CanonicalOperationOutcome {
            valid: true,
            value: mdbase::runtime::CanonicalOperationValue::Query(Some(
                mdbase::runtime::CanonicalQueryValue {
                    records: vec![mdbase::api::ProjectedValue::new(json!({
                        "path": "tasks/one.md",
                        "types": ["task"]
                    }))],
                    total_count: Some(1),
                    has_more: false,
                    meta: mdbase::api::QueryMetadata::new(json!({"source": "index"})),
                    embedded_diagnostics: Vec::new(),
                },
            )),
            diagnostics: Vec::new(),
        };

        assert_eq!(
            operation_response_value(&operation).unwrap(),
            json!({
                "valid": true,
                "result": {
                    "results": [{"path": "tasks/one.md", "types": ["task"]}],
                    "meta": {"source": "index", "total_count": 1, "has_more": false},
                    "diagnostics": []
                },
                "diagnostics": []
            })
        );
    }
}
