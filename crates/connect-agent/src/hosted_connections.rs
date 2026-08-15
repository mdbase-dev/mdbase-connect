use crate::cloud::CloudControlClient;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::{DateTime, Duration as ChronoDuration, SecondsFormat, Utc};
use mdbase_connect_core::{ConnectError, SystemSecretStore};
use mdbase_connect_protocol::{
    application_installation_id, authorization_requires_durable_mutation, is_collection_operation,
    is_mutating_operation, ApplicationAuthorizationBinding, ApplicationAuthorizationFlow,
    ApplicationAuthorizationProof, ConnectContractRequirements, HostedConnectionAuthorization,
    HostedConnectionAuthorizationStatus, HostedConnectionAuthorizeParams, HostedConnectionSummary,
    OperationRequest, OperationResponse, AUTHORITY_PROOF_DOMAIN, AUTHORITY_PROOF_NONCE_HEADER,
    AUTHORITY_PROOF_SIGNATURE_HEADER, AUTHORITY_PROOF_TIMESTAMP_HEADER, AUTHORITY_PROOF_VERSION,
    AUTHORITY_PROOF_VERSION_HEADER, OPERATION_TRANSPORT_PROTOCOL_VERSION,
};
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::SecretKey;
use rand_core::{OsRng, RngCore};
use reqwest::{Client, Method, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};
use tempfile::NamedTempFile;
use uuid::Uuid;

const REGISTRY_VERSION: u32 = 1;
const CLI_APPLICATION_ID: &str = "dev.mdbase.cli";
const CLI_APPLICATION_NAME: &str = "mdbase CLI";
const MAX_HOSTED_RESPONSE_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct HostedConnectionEntry {
    collection_id: Uuid,
    collection_name: String,
    application_id: Uuid,
    grant_id: Uuid,
    operations: Vec<String>,
    operations_url: String,
    proof_public_key: String,
    access_expires_at: String,
    refresh_expires_at: String,
}

