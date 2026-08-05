use super::*;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RelayMessage {
    RelayHello {
        protocol_version: u32,
        connector_version: String,
        capabilities: Vec<String>,
        contract_support: ConnectContractSupport,
    },
    RelayWelcome {
        protocol_version: u32,
        session_id: String,
        capabilities: Vec<String>,
        contract_support: ConnectContractSupport,
    },
    RelayIncompatible {
        protocol_version: u32,
        code: String,
        message: String,
        minimum_connector_version: String,
        update_url: String,
    },
    PolicySnapshot {
        protocol_version: u32,
        request_id: Uuid,
        revision: String,
        grants: Vec<GrantPolicy>,
    },
    PolicyApplied {
        protocol_version: u32,
        request_id: Uuid,
        revision: String,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<ControlError>,
    },
    AuthorizationOfferRequest {
        protocol_version: u32,
        request_id: Uuid,
        authorization_id: Uuid,
        #[serde(default)]
        requirements: ApplicationRequirements,
        #[serde(default)]
        provisions: ApplicationProvisions,
    },
    AuthorizationOfferResponse {
        protocol_version: u32,
        request_id: Uuid,
        paused: bool,
        collections: Vec<AuthorizationCollectionOffer>,
    },
    AuthorizationActivationRequest {
        protocol_version: u32,
        request_id: Uuid,
        authorization_id: Uuid,
        collection_id: Uuid,
        requirements: ApplicationRequirements,
        provisions: ApplicationProvisions,
        #[serde(default)]
        contract_setups: Vec<ContractSetupChoice>,
        grant: Box<GrantPolicy>,
    },
    AuthorizationActivationResponse {
        protocol_version: u32,
        request_id: Uuid,
        ok: bool,
        #[serde(default)]
        contracts: Vec<CollectionContractDescriptor>,
        /// Exact acknowledgement of every setup choice applied by the authority.
        #[serde(default)]
        contract_setups: Vec<ContractSetupChoice>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<ControlError>,
    },
    OperationRequest {
        protocol_version: u32,
        request_id: Uuid,
        grant_id: Uuid,
        collection_id: Uuid,
        application_id: Uuid,
        operation: String,
        input: Value,
    },
    OperationResponse {
        protocol_version: u32,
        request_id: Uuid,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        problem: Option<ConnectProblem>,
    },
    EncryptedOperationRequest {
        #[serde(flatten)]
        envelope: EncryptedRelayEnvelope,
    },
    EncryptedOperationResponse {
        #[serde(flatten)]
        envelope: EncryptedRelayEnvelope,
    },
    EncryptedOperationRejected {
        protocol_version: u32,
        request_id: Uuid,
        problem: ConnectProblem,
    },
}
