//! App grants: control-plane grant feeds, native grant activation and publishing grants to collection hosts.

use super::*;

impl Daemon {
    /// Reconcile a collection's cached grants with the control plane's list,
    /// persist, then announce. Called by the control-plane client.
    pub async fn apply_control_plane_grants(
        &self,
        collection: &str,
        grants: &[CachedGrant],
        lease_expires_ms: u64,
    ) -> Result<Vec<AccessEvent>, ControlError> {
        let _gate = self.account_gate.lock().await;
        let mut inner = self.inner.lock().await;
        let mut next = inner.access.clone();
        let events = next.sync_from_control_plane(
            collection,
            grants,
            fsutil::now_ms() as u64,
            lease_expires_ms,
            false,
        );
        if let Err(e) = next.save(&self.profile.access_file()) {
            inner.access.leases.clear();
            inner.access.monotonic_leases.clear();
            for h in &inner.hosts {
                h.publish_grants(&inner.access);
            }
            self.authority.publish_access(&inner.access);
            return Err(access_error(e));
        }
        inner.access = next;
        self.authority.publish_access(&inner.access);
        let barrier = publish_grants(&inner);
        drop(inner);
        barrier.wait().await;
        for e in &events {
            self.note_access_event(e).await;
            let _ = self.access_events.send(e.clone());
        }
        if !events.is_empty() {
            self.bump();
        }
        Ok(events)
    }

    pub(super) async fn access_change(
        &self,
        f: impl FnOnce(&mut AccessList) -> Result<AccessEntry, crate::access::AccessError>,
    ) -> Result<Value, ControlError> {
        let _gate = self.account_gate.lock().await;
        let mut inner = self.inner.lock().await;
        let mut next = inner.access.clone();
        let entry = f(&mut next).map_err(access_error)?;
        self.save_access(&mut inner, &next)?;
        inner.access = next;
        self.authority.publish_access(&inner.access);
        let barrier = publish_grants(&inner);
        drop(inner);
        barrier.wait().await;
        self.bump();
        to_value(&entry)
    }

    // Compare the complete displayed entry (including its durable generation)
    // under the same lock as approval publication, after the asynchronous dialog.
    pub(super) async fn approve_confirmed(
        &self,
        expected: &AccessEntry,
    ) -> Result<Value, ControlError> {
        let _gate = self.account_gate.lock().await;
        let mut inner = self.inner.lock().await;
        let current = inner
            .access
            .entries
            .iter()
            .find(|e| e.grant.grant == expected.grant.grant);
        if current != Some(expected)
            || !inner
                .access
                .lease_live(&expected.grant.collection, fsutil::now_ms() as u64)
        {
            return Err(ControlError::new(
                "forbidden",
                "consent_changed",
                "grant terms or lease changed; approve again",
            ));
        }
        let mut next = inner.access.clone();
        let entry = next
            .approve(&expected.grant.grant)
            .cloned()
            .map_err(access_error)?;
        self.save_access(&mut inner, &next)?;
        inner.access = next;
        self.authority.publish_access(&inner.access);
        drop(inner);
        self.bump();
        tracing::info!(grant = %expected.grant.grant, "grant approved on this device");
        to_value(&entry)
    }

    /// Positive eligibility for a bounded wait, NOT permission to serve. Capture
    /// the original consent generation and account incarnation; disk cache alone
    /// never restores a lease. The account gate preserves existing lock order.
    pub(super) async fn native_grant_wait_consent(
        &self,
        collection: &str,
        grant: &str,
    ) -> Option<NativeGrantWaitContext> {
        let _gate = self.account_gate.lock().await;
        let incarnation = self.authority.incarnation()?;
        let inner = self.inner.lock().await;
        let collection_entry = inner.registry.get(collection)?;
        if collection_entry.mode != SyncMode::SyncedE2e || collection_entry.paused {
            return None;
        }
        let entry = inner
            .access
            .entries
            .iter()
            .find(|e| e.grant.collection == collection && e.grant.grant == grant)?;
        if entry.state != AccessState::Active
            || entry.delisted
            || entry.grant.legacy_only
            || entry
                .grant
                .account_id
                .as_deref()
                .and_then(crate::authority::account_id)
                != Some(incarnation.account)
            || entry.grant.capabilities.is_empty()
            || crate::secrets::hex_decode(&entry.grant.client_pk)
                .ok()
                .is_none_or(|bytes| bytes.len() != 32)
            || crate::attest::uuid_bytes(grant).is_none()
            || !inner.access.lease_live(collection, fsutil::now_ms() as u64)
        {
            return None;
        }
        let deadline = *inner.access.monotonic_leases.get(collection)?;
        let runtime = inner
            .hosts
            .iter()
            .find(|h| h.entry().id == collection)?
            .runtime()?;
        Some(NativeGrantWaitContext {
            entry: entry.clone(),
            incarnation,
            deadline,
            runtime,
        })
    }

