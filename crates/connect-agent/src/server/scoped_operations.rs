use super::*;

impl AgentState {
    pub(super) fn execute_local_operation(
        &self,
        collection_id: uuid::Uuid,
        operation: &str,
        input: &serde_json::Value,
        cancellation: &mdbase::OperationCancellation,
    ) -> Result<serde_json::Value, ConnectError> {
        let started = Instant::now();
        let synchronize_us = std::cell::Cell::new(0_u64);
        let result = self.registry.operation_synchronized_cancellable(
            collection_id,
            operation,
            input,
            cancellation,
            || {
                let synchronize_started = Instant::now();
                let finalized = self.watcher.finalize(collection_id);
                synchronize_us.set(elapsed_us(synchronize_started));
                finalized
            },
        );
        profile_operation("control", operation, started, synchronize_us.get(), &result);
        result
    }

    pub(super) fn scoped_operation(
        &self,
        transport: &'static str,
        collection_id: uuid::Uuid,
        operation: &str,
        input: &serde_json::Value,
        grant: &mdbase_connect_protocol::GrantSummary,
    ) -> Result<serde_json::Value, ConnectError> {
        self.scoped_operation_cancellable(
            transport,
            collection_id,
            operation,
            input,
            grant,
            &mdbase::OperationCancellation::new(),
        )
    }

    pub(super) fn scoped_operation_cancellable(
        &self,
        transport: &'static str,
        collection_id: uuid::Uuid,
        operation: &str,
        input: &serde_json::Value,
        grant: &mdbase_connect_protocol::GrantSummary,
        cancellation: &mdbase::OperationCancellation,
    ) -> Result<serde_json::Value, ConnectError> {
        let started = Instant::now();
        let synchronize_us = std::cell::Cell::new(0_u64);
        if matches!(
            operation,
            "assess_collection_setup" | "apply_collection_setup"
        ) {
            setup_binding::validate_collection_setup_binding(input, grant)?;
        }
        if matches!(
            operation,
            "list_timers" | "put_timer" | "cancel_timer" | "reconcile_timers"
        ) {
            let result = self
                .runtime_timers
                .as_ref()
                .ok_or_else(|| {
                    ConnectError::TimerRuntime("The timer authority is unavailable.".to_string())
                })
                .and_then(|timers| {
                    timers
                        .operation(collection_id, grant.clone(), operation, input.clone())
                        .map_err(|error| {
                            if error.internal {
                                ConnectError::TimerRuntime(error.message)
                            } else {
                                ConnectError::InvalidTimer(error.message)
                            }
                        })
                });
            profile_operation(transport, operation, started, 0, &result);
            return result;
        }
        if operation == "sync" {
            let mode = if grant.operations.iter().any(|operation| {
                matches!(
                    operation.as_str(),
                    "create" | "update" | "delete" | "rename"
                )
            }) {
                SyncReplicaMode::ReadWrite
            } else {
                SyncReplicaMode::ReadOnly
            };
            let result = self.registry.sync_operation_synchronized_cancellable(
                collection_id,
                input,
                LocalReplica {
                    id: grant.id,
                    name: grant.application_name.clone(),
                    mode,
                    allowed_types: Default::default(),
                },
                &grant.scope,
                cancellation,
                || {
                    let synchronize_started = Instant::now();
                    let finalized = self.watcher.finalize(collection_id);
                    synchronize_us.set(elapsed_us(synchronize_started));
                    finalized
                },
            );
            profile_operation(transport, operation, started, synchronize_us.get(), &result);
            return result;
        }
        let result = self.registry.scoped_operation_synchronized_cancellable(
            collection_id,
            operation,
            input,
            &grant.scope,
            cancellation,
            || {
                let synchronize_started = Instant::now();
                let finalized = self.watcher.finalize(collection_id);
                synchronize_us.set(elapsed_us(synchronize_started));
                finalized
            },
        );
        profile_operation(transport, operation, started, synchronize_us.get(), &result);
        result
    }
}
