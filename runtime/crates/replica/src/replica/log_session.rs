//! Trusted-host log provenance. Opaque identities are process-local, NOT server
//! authentication, permission, or a cryptographic current-service witness.
//! Adapters must authenticate the configured endpoint and fence every await.

use std::collections::BTreeMap;
use std::sync::Arc;

use mdbn_wire::common::Uuid;
use mdbn_wire::log_service::ReadParams;

use super::Replica;
use crate::log::{CallId, EndpointId, LogCall, LogError, LogPort, LogPush, LogReply, LogResponse};
use crate::store::{Head, Store};

/// A trusted adapter's authenticated collection/endpoint session. No wire form,
/// public identity constructor, or transferable collection permission exists.
#[derive(Debug, Clone)]
pub struct AuthenticatedLogSession(Arc<SessionIdentity>);

#[derive(Debug)]
struct SessionIdentity {
    collection: Uuid,
    endpoint: EndpointId,
}

/// Original call provenance captured before queue/send/await. Clones cannot
/// accept a second reply: the original pending binding is consumed once.
#[derive(Debug, Clone)]
pub struct LogReplyScope(Arc<OriginalCall>);

#[derive(Debug)]
struct OriginalCall {
    session: AuthenticatedLogSession,
    id: CallId,
    method: &'static str,
    read: Option<ReadParams>,
    captured_head: Head,
}

impl LogReplyScope {
    /// Immutable original read interval/budget and the local head at capture,
    /// BEFORE send/await. These are request metadata, NOT a completed prefix or
    /// current policy proof. Returning the LogCall to a host cannot relabel them.
    pub fn original_read(&self) -> Option<(&ReadParams, Head)> {
        self.0
            .read
            .as_ref()
            .map(|read| (read, self.0.captured_head))
    }
}

/// Local host-port failure; these variants have no allocated wire numbers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogSessionError {
    /// Session/call is retired, consumed, or belongs to another replica.
    Stale,
    /// The adapter supplied another collection or endpoint.
    WrongBinding,
    /// Terminal Store failure requires a fresh replica and transport.
    ReopenRequired,
    /// Decoded response/push does not match the original request/binding.
    WrongShape,
}

#[derive(Default)]
pub(super) struct State {
    current: Option<AuthenticatedLogSession>,
    calls: BTreeMap<CallId, Arc<OriginalCall>>,
}
impl State {
    pub(super) fn forget_call(&mut self, id: CallId) {
        self.calls.remove(&id);
    }
}

/// Only the matched, current host callback can construct this private context.
/// Legacy LogPort dispatch always supplies None. Prefix authority is a separate
/// future check; merely obtaining this context does not prove any prefix.
pub(super) struct MatchedLogReply {
    original: Arc<OriginalCall>,
}

