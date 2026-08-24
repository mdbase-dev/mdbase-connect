//! Shared provider HTTP state.
//!
//! Split from the route module so each file stays inside its architecture
//! line budget. Collaboration wake plumbing lives in
//! [`crate::http::collaboration`].

use axum::http::HeaderMap;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use subtle::ConstantTimeEq;
use tokio::sync::Semaphore;

use crate::{
    error::{ApiError, ApiResult},
    http::collaboration_sessions::CollaborationSessionRuntime,
    provider::collaboration::{CollaborationWakeHub, CollaborationWakeRuntime},
    provider::HostedProvider,
};

// An admitted request holds one primary-pool connection for its cross-process
// advisory permit. Eight permits leave ten primary connections for handler and
// maintenance work, preventing a pool-ordering deadlock under saturation.
const MAX_ADMITTED_REQUESTS: usize = 8;
const MAX_COLLABORATION_CONNECTIONS: usize = 256;

#[derive(Clone)]
pub struct AppState {
    pub(crate) provider: HostedProvider,
    internal_token_hash: [u8; 32],
    pub(crate) request_slots: Arc<Semaphore>,
    pub(crate) collaboration_slots: Arc<Semaphore>,
    /// Coalescing hub of per-room durable high-water marks. Sessions and the
    /// PostgreSQL listener both feed it; delivery always reloads authoritative
    /// state.
    pub(crate) collaboration_wakes: Arc<CollaborationWakeHub>,
    /// Started explicitly via [`AppState::start_collaboration_wake_runtime`]
    /// so constructors stay synchronous while startup still fails closed when
    /// collaboration is enabled. A stopped runtime is replaced by the next
    /// start call.
    pub(crate) collaboration_wake_runtime:
        Arc<tokio::sync::Mutex<Option<CollaborationWakeRuntime>>>,
    /// Bounded registry of upgraded collaboration sockets with its
    /// Accepting/Draining/Closing/Drained lifecycle, so shutdown can finish
    /// started updates, close sockets with 1001, and await their exit.
    /// Bounded by [`MAX_COLLABORATION_CONNECTIONS`] through the slot permit.
    pub(crate) collaboration_sessions: Arc<CollaborationSessionRuntime>,
}

impl AppState {
    pub fn new(provider: HostedProvider, internal_token: &str) -> ApiResult<Self> {
        if internal_token.len() < 32 {
            return Err(ApiError::bad_request(
                "invalid_internal_token",
                "The provider internal credential must contain at least 32 characters.",
            ));
        }
        Ok(Self {
            provider,
            internal_token_hash: Sha256::digest(internal_token.as_bytes()).into(),
            request_slots: Arc::new(Semaphore::new(MAX_ADMITTED_REQUESTS)),
            collaboration_slots: Arc::new(Semaphore::new(MAX_COLLABORATION_CONNECTIONS)),
            collaboration_wakes: Arc::new(CollaborationWakeHub::new()),
            collaboration_wake_runtime: Arc::new(tokio::sync::Mutex::new(None)),
            collaboration_sessions: Arc::new(CollaborationSessionRuntime::new()),
        })
    }

    pub(crate) fn collaboration_wakes(&self) -> &Arc<CollaborationWakeHub> {
        &self.collaboration_wakes
    }

    pub(crate) fn authorize_internal(&self, headers: &HeaderMap) -> ApiResult<()> {
        let token = crate::http::authentication::bearer(headers)?;
        let candidate: [u8; 32] = Sha256::digest(token.as_bytes()).into();
        if bool::from(candidate.ct_eq(&self.internal_token_hash)) {
            Ok(())
        } else {
            Err(ApiError::unauthorized(
                "invalid_internal_token",
                "The provider internal credential is invalid.",
            ))
        }
    }
}
