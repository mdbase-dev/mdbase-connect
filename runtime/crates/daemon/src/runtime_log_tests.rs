//! Synthetic host-boundary races through the production native delivery helpers.
//! No real TLS, CP/current-prefix certificate, OS custody or power-cut claim.
use super::*;
use crate::log_generation::Generation;
use crate::logwire::tests::{epoch_source, fixture_replica};
use crate::logwire::{Event, Session};
use mdbn_replica::log::{LogError, LogPush, LogResponse};
use mdbn_replica::replica::{LogReplyScope, LogSessionError};
use mdbn_wire::common::{B16, B32};
use std::cell::Cell;
use std::sync::atomic::Ordering;

const COL: B16 = B16([0x0c; 16]);
type Rep = Replica<mdbn_replica::mem::MemStore>;
fn up(rep: &mut Rep, active: &mut Option<Session>, generation: Generation) -> Session {
    let (tx, mut rx) = tokio::sync::oneshot::channel();
    on_log_event(
        rep,
        COL,
        active,
        Event::Up {
            generation,
            reply: tx,
        },
    );
    rx.try_recv().unwrap().unwrap()
}
fn scope(rep: &mut Rep, session: &Session) -> LogReplyScope {
    rep.tick();
    rep.take_authenticated_log_calls(session.authenticated())
        .unwrap()
        .into_iter()
        .find(|(call, _)| call.request.method() == "subscribe")
        .expect("bootstrap subscribe call")
        .1
}
fn head() -> mdbn_replica::log::LogReply {
    Ok(LogResponse::Subscribed {
        head: 700,
        head_chain: B32([9; 32]),
    })
}
#[test]
fn old_down_and_old_replies_cannot_retire_or_decode_new_binding() {
    let mut rep = fixture_replica();
    let (source, _) = epoch_source();
    let mut active = None;
    let old = up(&mut rep, &mut active, Generation::begin(source.clone()));
    let old_scope = scope(&mut rep, &old);
    let new = up(&mut rep, &mut active, Generation::begin(source));
    let new_scope = scope(&mut rep, &new);
    on_log_event(&mut rep, COL, &mut active, Event::Down(old.clone()));
    assert!(active.as_ref().unwrap().same(&new));
    let decoded = Cell::new(0);
    assert_eq!(
        deliver_log_reply(&mut rep, &old, old_scope, |_, _| {
            decoded.set(decoded.get() + 1);
            head()
        }),
        Err(LogSessionError::Stale)
    );
    assert_eq!(
        deliver_log_push(&mut rep, &old, |_| {
            decoded.set(decoded.get() + 1);
            Ok(LogPush::Head {
                collection: COL,
                head: 700,
                head_chain: B32([9; 32]),
            })
        }),
        Err(LogSessionError::Stale)
    );
    assert_eq!(decoded.get(), 0);
    assert_eq!(rep.sync_status().head_known, 0);
    deliver_log_reply(&mut rep, &new, new_scope, |_, method| {
        assert_eq!(method, "subscribe");
        decoded.set(decoded.get() + 1);
        head()
    })
    .unwrap();
    assert_eq!(decoded.get(), 1);
    assert_eq!(rep.sync_status().head_known, 700);
}
#[test]
fn stale_source_denies_decoder_entry_and_postdecode_result() {
    for during in [false, true] {
        let mut rep = fixture_replica();
        let (source, epoch) = epoch_source();
        let mut active = None;
        let session = up(&mut rep, &mut active, Generation::begin(source));
        let call = scope(&mut rep, &session);
        if !during {
            epoch.store(2, Ordering::SeqCst);
        }
        let decoded = Cell::new(0);
        let _ = deliver_log_reply(&mut rep, &session, call, |_, _| {
            decoded.set(decoded.get() + 1);
            epoch.store(2, Ordering::SeqCst);
            head()
        });
        assert_eq!(decoded.get(), usize::from(during));
        assert_eq!(rep.sync_status().head_known, 0);
        let push_decoded = Cell::new(false);
        assert_eq!(
            deliver_log_push(&mut rep, &session, |_| {
                push_decoded.set(true);
                Err(LogError::NoResponse)
            }),
            Err(LogSessionError::Stale)
        );
        assert!(!push_decoded.get());
        retire_stale_log(&mut rep, &mut active);
        assert!(active.is_none());
    }
}
#[test]
fn source_change_during_push_decode_does_not_apply_it() {
    let mut rep = fixture_replica();
    let (source, epoch) = epoch_source();
    let mut active = None;
    let session = up(&mut rep, &mut active, Generation::begin(source));
    let decoded = Cell::new(false);
    assert_eq!(
        deliver_log_push(&mut rep, &session, |_| {
            decoded.set(true);
            epoch.store(2, Ordering::SeqCst);
            Ok(LogPush::Head {
                collection: COL,
                head: 700,
                head_chain: B32([9; 32]),
            })
        }),
        Err(LogSessionError::WrongShape)
    );
    assert!(decoded.get());
    assert_eq!(rep.sync_status().head_known, 0);
}
#[test]
fn cancelled_up_handback_and_stale_up_leave_no_binding() {
    for stale in [false, true] {
        let mut rep = fixture_replica();
        let (source, epoch) = epoch_source();
        let mut active = None;
        let (tx, rx) = tokio::sync::oneshot::channel();
        if stale {
            epoch.store(2, Ordering::SeqCst);
        }
        drop(rx);
        on_log_event(
            &mut rep,
            COL,
            &mut active,
            Event::Up {
                generation: Generation::begin(source),
                reply: tx,
            },
        );
        assert!(active.is_none());
    }
}
#[test]
fn native_event_labels_never_relabel_original_scope_and_scope_is_one_shot() {
    let mut rep = fixture_replica();
    let (source, _) = epoch_source();
    let mut active = None;
    let session = up(&mut rep, &mut active, Generation::begin(source));
    use mdbn_wire::{
        log_service::{LsFrame, LsResponse},
        schema::Wire,
    };
    rep.tick();
    let (original, call) = rep
        .take_authenticated_log_calls(session.authenticated())
        .unwrap()
        .into_iter()
        .find(|(c, _)| c.request.method() == "subscribe")
        .expect("bootstrap subscribe call");
    let reply = LsFrame::Response(LsResponse {
        id: original.id.0,
        result: Some(mdbn_wire::cbor::Cbor::Map(vec![
            (
                mdbn_wire::cbor::Cbor::Uint(0),
                mdbn_wire::cbor::Cbor::Uint(700),
            ),
            (mdbn_wire::cbor::Cbor::Uint(1), B32([9; 32]).to_cbor()),
        ])),
        error: None,
    })
    .to_bytes()
    .unwrap();
    on_log_event(
        &mut rep,
        COL,
        &mut active,
        Event::Reply {
            id: u64::MAX,
            method: "caller-label-invalid".into(),
            bytes: reply,
            budget: crate::logwire::Budget::none(),
            scope: call.clone(),
            session: session.clone(),
        },
    );
    assert_eq!(rep.sync_status().head_known, 700);
    let decoded = Cell::new(0);
    assert_eq!(
        deliver_log_reply(&mut rep, &session, call.clone(), |_, _| {
            decoded.set(decoded.get() + 1);
            head()
        }),
        Err(LogSessionError::Stale)
    );
    assert_eq!(decoded.get(), 0);
    // A fresh binding gives a fresh original call; its scope is consumed once.
    let (source, _) = epoch_source();
    let session = up(&mut rep, &mut active, Generation::begin(source));
    let call = scope(&mut rep, &session);
    deliver_log_reply(&mut rep, &session, call.clone(), |id, method| {
        assert_ne!(id.0, u64::MAX);
        assert_eq!(method, "subscribe");
        decoded.set(decoded.get() + 1);
        head()
    })
    .unwrap();
    assert_eq!(
        deliver_log_reply(&mut rep, &session, call, |_, _| {
            decoded.set(decoded.get() + 1);
            head()
        }),
        Err(LogSessionError::Stale)
    );
    assert_eq!(decoded.get(), 1);
}
