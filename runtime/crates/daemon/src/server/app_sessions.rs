//! App sessions over local IPC and the localhost link: the `session::Handler` implementation, link approval and native confirmation.

use super::*;

/// The only replica methods a localhost-link session may call (§12.4, allowlist):
/// data, holds, conflicts, files, presence and the editor fence. Anything
/// else, including device and grant approval, recovery, settings and any method
/// added later, is confirmed in the daemon's own UI and refused on the link.
pub const LINK_ALLOWED: &[&str] = &[
    "cancel",
    "submit",
    "await",
    "describe",
    "get",
    "query",
    "subscribe",
    "unsubscribe",
    "changes",
    "validate",
    "receipt",
    "get_status",
    "applied_prefix",
    "subscribe_status",
    "list_holds",
    "subscribe_holds",
    "resolve_hold",
    "list_conflicts",
    "subscribe_conflicts",
    "list_files",
    "get_file",
    "open_upload",
    "upload_chunk",
    "commit_upload",
    "abort_upload",
    "read_file",
    "ack_chunks",
    "fetch_file",
    "evict_file",
    "get_materialization",
    "set_materialization",
    "presence_join",
    "presence_update",
    "presence_leave",
    "subscribe_presence",
    "fence_report",
];

/// The keychain entry holding the link client key the user approved for a
/// collection (linked-client authorization).
fn link_client_secret(collection: &str) -> String {
    format!("link-client.{collection}")
}

/// Open a replica session on a runtime and bridge its frames to the transport.
pub(super) async fn open_on_runtime(
    daemon: Arc<Daemon>,
    collection: String,
    rt: Arc<crate::runtime::Runtime>,
    auth: crate::session::Auth,
    hello: mdbn_wire::client::ClientRequest,
    restricted: bool,
) -> crate::session::Opened {
    use crate::session::{Opened, SessionChannels, problem_response};
    use mdbn_wire::Wire;
    use mdbn_wire::client::ClientFrame;
    let id = hello.id;
    let refuse = |reason: crate::access::Refusal| Opened {
        response: mdbn_wire::client::ClientResponse {
            id,
            result: None,
            problem: Some(reason.problem()),
        },
        session: None,
    };
    if let Err(error) = daemon.authority.authorize_session(&collection, auth) {
        return refuse(error);
    }
    let replica_auth = match auth {
        crate::session::Auth::Host { .. } | crate::session::Auth::Link { .. } => {
            mdbn_replica::api::SessionAuth::Host
        }
        crate::session::Auth::Grant {
            grant, client_pk, ..
        } => mdbn_replica::api::SessionAuth::Grant {
            grant: mdbn_wire::common::B16(grant),
            client_pk,
        },
    };
    let mut changes = daemon.changes.subscribe();
    let Ok(bytes) = ClientFrame::Request(hello).to_bytes() else {
        return Opened {
            response: problem_response(id, "invalid_request", "bad_hello", "hello does not encode"),
            session: None,
        };
    };
    let Some((session, resp, mut out)) = rt.hello(replica_auth, bytes).await else {
        return Opened {
            response: problem_response(
                id,
                "unavailable",
                "runtime_stopped",
                "the collection stopped",
            ),
            session: None,
        };
    };
    let response = match ClientFrame::from_bytes(&resp) {
        Ok(ClientFrame::Response(r)) => r,
        _ => problem_response(id, "internal", "bad_response", "the replica answered badly"),
    };
    let Some(session) = session else {
        return Opened {
            response,
            session: None,
        };
    };
    if let Err(error) = daemon.authority.authorize_session(&collection, auth) {
        rt.close(session);
        return refuse(error);
    }
    let (in_tx, mut in_rx) = mpsc::channel::<ClientFrame>(64);
    let (out_tx, out_rx) = mpsc::channel::<ClientFrame>(64);
    let rt2 = rt.clone();
    tokio::spawn(async move {
        loop {
            let (frame, incoming) = tokio::select! {
                changed = changes.changed() => {
                    if changed.is_err() { break; }
                    (None, false)
                }
                frame = in_rx.recv() => match frame {
                    Some(frame) => (Some(frame), true),
                    None => break,
                },
                bytes = out.recv() => match bytes {
                    Some(bytes) => match ClientFrame::from_bytes(&bytes) {
                        Ok(frame) => (Some(frame), false),
                        Err(_) => break,
                    },
                    None => break,
                },
            };
            let terminal = !incoming
                && matches!(&frame, Some(ClientFrame::Push(push)) if push.kind == "closed");
            if !terminal && let Err(reason) = daemon.authority.authorize_session(&collection, auth)
            {
                let problem = reason.problem();
                if let (Some(ClientFrame::Request(request)), true) = (&frame, incoming) {
                    let _ = out_tx
                        .send(ClientFrame::Response(mdbn_wire::client::ClientResponse {
                            id: request.id,
                            result: None,
                            problem: Some(problem.clone()),
                        }))
                        .await;
                }
                let _ = out_tx
                    .send(ClientFrame::Push(mdbn_wire::client::ClientPush {
                        kind: "closed".into(),
                        payload: problem.to_cbor(),
                    }))
                    .await;
                break;
            }
            match (frame, incoming) {
                (Some(ClientFrame::Request(r)), true)
                    if restricted && !LINK_ALLOWED.contains(&r.method.as_str()) =>
                {
                    let resp = crate::session::problem_response(
                        r.id,
                        "forbidden",
                        "confirm_in_daemon_ui",
                        "approvals and recovery are confirmed in mdbase's own window",
                    );
                    if out_tx.send(ClientFrame::Response(resp)).await.is_err() {
                        break;
                    }
                }
                (Some(f), true) => match f.to_bytes() {
                    Ok(b) => {
                        if !rt2.frame(session, b) {
                            break;
                        }
                    }
                    Err(_) => break,
                },
                (Some(f), false) => {
                    if out_tx.send(f).await.is_err() {
                        break;
                    }
                    if terminal {
                        break;
                    }
                }
                (None, _) => continue,
            }
        }
        rt2.close(session);
    });
    Opened {
        response,
        session: Some(SessionChannels {
            inbound: in_tx,
            outbound: out_rx,
        }),
    }
}