impl HostedConnectionEntry {
    fn summary(&self) -> HostedConnectionSummary {
        HostedConnectionSummary {
            collection_id: self.collection_id,
            collection_name: self.collection_name.clone(),
            grant_id: self.grant_id,
            operations: self.operations.clone(),
            access_expires_at: self.access_expires_at.clone(),
            refresh_expires_at: self.refresh_expires_at.clone(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct HostedConnectionRegistryFile {
    version: u32,
    connections: Vec<HostedConnectionEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct HostedConnectionCredentials {
    access_token: String,
    refresh_token: String,
    authority_access_token: String,
    grant_signing_private_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CliApplicationIdentity {
    installation_signing_private_key: String,
}

#[derive(Debug)]
struct PendingAuthorization {
    application_id: Uuid,
    collection_id: Uuid,
    device_code: String,
    verifier: String,
    grant_signing_private_key: String,
    requested_operations: Vec<String>,
    expires_at: DateTime<Utc>,
    next_poll_at: DateTime<Utc>,
    interval_seconds: u64,
}

#[derive(Debug, Deserialize)]
struct RegisteredApplicationResponse {
    application: RegisteredApplication,
}

#[derive(Debug, Deserialize)]
struct RegisteredApplication {
    id: Uuid,
    manifest_digest: String,
}

#[derive(Debug, Deserialize)]
struct DeviceAuthorizationResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    verification_uri_complete: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    expires_in: i64,
    refresh_expires_in: i64,
    collection_id: Uuid,
    collection_name: Option<String>,
    operations: Vec<String>,
    grant_id: Uuid,
    application_origin: String,
    encryption: Option<Value>,
    authority: HostedAuthorityToken,
}

#[derive(Debug, Deserialize)]
struct HostedAuthorityToken {
    operations_url: String,
    access_token: String,
    proof_public_key: String,
}

pub(crate) struct HostedConnectionManager {
    state_dir: PathBuf,
    server_url: String,
    cloud: CloudControlClient,
    client: Client,
    secrets: SystemSecretStore,
    entries: RwLock<Vec<HostedConnectionEntry>>,
    pending: Mutex<HashMap<Uuid, PendingAuthorization>>,
    refresh: tokio::sync::Mutex<()>,
}

impl HostedConnectionManager {
    pub(crate) fn open(state_dir: &Path, cloud: &CloudControlClient) -> Result<Self, ConnectError> {
        let path = state_dir.join("hosted-connections.json");
        let entries = match fs::read(&path) {
            Ok(bytes) => {
                let registry: HostedConnectionRegistryFile = serde_json::from_slice(&bytes)?;
                if registry.version != REGISTRY_VERSION {
                    return Err(ConnectError::Settings(format!(
                        "Hosted connection registry version {} is unsupported.",
                        registry.version
                    )));
                }
                registry.connections
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(error.into()),
        };
        Ok(Self {
            state_dir: state_dir.to_path_buf(),
            server_url: cloud.server_url().trim_end_matches('/').to_string(),
            cloud: cloud.clone(),
            client: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .map_err(|error| ConnectError::Cloud(error.to_string()))?,
            secrets: SystemSecretStore::new(state_dir),
            entries: RwLock::new(entries),
            pending: Mutex::new(HashMap::new()),
            refresh: tokio::sync::Mutex::new(()),
        })
    }

    pub(crate) fn list(&self) -> Vec<HostedConnectionSummary> {
        self.entries
            .read()
            .expect("hosted connection registry lock poisoned")
            .iter()
            .map(HostedConnectionEntry::summary)
            .collect()
    }

    pub(crate) async fn begin_authorization(
        &self,
        params: HostedConnectionAuthorizeParams,
    ) -> Result<HostedConnectionAuthorization, ConnectError> {
        let mut operations = params.operations;
        operations.sort();
        operations.dedup();
        if operations.is_empty()
            || operations
                .iter()
                .any(|value| !is_collection_operation(value))
        {
            return Err(ConnectError::InvalidInput(
                "Hosted CLI access requires one or more supported collection operations."
                    .to_string(),
            ));
        }
        let application = self.register_application().await?;
        let identity = self.load_or_create_application_identity()?;
        let installation_signing = signing_key(&identity.installation_signing_private_key)?;
        let installation_public = public_key(&installation_signing);
        let grant_agreement = SecretKey::random(&mut OsRng);
        let grant_agreement_public = URL_SAFE_NO_PAD.encode(
            grant_agreement
                .public_key()
                .to_encoded_point(false)
                .as_bytes(),
        );
        let grant_signing = SigningKey::random(&mut OsRng);
        let grant_signing_public = public_key(&grant_signing);
        let verifier = random_base64(32);
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let issued_at = Utc::now();
        let expires_at = issued_at + ChronoDuration::minutes(10);
        let binding = ApplicationAuthorizationBinding {
            protocol_version: mdbase_connect_protocol::APPLICATION_AUTHORIZATION_PROTOCOL_VERSION,
            authorization_id: Uuid::new_v4(),
            application_id: application.id,
            application_declaration_id: CLI_APPLICATION_ID.to_string(),
            application_manifest_digest: application.manifest_digest,
            application_installation_id: application_installation_id(&installation_public)
                .map_err(|error| ConnectError::Settings(error.to_string()))?,
            installation_signing_public_key: installation_public,
            grant_agreement_public_key: grant_agreement_public,
            grant_signing_public_key: grant_signing_public,
            flow: ApplicationAuthorizationFlow::DeviceCode,
            authorization_nonce: random_base64(32),
            issued_at: issued_at.to_rfc3339_opts(SecondsFormat::Millis, true),
            expires_at: expires_at.to_rfc3339_opts(SecondsFormat::Millis, true),
            redirect_uri: None,
            state: None,
            code_challenge: challenge.clone(),
            contracts: ConnectContractRequirements::current(
                authorization_requires_durable_mutation(&operations, None),
            ),
            requested_operations: operations.clone(),
            requested_files: None,
            collection_id: Some(params.collection_id),
        };
        let message = binding
            .signing_message()
            .map_err(|error| ConnectError::Settings(error.to_string()))?;
        let signature: Signature = installation_signing.sign(&message);
        let signature = signature.normalize_s().unwrap_or(signature);
        let proof = ApplicationAuthorizationProof {
            binding,
            signature: URL_SAFE_NO_PAD.encode(signature.to_bytes()),
        };
        let response = self
            .client
            .post(format!("{}/oauth/device_authorization", self.server_url))
            .form(&[
                ("client_id", application.id.to_string()),
                ("operations", operations.join(",")),
                ("collection_id", params.collection_id.to_string()),
                ("code_challenge", challenge),
                ("code_challenge_method", "S256".to_string()),
                ("application_authorization", serde_json::to_string(&proof)?),
            ])
            .send()
            .await
            .map_err(cloud_transport_error)?;
        let device: DeviceAuthorizationResponse = decode_response(response).await?;
        self.validate_verification_url(&device.verification_uri)?;
        self.validate_verification_url(&device.verification_uri_complete)?;
        if device.expires_in == 0 || device.expires_in > 10 * 60 || device.interval == 0 {
            return Err(ConnectError::CloudProblem {
                code: "invalid_device_authorization_response".to_string(),
                message: "Connect returned unsafe hosted authorization timing.".to_string(),
            });
        }
        let authorization_id = Uuid::new_v4();
        let expires_at = Utc::now() + ChronoDuration::seconds(device.expires_in as i64);
        self.pending
            .lock()
            .expect("hosted authorization lock poisoned")
            .insert(
                authorization_id,
                PendingAuthorization {
                    application_id: application.id,
                    collection_id: params.collection_id,
                    device_code: device.device_code,
                    verifier,
                    grant_signing_private_key: private_key(&grant_signing),
                    requested_operations: operations,
                    expires_at,
                    next_poll_at: Utc::now(),
                    interval_seconds: device.interval.max(1),
                },
            );
        Ok(HostedConnectionAuthorization {
            authorization_id,
            collection_id: params.collection_id,
            user_code: device.user_code,
            verification_uri: device.verification_uri,
            verification_uri_complete: device.verification_uri_complete,
            expires_at: expires_at.to_rfc3339_opts(SecondsFormat::Millis, true),
            interval_seconds: device.interval.max(1),
        })
    }

    pub(crate) async fn poll_authorization(
        &self,
        authorization_id: Uuid,
    ) -> Result<HostedConnectionAuthorizationStatus, ConnectError> {
        let pending = self
            .pending
            .lock()
            .expect("hosted authorization lock poisoned")
            .remove(&authorization_id)
            .ok_or_else(|| ConnectError::CloudProblem {
                code: "hosted_authorization_not_found".to_string(),
                message: "That hosted CLI authorization is unavailable or expired.".to_string(),
            })?;
        if Utc::now() >= pending.expires_at {
            return Err(ConnectError::CloudProblem {
                code: "hosted_authorization_expired".to_string(),
                message: "Hosted CLI authorization expired before approval completed.".to_string(),
            });
        }
        if Utc::now() < pending.next_poll_at {
            self.pending
                .lock()
                .expect("hosted authorization lock poisoned")
                .insert(authorization_id, pending);
            return Ok(HostedConnectionAuthorizationStatus::Pending);
        }
        let response = self
            .client
            .post(format!("{}/oauth/token", self.server_url))
            .form(&[
                (
                    "grant_type",
                    "urn:ietf:params:oauth:grant-type:device_code".to_string(),
                ),
                ("device_code", pending.device_code.clone()),
                ("client_id", pending.application_id.to_string()),
                ("code_verifier", pending.verifier.clone()),
            ])
            .send()
            .await;
        let response = match response {
            Ok(response) => response,
            Err(_) => {
                let mut pending = pending;
                pending.next_poll_at =
                    Utc::now() + ChronoDuration::seconds(pending.interval_seconds as i64);
                self.pending
                    .lock()
                    .expect("hosted authorization lock poisoned")
                    .insert(authorization_id, pending);
                return Ok(HostedConnectionAuthorizationStatus::Pending);
            }
        };
        if response.status() == StatusCode::BAD_REQUEST {
            let (_, value) = response_value(response).await?;
            let code = value
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("authorization_failed");
            if matches!(code, "authorization_pending" | "slow_down") {
                let mut pending = pending;
                if code == "slow_down" {
                    pending.interval_seconds = pending.interval_seconds.saturating_add(5);
                }
                pending.next_poll_at =
                    Utc::now() + ChronoDuration::seconds(pending.interval_seconds as i64);
                self.pending
                    .lock()
                    .expect("hosted authorization lock poisoned")
                    .insert(authorization_id, pending);
                return Ok(HostedConnectionAuthorizationStatus::Pending);
            }
            return Err(api_value_error(value, "Hosted CLI authorization failed."));
        }
        let token: TokenResponse = decode_response(response).await?;
        validate_token_response(&token)?;
        if token.collection_id != pending.collection_id {
            return Err(ConnectError::CloudProblem {
                code: "authorization_changed".to_string(),
                message: "Connect returned a grant for a different collection.".to_string(),
            });
        }
        if token
            .operations
            .iter()
            .any(|operation| !pending.requested_operations.contains(operation))
        {
            return Err(ConnectError::CloudProblem {
                code: "authorization_changed".to_string(),
                message: "Connect returned operations that the CLI did not request.".to_string(),
            });
        }
        if token.authority.proof_public_key
            != public_key(&signing_key(&pending.grant_signing_private_key)?)
        {
            return Err(ConnectError::CloudProblem {
                code: "authorization_binding_mismatch".to_string(),
                message: "Connect returned a hosted capability bound to another signing key."
                    .to_string(),
            });
        }
        let now = Utc::now();
        let entry = HostedConnectionEntry {
            collection_id: token.collection_id,
            collection_name: token
                .collection_name
                .unwrap_or_else(|| format!("Collection {}", &token.collection_id.to_string()[..8])),
            application_id: pending.application_id,
            grant_id: token.grant_id,
            operations: token.operations,
            operations_url: token.authority.operations_url,
            proof_public_key: token.authority.proof_public_key,
            access_expires_at: (now + ChronoDuration::seconds(token.expires_in))
                .to_rfc3339_opts(SecondsFormat::Millis, true),
            refresh_expires_at: (now + ChronoDuration::seconds(token.refresh_expires_in))
                .to_rfc3339_opts(SecondsFormat::Millis, true),
        };
        let credentials = HostedConnectionCredentials {
            access_token: token.access_token,
            refresh_token: token.refresh_token,
            authority_access_token: token.authority.access_token,
            grant_signing_private_key: pending.grant_signing_private_key,
        };
        self.secrets.set_hosted_connection_credentials(
            entry.collection_id,
            &serde_json::to_string(&credentials)?,
        )?;
        self.upsert(entry.clone())?;
        Ok(HostedConnectionAuthorizationStatus::Connected {
            connection: entry.summary(),
        })
    }

    pub(crate) async fn remove(&self, collection_id: Uuid) -> Result<Value, ConnectError> {
        let entry = {
            let entries = self
                .entries
                .read()
                .expect("hosted connection registry lock poisoned");
            entries
                .iter()
                .find(|entry| entry.collection_id == collection_id)
                .cloned()
                .ok_or(ConnectError::CollectionNotFound(collection_id))?
        };
        let revocation = self
            .cloud
            .connector_request::<Value>(
                Method::DELETE,
                &format!("/v1/connectors/hosted/grants/{}", entry.grant_id),
                None,
            )
            .await;
        if let Err(error) = revocation {
            if error.code() != "grant_not_found" {
                return Err(error);
            }
        }
        let mut entries = self
            .entries
            .write()
            .expect("hosted connection registry lock poisoned");
        let mut updated = entries.clone();
        updated.retain(|entry| entry.collection_id != collection_id);
        self.secrets
            .clear_hosted_connection_credentials(collection_id)?;
        self.write_registry(&updated)?;
        *entries = updated;
        Ok(json!({"removed": true, "collection_id": collection_id}))
    }

    pub(crate) fn contains(&self, collection_id: Uuid) -> bool {
        self.entries
            .read()
            .expect("hosted connection registry lock poisoned")
            .iter()
            .any(|entry| entry.collection_id == collection_id)
    }

    pub(crate) async fn operation(
        &self,
        collection_id: Uuid,
        operation: &str,
        input: Value,
    ) -> Result<Value, ConnectError> {
        let (entry, credentials) = self.fresh_connection(collection_id, false).await?;
        if !entry.operations.iter().any(|allowed| allowed == operation) {
            return Err(ConnectError::AccessDenied(format!(
                "The mdbase CLI grant for {} does not permit {operation}.",
                entry.collection_name
            )));
        }
        let first = self
            .send_operation(&entry, &credentials, operation, input.clone())
            .await;
        if first.as_ref().is_err_and(|error| {
            matches!(
                error.code(),
                "invalid_replica_token"
                    | "invalid_capability"
                    | "expired_capability"
                    | "unauthorized"
            )
        }) {
            let (entry, credentials) = self.fresh_connection(collection_id, true).await?;
            return self
                .send_operation(&entry, &credentials, operation, input)
                .await;
        }
        first
    }

    async fn fresh_connection(
        &self,
        collection_id: Uuid,
        force: bool,
    ) -> Result<(HostedConnectionEntry, HostedConnectionCredentials), ConnectError> {
        let _refresh = self.refresh.lock().await;
        let entry = self
            .entries
            .read()
            .expect("hosted connection registry lock poisoned")
            .iter()
            .find(|entry| entry.collection_id == collection_id)
            .cloned()
            .ok_or(ConnectError::CollectionNotFound(collection_id))?;
        let credentials: HostedConnectionCredentials = self
            .secrets
            .hosted_connection_credentials(collection_id)?
            .ok_or_else(|| {
                ConnectError::CredentialStore(
                    "Hosted connection credentials are missing; authorize this collection again."
                        .to_string(),
                )
            })
            .and_then(|value| serde_json::from_str(&value).map_err(ConnectError::from))?;
        if entry.proof_public_key
            != public_key(&signing_key(&credentials.grant_signing_private_key)?)
        {
            return Err(ConnectError::CredentialStore(
                "Hosted connection metadata does not match its signing key; authorize this collection again."
                    .to_string(),
            ));
        }
        let expires_at = DateTime::parse_from_rfc3339(&entry.access_expires_at)
            .map_err(|_| {
                ConnectError::Settings(
                    "Hosted connection expiry is invalid; authorize this collection again."
                        .to_string(),
                )
            })?
            .with_timezone(&Utc);
        if !force && expires_at > Utc::now() + ChronoDuration::seconds(30) {
            return Ok((entry, credentials));
        }
        let refresh_expires_at = DateTime::parse_from_rfc3339(&entry.refresh_expires_at)
            .map_err(|_| {
                ConnectError::Settings(
                    "Hosted connection refresh expiry is invalid; authorize this collection again."
                        .to_string(),
                )
            })?
            .with_timezone(&Utc);
        if refresh_expires_at <= Utc::now() {
            return Err(ConnectError::CloudProblem {
                code: "connection_expired".to_string(),
                message: format!(
                    "CLI access to {} expired; authorize this collection again.",
                    entry.collection_name
                ),
            });
        }
        let refresh_url = format!("{}/oauth/token", self.server_url);
        let body = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("grant_type", "refresh_token")
            .append_pair("refresh_token", &credentials.refresh_token)
            .append_pair("client_id", &entry.application_id.to_string())
            .finish();
        let proof = authority_proof(
            &credentials.grant_signing_private_key,
            "POST",
            &refresh_url,
            &body,
            &credentials.refresh_token,
        )?;
        let response = self
            .client
            .post(&refresh_url)
            .header("content-type", "application/x-www-form-urlencoded")
            .header(AUTHORITY_PROOF_VERSION_HEADER, proof.version)
            .header(AUTHORITY_PROOF_TIMESTAMP_HEADER, proof.timestamp)
            .header(AUTHORITY_PROOF_NONCE_HEADER, proof.nonce)
            .header(AUTHORITY_PROOF_SIGNATURE_HEADER, proof.signature)
            .body(body)
            .send()
            .await
            .map_err(cloud_transport_error)?;
        let token: TokenResponse = decode_response(response).await?;
        validate_token_response(&token)?;
        if token.collection_id != entry.collection_id || token.grant_id != entry.grant_id {
            return Err(ConnectError::CloudProblem {
                code: "authorization_changed".to_string(),
                message: "Connect returned a different hosted collection grant.".to_string(),
            });
        }
        if token
            .operations
            .iter()
            .any(|operation| !entry.operations.contains(operation))
        {
            return Err(ConnectError::CloudProblem {
                code: "authorization_changed".to_string(),
                message: "Connect expanded the hosted grant during refresh.".to_string(),
            });
        }
        if token.authority.proof_public_key
            != public_key(&signing_key(&credentials.grant_signing_private_key)?)
        {
            return Err(ConnectError::CloudProblem {
                code: "authorization_binding_mismatch".to_string(),
                message: "Connect refreshed the hosted capability for another signing key."
                    .to_string(),
            });
        }
        let now = Utc::now();
        let updated_entry = HostedConnectionEntry {
            collection_id: entry.collection_id,
            collection_name: token.collection_name.unwrap_or(entry.collection_name),
            application_id: entry.application_id,
            grant_id: entry.grant_id,
            operations: token.operations,
            operations_url: token.authority.operations_url,
            proof_public_key: token.authority.proof_public_key,
            access_expires_at: (now + ChronoDuration::seconds(token.expires_in))
                .to_rfc3339_opts(SecondsFormat::Millis, true),
            refresh_expires_at: (now + ChronoDuration::seconds(token.refresh_expires_in))
                .to_rfc3339_opts(SecondsFormat::Millis, true),
        };
        let updated_credentials = HostedConnectionCredentials {
            access_token: token.access_token,
            refresh_token: token.refresh_token,
            authority_access_token: token.authority.access_token,
            grant_signing_private_key: credentials.grant_signing_private_key,
        };
        self.secrets.set_hosted_connection_credentials(
            collection_id,
            &serde_json::to_string(&updated_credentials)?,
        )?;
        self.upsert(updated_entry.clone())?;
        Ok((updated_entry, updated_credentials))
    }

    async fn send_operation(
        &self,
        entry: &HostedConnectionEntry,
        credentials: &HostedConnectionCredentials,
        operation: &str,
        input: Value,
    ) -> Result<Value, ConnectError> {
        let url = format!(
            "{}/{}",
            entry.operations_url.trim_end_matches('/'),
            operation
        );
        let request = OperationRequest {
            protocol_version: OPERATION_TRANSPORT_PROTOCOL_VERSION,
            request_id: Uuid::new_v4(),
            input,
        };
        let body = serde_json::to_string(&request)?;
        let mut attempt = 0_u8;
        let result = loop {
            attempt += 1;
            let proof = authority_proof(
                &credentials.grant_signing_private_key,
                "POST",
                &url,
                &body,
                &credentials.authority_access_token,
            )?;
            let response = self
                .client
                .request(Method::POST, &url)
                .bearer_auth(&credentials.authority_access_token)
                .header("content-type", "application/json")
                .header("origin", "null")
                .header(AUTHORITY_PROOF_VERSION_HEADER, proof.version)
                .header(AUTHORITY_PROOF_TIMESTAMP_HEADER, proof.timestamp)
                .header(AUTHORITY_PROOF_NONCE_HEADER, proof.nonce)
                .header(AUTHORITY_PROOF_SIGNATURE_HEADER, proof.signature)
                .body(body.clone())
                .send()
                .await;
            let last_transport_error = match response {
                Ok(response) if !transient_operation_status(response.status()) => {
                    let success_status = response.status().is_success();
                    match decode_response::<OperationResponse>(response).await {
                        Ok(result) => break result,
                        Err(_)
                            if success_status
                                && is_mutating_operation(operation, &request.input) =>
                        {
                            return Err(unknown_hosted_mutation(operation, request.request_id));
                        }
                        Err(error) => return Err(error),
                    }
                }
                Ok(response) => ConnectError::Cloud(format!(
                    "Hosted authority temporarily failed with HTTP {}.",
                    response.status()
                )),
                Err(error) => cloud_transport_error(error),
            };
            if attempt == 1 {
                // The provider's durable journal makes replaying the exact request ID safe.
                continue;
            }
            if is_mutating_operation(operation, &request.input) {
                return Err(unknown_hosted_mutation(operation, request.request_id));
            }
            return Err(last_transport_error);
        };
        if result.request_id != request.request_id
            || result.protocol_version != request.protocol_version
        {
            if is_mutating_operation(operation, &request.input) {
                return Err(unknown_hosted_mutation(operation, request.request_id));
            }
            return Err(ConnectError::CloudProblem {
                code: "invalid_operation_response".to_string(),
                message: "The hosted authority returned a mismatched operation response."
                    .to_string(),
            });
        }
        if result.ok {
            result.result.ok_or_else(|| {
                if is_mutating_operation(operation, &request.input) {
                    unknown_hosted_mutation(operation, request.request_id)
                } else {
                    ConnectError::CloudProblem {
                        code: "invalid_operation_response".to_string(),
                        message: "The hosted authority returned no operation result.".to_string(),
                    }
                }
            })
        } else {
            let problem = result.problem.ok_or_else(|| ConnectError::CloudProblem {
                code: "invalid_operation_response".to_string(),
                message: "The hosted authority returned no operation problem.".to_string(),
            })?;
            Err(ConnectError::CloudProblem {
                code: problem.code,
                message: problem.message,
            })
        }
    }

    async fn register_application(&self) -> Result<RegisteredApplication, ConnectError> {
        let response = self
            .client
            .post(format!("{}/v1/apps/register", self.server_url))
            .json(&json!({
                "manifest": {
                    "manifest_version": 1,
                    "distribution": "portable",
                    "id": CLI_APPLICATION_ID,
                    "name": CLI_APPLICATION_NAME,
                    "requirements": {"access": "full_collection", "contracts": []}
                }
            }))
            .send()
            .await
            .map_err(cloud_transport_error)?;
        Ok(decode_response::<RegisteredApplicationResponse>(response)
            .await?
            .application)
    }

    fn load_or_create_application_identity(&self) -> Result<CliApplicationIdentity, ConnectError> {
        if let Some(value) = self.secrets.cli_application_identity()? {
            return serde_json::from_str(&value).map_err(ConnectError::from);
        }
        let identity = CliApplicationIdentity {
            installation_signing_private_key: private_key(&SigningKey::random(&mut OsRng)),
        };
        self.secrets
            .set_cli_application_identity(&serde_json::to_string(&identity)?)?;
        Ok(identity)
    }

    fn validate_verification_url(&self, value: &str) -> Result<(), ConnectError> {
        let candidate = url::Url::parse(value).map_err(|_| ConnectError::CloudProblem {
            code: "invalid_device_authorization_response".to_string(),
            message: "Connect returned an invalid approval address.".to_string(),
        })?;
        let expected = url::Url::parse(&self.server_url).map_err(|_| {
            ConnectError::Settings("Configured Connect server URL is invalid.".to_string())
        })?;
        if candidate.origin() != expected.origin()
            || !candidate.username().is_empty()
            || candidate.password().is_some()
        {
            return Err(ConnectError::CloudProblem {
                code: "invalid_device_authorization_response".to_string(),
                message: "Connect returned an approval address on another origin.".to_string(),
            });
        }
        Ok(())
    }

    fn upsert(&self, entry: HostedConnectionEntry) -> Result<(), ConnectError> {
        let mut entries = self
            .entries
            .write()
            .expect("hosted connection registry lock poisoned");
        let mut updated = entries.clone();
        updated.retain(|candidate| candidate.collection_id != entry.collection_id);
        updated.push(entry);
        self.write_registry(&updated)?;
        *entries = updated;
        Ok(())
    }

    fn write_registry(&self, connections: &[HostedConnectionEntry]) -> Result<(), ConnectError> {
        fs::create_dir_all(&self.state_dir)?;
        let mut temporary = NamedTempFile::new_in(&self.state_dir)?;
        temporary.write_all(&serde_json::to_vec_pretty(&HostedConnectionRegistryFile {
            version: REGISTRY_VERSION,
            connections: connections.to_vec(),
        })?)?;
        temporary.as_file().sync_all()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            temporary
                .as_file()
                .set_permissions(fs::Permissions::from_mode(0o600))?;
        }
        temporary
            .persist(self.state_dir.join("hosted-connections.json"))
            .map_err(|error| error.error)?;
        Ok(())
    }
}

mod support;
use support::*;

#[cfg(test)]
mod tests;
