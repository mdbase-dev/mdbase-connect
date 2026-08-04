use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};
use thiserror::Error;

pub type ApiResult<T> = Result<T, ApiError>;

#[derive(Debug, Clone, Error)]
#[error("{message}")]
pub struct ApiError {
    pub status: StatusCode,
    pub code: String,
    pub message: String,
    pub details: Option<Value>,
}

impl ApiError {
    pub fn new(status: StatusCode, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }

    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }

    pub fn bad_request(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, message)
    }

    pub fn unauthorized(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, code, message)
    }

    pub fn forbidden(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, code, message)
    }

    pub fn not_found(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, code, message)
    }

    pub fn conflict(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, code, message)
    }

    pub fn quota(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(StatusCode::TOO_MANY_REQUESTS, code, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "provider_internal_error",
            message,
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut error = json!({
            "code": self.code,
            "message": self.message,
        });
        if let Some(details) = self.details {
            error["details"] = details;
        }
        (self.status, Json(json!({ "error": error }))).into_response()
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(error: sqlx::Error) -> Self {
        let timeout_class = match &error {
            sqlx::Error::PoolTimedOut => Some("pool"),
            sqlx::Error::Database(database) if database.code().as_deref() == Some("57014") => {
                Some("statement")
            }
            sqlx::Error::Database(database) if database.code().as_deref() == Some("55P03") => {
                Some("lock")
            }
            _ => None,
        };
        if let Some(timeout_class) = timeout_class {
            tracing::warn!(
                target: "mdbase_connect::metrics",
                metric = "database_timeout",
                timeout_class,
                "privacy-safe hosted provider metric"
            );
            return Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "provider_database_timeout",
                "The hosted provider database is busy. Retry the request.",
            )
            .with_details(json!({ "timeout_class": timeout_class }));
        }
        if let Some(database) = error.as_database_error() {
            let quota = match database.message() {
                "account_collection_quota_exceeded" => Some((
                    "account_collection_quota_exceeded",
                    "The account has reached its hosted collection limit.",
                )),
                "account_storage_quota_exceeded" => Some((
                    "account_storage_quota_exceeded",
                    "The change would exceed the account's hosted storage limit.",
                )),
                "account_retained_storage_quota_exceeded" => Some((
                    "account_retained_storage_quota_exceeded",
                    "The change would exceed the account's retained file storage limit.",
                )),
                _ => None,
            };
            if let Some((code, message)) = quota {
                return Self::quota(code, message);
            }
        }
        tracing::error!(error = %error, "hosted provider database error");
        Self::internal("The hosted provider could not access its authoritative store.")
    }
}

impl From<std::io::Error> for ApiError {
    fn from(error: std::io::Error) -> Self {
        tracing::error!(error = %error, "hosted provider working-set error");
        Self::internal("The hosted provider could not prepare the collection working set.")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pool_saturation_is_a_typed_bounded_service_failure() {
        let error = ApiError::from(sqlx::Error::PoolTimedOut);
        assert_eq!(error.status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(error.code, "provider_database_timeout");
        assert_eq!(
            error
                .details
                .as_ref()
                .and_then(|value| value["timeout_class"].as_str()),
            Some("pool")
        );
    }
}