impl crate::session::Handler for Daemon {
    fn open<'a>(
        &'a self,
        prologue: crate::session::Prologue,
        auth: crate::session::Auth,
        hello: mdbn_wire::client::ClientRequest,
    ) -> crate::session::BoxFuture<'a, crate::session::Opened> {
        use crate::session::{Opened, problem_response};
        Box::pin(async move {
            let id = secrets::uuid_string(&prologue.collection);
            let refuse = |code: &str, reason: &str, message: &str| Opened {
                response: problem_response(hello.id, code, reason, message),
                session: None,
            };
            if !self.is_ready() {
                return refuse("unavailable", "not_ready", "the daemon is not ready");
            }
            // the hosting app proves the keychain-derived host key. Any
            // other process of the user must hold a grant, so its writes are
            // attributed to that grant. Checked before the collection lookup so a
            // keyless process learns nothing about which collections are hosted.
            if let crate::session::Auth::Host { client_pk } = auth {
                let ok = self.control_key.get().is_some_and(|k| {
                    crate::noise::public_key(&secrets::host_noise_secret(k)) == client_pk
                });
                if !ok {
                    return refuse(
                        "forbidden",
                        "host_key_required",
                        "a session without a grant needs this computer's host key",
                    );
                }
            }
            let inner = self.inner.lock().await;
            let Some(host) = inner.hosts.iter().find(|h| h.entry().id == id) else {
                return refuse(
                    "not_found",
                    "unknown_collection",
                    "this daemon does not host that collection",
                );
            };
            let source = match self
                .authority
                .source(mdbn_wire::common::B16(prologue.collection))
            {
                Ok(source) => source,
                Err(reason) => {
                    return refuse(
                        "forbidden",
                        reason.reason(),
                        "no authenticated collection authority",
                    );
                }
            };
            // Synced authority belongs to the verified replica policy, never owner metadata.
            if host.entry().mode == SyncMode::Local
                && let Err(reason) = source.authorize(None)
            {
                return refuse(
                    "forbidden",
                    reason.reason(),
                    "collection is not authorized for this account",
                );
            }
            if let Err(reason) = self.authority.authorize_session(&id, auth) {
                return Opened {
                    response: mdbn_wire::client::ClientResponse {
                        id: hello.id,
                        result: None,
                        problem: Some(reason.problem()),
                    },
                    session: None,
                };
            }
            let (true, Some(rt)) = (host.is_serving(), host.runtime()) else {
                let s = host.status();
                if s.reason.as_deref() == Some("collection_deleted") {
                    let mut closed = refuse(
                        "forbidden",
                        "collection_deleted",
                        "the collection was deleted by its owner",
                    );
                    closed
                        .response
                        .problem
                        .as_mut()
                        .expect("refusal has a problem")
                        .recovery = mdbn_wire::client::Recovery::None;
                    return closed;
                }
                if s.reason.as_deref() == Some("sync_revoked") {
                    return refuse(
                        "forbidden",
                        "sync_revoked",
                        "this computer was removed from this collection and can no longer sync it",
                    );
                }
                return refuse(
                    "unavailable",
                    s.reason.as_deref().unwrap_or("not_serving"),
                    "the collection is not being served",
                );
            };
            let name = host.entry().name.clone();
            drop(inner);
            if let crate::session::Auth::Link { client_pk } = auth
                && let Err(e) = self.link_authorized(&id, &name, &client_pk).await
            {
                return refuse(
                    &e.code,
                    e.reason.as_deref().unwrap_or("link_not_approved"),
                    &e.message,
                );
            }
            let restricted = matches!(auth, crate::session::Auth::Link { .. });
            open_on_runtime(
                self.arc().expect("daemon owns its session"),
                id,
                rt,
                auth,
                hello,
                restricted,
            )
            .await
        })
    }
}

