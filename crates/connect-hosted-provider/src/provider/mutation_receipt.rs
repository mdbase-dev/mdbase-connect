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

    /// A sync or file control failure stored by a release before transient
    /// errors stopped being stored: server errors, a quota (the account
    /// storage trigger or a file quota), a token rotated mid-request, or a
    /// collection briefly not active. None is a final answer. Other 4xx
    /// failures (400, 403, and the file refusals such as 409
    /// `stale_file_revision`) were deterministic for that exact request, so
    /// they stay final.
    pub(super) fn is_retryable_stored_failure(&self) -> bool {
        matches!(self, Self::Failure { status, .. }
            if *status >= 500 || matches!(*status, 401 | 404 | 429))
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

/// What an abandoned receipt asserts about the request's effect (ADR 0005).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum AbandonedApplication {
    /// The effect commits atomically with the journal's applied transition, so a
    /// still-`prepared` row proves it never applied.
    NotApplied,
    /// A timer request: its state is outside the collection log, so whether it
    /// applied cannot be proved. The app restores its timers with a new request.
    Unverified,
}

/// The final result of an abandoned request. It is stored as an ordinary
/// failure receipt and replayed unchanged; it is never retried.
pub(super) fn mutation_abandoned(request_id: Uuid, application: AbandonedApplication) -> ApiError {
    let (application, message) = match application {
        AbandonedApplication::NotApplied => (
            "not_applied",
            "The change was abandoned before it was applied, so nothing changed. Make it again if it is still wanted.",
        ),
        AbandonedApplication::Unverified => (
            "unverified",
            "The timer request was abandoned and may not have finished. Send the app's current desired timers as a new request.",
        ),
    };
    ApiError::conflict("mutation_abandoned", message)
        .with_details(json!({ "request_id": request_id, "application": application }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn abandoned_receipt_is_a_catalogued_final_failure() {
        for application in [
            AbandonedApplication::NotApplied,
            AbandonedApplication::Unverified,
        ] {
            let request_id = Uuid::now_v7();
            let error = mutation_abandoned(request_id, application);
            let definition = mdbase_connect_protocol::connect_problem_definition(&error.code)
                .expect("mutation_abandoned is in the generated problem catalogue");
            assert_eq!(
                definition.recovery,
                mdbase_connect_protocol::ConnectRecoveryAction::None
            );
            // A definitive 4xx: clients treat it as final, never as busy or retryable.
            assert_eq!(error.status, StatusCode::CONFLICT);
            let receipt = StoredMutationReceipt::from_result(&Err(error.clone()));
            let replayed = receipt.into_result().unwrap_err();
            assert_eq!(
                (replayed.status, replayed.code, replayed.details),
                (error.status, error.code, error.details)
            );
        }
    }
}
