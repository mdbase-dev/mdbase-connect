//! One connection: frame decoding, `hello`, method dispatch, and the
//! connection-level methods (subscriptions §9, ephemeral streams §8).
//!
//! Hosts (the Postgres gateway, the Durable Object) own sockets and timers; they
//! call [`handle_frame`] for every inbound frame and [`close`] when a socket closes.

use std::collections::BTreeSet;

use mdbn_wire::cbor::Cbor;
use mdbn_wire::common::{B32, Uuid, Version};
use mdbn_wire::log_service::{
    LsFrame, LsHelloParams, LsHelloResult, LsRequest, LsResponse, StreamRef, StreamSendParams,
    SubscribeParams,
};
use mdbn_wire::schema::Wire;

use crate::auth::{Principal, verify_hello_with_budget};
use crate::backend::{Backend, ObjectStore};
use crate::decode::Budget;
use crate::error::{Code, Result, ServiceError};
use crate::hub::{Hub, Push, SessionId};
use crate::model::CommitNotice;
use crate::service::Service;

/// What a host provides to sessions.
pub trait HubHost {
    /// Run `f` on the hub of collection `c` (creating it if needed).
    fn with_hub<R>(&self, c: &Uuid, f: impl FnOnce(&mut Hub) -> R) -> R;
    /// Deliver pushes to sessions (possibly other connections).
    fn deliver(&self, pushes: Vec<Push>);
    /// A call on this host committed. The DO pushes from here; the Postgres gateway
    /// ignores it and pushes from `LISTEN` instead, so every gateway sees every commit.
    fn committed(&self, notice: &CommitNotice, items: &[(u64, Vec<u8>)]);
    /// A device's credentials were revoked (§12): close its sessions here.
    fn credentials_revoked(&self, _device: &Uuid) {}
    /// A repair append committed: log it and count it.
    fn repair_append(&self, _r: &crate::service::RepairAppend) {}
}

/// Per-connection state.
#[derive(Debug, Clone)]
pub struct Session {
    /// Session ID.
    pub id: SessionId,
    /// Set by `hello`.
    pub principal: Option<Principal>,
    /// The nonce the client must sign in its next `hello`.
    pub nonce: [u8; 32],
    /// Collections with hub state for this session.
    pub collections: BTreeSet<Uuid>,
}

impl Session {
    /// A new session; `nonce` goes to the client in the upgrade response.
    pub fn new(id: SessionId, nonce: [u8; 32]) -> Self {
        Session {
            id,
            principal: None,
            nonce,
            collections: BTreeSet::new(),
        }
    }

    fn device(&self) -> Option<Uuid> {
        match self.principal {
            Some(Principal::Device { id, .. }) => Some(id),
            _ => None,
        }
    }
}

fn response(id: u64, r: Result<Cbor>) -> Vec<u8> {
    let resp = match r {
        Ok(v) => LsResponse {
            id,
            result: Some(v),
            error: None,
        },
        Err(e) => LsResponse {
            id,
            result: None,
            error: Some(e.to_wire()),
        },
    };
    LsFrame::Response(resp)
        .to_bytes()
        .expect("response encodes")
}

fn map(entries: Vec<(u64, Cbor)>) -> Cbor {
    Cbor::Map(
        entries
            .into_iter()
            .map(|(k, v)| (Cbor::Uint(k), v))
            .collect(),
    )
}

/// Handle one inbound frame; returns the response frame (if the frame was a request).
/// `fresh_nonce` becomes the session's next nonce after a successful `hello`.
pub async fn handle_frame<B: Backend, O: ObjectStore, H: HubHost>(
    svc: &Service<B, O>,
    host: &H,
    sess: &mut Session,
    frame: &[u8],
    now: i64,
    fresh_nonce: [u8; 32],
) -> Option<Vec<u8>> {
    handle_frame_with_budget(svc, host, sess, frame, now, fresh_nonce, &Budget::default()).await
}

/// Handle a frame using a budget created by the transport at admission.
pub async fn handle_frame_with_budget<B: Backend, O: ObjectStore, H: HubHost>(
    svc: &Service<B, O>,
    host: &H,
    sess: &mut Session,
    frame: &[u8],
    now: i64,
    fresh_nonce: [u8; 32],
    budget: &Budget,
) -> Option<Vec<u8>> {
    let req = match budget.wire::<LsFrame>(frame) {
        Ok(LsFrame::Request(r)) => r,
        Err(e) => return Some(response(0, Err(e))),
        _ => {
            return Some(response(
                0,
                Err(ServiceError::invalid("shape").msg("not a request frame")),
            ));
        }
    };
    handle_request(svc, host, sess, &req, now, fresh_nonce, budget).await
}

