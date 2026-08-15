use super::*;

pub(super) fn transient_operation_status(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::REQUEST_TIMEOUT
            | StatusCode::BAD_GATEWAY
            | StatusCode::SERVICE_UNAVAILABLE
            | StatusCode::GATEWAY_TIMEOUT
    )
}

pub(super) fn unknown_hosted_mutation(operation: &str, request_id: Uuid) -> ConnectError {
    ConnectError::CloudProblem {
        code: "operation_outcome_unknown".to_string(),
        message: format!(
            "Hosted mutation {operation} may have completed. Its durable request ID is {request_id}; retry only after resolving that outcome."
        ),
    }
}

#[derive(Debug)]
pub(super) struct AuthorityProof {
    pub(super) version: String,
    pub(super) timestamp: String,
    pub(super) nonce: String,
    pub(super) signature: String,
}

pub(super) fn authority_proof(
    private_key_value: &str,
    method: &str,
    url: &str,
    body: &str,
    credential: &str,
) -> Result<AuthorityProof, ConnectError> {
    let target = url::Url::parse(url)
        .map_err(|_| ConnectError::InvalidInput("Hosted authority URL is invalid.".to_string()))?;
    let target = match target.query() {
        Some(query) => format!("{}?{query}", target.path()),
        None => target.path().to_string(),
    };
    let timestamp = Utc::now().timestamp();
    let nonce = Uuid::new_v4().to_string();
    let message = [
        AUTHORITY_PROOF_DOMAIN.to_string(),
        AUTHORITY_PROOF_VERSION.to_string(),
        method.to_ascii_uppercase(),
        target,
        URL_SAFE_NO_PAD.encode(Sha256::digest(body.as_bytes())),
        URL_SAFE_NO_PAD.encode(Sha256::digest(credential.as_bytes())),
        timestamp.to_string(),
        nonce.clone(),
    ]
    .join("\n");
    let key = signing_key(private_key_value)?;
    let signature: Signature = key.sign(message.as_bytes());
    let signature = signature.normalize_s().unwrap_or(signature);
    Ok(AuthorityProof {
        version: AUTHORITY_PROOF_VERSION.to_string(),
        timestamp: timestamp.to_string(),
        nonce,
        signature: URL_SAFE_NO_PAD.encode(signature.to_bytes()),
    })
}

pub(super) fn private_key(key: &SigningKey) -> String {
    URL_SAFE_NO_PAD.encode(key.to_bytes())
}

pub(super) fn signing_key(value: &str) -> Result<SigningKey, ConnectError> {
    let bytes = URL_SAFE_NO_PAD.decode(value).map_err(|_| {
        ConnectError::CredentialStore("A hosted signing key is invalid.".to_string())
    })?;
    SigningKey::from_slice(&bytes)
        .map_err(|_| ConnectError::CredentialStore("A hosted signing key is invalid.".to_string()))
}

pub(super) fn public_key(key: &SigningKey) -> String {
    URL_SAFE_NO_PAD.encode(key.verifying_key().to_encoded_point(false).as_bytes())
}

pub(super) fn random_base64(bytes: usize) -> String {
    let mut value = vec![0_u8; bytes];
    OsRng.fill_bytes(&mut value);
    URL_SAFE_NO_PAD.encode(value)
}

pub(super) fn validate_token_response(token: &TokenResponse) -> Result<(), ConnectError> {
    if token.access_token.is_empty()
        || token.refresh_token.is_empty()
        || token.authority.access_token.is_empty()
        || token.expires_in <= 0
        || token.refresh_expires_in <= 0
        || token.application_origin != "null"
        || token.encryption.is_some()
        || token.operations.is_empty()
        || token
            .operations
            .iter()
            .any(|operation| !is_collection_operation(operation))
    {
        return Err(ConnectError::CloudProblem {
            code: "invalid_token_response".to_string(),
            message: "Connect returned invalid hosted connection credentials.".to_string(),
        });
    }
    let url = url::Url::parse(&token.authority.operations_url).map_err(|_| {
        ConnectError::CloudProblem {
            code: "invalid_token_response".to_string(),
            message: "Connect returned an invalid hosted authority address.".to_string(),
        }
    })?;
    let expected_path = format!("/v1/authorities/{}/operations", token.collection_id);
    let secure = url.scheme() == "https"
        || (url.scheme() == "http"
            && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1")));
    if !secure
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != expected_path
    {
        return Err(ConnectError::CloudProblem {
            code: "invalid_token_response".to_string(),
            message: "Connect returned an unsafe hosted authority address.".to_string(),
        });
    }
    Ok(())
}

pub(super) async fn decode_response<T: for<'de> Deserialize<'de>>(
    response: reqwest::Response,
) -> Result<T, ConnectError> {
    let (status, value) = response_value(response).await?;
    if !status.is_success() {
        return Err(api_value_error(
            value,
            &format!("Hosted request failed with HTTP {status}."),
        ));
    }
    serde_json::from_value(value).map_err(ConnectError::from)
}

pub(super) async fn response_value(
    mut response: reqwest::Response,
) -> Result<(StatusCode, Value), ConnectError> {
    let status = response.status();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(cloud_transport_error)? {
        if bytes.len().saturating_add(chunk.len()) > MAX_HOSTED_RESPONSE_BYTES {
            return Err(ConnectError::CloudProblem {
                code: "hosted_response_too_large".to_string(),
                message: "The hosted authority response exceeded the connector limit.".to_string(),
            });
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| ConnectError::CloudProblem {
        code: "invalid_hosted_response".to_string(),
        message: "Connect returned a malformed hosted response.".to_string(),
    })?;
    Ok((status, value))
}

pub(super) fn api_value_error(value: Value, fallback: &str) -> ConnectError {
    let code = value
        .pointer("/error/code")
        .and_then(Value::as_str)
        .or_else(|| value.get("error").and_then(Value::as_str))
        .unwrap_or("hosted_request_failed")
        .to_string();
    let message = value
        .pointer("/error/message")
        .and_then(Value::as_str)
        .or_else(|| value.get("error_description").and_then(Value::as_str))
        .unwrap_or(fallback)
        .to_string();
    ConnectError::CloudProblem { code, message }
}

pub(super) fn cloud_transport_error(error: reqwest::Error) -> ConnectError {
    ConnectError::Cloud(format!("Hosted request failed: {error}"))
}
