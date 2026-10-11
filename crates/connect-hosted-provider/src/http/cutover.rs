//! Old clients whose collection is fenced or moved to mdbase-next get a reason
//! they can show their user, instead of the bare refusal a revoked replica or a
//! non-active collection otherwise produces.

use super::*;
use axum::response::IntoResponse;

/// Shown to old clients after their collection moves to mdbase-next.
const DEFAULT_CLIENT_UPDATE_URL: &str = "https://mdbase.dev/downloads";
/// A fenced collection usually finishes its cutover within minutes.
const COLLECTION_MIGRATING_RETRY_SECONDS: u64 = 300;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClientUpdatePolicy {
    pub update_url: String,
    /// Set by release at cutover; absent until then.
    pub minimum_client_version: Option<String>,
}

impl Default for ClientUpdatePolicy {
    fn default() -> Self {
        Self {
            update_url: DEFAULT_CLIENT_UPDATE_URL.to_owned(),
            minimum_client_version: None,
        }
    }
}

/// Rewrites an authentication or not-found refusal on a migrating or migrated
/// collection. Runs only on those refusals, and only for a bearer that belonged
/// to the collection, so successful requests pay nothing and probes learn nothing.
pub(super) async fn explain_cutover_refusal(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    let collection_id = authority_collection_id(request.uri());
    let token = bearer(request.headers()).ok().map(str::to_owned);
    let response = next.run(request).await;
    if !matches!(
        response.status(),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN | StatusCode::NOT_FOUND
    ) {
        return response;
    }
    let (Some(collection_id), Some(token)) = (collection_id, token) else {
        return response;
    };
    match state
        .provider
        .cutover_state_for_token(collection_id, &token)
        .await
    {
        Ok(Some(cutover_state)) => cutover_refusal(&cutover_state, &state.client_update)
            .map(IntoResponse::into_response)
            .unwrap_or(response),
        _ => response,
    }
}

fn authority_collection_id(uri: &Uri) -> Option<Uuid> {
    uri.path()
        .strip_prefix("/v1/authorities/")?
        .split('/')
        .next()?
        .parse()
        .ok()
}

fn cutover_refusal(
    cutover_state: &str,
    policy: &ClientUpdatePolicy,
) -> Option<(StatusCode, HeaderMap, Json<Value>)> {
    let (code, message, details, retry_after) = match cutover_state {
        "migrating" => (
            "collection_migrating",
            "This collection is being upgraded. Your data is safe, and editing will resume \
             once the upgrade finishes. Try again in a few minutes."
                .to_owned(),
            json!({ "retry_after_seconds": COLLECTION_MIGRATING_RETRY_SECONDS }),
            Some(COLLECTION_MIGRATING_RETRY_SECONDS),
        ),
        "migrated" => {
            let mut details = json!({
                "reason": "moved_to_next_runtime",
                "update_url": policy.update_url,
            });
            if let Some(version) = &policy.minimum_client_version {
                details["minimum_client_version"] = json!(version);
            }
            (
                "collection_unavailable",
                format!(
                    "mdbase was upgraded, and this app needs to update to keep syncing. \
                     Reload the page, or download the latest version from {} if you use \
                     the desktop or mobile app.",
                    policy.update_url
                ),
                details,
                None,
            )
        }
        _ => return None,
    };
    let mut headers = HeaderMap::new();
    if let Some(seconds) = retry_after {
        headers.insert(axum::http::header::RETRY_AFTER, seconds.into());
    }
    Some((
        StatusCode::CONFLICT,
        headers,
        Json(json!({ "error": { "code": code, "message": message, "details": details } })),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_collection_from_authority_paths_only() {
        let id = Uuid::now_v7();
        let uri: Uri = format!("/v1/authorities/{id}/operations/query")
            .parse()
            .unwrap();
        assert_eq!(authority_collection_id(&uri), Some(id));
        let other: Uri = format!("/internal/v1/collections/{id}").parse().unwrap();
        assert_eq!(authority_collection_id(&other), None);
    }

    #[test]
    fn moved_refusal_names_the_update_link_and_optional_minimum_version() {
        let policy = ClientUpdatePolicy {
            update_url: "https://example.test/get".to_owned(),
            minimum_client_version: Some("2.0.0".to_owned()),
        };
        let (status, headers, Json(body)) = cutover_refusal("migrated", &policy).unwrap();
        assert_eq!(status, StatusCode::CONFLICT);
        assert!(headers.get("retry-after").is_none());
        assert_eq!(body["error"]["code"], "collection_unavailable");
        assert_eq!(body["error"]["details"]["reason"], "moved_to_next_runtime");
        assert_eq!(body["error"]["details"]["minimum_client_version"], "2.0.0");
        assert!(body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("https://example.test/get"));

        let (_, headers, Json(body)) =
            cutover_refusal("migrating", &ClientUpdatePolicy::default()).unwrap();
        assert_eq!(headers["retry-after"], "300");
        assert_eq!(body["error"]["code"], "collection_migrating");
        assert!(cutover_refusal("active", &ClientUpdatePolicy::default()).is_none());
    }
}