impl Daemon {
    /// A localhost-link session serves only a collection the user linked to
    /// that client key, on this computer's screen. The approved key is kept in
    /// the OS keychain (as the host key), never in a file; the link file's
    /// token alone (readable by any process of the user) is not enough. A new or
    /// changed key asks again; one prompt at a time.
    async fn link_authorized(
        &self,
        collection: &str,
        name: &str,
        client_pk: &[u8; 32],
    ) -> Result<(), ControlError> {
        let secret = link_client_secret(collection);
        let unavailable = |e: secrets::SecretError| {
            ControlError::unavailable("keychain_unavailable", e.to_string())
        };
        if let Some(k) = self.secrets.get(&secret).map_err(unavailable)?
            && ct_eq(&k, client_pk)
        {
            return Ok(());
        }
        let Ok(_prompt) = self.link_prompt.try_lock() else {
            return Err(ControlError::unavailable(
                "link_prompt_busy",
                "another link request is waiting for confirmation",
            ));
        };
        self.confirm(&crate::confirm::Prompt::LinkObsidian {
            collection: name.to_owned(),
        })
        .await
        .map_err(|e| {
            ControlError::new(
                "forbidden",
                "link_not_approved",
                format!(
                    "linking was not confirmed ({})",
                    e.reason.unwrap_or_default()
                ),
            )
        })?;
        self.secrets.set(&secret, client_pk).map_err(unavailable)?;
        Ok(())
    }

    /// Replace how confirmations are asked (tests). Nothing on the control
    /// endpoint can: a confirmation is trusted only because the daemon starts the
    /// dialog process itself ([`crate::confirm`]).
    #[cfg(test)]
    pub(crate) fn set_confirmer(&self, c: Arc<dyn crate::confirm::Confirmer>) {
        *self.confirmer.write().unwrap_or_else(|p| p.into_inner()) = c;
    }

    /// Ask the user on screen; refuse unless they confirm.
    pub(super) async fn confirm(
        &self,
        prompt: &crate::confirm::Prompt,
    ) -> Result<(), ControlError> {
        use crate::confirm::Answer;
        let c = self
            .confirmer
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        match c.ask(prompt).await {
            Answer::Yes => Ok(()),
            Answer::No => Err(ControlError::new(
                "forbidden",
                "not_confirmed",
                "not confirmed on this computer's screen",
            )),
            Answer::Unavailable => Err(ControlError::unavailable(
                "confirmation_unavailable",
                "this needs a confirmation on this computer's screen, and none could be shown; \
                 install the mdbase connect app on this computer and try again from its desktop",
            )),
        }
    }
}