/// Dispatch an already budgeted frame without re-decoding it for routing/metrics.
pub async fn handle_request<B: Backend, O: ObjectStore, H: HubHost>(
    svc: &Service<B, O>,
    host: &H,
    sess: &mut Session,
    req: &LsRequest,
    now: i64,
    fresh_nonce: [u8; 32],
    budget: &Budget,
) -> Option<Vec<u8>> {
    let scoped = svc.scoped(budget);
    let r = dispatch(
        &scoped,
        host,
        sess,
        &req.method,
        &req.params,
        now,
        fresh_nonce,
        budget,
    )
    .await;
    Some(response(req.id, r))
}

async fn dispatch<B: Backend, O: ObjectStore, H: HubHost>(
    svc: &Service<B, O>,
    host: &H,
    sess: &mut Session,
    method: &str,
    params: &Cbor,
    now: i64,
    fresh_nonce: [u8; 32],
    budget: &Budget,
) -> Result<Cbor> {
    let bad =
        |e: mdbn_wire::SchemaError| ServiceError::invalid("shape").msg(format!("params: {e}"));
    if method == "hello" {
        let p = LsHelloParams::from_cbor(params).map_err(bad)?;
        let principal =
            verify_hello_with_budget(&p, &sess.nonce, &svc.config.token_issuers, now, budget)?;
        svc.check_credentials(&principal, now, true).await?;
        sess.principal = Some(principal);
        sess.nonce = fresh_nonce;
        return Ok(LsHelloResult {
            version: Version { major: 1, minor: 0 },
            server_nonce: B32(fresh_nonce),
        }
        .to_cbor());
    }
    let Some(principal) = sess.principal else {
        return Err(ServiceError::reason(Code::Unauthenticated, "hello"));
    };
    svc.check_credentials(&principal, now, false).await?;
    match method {
        "subscribe" => {
            let p = SubscribeParams::from_cbor(params).map_err(bad)?;
            // Authorize first (no pushes before the check). Then register,
            // then read the head: a commit racing the subscription is either in the
            // head read or pushed, never neither.
            svc.authorize_device(&principal, &p.collection).await?;
            let dev = sess.device();
            host.with_hub(&p.collection, |hub| {
                hub.subscribe(sess.id, dev, p.inline_bytes)
            });
            let h = match svc.head(&principal, &p.collection).await {
                Ok(h) => h,
                Err(e) => {
                    host.with_hub(&p.collection, |hub| hub.unsubscribe(sess.id));
                    return Err(e);
                }
            };
            sess.collections.insert(p.collection);
            Ok(map(vec![
                (0, Cbor::Uint(h.head)),
                (1, Cbor::Bytes(h.head_chain.0.to_vec())),
            ]))
        }
        "unsubscribe" => {
            let c = match params {
                Cbor::Map(m) => m
                    .iter()
                    .find(|(k, _)| *k == Cbor::Uint(0))
                    .and_then(|(_, v)| Uuid::from_cbor(v).ok()),
                _ => None,
            }
            .ok_or_else(|| ServiceError::invalid("shape"))?;
            host.with_hub(&c, |hub| hub.unsubscribe(sess.id));
            Ok(map(vec![]))
        }
        "stream_join" => {
            let p = StreamRef::from_cbor(params).map_err(bad)?;
            let Some(dev) = svc.authorize_device(&principal, &p.collection).await? else {
                return Err(ServiceError::reason(Code::Forbidden, "principal"));
            };
            let (others, pushes) =
                host.with_hub(&p.collection, |hub| hub.join(sess.id, dev, p.stream, now))?;
            sess.collections.insert(p.collection);
            host.deliver(pushes);
            Ok(map(vec![(
                0,
                Cbor::Array(others.iter().map(|d| d.to_cbor()).collect()),
            )]))
        }
        "stream_leave" => {
            let p = StreamRef::from_cbor(params).map_err(bad)?;
            let pushes = host.with_hub(&p.collection, |hub| hub.leave(sess.id, &p.stream));
            host.deliver(pushes);
            Ok(map(vec![]))
        }
        "stream_send" => {
            let p = StreamSendParams::from_cbor(params).map_err(bad)?;
            let (n, pushes) = host.with_hub(&p.collection, |hub| {
                hub.send_with_budget(sess.id, p.stream, p.message.0, now, budget)
            })?;
            host.deliver(pushes);
            Ok(map(vec![(0, Cbor::Uint(n))]))
        }
        _ => {
            let out = svc
                .call_with_budget(&principal, method, params, now, budget)
                .await?;
            if let Some(n) = &out.notice {
                host.committed(n, &out.items);
            }
            if let Some(d) = &out.credentials_revoked {
                host.credentials_revoked(d);
            }
            if let Some(r) = &out.repair {
                host.repair_append(r);
            }
            Ok(out.result)
        }
    }
}

/// The connection closed: leave every stream and subscription.
pub fn close<H: HubHost>(host: &H, sess: &Session) {
    for c in &sess.collections {
        let pushes = host.with_hub(c, |hub| hub.disconnect(sess.id));
        host.deliver(pushes);
    }
}