    /// One grant's approval state from its collection's replica.
    async fn native_grant_state(
        &self,
        collection: &str,
        grant: &[u8; 16],
    ) -> Option<mdbn_replica::api::GrantApprovalState> {
        let rt = self.collection_runtime(collection).await?;
        match rt
            .grant_approval(crate::runtime::GrantApprovalOp::State(
                mdbn_wire::common::B16(*grant),
            ))
            .await
        {
            Some(crate::runtime::GrantApprovalReply::State(s)) => s,
            _ => None,
        }
    }

    /// Mark a native grant active here (the log approval is the authority;
    /// this is the device's display and refusal state).
    pub(super) async fn activate_native_entry(
        &self,
        expected: &AccessEntry,
    ) -> Result<Value, ControlError> {
        let _gate = self.account_gate.lock().await;
        let mut inner = self.inner.lock().await;
        let current = inner
            .access
            .entries
            .iter()
            .find(|e| e.grant.grant == expected.grant.grant);
        if current != Some(expected) {
            return Err(ControlError::new(
                "forbidden",
                "consent_changed",
                "grant terms or decision changed during approval",
            ));
        }
        if expected.state == AccessState::Active {
            return to_value(expected);
        }
        let mut next = inner.access.clone();
        let entry = next
            .approve(&expected.grant.grant)
            .cloned()
            .map_err(access_error)?;
        self.save_access(&mut inner, &next)?;
        inner.access = next;
        self.authority.publish_access(&inner.access);
        drop(inner);
        self.bump();
        to_value(&entry)
    }