impl<S: Store> Replica<S> {
    fn check_log_session(&self, session: &AuthenticatedLogSession) -> Result<(), LogSessionError> {
        if self.apply_fault {
            return Err(LogSessionError::ReopenRequired);
        }
        if session.0.collection != self.cfg.collection || session.0.endpoint != self.endpoint {
            return Err(LogSessionError::WrongBinding);
        }
        if !self
            .log_sessions
            .current
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(&current.0, &session.0))
        {
            return Err(LogSessionError::Stale);
        }
        Ok(())
    }

    /// Trusted HOST ONLY, after actual authenticated completion and its own
    /// post-await epoch check. Never expose this as an app RPC/ready boolean.
    /// Bootstrap/read recovery does not depend on epoch readiness or fresh head.
    pub fn bind_authenticated_log(
        &mut self,
        endpoint: EndpointId,
        collection: Uuid,
    ) -> Result<AuthenticatedLogSession, LogSessionError> {
        if self.apply_fault {
            return Err(LogSessionError::ReopenRequired);
        }
        if endpoint != self.endpoint || collection != self.cfg.collection {
            return Err(LogSessionError::WrongBinding);
        }
        if let Some(old) = self.log_sessions.current.clone() {
            self.retire_authenticated_log(&old);
        }
        if self.apply_fault {
            return Err(LogSessionError::ReopenRequired);
        }
        let session = AuthenticatedLogSession(Arc::new(SessionIdentity {
            collection,
            endpoint,
        }));
        self.log_sessions.current = Some(session.clone());
        self.dispatch_log_push(LogPush::Reconnected);
        Ok(session)
    }

    /// Retire ONLY this exact current session. Classify its original calls as
    /// unknown internally BEFORE replacement; do not reject old NoResponse via
    /// the current-session reply API or drop/re-plan the unknown append bytes.
    pub fn retire_authenticated_log(&mut self, session: &AuthenticatedLogSession) {
        if !self
            .log_sessions
            .current
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(&current.0, &session.0))
        {
            return;
        }
        self.log_sessions.current = None;
        let calls = std::mem::take(&mut self.log_sessions.calls);
        self.dispatch_log_push(LogPush::Disconnected);
        for id in calls.into_keys() {
            self.on_log_reply(id, Err(LogError::NoResponse));
        }
    }

    /// Capture the original scope BEFORE sending or awaiting. No scope is minted
    /// from a caller-supplied generation. Missing/retired binding leaves queued
    /// calls untouched so bootstrap can wait for genuine transport admission.
    pub fn take_authenticated_log_calls(
        &mut self,
        session: &AuthenticatedLogSession,
    ) -> Result<Vec<(LogCall, LogReplyScope)>, LogSessionError> {
        self.check_log_session(session)?;
        self.prune_hosted_uploads();
        // Check all queued routes before draining anything.
        if self
            .calls
            .iter()
            .any(|call| call.endpoint != session.0.endpoint)
        {
            return Err(LogSessionError::WrongBinding);
        }
        let captured_head = self.head;
        Ok(std::mem::take(&mut self.calls)
            .into_iter()
            .map(|call| {
                let original = Arc::new(OriginalCall {
                    session: session.clone(),
                    id: call.id,
                    method: call.request.method(),
                    read: match &call.request {
                        crate::log::LogRequest::Read(read) => Some(read.clone()),
                        _ => None,
                    },
                    captured_head,
                });
                self.log_sessions.calls.insert(call.id, original.clone());
                (call, LogReplyScope(original))
            })
            .collect())
    }

    /// Validate BEFORE invoking the host's decoder. The decoder gets immutable
    /// original ID/method, not event-supplied labels. Stale data is never decoded.
    pub fn on_authenticated_log_reply(
        &mut self,
        scope: LogReplyScope,
        decode: impl FnOnce(CallId, &'static str) -> LogReply,
    ) -> Result<(), LogSessionError> {
        self.check_log_session(&scope.0.session)?;
        self.prune_hosted_uploads();
        if !self
            .log_sessions
            .calls
            .get(&scope.0.id)
            .is_some_and(|original| Arc::ptr_eq(original, &scope.0))
            || !self.inflight.contains_key(&scope.0.id)
        {
            return Err(LogSessionError::Stale);
        }
        let reply = decode(scope.0.id, scope.0.method);
        let shape_ok = match &reply {
            Ok(response) => response_matches(scope.0.method, response),
            Err(_) => true,
        };
        self.log_sessions.calls.remove(&scope.0.id);
        if !shape_ok {
            self.on_log_reply(scope.0.id, Err(LogError::NoResponse));
            return Err(LogSessionError::WrongShape);
        }
        self.dispatch_log_reply(
            scope.0.id,
            reply,
            Some(MatchedLogReply { original: scope.0 }),
        );
        Ok(())
    }

    /// Current session is checked before decoding a push. Transport lifecycle
    /// events use bind/retire, never decoded remote Reconnected/Disconnected.
    pub fn on_authenticated_log_push(
        &mut self,
        session: &AuthenticatedLogSession,
        decode: impl FnOnce(Uuid) -> Result<LogPush, LogError>,
    ) -> Result<(), LogSessionError> {
        self.check_log_session(session)?;
        let push = decode(self.cfg.collection).map_err(|_| LogSessionError::WrongShape)?;
        let collection = match &push {
            LogPush::Items { collection, .. }
            | LogPush::Head { collection, .. }
            | LogPush::Closed { collection, .. }
            | LogPush::StreamMsg { collection, .. }
            | LogPush::StreamEvent { collection, .. } => *collection,
            LogPush::Reconnected | LogPush::Disconnected => {
                return Err(LogSessionError::WrongShape);
            }
        };
        if collection != self.cfg.collection {
            return Err(LogSessionError::WrongBinding);
        }
        self.dispatch_log_push(push);
        Ok(())
    }

    /// The exact current authenticated session, if any.
    pub(super) fn current_log_session(&self) -> Option<&AuthenticatedLogSession> {
        self.log_sessions.current.as_ref()
    }

    pub(super) fn retire_log_session_for_legacy_lifecycle(&mut self) {
        if let Some(session) = self.log_sessions.current.clone() {
            self.retire_authenticated_log(&session);
        }
    }

    pub(super) fn forget_log_reply_scope(&mut self, id: CallId) {
        self.log_sessions.calls.remove(&id);
    }

    pub(super) fn forget_log_session_for_repoint(&mut self) {
        self.log_sessions = State::default();
    }
}

fn response_matches(method: &str, response: &LogResponse) -> bool {
    matches!(
        (method, response),
        ("append", LogResponse::Append(_))
            | ("read", LogResponse::Read(_))
            | ("head", LogResponse::Head(_))
            | ("subscribe", LogResponse::Subscribed { .. })
            | ("put_object", LogResponse::PutObject { .. })
            | ("get_object", LogResponse::GetObject { .. })
            | ("has_objects", LogResponse::HasObjects(_))
            | ("put_snapshot", LogResponse::PutSnapshot(_))
            | ("get_snapshot", LogResponse::GetSnapshot(_))
            | ("endorse_snapshot", LogResponse::EndorseSnapshot(_))
            | ("stream_join", LogResponse::StreamJoined(_))
            | ("stream_send", LogResponse::StreamSent(_))
            | ("unsubscribe" | "stream_leave", LogResponse::Ok)
    )
}

pub(super) mod prefix;

#[cfg(test)]
mod tests;
