use axum::http::{header::AUTHORIZATION, HeaderMap, HeaderName, Method, Uri};
use mdbase_connect_protocol::{
    AUTHORITY_PROOF_NONCE_HEADER, AUTHORITY_PROOF_SIGNATURE_HEADER,
    AUTHORITY_PROOF_TIMESTAMP_HEADER, AUTHORITY_PROOF_VERSION_HEADER,
};
use serde_json::Value;
use uuid::Uuid;

use crate::{
    error::{ApiError, ApiResult},
    provider::AuthorityRequestProof,
};

pub(super) fn request_origin(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(axum::http::header::ORIGIN)
        .and_then(|value| value.to_str().ok())
}

pub(super) fn request_proof(
    headers: &HeaderMap,
    method: Method,
    uri: &Uri,
    body: &[u8],
) -> ApiResult<Option<AuthorityRequestProof>> {
    let values = [
        header_text(headers, AUTHORITY_PROOF_VERSION_HEADER),
        header_text(headers, AUTHORITY_PROOF_TIMESTAMP_HEADER),
        header_text(headers, AUTHORITY_PROOF_NONCE_HEADER),
        header_text(headers, AUTHORITY_PROOF_SIGNATURE_HEADER),
    ];
    if values.iter().all(Option::is_none) {
        return Ok(None);
    }
    let [Some(version), Some(timestamp), Some(nonce), Some(signature)] = values else {
        return Err(ApiError::unauthorized(
            "invalid_authority_proof",
            "The authority request proof is incomplete.",
        ));
    };
    let version = version.parse::<u32>().map_err(|_| {
        ApiError::unauthorized(
            "invalid_authority_proof",
            "The authority request proof version is invalid.",
        )
    })?;
    let timestamp = timestamp.parse::<i64>().map_err(|_| {
        ApiError::unauthorized(
            "invalid_authority_proof",
            "The authority request proof timestamp is invalid.",
        )
    })?;
    let nonce = Uuid::parse_str(nonce).map_err(|_| {
        ApiError::unauthorized(
            "invalid_authority_proof",
            "The authority request proof nonce is invalid.",
        )
    })?;
    if signature.is_empty() {
        return Err(ApiError::unauthorized(
            "invalid_authority_proof",
            "The authority request proof signature is invalid.",
        ));
    }
    Ok(Some(AuthorityRequestProof {
        version,
        timestamp,
        nonce,
        signature: signature.to_string(),
        method: method.to_string(),
        target: uri
            .path_and_query()
            .map(|value| value.as_str())
            .unwrap_or_else(|| uri.path())
            .to_string(),
        body: body.to_vec(),
    }))
}

fn header_text<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get(HeaderName::from_bytes(name.as_bytes()).ok()?)
        .and_then(|value| value.to_str().ok())
}

pub(super) fn is_query_cursor_release(operation: &str, input: &Value, mutating: bool) -> bool {
    !mutating
        && matches!(operation, "query" | "execute_view")
        && input.get("release_cursor").is_some()
}

pub(super) fn bearer(headers: &HeaderMap) -> ApiResult<&str> {
    headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|token| !token.is_empty())
        .ok_or_else(|| {
            ApiError::unauthorized("missing_bearer_token", "A bearer credential is required.")
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn cursor_release_exemption_is_closed_to_query_operations() {
        let release = json!({"release_cursor": "opaque"});
        assert!(is_query_cursor_release("query", &release, false));
        assert!(is_query_cursor_release("execute_view", &release, false));
        assert!(!is_query_cursor_release("describe", &release, false));
        assert!(!is_query_cursor_release("query", &release, true));
        assert!(!is_query_cursor_release("query", &json!({}), false));
    }
}