    /// Materialize an account-approved Private grant automatically. The sealed
    /// kind-6 item carries Private folder scope; it is not another user decision
    /// and never invokes a native confirmation or key comparison.
    pub(super) async fn publish_native_grant(
        self: &Arc<Self>,
        expected: &AccessEntry,
    ) -> Result<Value, ControlError> {
        // Publish only a fresh feed for the currently signed-in account. A
        // missing account is never consent, including when signed out.
        let account = expected
            .grant
            .account_id
            .as_deref()
            .and_then(crate::authority::account_id)
            .ok_or_else(|| {
                ControlError::new("forbidden", "consent_changed", "grant account is missing")
            })?;
        {
            let _gate = self.account_gate.lock().await;
            let inner = self.inner.lock().await;
            let current = inner
                .access
                .entries
                .iter()
                .find(|e| e.grant.grant == expected.grant.grant);
            if current != Some(expected)
                || expected.is_refused()
                || !inner
                    .access
                    .lease_live(&expected.grant.collection, fsutil::now_ms() as u64)
                || Some(account) != self.authority.active_account()
                || expected.grant.legacy_only
            {
                return Err(ControlError::new(
                    "forbidden",
                    "consent_changed",
                    "account grant or feed authority changed",
                ));
            }
        }
        let Some(grant16) = crate::attest::uuid_bytes(&expected.grant.grant) else {
            return Err(ControlError::internal("grant or collection ID malformed"));
        };
        let state = self
            .native_grant_state(&expected.grant.collection, &grant16)
            .await
            .ok_or_else(|| {
                ControlError::unavailable(
                    "grant_not_in_log",
                    "this computer has not received the app's request yet; try again shortly",
                )
            })?;
        // The feed's terms were shown to the user; the log's must match,
        // including when an approval from another device already exists.
        let entry_pk = crate::secrets::hex_decode(&expected.grant.client_pk)
            .ok()
            .and_then(|b| <[u8; 32]>::try_from(b).ok());
        if !state.active
            || entry_pk != Some(state.client_pk)
            || expected.grant.capabilities.is_empty()
            || !expected
                .grant
                .capabilities
                .iter()
                .all(|c| state.capabilities.contains(c))
        {
            return Err(ControlError::new(
                "forbidden",
                "consent_changed",
                "the app's request in the collection differs from what was shown; approve again",
            ));
        }
        if state.approved_capabilities.is_none() {
            let rt = self
                .collection_runtime(&expected.grant.collection)
                .await
                .ok_or_else(|| {
                    ControlError::unavailable("not_serving", "the collection is not being served")
                })?;
            match rt
                .grant_approval(crate::runtime::GrantApprovalOp::Approve {
                    grant: mdbn_wire::common::B16(grant16),
                    capabilities: expected.grant.capabilities.clone(),
                    folders: expected.grant.folders.clone(),
                })
                .await
            {
                Some(crate::runtime::GrantApprovalReply::Approve(Ok(()))) => {}
                Some(crate::runtime::GrantApprovalReply::Approve(Err(reason))) => {
                    return Err(ControlError::new(
                        "forbidden",
                        &reason,
                        "this computer cannot approve that grant",
                    ));
                }
                _ => {
                    return Err(ControlError::unavailable(
                        "not_serving",
                        "the collection is not being served",
                    ));
                }
            }
        }
        // The append is queued; wait briefly for it to apply, then report.
        for _ in 0..40 {
            if let Some(s) = self
                .native_grant_state(&expected.grant.collection, &grant16)
                .await
            {
                if let Some(failure) = &s.failure {
                    return Err(ControlError::new(
                        "forbidden",
                        failure,
                        "the approval could not be saved to the collection",
                    ));
                }
                if s.approved_capabilities.is_some() {
                    return self.activate_native_entry(expected).await;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        self.spawn_native_grant_publisher(expected.grant.grant.clone());
        Err(ControlError::unavailable(
            "grant_approval_pending",
            "the approval is still being saved; the app can connect once it lands",
        ))
    }

    /// Retry automatic Private grant materialization while account consent is
    /// current. One task per grant; a no-op if already running.
    pub(super) fn spawn_native_grant_publisher(&self, grant: String) {
        let Some(d) = self.arc() else {
            return;
        };
        {
            let mut set = self
                .grant_publications
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            if !set.insert(grant.clone()) {
                return;
            }
        }
        d.clone().spawn(async move {
            for attempt in 0..300 {
                if attempt != 0 {
                    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                }
                let entry = {
                    let inner = d.inner.lock().await;
                    inner
                        .access
                        .entries
                        .iter()
                        .find(|e| e.grant.grant == grant)
                        .cloned()
                };
                let Some(entry) = entry else { break };
                if entry.is_refused() {
                    break;
                }
                let Some(grant16) = crate::attest::uuid_bytes(&entry.grant.grant) else {
                    break;
                };
                let Some(state) = d
                    .native_grant_state(&entry.grant.collection, &grant16)
                    .await
                else {
                    continue;
                };
                if state.failure.is_some() || !state.active {
                    break;
                }
                if d.publish_native_grant(&entry).await.is_ok() {
                    break;
                }
            }
            d.grant_publications
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&grant);
        });
    }

    /// After a fresh account feed, automatically publish missing sealed scope,
    /// including after restart. Already materialized grants need no report.
    async fn publish_account_grants(&self) {
        let pending: Vec<String> = {
            let inner = self.inner.lock().await;
            inner
                .access
                .entries
                .iter()
                .filter(|e| {
                    !e.is_refused()
                        && inner
                            .registry
                            .get(&e.grant.collection)
                            .is_some_and(|c| c.mode == SyncMode::SyncedE2e)
                })
                .map(|e| e.grant.grant.clone())
                .collect()
        };
        for grant in pending {
            let entry = {
                let inner = self.inner.lock().await;
                inner
                    .access
                    .entries
                    .iter()
                    .find(|e| e.grant.grant == grant)
                    .cloned()
            };
            if let Some(entry) = entry
                && let Some(id) = crate::attest::uuid_bytes(&grant)
                && self
                    .native_grant_state(&entry.grant.collection, &id)
                    .await
                    .is_some_and(|s| s.approved_capabilities.is_some())
            {
                continue;
            }
            self.spawn_native_grant_publisher(grant);
        }
    }

    pub(super) async fn commit_control_plane_feed(
        &self,
        snapshot: &crate::relay::Snapshot,
        grants: &std::collections::BTreeMap<String, Vec<CachedGrant>>,
    ) -> Result<(), ControlError> {
        let _gate = self.account_gate.lock().await;
        let record = crate::cloud::AccountRecord::load(&self.profile.account_file())
            .map_err(|error| ControlError::unavailable("account_state", error.to_string()))?;
        if record.active_account().is_none()
            || record.epoch != snapshot.account_epoch
            || record.connector_id.as_deref() != Some(snapshot.connector_id.as_str())
            || self.authority.active_account() != record.active_account()
        {
            return Err(ControlError::new(
                "forbidden",
                "policy_authority_mismatch",
                "relay account epoch or connector is no longer active",
            ));
        }
        self.commit_control_plane_feed_with(snapshot, grants, |next| {
            next.save(&self.profile.access_file())
        })
        .await
    }

    pub(super) async fn commit_control_plane_feed_with(
        &self,
        snapshot: &crate::relay::Snapshot,
        grants: &std::collections::BTreeMap<String, Vec<CachedGrant>>,
        save: impl FnOnce(&AccessList) -> Result<(), crate::access::AccessError>,
    ) -> Result<(), ControlError> {
        let mut inner = self.inner.lock().await;
        if let Some(cursor) = &inner.access.feed_cursor
            && (cursor.connector != snapshot.connector_id
                || snapshot.sequence < cursor.sequence
                || (snapshot.sequence == cursor.sequence && snapshot.revision != cursor.revision))
        {
            return Err(ControlError::new(
                "forbidden",
                "stale_policy",
                "feed cursor mismatch",
            ));
        }
        if inner
            .access
            .feed_cursor
            .as_ref()
            .is_some_and(|c| c.sequence == snapshot.sequence && c.revision == snapshot.revision)
        {
            // An ACK retry is idempotent, not a new freshness lease. After a
            // restart/failure, reconciliation must deliver a newer sequence.
            return Ok(());
        }
        let mut next = inner.access.clone();
        let mut events = Vec::new();
        let now = fsutil::now_ms() as u64;
        // Local collections serve from this list; synced end-to-end ones are
        // synced so account-approved native grants can be materialized without
        // a second user decision (the replica's log policy decides sessions).
        for collection in inner
            .registry
            .collections
            .iter()
            .filter(|e| matches!(e.mode, SyncMode::Local | SyncMode::SyncedE2e))
        {
            events.extend(
                next.sync_from_control_plane(
                    &collection.id,
                    grants
                        .get(&collection.id)
                        .map(Vec::as_slice)
                        .unwrap_or_default(),
                    now,
                    snapshot.lease_expires_ms,
                    collection.mode == SyncMode::SyncedE2e,
                ),
            );
            next.monotonic_leases
                .insert(collection.id.clone(), snapshot.lease_deadline);
        }
        next.feed_cursor = Some(crate::access::FeedCursor {
            connector: snapshot.connector_id.clone(),
            sequence: snapshot.sequence,
            revision: snapshot.revision.clone(),
        });
        if let Err(e) = save(&next) {
            // A failure may be before rename or after rename/directory sync.
            // Nothing is served in either case; restart also needs a fresh lease.
            inner.access.leases.clear();
            inner.access.monotonic_leases.clear();
            self.authority.publish_access(&inner.access);
            let barrier = publish_grants(&inner);
            drop(inner);
            barrier.wait().await;
            return Err(access_error(e));
        }
        inner.access = next;
        self.authority.publish_access(&inner.access);
        // The feed is acknowledged (policy_applied) only after every runtime has
        // re-checked its sessions under the new grants (revoke barrier).
        let barrier = publish_grants(&inner);
        drop(inner);
        barrier.wait().await;
        for event in events {
            self.note_access_event(&event).await;
            let _ = self.access_events.send(event);
        }
        self.bump();
        self.publish_account_grants().await;
        Ok(())
    }
}

pub(super) fn access_error(e: crate::access::AccessError) -> ControlError {
    use crate::access::AccessError as E;
    match e {
        E::NotFound => ControlError::not_found("no such grant on this device"),
        E::WrongState(s) => ControlError::invalid("wrong_state", format!("the grant is {s:?}")),
        other => ControlError::internal(other.to_string()),
    }
}

/// The hosts to wait for after an access change.
struct GrantsBarrier(Vec<crate::collections::HostBarrier>);

impl GrantsBarrier {
    /// Wait until every host has re-checked its sessions, including runtimes
    /// still opening (see [`crate::collections::HostBarrier::wait`]).
    async fn wait(self) {
        for h in self.0 {
            h.wait().await;
        }
    }
}

/// Publish the access list's leases to every collection host. Call after the
/// authority has the new access list; await the result before acknowledging.
fn publish_grants(inner: &Inner) -> GrantsBarrier {
    GrantsBarrier(
        inner
            .hosts
            .iter()
            .inspect(|h| h.publish_grants(&inner.access))
            .filter_map(|h| h.barrier())
            .collect(),
    )
}

pub(super) struct NativeGrantWaitContext {
    pub(super) entry: AccessEntry,
    pub(super) incarnation: crate::authority::Incarnation,
    pub(super) deadline: std::time::Instant,
    pub(super) runtime: Arc<crate::runtime::Runtime>,
}
