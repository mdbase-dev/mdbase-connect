use crate::{ApplicationFileRequirement, FileAction};
use crate::{ConnectOperationOutcome, ConnectProblem};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const OPERATION_TRANSPORT_PROTOCOL_VERSION: u32 = 3;
pub const LEGACY_OPERATION_TRANSPORT_PROTOCOL_VERSION: u32 = 2;
pub const SUPPORTED_OPERATION_TRANSPORT_PROTOCOL_VERSIONS: &[u32] = &[
    OPERATION_TRANSPORT_PROTOCOL_VERSION,
    LEGACY_OPERATION_TRANSPORT_PROTOCOL_VERSION,
];
pub const AUTHORIZATION_BINDING_PROTOCOL_VERSION: u32 = 5;
pub const LEGACY_AUTHORIZATION_BINDING_PROTOCOL_VERSION: u32 = 4;
pub const SUPPORTED_AUTHORIZATION_BINDING_PROTOCOL_VERSIONS: &[u32] = &[
    AUTHORIZATION_BINDING_PROTOCOL_VERSION,
    LEGACY_AUTHORIZATION_BINDING_PROTOCOL_VERSION,
];
pub const SEMANTIC_CAPABILITY_CONTRACT_VERSION: u32 = 1;
pub const DURABLE_MUTATION_CONTRACT_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectContractRequirements {
    pub operation_transport: u32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub operation_transport_recovery: Vec<u32>,
    pub authorization_binding: u32,
    pub semantic_capabilities: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub durable_mutation: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectContractSupport {
    pub operation_transport: Vec<u32>,
    pub authorization_binding: Vec<u32>,
    pub semantic_capabilities: Vec<u32>,
    pub durable_mutation: Vec<u32>,
}

impl Default for ConnectContractSupport {
    fn default() -> Self {
        Self {
            operation_transport: SUPPORTED_OPERATION_TRANSPORT_PROTOCOL_VERSIONS.to_vec(),
            authorization_binding: SUPPORTED_AUTHORIZATION_BINDING_PROTOCOL_VERSIONS.to_vec(),
            semantic_capabilities: vec![SEMANTIC_CAPABILITY_CONTRACT_VERSION],
            durable_mutation: vec![DURABLE_MUTATION_CONTRACT_VERSION],
        }
    }
}

impl ConnectContractSupport {
    pub fn supports_current(&self) -> bool {
        self.operation_transport
            .contains(&OPERATION_TRANSPORT_PROTOCOL_VERSION)
            && self
                .authorization_binding
                .contains(&AUTHORIZATION_BINDING_PROTOCOL_VERSION)
            && self
                .semantic_capabilities
                .contains(&SEMANTIC_CAPABILITY_CONTRACT_VERSION)
            && self
                .durable_mutation
                .contains(&DURABLE_MUTATION_CONTRACT_VERSION)
    }
}

impl ConnectContractRequirements {
    pub fn current(requires_durable_mutation: bool) -> Self {
        Self {
            operation_transport: OPERATION_TRANSPORT_PROTOCOL_VERSION,
            operation_transport_recovery: Vec::new(),
            authorization_binding: AUTHORIZATION_BINDING_PROTOCOL_VERSION,
            semantic_capabilities: SEMANTIC_CAPABILITY_CONTRACT_VERSION,
            durable_mutation: requires_durable_mutation
                .then_some(DURABLE_MUTATION_CONTRACT_VERSION),
        }
    }

    pub fn with_operation_transport_recovery(mut self, versions: Vec<u32>) -> Self {
        self.operation_transport_recovery = versions;
        self.operation_transport_recovery
            .sort_unstable_by(|a, b| b.cmp(a));
        self.operation_transport_recovery.dedup();
        self.operation_transport_recovery
            .retain(|version| *version != self.operation_transport);
        self
    }

    pub fn valid_for_authorization(&self, requires_durable_mutation: bool) -> bool {
        SUPPORTED_OPERATION_TRANSPORT_PROTOCOL_VERSIONS.contains(&self.operation_transport)
            && SUPPORTED_AUTHORIZATION_BINDING_PROTOCOL_VERSIONS
                .contains(&self.authorization_binding)
            && self.semantic_capabilities == SEMANTIC_CAPABILITY_CONTRACT_VERSION
            && (if requires_durable_mutation {
                self.durable_mutation == Some(DURABLE_MUTATION_CONTRACT_VERSION)
            } else {
                self.durable_mutation.is_none()
            })
            && (self.authorization_binding != AUTHORIZATION_BINDING_PROTOCOL_VERSION
                || self.operation_transport == OPERATION_TRANSPORT_PROTOCOL_VERSION)
            && self.operation_transport_recovery.iter().all(|version| {
                *version != self.operation_transport
                    && SUPPORTED_OPERATION_TRANSPORT_PROTOCOL_VERSIONS.contains(version)
            })
            && self
                .operation_transport_recovery
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                == self.operation_transport_recovery.len()
            && (self.authorization_binding != LEGACY_AUTHORIZATION_BINDING_PROTOCOL_VERSION
                || self.operation_transport_recovery.is_empty())
            && (self.operation_transport_recovery.is_empty() || requires_durable_mutation)
    }

    pub fn permits_operation_transport(&self, version: u32, recovery_only: bool) -> bool {
        self.operation_transport == version
            || (recovery_only && self.operation_transport_recovery.contains(&version))
    }

    pub fn mismatch_problem(
        &self,
        operation: &str,
        input: &Value,
        peer: &str,
    ) -> Option<ConnectProblem> {
        let supported = ConnectContractSupport::default();
        let checks = [
            (
                "operation_transport",
                "transport_protocol_incompatible",
                self.operation_transport,
                supported.operation_transport.as_slice(),
            ),
            (
                "authorization_binding",
                "authorization_binding_incompatible",
                self.authorization_binding,
                supported.authorization_binding.as_slice(),
            ),
            (
                "semantic_capabilities",
                "capability_contract_incompatible",
                self.semantic_capabilities,
                supported.semantic_capabilities.as_slice(),
            ),
        ];
        for (contract, code, required, versions) in checks {
            if !versions.contains(&required) {
                return Some(contract_problem(
                    code, contract, required, versions, peer, operation,
                ));
            }
        }
        for required in &self.operation_transport_recovery {
            if !supported.operation_transport.contains(required) {
                return Some(contract_problem(
                    "transport_protocol_incompatible",
                    "operation_transport",
                    *required,
                    &supported.operation_transport,
                    peer,
                    operation,
                ));
            }
        }
        if crate::is_mutating_operation(operation, input) {
            let required = self.durable_mutation;
            if required.is_none_or(|version| !supported.durable_mutation.contains(&version)) {
                return Some(contract_problem(
                    "durable_mutation_unsupported",
                    "durable_mutation",
                    required.unwrap_or(DURABLE_MUTATION_CONTRACT_VERSION),
                    &supported.durable_mutation,
                    peer,
                    operation,
                ));
            }
        }
        None
    }
}

pub fn authorization_requires_durable_mutation(
    operations: &[String],
    files: Option<&ApplicationFileRequirement>,
) -> bool {
    operations.iter().any(|operation| {
        matches!(
            operation.as_str(),
            "create_view_source"
                | "update_view_source"
                | "delete_view_source"
                | "create"
                | "update"
                | "delete"
                | "rename"
                | "create_type"
                | "update_type"
                | "apply_type_pack"
                | "apply_collection_setup"
                | "put_timer"
                | "cancel_timer"
                | "reconcile_timers"
                | "sync"
        )
    }) || files.is_some_and(|files| {
        files.actions.iter().any(|action| {
            matches!(
                action,
                FileAction::Add | FileAction::Replace | FileAction::Move | FileAction::Delete
            )
        })
    })
}

fn contract_problem(
    code: &str,
    contract: &str,
    required: u32,
    supported: &[u32],
    peer: &str,
    operation: &str,
) -> ConnectProblem {
    ConnectProblem::new(
        code,
        "A required Connect contract is not supported by this peer.",
    )
    .with_details(serde_json::json!({
        "contract": contract,
        "required": [required],
        "supported": supported,
        "peer": peer,
        "operation": operation,
    }))
    .with_operation_outcome(ConnectOperationOutcome::NotSent)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_do_not_require_the_durable_mutation_axis() {
        let requirements = ConnectContractRequirements::current(false);
        assert!(requirements
            .mismatch_problem("query", &serde_json::json!({}), "connector")
            .is_none());
    }

    #[test]
    fn application_collection_setup_requires_the_durable_mutation_axis() {
        assert!(authorization_requires_durable_mutation(
            &["apply_collection_setup".to_string()],
            None
        ));
    }

    #[test]
    fn mutations_fail_not_sent_without_durable_mutation_support() {
        let requirements = ConnectContractRequirements::current(false);
        let problem = requirements
            .mismatch_problem("create", &serde_json::json!({}), "connector")
            .expect("mutation must require durable recovery");
        assert_eq!(problem.code, "durable_mutation_unsupported");
        assert_eq!(
            problem.operation_outcome,
            Some(ConnectOperationOutcome::NotSent)
        );
    }

    #[test]
    fn every_independent_axis_reports_its_typed_mismatch() {
        let cases = [
            (
                ConnectContractRequirements {
                    operation_transport: 99,
                    ..ConnectContractRequirements::current(true)
                },
                "transport_protocol_incompatible",
            ),
            (
                ConnectContractRequirements {
                    authorization_binding: 99,
                    ..ConnectContractRequirements::current(true)
                },
                "authorization_binding_incompatible",
            ),
            (
                ConnectContractRequirements {
                    semantic_capabilities: 99,
                    ..ConnectContractRequirements::current(true)
                },
                "capability_contract_incompatible",
            ),
            (
                ConnectContractRequirements {
                    durable_mutation: Some(99),
                    ..ConnectContractRequirements::current(true)
                },
                "durable_mutation_unsupported",
            ),
        ];
        for (requirements, expected) in cases {
            let problem = requirements
                .mismatch_problem("create", &serde_json::json!({}), "connector")
                .expect("axis must fail closed");
            assert_eq!(problem.code, expected);
            assert_eq!(
                problem.operation_outcome,
                Some(ConnectOperationOutcome::NotSent)
            );
        }
    }
}
