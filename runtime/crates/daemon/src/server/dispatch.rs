//! The control endpoint: per-connection serving, caller authentication and method dispatch.

use super::*;

impl Daemon {
    /// [`Self::handle`], then log what a successful call changed.
    pub(super) async fn handle_and_note(
        self: &Arc<Self>,
        req: &Request,
        conn: &mut ConnAuth,
    ) -> Result<Value, ControlError> {
        let prior = self
            .collection_name(req.params.get("collection").and_then(Value::as_str))
            .await;
        let v = self.handle(req, conn).await?;
        self.note_control_call(req, &v, prior).await;
        Ok(v)
    }

    pub(super) async fn handle(
        self: &Arc<Self>,
        req: &Request,
        conn: &mut ConnAuth,
    ) -> Result<Value, ControlError> {
        match req.method.as_str() {
            Method::AUTH_CHALLENGE => {
                if self.control_key.get().is_none() {
                    self.credential_retry.notify_one();
                    let mut r = self.readiness.subscribe();
                    let _ = tokio::time::timeout(
                        CREDENTIAL_RETRY_WAIT,
                        r.wait_for(|r| r.safe_reason != Some(NotReady::CredentialStoreUnavailable)),
                    )
                    .await;
                }
                let mut n = [0u8; 32];
                getrandom::fill(&mut n).map_err(|e| ControlError::internal(e.to_string()))?;
                conn.nonce = Some(n);
                return Ok(json!({ "nonce": secrets::hex(&n) }));
            }
            Method::AUTH_PROVE => {
                let nonce = conn.nonce.take().ok_or_else(|| {
                    ControlError::invalid("no_challenge", "call auth.challenge first")
                })?;
                let proof = req
                    .params
                    .get("proof")
                    .and_then(Value::as_str)
                    .and_then(|h| secrets::hex_decode(h).ok())
                    .unwrap_or_default();
                let key = self.control_key.get().ok_or_else(|| {
                    ControlError::unavailable("not_ready", "the control key is not loaded")
                })?;
                let want = secrets::control_proof(key, &nonce);
                if !ct_eq(&proof, &want) {
                    tracing::warn!("control caller failed authentication");
                    return Err(ControlError::new(
                        "unauthenticated",
                        "bad_proof",
                        "control authentication failed",
                    ));
                }
                conn.privileged = true;
                return Ok(json!({}));
            }
            m if crate::control::PRIVILEGED.contains(&m) && !conn.privileged => {
                return Err(ControlError::new(
                    "forbidden",
                    "caller_not_authenticated",
                    format!("{m} needs an authenticated caller (auth.challenge, auth.prove)"),
                ));
            }
            _ => {}
        }
        let always = matches!(
            req.method.as_str(),
            Method::PING
                | Method::STATUS
                | Method::STATUS_SUBSCRIBE
                | Method::SHUTDOWN
                | Method::DOCTOR
        );
        if !always && !self.is_ready() {
            let r = self.readiness.borrow().clone();
            return Err(ControlError::unavailable(
                "not_ready",
                format!(
                    "the daemon is not ready ({})",
                    r.safe_reason
                        .map(|s| serde_json::to_value(s).unwrap_or_default())
                        .and_then(|v| v.as_str().map(str::to_string))
                        .unwrap_or_else(|| "unknown".into())
                ),
            ));
        }
        match req.method.as_str() {
            Method::PING => Ok(json!({ "readiness": *self.readiness.borrow() })),
            Method::STATUS | Method::STATUS_SUBSCRIBE => to_value(&self.status().await),
            // `serve_control` stops the daemon once this reply is queued.
            Method::SHUTDOWN => Ok(json!({})),
            Method::COLLECTION_LIST => {
                let inner = self.inner.lock().await;
                let taken = self.takeover_record();
                let mut collections = Vec::with_capacity(inner.hosts.len());
                for host in &inner.hosts {
                    collections.push(with_private_sync_pending(
                        with_takeover_holds(
                            with_access_notices(host.observed_status().await, &inner.access),
                            taken.as_ref(),
                        ),
                        &self.auto_private,
                        &self.profile.state_dir.join("collections"),
                    ));
                }
                bound_file_notices(&mut collections);
                to_value(&collections)
            }
            Method::COLLECTION_ADD => self.add(params(req)?).await,
            Method::COLLECTION_REMOVE => {
                let p: CollectionRef = params(req)?;
                self.remove(&p.collection).await
            }
            Method::COLLECTION_MODE => self.change_collection_mode(params(req)?).await,
            Method::COLLECTION_MODE_STATUS => {
                let p: CollectionRef = params(req)?;
                self.collection_mode_status(&p.collection).await
            }
            Method::COLLECTION_DELETE => self.delete_collection(params(req)?).await,
            Method::COLLECTION_UPDATE => {
                let p: UpdateCollection = params(req)?;
                self.update_collection(p).await
            }
            Method::COLLECTION_PAUSE | Method::COLLECTION_RESUME => {
                let p: CollectionRef = params(req)?;
                let out = self
                    .set_paused(&p.collection, req.method == Method::COLLECTION_PAUSE)
                    .await;
                if out.is_ok() && req.method == Method::COLLECTION_RESUME {
                    self.spawn_auto_private();
                }
                out
            }
            Method::COLLECTION_HOLDS => {
                let p: CollectionRef = params(req)?;
                self.holds(&p.collection).await
            }
            Method::COLLECTION_RESOLVE_HOLD => self.resolve_hold(params(req)?).await,
            Method::CONFLICTS_DISMISS => self.dismiss_conflict(params(req)?).await,
            Method::SYNC_FILES => {
                let p: CollectionRef = params(req)?;
                Ok(json!(self.sync_files(&p.collection).await?))
            }
            Method::SYNC_FILES_SET => self.set_sync_files(params(req)?).await,
            Method::COLLECTION_CONFLICTS => {
                let p: CollectionRef = params(req)?;
                self.conflicts(&p.collection).await
            }
            Method::SYNC_ENABLE => {
                let p: EnableSync = params(req)?;
                if p.mode == Some(SyncMode::Local) {
                    return Err(ControlError::invalid(
                        "invalid_mode",
                        "sync.enable takes mode synced or synced_e2e",
                    ));
                }
                let out = self.enable_sync(p).await;
                // A private collection enabled here is keyed for the account key.
                self.account_keys.wake();
                out
            }
            Method::COLLECTION_JOIN => {
                let out = self.join(params(req)?).await;
                self.account_keys.wake();
                out
            }
            Method::SYNC_DISABLE => {
                let p: CollectionRef = params(req)?;
                self.serving(&p.collection).await?;
                Err(ControlError::not_implemented("disabling sync"))
            }
            Method::DEVICE_PENDING => self.device_pending(params(req)?).await,
            Method::DEVICE_APPROVE => self.device_approve(params(req)?).await,
            Method::DEVICE_REJECT => self.device_reject(params(req)?).await,
            Method::RECOVERY_STATUS | Method::RECOVERY_CREATE | Method::RECOVERY_IMPORT => {
                let p: CollectionRef = params(req)?;
                self.e2e_collection(&p.collection).await?;
                Err(ControlError::not_implemented(&req.method))
            }
            Method::PRIVATE_STATUS => self.private_status().await,
            Method::PRIVATE_SETUP => self.private_setup(params(req)?).await,
            Method::PRIVATE_UNLOCK => self.private_unlock(params(req)?).await,
            Method::PRIVATE_PASSWORD => self.private_password(params(req)?).await,
            Method::PRIVATE_STRICT => self.private_strict().await,
            Method::DOCTOR => to_value(&self.doctor().await),
            Method::MIGRATE_STATUS => {
                let refresh =
                    req.params.get("refresh_rollout").and_then(Value::as_bool) == Some(true);
                self.spawn(self.clone().retry_takeover(refresh));
                self.takeover_status().await
            }
            Method::MIGRATE_START => {
                let p: crate::control::MigrateStart = params(req)?;
                let out = self.clone().takeover_run(p.stop_mirrors, false).await;
                if out.is_ok() {
                    self.spawn(self.clone().auto_private());
                }
                out
            }
            Method::ACCESS_LIST => {
                let c: Option<String> = req
                    .params
                    .get("collection")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let inner = self.inner.lock().await;
                to_value(&inner.access.list(c.as_deref()))
            }
            Method::ACCESS_REVOKE | Method::ACCESS_DENY => {
                let p: GrantRef = params(req)?;
                let revoke = req.method == Method::ACCESS_REVOKE;
                tracing::info!(grant = %p.grant, revoke, "grant refused on this device");
                let v = self
                    .access_change(|l| {
                        if revoke {
                            l.revoke(&p.grant).cloned()
                        } else {
                            l.deny(&p.grant).cloned()
                        }
                    })
                    .await?;
                self.revoke_upstream(p.grant.clone());
                Ok(v)
            }
            Method::ACCESS_APPROVE => {
                let p: GrantRef = params(req)?;
                // Private grants already have account consent. No native
                // dialog is part of their access path, even on an explicit CLI
                // review of an entry cached by an older build.
                let native = {
                    let inner = self.inner.lock().await;
                    inner
                        .access
                        .entries
                        .iter()
                        .find(|e| e.grant.grant == p.grant)
                        .filter(|e| {
                            inner
                                .registry
                                .get(&e.grant.collection)
                                .is_some_and(|c| c.mode == SyncMode::SyncedE2e)
                        })
                        .cloned()
                };
                if let Some(entry) = native {
                    self.spawn_native_grant_publisher(entry.grant.grant.clone());
                    return to_value(&entry);
                }
                let (expected, prompt) = {
                    let inner = self.inner.lock().await;
                    let e = inner
                        .access
                        .entries
                        .iter()
                        .find(|e| e.grant.grant == p.grant)
                        .ok_or_else(|| ControlError::not_found("no such grant on this device"))?;
                    let name = inner
                        .registry
                        .get(&e.grant.collection)
                        .map(|c| c.name.clone())
                        .unwrap_or_else(|| e.grant.collection.clone());
                    let prompt = crate::confirm::Prompt::ApproveApp {
                        app: e.grant.app_name.clone(),
                        collection: name,
                        capabilities: e.grant.capabilities.clone(),
                        folders: e.grant.folders.clone(),
                        key: e.grant.fingerprint(),
                    };
                    (e.clone(), prompt)
                };
                self.confirm(&prompt).await?;
                self.approve_confirmed(&expected).await
            }
            Method::ACCESS_ACK => {
                let p: GrantRef = params(req)?;
                self.access_change(|l| l.acknowledge(&p.grant).cloned())
                    .await
            }
            Method::ACCOUNT_SIGN_IN => self.sign_in(req).await,
            Method::ACCOUNT_SIGN_OUT => self.sign_out().await,
            Method::ACTIVITY_LIST => {
                let limit = req
                    .params
                    .get("limit")
                    .and_then(Value::as_u64)
                    .unwrap_or(50);
                to_value(
                    &self
                        .activity
                        .list(limit.min(crate::activity::KEEP as u64) as usize),
                )
            }
            Method::ACCOUNT_RENAME => {
                let name = req.params.get("name").and_then(Value::as_str).unwrap_or("");
                self.rename_computer(name).await
            }
            Method::ACCOUNT_APPLICATIONS => self.account_applications().await,
            Method::SETTINGS_GET => {
                let inner = self.inner.lock().await;
                to_value(&Settings {
                    require_grant_approval: inner.access.require_grant_approval,
                })
            }
            Method::SETTINGS_SET => {
                let want = req
                    .params
                    .get("require_grant_approval")
                    .and_then(Value::as_bool);
                if want == Some(false) {
                    self.confirm(&crate::confirm::Prompt::DisableApproval)
                        .await?;
                }
                let mut inner = self.inner.lock().await;
                if let Some(v) = want {
                    let mut next = inner.access.clone();
                    next.require_grant_approval = v;
                    next.save(&self.profile.access_file())
                        .map_err(access_error)?;
                    inner.access = next;
                    for h in &inner.hosts {
                        h.publish_grants(&inner.access);
                    }
                    tracing::info!(require_grant_approval = v, "settings changed");
                }
                let s = Settings {
                    require_grant_approval: inner.access.require_grant_approval,
                };
                drop(inner);
                self.bump();
                to_value(&s)
            }
            other => Err(ControlError::invalid(
                "unknown_method",
                format!("unknown method {other}"),
            )),
        }
    }

