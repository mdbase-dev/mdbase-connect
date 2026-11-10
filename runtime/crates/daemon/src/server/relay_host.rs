//! The relay's view of the daemon (`relay::RelayHost`): grant checks, inventory and connection state.

use super::*;

impl Daemon {
    /// Inventory entries for the account (local collections only).
    async fn inventory_entries(&self) -> Vec<(String, Value)> {
        let inner = self.inner.lock().await;
        inner
            .registry
            .collections
            .iter()
            .filter(|e| e.mode == SyncMode::Local)
            .map(|e| {
                (
                    e.id.clone(),
                    json!({
                        "id": e.id,
                        "display_name": e.name,
                        "spec_version": spec_version(&e.root),
                        "enabled": !e.paused,
                        "contracts": [],
                    }),
                )
            })
            .collect()
    }
}

impl crate::relay::RelayHost for Daemon {
    fn grant_refusal<'a>(
        &'a self,
        collection: &'a str,
        grant: &'a str,
    ) -> crate::session::BoxFuture<'a, Option<String>> {
        Box::pin(async move {
            if self.grant_live(collection, grant).await {
                return None;
            }
            let inner = self.inner.lock().await;
            let mode = inner.registry.get(collection).map(|entry| entry.mode);
            if mode != Some(SyncMode::Synced) {
                return Some(
                    match inner.access.entries.iter().find(|entry| {
                        entry.grant.collection == collection && entry.grant.grant == grant
                    }) {
                        Some(entry) if entry.is_refused() => {
                            crate::access::Refusal::RevokedLocally.reason()
                        }
                        _ if mode == Some(SyncMode::SyncedE2e)
                            && !inner.access.lease_live(collection, fsutil::now_ms() as u64) =>
                        {
                            crate::access::Refusal::LeaseExpired.reason()
                        }
                        Some(entry)
                            if entry.state == crate::access::AccessState::PendingApproval =>
                        {
                            crate::access::Refusal::PendingApproval.reason()
                        }
                        Some(_)
                            if !inner.access.lease_live(collection, fsutil::now_ms() as u64) =>
                        {
                            crate::access::Refusal::LeaseExpired.reason()
                        }
                        _ if mode != Some(SyncMode::Local) => {
                            crate::access::Refusal::Unavailable.reason()
                        }
                        Some(_) => "grant_inactive",
                        None => crate::access::Refusal::UnknownGrant.reason(),
                    }
                    .into(),
                );
            }
            Some("grant_inactive".into())
        })
    }

    fn inventory(&self) -> crate::session::BoxFuture<'_, Vec<(String, Value)>> {
        Box::pin(self.inventory_entries())
    }

    fn policy_cursor(&self) -> crate::session::BoxFuture<'_, Option<crate::access::FeedCursor>> {
        Box::pin(async move { self.inner.lock().await.access.feed_cursor.clone() })
    }

    fn commit_feed<'a>(
        &'a self,
        snapshot: &'a crate::relay::Snapshot,
        grants: &'a std::collections::BTreeMap<String, Vec<CachedGrant>>,
    ) -> crate::session::BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            self.commit_control_plane_feed(snapshot, grants)
                .await
                .map_err(|e| e.message)
        })
    }

    fn grant_live<'a>(
        &'a self,
        collection: &'a str,
        grant: &'a str,
    ) -> crate::session::BoxFuture<'a, bool> {
        Box::pin(async move {
            let (mode, auth, grant16) = {
                let inner = self.inner.lock().await;
                let mode = inner.registry.get(collection).map(|c| c.mode);
                if mode == Some(SyncMode::Synced) {
                    return inner
                        .access
                        .grant_live(collection, grant, fsutil::now_ms() as u64);
                }
                let Some(entry) = inner.access.entries.iter().find(|entry| {
                    entry.grant.grant == grant && entry.grant.collection == collection
                }) else {
                    return false;
                };
                let (Some(grant), Some(client_pk)) = (
                    crate::attest::uuid_bytes(grant),
                    secrets::hex_decode(&entry.grant.client_pk)
                        .ok()
                        .and_then(|bytes| bytes.try_into().ok()),
                ) else {
                    return false;
                };
                let auth = crate::session::Auth::Grant {
                    grant,
                    client_pk,
                    origin: crate::session::Origin::RelayPipe,
                };
                if self.authority.authorize_session(collection, auth).is_err() {
                    return false;
                }
                (mode, auth, grant)
            };
            if mode == Some(SyncMode::SyncedE2e) {
                let Some(rt) = self.collection_runtime(collection).await else {
                    return false;
                };
                return matches!(
                    rt.grant_approval(crate::runtime::GrantApprovalOp::Effective(
                        mdbn_wire::common::B16(grant16),
                    ))
                    .await,
                    Some(crate::runtime::GrantApprovalReply::Effective(true))
                ) && self.authority.authorize_session(collection, auth).is_ok();
            }
            true
        })
    }

    fn grant_activation<'a>(
        self: &'a Arc<Self>,
        collection: &'a str,
        grant: &'a str,
    ) -> crate::session::BoxFuture<'a, Option<crate::relay::GrantActivation>> {
        Box::pin(async move {
            let NativeGrantWaitContext {
                entry: expected,
                incarnation,
                deadline: lease_deadline,
                runtime,
            } = self.native_grant_wait_consent(collection, grant).await?;
            let grant16 = crate::attest::uuid_bytes(grant)?;
            // Capture subscriptions and immutable context BEFORE task spawning.
            let mut policy_changes = runtime.grant_policy_changes();
            let mut authority_changes = self.changes.subscribe();
            let (daemon, col, gid, entry, original_runtime) = (
                self.clone(),
                collection.to_owned(),
                grant.to_owned(),
                expected.clone(),
                runtime.clone(),
            );
            let current: crate::relay::GrantActivationGuard = Arc::new(move || {
                let (d, c, g, e, r) = (
                    daemon.clone(),
                    col.clone(),
                    gid.clone(),
                    entry.clone(),
                    original_runtime.clone(),
                );
                Box::pin(async move {
                    if std::time::Instant::now() >= lease_deadline
                        || d.authority.incarnation() != Some(incarnation)
                    {
                        return false;
                    }
                    let consent = d.native_grant_wait_consent(&c, &g).await;
                    consent.is_some_and(|actual| {
                        actual.entry == e
                            && actual.incarnation == incarnation
                            && Arc::ptr_eq(&actual.runtime, &r)
                            && std::time::Instant::now() < lease_deadline
                            && d.authority.incarnation() == Some(incarnation)
                    })
                })
            });
            if !current().await {
                return None;
            }
            let wait_current = current.clone();
            let wait = Box::pin(async move {
                loop {
                    if !wait_current().await {
                        return false;
                    }
                    let state = runtime
                        .grant_approval(crate::runtime::GrantApprovalOp::State(
                            mdbn_wire::common::B16(grant16),
                        ))
                        .await;
                    // Fence this await BEFORE asking the next authoritative query.
                    if !wait_current().await {
                        return false;
                    }
                    match state {
                        Some(crate::runtime::GrantApprovalReply::State(Some(state))) => {
                            let pk = crate::secrets::hex_decode(&expected.grant.client_pk)
                                .ok()
                                .and_then(|b| <[u8; 32]>::try_from(b).ok());
                            if !state.active
                                || state.failure.is_some()
                                || pk != Some(state.client_pk)
                                || !expected
                                    .grant
                                    .capabilities
                                    .iter()
                                    .all(|c| state.capabilities.contains(c))
                            {
                                return false;
                            }
                        }
                        Some(crate::runtime::GrantApprovalReply::State(None)) => {}
                        _ => return false,
                    }
                    let effective = runtime
                        .grant_approval(crate::runtime::GrantApprovalOp::Effective(
                            mdbn_wire::common::B16(grant16),
                        ))
                        .await;
                    // A positive reply cannot outlive the captured lease, epoch,
                    // consent generation or runtime, even across lease renewal.
                    if !wait_current().await {
                        return false;
                    }
                    match effective {
                        Some(crate::runtime::GrantApprovalReply::Effective(true)) => return true,
                        Some(crate::runtime::GrantApprovalReply::Effective(false)) => {}
                        _ => return false,
                    }
                    tokio::select! {
                        result = policy_changes.changed() => if result.is_err() { return false },
                        result = authority_changes.changed() => if result.is_err() { return false },
                        _ = tokio::time::sleep_until(tokio::time::Instant::from_std(lease_deadline)) => return false,
                    }
                }
            });
            Some(crate::relay::GrantActivation { current, wait })
        })
    }

    fn set_online(&self, online: bool) {
        self.online
            .store(online, std::sync::atomic::Ordering::Relaxed);
        if online {
            self.account
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .last_error = None;
        }
        self.bump();
    }

    fn old_connector_running(&self) -> bool {
        self.takeover
            .old_running
            .load(std::sync::atomic::Ordering::SeqCst)
    }
}
