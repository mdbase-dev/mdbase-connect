//! Log delivery: binding, fencing and retiring log sessions, replies, pushes and outbound calls.

use super::*;

/// Retire stale transport authority before any command/output after a wake.
pub(super) fn retire_stale_log<S: mdbn_replica::store::Store>(
    rep: &mut Replica<S>,
    active: &mut Option<crate::logwire::Session>,
) {
    if active.as_ref().is_some_and(|s| s.check().is_err())
        && let Some(old) = active.take()
    {
        rep.retire_authenticated_log(old.authenticated());
    }
}

/// Fence the native source and the portable original call before decoder entry.
pub(super) fn deliver_log_reply<S: mdbn_replica::store::Store>(
    rep: &mut Replica<S>,
    session: &crate::logwire::Session,
    scope: mdbn_replica::replica::LogReplyScope,
    decode: impl FnOnce(mdbn_replica::log::CallId, &'static str) -> mdbn_replica::log::LogReply,
) -> Result<(), mdbn_replica::replica::LogSessionError> {
    use mdbn_replica::{log::LogError, replica::LogSessionError};
    if session.check().is_err() {
        rep.retire_authenticated_log(session.authenticated());
        return Err(LogSessionError::Stale);
    }
    let result = rep.on_authenticated_log_reply(scope, |id, method| {
        if session.check().is_err() {
            return Err(LogError::NoResponse);
        }
        let decoded = decode(id, method);
        if session.check().is_err() {
            return Err(LogError::NoResponse);
        }
        decoded
    });
    if session.check().is_err() {
        rep.retire_authenticated_log(session.authenticated());
    }
    result
}
pub(super) fn deliver_log_push<S: mdbn_replica::store::Store>(
    rep: &mut Replica<S>,
    session: &crate::logwire::Session,
    decode: impl FnOnce(B16) -> Result<mdbn_replica::log::LogPush, mdbn_replica::log::LogError>,
) -> Result<(), mdbn_replica::replica::LogSessionError> {
    use mdbn_replica::{log::LogError, replica::LogSessionError};
    if session.check().is_err() {
        rep.retire_authenticated_log(session.authenticated());
        return Err(LogSessionError::Stale);
    }
    let result = rep.on_authenticated_log_push(session.authenticated(), |collection| {
        if session.check().is_err() {
            return Err(LogError::Offline);
        }
        let decoded = decode(collection);
        if session.check().is_err() {
            return Err(LogError::Offline);
        }
        decoded
    });
    if session.check().is_err() {
        rep.retire_authenticated_log(session.authenticated());
    }
    result
}

/// Deliver only the original opaque scope, checking the native producer BEFORE
/// decoding and again afterwards. No event-provided ID/method can relabel it.
pub(super) fn on_log_event<S: mdbn_replica::store::Store>(
    rep: &mut Replica<S>,
    collection: B16,
    active: &mut Option<crate::logwire::Session>,
    e: crate::logwire::Event,
) {
    use crate::logwire::{Event, Session};
    use mdbn_replica::log::{EndpointId, LogError};
    retire_stale_log(rep, active);
    match e {
        Event::Up { generation, reply } => {
            if generation.check().is_err() {
                let _ = reply.send(None);
                return;
            }
            let Ok(authenticated) = rep.bind_authenticated_log(EndpointId(1), collection) else {
                let _ = reply.send(None);
                return;
            };
            let session = Session::bind(generation, authenticated);
            if session.check().is_err() {
                rep.retire_authenticated_log(session.authenticated());
                let _ = reply.send(None);
                return;
            }
            *active = Some(session.clone());
            if reply.send(Some(session.clone())).is_err() {
                rep.retire_authenticated_log(session.authenticated());
                *active = None;
            }
        }
        Event::Down(session) | Event::Lost { session, .. } => {
            rep.retire_authenticated_log(session.authenticated());
            if active.as_ref().is_some_and(|s| s.same(&session)) {
                *active = None;
            }
        }
        Event::Offline { scope, session, .. } => {
            if session.check().is_ok() {
                let _ = rep.on_authenticated_log_reply(scope, |_, _| Err(LogError::Offline));
            } else {
                rep.retire_authenticated_log(session.authenticated());
            }
        }
        Event::Reply {
            scope,
            session,
            bytes,
            ..
        } => {
            let _ = deliver_log_reply(rep, &session, scope, |id, method| {
                let decoded = mdbn_replica::log_codec::reply(id, method, &bytes)
                    .unwrap_or(Err(LogError::NoResponse));
                match &decoded {
                    Ok(r) => tracing::debug!(id = id.0, method, reply = %short(r), "log reply"),
                    Err(e) => tracing::debug!(id = id.0, method, error = %e, "log reply"),
                }
                decoded
            });
        }
        Event::Push(bytes, _budget, session) => {
            let _ = deliver_log_push(rep, &session, |collection| {
                mdbn_replica::log_codec::push(collection, &bytes).map_err(|_| LogError::NoResponse)
            });
        }
        Event::Proof {
            nonce,
            token,
            generation,
            reply,
        } => {
            if generation.check().is_err() {
                let _ = reply.send(None);
                return;
            }
            let proof = rep
                .log_hello_proof(nonce, &token)
                .inspect_err(|e| tracing::warn!(error = ?e, "log hello proof not signed"))
                .ok()
                .map(|s| s.0);
            let _ = reply.send(if generation.check().is_ok() {
                proof
            } else {
                None
            });
        }
    }
    retire_stale_log(rep, active);
}

/// A one-line, content-free summary of a log reply for debug logs.
fn short(r: &mdbn_replica::log::LogResponse) -> String {
    use mdbn_replica::log::LogResponse as R;
    match r {
        R::Append(a) => format!("append {a:?}").chars().take(120).collect(),
        R::Read(r) => format!(
            "read {} items head {} more {}",
            r.items.len(),
            r.head,
            r.more
        ),
        R::Head(h) => format!("head {}", h.head),
        R::Subscribed { head, .. } => format!("subscribed head {head}"),
        other => format!("{:?}", std::mem::discriminant(other)),
    }
}

/// Send the replica's queued log calls through the transport.
pub(super) fn send_log_calls(
    rep: &mut Replica<Store>,
    link: &crate::logwire::Link,
    active: &mut Option<crate::logwire::Session>,
) {
    use mdbn_replica::log::LogError;
    retire_stale_log(rep, active);
    let Some(session) = active.as_ref().cloned() else {
        return;
    };
    let Ok(calls) = rep.take_authenticated_log_calls(session.authenticated()) else {
        return;
    };
    for (c, scope) in calls {
        if session.check().is_err() {
            rep.retire_authenticated_log(session.authenticated());
            break;
        }
        let sent = match mdbn_replica::log_codec::request(&c) {
            Ok(frame) => {
                let method = c.request.method().into();
                // Over the inline limit, the sealed bytes are not in the frame:
                // they go beside it for a direct upload (log-service-api §6).
                let object = match c.request {
                    mdbn_replica::log::LogRequest::PutObject {
                        collection,
                        address,
                        bytes,
                        ..
                    } if bytes.len() > mdbn_replica::log_codec::INLINE_OBJECT_MAX => {
                        Some(crate::logwire::SealedObject {
                            collection,
                            address,
                            bytes: bytes.into(),
                        })
                    }
                    _ => None,
                };
                link.send(crate::logwire::Outbound {
                    id: c.id.0,
                    method,
                    frame,
                    object,
                    scope: scope.clone(),
                    session: session.clone(),
                })
            }
            Err(_) => false,
        };
        if !sent {
            if session.check().is_ok() {
                let _ = rep.on_authenticated_log_reply(scope, |_, _| Err(LogError::Offline));
            } else {
                rep.retire_authenticated_log(session.authenticated());
                break;
            }
        }
    }
    retire_stale_log(rep, active);
}