    async fn collection_name(&self, id: Option<&str>) -> Option<String> {
        let id = id?;
        let inner = self.inner.lock().await;
        inner.registry.get(id).map(|e| e.name.clone())
    }

    /// Log a successful control call that changed something.
    async fn note_control_call(&self, req: &Request, result: &Value, prior: Option<String>) {
        let prior = match prior {
            Some(n) => Some(n),
            None => {
                self.collection_name(result.get("collection").and_then(Value::as_str))
                    .await
            }
        };
        if let Some(e) = crate::activity::for_control_call(&req.method, &req.params, result, prior)
        {
            self.activity.record(e);
        }
    }

    /// Log an access change that came from the account (or a new request).
    pub(super) async fn note_access_event(&self, event: &AccessEvent) {
        let (kind, collection, app) = match event {
            AccessEvent::NewAccess { entry } => (
                "app_connected",
                &entry.grant.collection,
                &entry.grant.app_name,
            ),
            AccessEvent::ApprovalRequested { entry } => (
                "app_requested",
                &entry.grant.collection,
                &entry.grant.app_name,
            ),
            AccessEvent::Revoked {
                collection,
                app_name,
                ..
            } => ("app_revoked_in_account", collection, app_name),
        };
        let mut e = crate::activity::ActivityEntry::now(kind);
        e.collection_name = self.collection_name(Some(collection)).await;
        e.collection = Some(collection.clone());
        e.app_name = Some(app.clone());
        self.activity.record(e);
    }
}

