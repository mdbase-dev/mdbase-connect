//! Daemon and collection status, with the notices added to each collection.

use super::*;

impl Daemon {
    /// Rebuild status once per change for all `status.subscribe` connections,
    /// rather than once per connection.
    pub(super) async fn publish_status(self: Arc<Self>) {
        let mut changes = self.changes.subscribe();
        while changes.changed().await.is_ok() {
            if self.status_feed.receiver_count() == 0 {
                continue;
            }
            let status = serde_json::to_value(self.status().await).unwrap_or_default();
            self.status_feed.send_replace(Some(Arc::new(status)));
        }
    }

    pub(super) async fn status(&self) -> DaemonStatus {
        self.reconcile_private_choices().await;
        let collections = self.collection_statuses().await;
        let (device, clock_skew) = {
            let inner = self.inner.lock().await;
            (
                inner.device.as_ref().map(|p| DeviceInfo {
                    device_id: p.device.clone(),
                    noise_pk: p.noise_pk.clone(),
                    sign_pk: p.sign_pk.clone(),
                }),
                inner.hosts.iter().any(CollectionHost::clock_skew),
            )
        };
        DaemonStatus {
            readiness: self.readiness.borrow().clone(),
            pid: std::process::id(),
            target: self.profile.target,
            state_dir: self.profile.state_dir.clone(),
            started_at_ms: self.started_at_ms,
            secret_backend: self.secrets.backend().to_string(),
            device,
            account: {
                let a = self.account.lock().unwrap_or_else(|p| p.into_inner());
                let cloud = crate::cloud::CloudConfig::load(&self.profile.cloud_file())
                    .ok()
                    .flatten()
                    .filter(|_| a.signed_in);
                AccountInfo {
                    signed_in: a.signed_in,
                    online: self.online.load(std::sync::atomic::Ordering::Relaxed),
                    pairing: a.pairing.clone(),
                    last_error: if a.signed_in && clock_skew {
                        Some("system_clock_wrong".into())
                    } else {
                        a.last_error
                            .clone()
                            .or_else(|| a.registration_error.clone())
                    },
                    account_id: self
                        .authority
                        .active_account()
                        .map(|id| secrets::uuid_string(&id.0)),
                    server: cloud.as_ref().map(|c| c.server_url.clone()),
                    computer_name: cloud.and_then(|c| c.computer_name),
                    environment: crate::trust::Environment::embedded().name().into(),
                }
            },
            collections,
        }
    }

    /// Every collection as `status` and `collection.list` report it. Only the
    /// registration and access notices are read under the registry lock; the
    /// runtimes are asked after it is released, each for at most
    /// [`crate::collections::ACTOR_WAIT`].
    pub(super) async fn collection_statuses(&self) -> Vec<CollectionStatus> {
        let (observations, access): (Vec<_>, Vec<_>) = {
            let inner = self.inner.lock().await;
            inner
                .hosts
                .iter()
                .map(|h| {
                    let mut notices = access_notices(&inner.access, &h.entry().id);
                    notices.extend(self.mode_driver.notices(&h.entry().id));
                    (h.observation(), notices)
                })
                .unzip()
        };
        let observed = futures_util::future::join_all(
            observations
                .into_iter()
                .map(crate::collections::Observation::status),
        )
        .await;
        let mut collections: Vec<_> = observed
            .into_iter()
            .zip(access)
            .map(|(mut status, access)| {
                status.notices.extend(access);
                status
            })
            .collect();
        bound_file_notices(&mut collections);
        collections
    }

    /// The collection's status once it has finished opening (or settled in
    /// another state), or as it is after `wait`.
    pub(super) async fn settled_status(
        &self,
        id: &str,
        wait: Duration,
    ) -> Result<CollectionStatus, ControlError> {
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let observation = {
                let inner = self.inner.lock().await;
                let host = inner
                    .hosts
                    .iter()
                    .find(|h| h.entry().id == id)
                    .ok_or_else(|| {
                        ControlError::not_found(format!("no registered collection {id}"))
                    })?;
                (host.state() != crate::control::CollectionState::Opening
                    || tokio::time::Instant::now() >= deadline)
                    .then(|| host.observation())
            };
            // Reported like `status`: syncing, not ready, while work is unfinished.
            if let Some(observation) = observation {
                return Ok(observation.status().await);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

/// The access-list notices for one collection.
fn access_notices(access: &AccessList, collection: &str) -> Vec<Notice> {
    access
        .list(Some(collection))
        .into_iter()
        .filter_map(|e| {
            let (code, verb) = match e.state {
                AccessState::Active if !e.acknowledged => ("app_access_added", "can now use"),
                AccessState::PendingApproval => ("app_access_pending", "asks to use"),
                _ => return None,
            };
            Some(Notice {
                path: None,
                code: code.into(),
                message: format!(
                    "{} {verb} this collection ({}; key {}). Review with `mdbase access list`.",
                    e.grant.app_name,
                    e.grant.capabilities.join(", "),
                    e.grant.fingerprint()
                ),
            })
        })
        .collect()
}

/// Keep per-file diagnostics within a shared budget across all collections.
pub(crate) fn bound_file_notices(collections: &mut [CollectionStatus]) {
    let mut remaining = 128 * 1024;
    for collection in collections {
        let mut omitted = 0;
        collection.notices.retain(|notice| {
            if notice.path.is_none() {
                return true;
            }
            let bytes = serde_json::to_vec(notice)
                .expect("notice is serializable")
                .len();
            if bytes > remaining {
                omitted += 1;
                false
            } else {
                remaining -= bytes;
                true
            }
        });
        if omitted > 0 {
            collection.notices.push(Notice {
                path: None,
                code: "status_file_notices_omitted".into(),
                message: format!("{omitted} additional file notices did not fit in status."),
            });
        }
    }
}
