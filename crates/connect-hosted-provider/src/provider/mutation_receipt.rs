use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub(super) enum StoredMutationReceipt {
    Success {
        value: Value,
    },
    Failure {
        status: u16,
        code: String,
        message: String,
        details: Option<Value>,
    },
}

impl StoredMutationReceipt {
    pub(super) fn from_result(result: &ApiResult<Value>) -> Self {
        match result {
            Ok(value) => Self::Success {
                value: value.clone(),
            },
            Err(error) => Self::Failure {
                status: error.status.as_u16(),
                code: error.code.clone(),
                message: error.message.clone(),
                details: error.details.clone(),
            },
        }
    }

    pub(super) fn into_result(self) -> ApiResult<Value> {
        match self {
            Self::Success { value } => Ok(value),
            Self::Failure {
                status,
                code,
                message,
                details,
            } => {
                let status =
                    StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
                let mut error = ApiError::new(status, code, message);
                error.details = details;
                Err(error)
            }
        }
    }
}