pub(super) fn to_value<T: serde::Serialize>(v: &T) -> Result<Value, ControlError> {
    serde_json::to_value(v).map_err(|e| ControlError::internal(e.to_string()))
}

fn params<T: serde::de::DeserializeOwned>(req: &Request) -> Result<T, ControlError> {
    serde_json::from_value(req.params.clone())
        .map_err(|e| ControlError::invalid("invalid_params", format!("{}: {e}", req.method)))
}

pub(super) async fn serve_control(d: Arc<Daemon>, stream: BoxStream) -> std::io::Result<()> {
    let (mut rd, mut wr) = tokio::io::split(stream);
    let (tx, mut rx) = mpsc::channel::<Response>(64);
    // Untracked: it only writes to this socket, and it ends once the tracked
    // connection task (and its subscription) drop their senders. Aborting it
    // instead could lose the reply to `shutdown`.
    let writer = tokio::spawn(async move {
        while let Some(resp) = rx.recv().await {
            let bytes = serde_json::to_vec(&resp).unwrap_or_default();
            if ipc::write_frame(&mut wr, &bytes).await.is_err() {
                break;
            }
        }
        let _ = wr.shutdown().await;
    });
    let mut subscription: Option<tokio::task::AbortHandle> = None;
    let mut conn = ConnAuth::default();
    let mut stop = d.shutdown.subscribe();
    loop {
        let frame = tokio::select! {
            f = ipc::read_frame(&mut rd, ipc::MAX_CONTROL_FRAME) => f?,
            _ = async { let _ = stop.wait_for(|s| *s).await; } => None,
        };
        let Some(frame) = frame else { break };
        let req: Request = match serde_json::from_slice(&frame) {
            Ok(r) => r,
            Err(e) => {
                let _ = tx
                    .send(Response::err(
                        0,
                        ControlError::invalid("malformed_frame", e.to_string()),
                    ))
                    .await;
                break;
            }
        };
        if req.v != PROTOCOL {
            let _ = tx
                .send(Response::err(
                    req.id,
                    ControlError::new(
                        "upgrade_required",
                        "protocol_version",
                        format!(
                            "this daemon speaks control protocol {PROTOCOL}, not {}",
                            req.v
                        ),
                    ),
                ))
                .await;
            break;
        }
        let result = d.handle_and_note(&req, &mut conn).await;
        let stopping = req.method == Method::SHUTDOWN && result.is_ok();
        let resp = match result {
            Ok(v) => Response::ok(req.id, v),
            Err(e) => Response::err(req.id, e),
        };
        let sent = tx.send(resp).await;
        // Only after the reply is queued: shutdown aborts this task.
        if stopping {
            d.shutdown.send_replace(true);
        }
        if sent.is_err() {
            break;
        }
        if req.method == Method::STATUS_SUBSCRIBE && subscription.is_none() {
            let d2 = d.clone();
            let tx2 = tx.clone();
            subscription = d.spawn(async move {
                let mut feed = d2.status_feed.subscribe();
                let mut access = d2.access_events.subscribe();
                feed.mark_unchanged();
                loop {
                    let push = tokio::select! {
                        c = feed.changed() => {
                            if c.is_err() { break; }
                            let Some(status) = feed.borrow_and_update().clone() else { continue };
                            Response::push("status", (*status).clone())
                        }
                        e = access.recv() => match e {
                            Ok(ev) => Response::push("access", serde_json::to_value(&ev).unwrap_or_default()),
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                            Err(_) => break,
                        },
                    };
                    if tx2.send(push).await.is_err() {
                        break;
                    }
                }
            });
        }
    }
    if let Some(s) = subscription {
        s.abort();
    }
    drop(tx);
    let _ = writer.await;
    Ok(())
}

/// Per-connection caller authentication.
#[derive(Default)]
pub(super) struct ConnAuth {
    pub(super) nonce: Option<[u8; 32]>,
    pub(super) privileged: bool,
}

pub(super) fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}
