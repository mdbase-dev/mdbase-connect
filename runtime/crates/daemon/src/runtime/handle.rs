//! The `Runtime` handle: opening the collection thread and every request to it.

use super::*;

/// A handle to a running collection runtime.
pub struct Runtime {
    tx: std_mpsc::Sender<Cmd>,
    grant_changes: watch::Receiver<()>,
    thread: std::sync::Mutex<Option<std::thread::JoinHandle<()>>>,
    #[cfg(test)]
    capture_fixture_frozen: std::sync::Mutex<Option<Option<Frozen>>>,
}

/// Why a runtime did not open. Messages carry no file contents.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenFailed(pub String);

impl Runtime {
    /// Open the runtime on its own thread; returns once the replica is open.
    pub fn open(
        cfg: RuntimeConfig,
        secrets: DeviceSecrets,
        source: Box<dyn mdbn_replica::policy::GrantSource + Send>,
        grants: LocalGrants,
    ) -> Result<Runtime, OpenFailed> {
        // Inspect private admission before spawning a runtime, transport, watcher
        // or acquiring the folder lock. The native opener keeps its original
        // host-lock ordering (an already-active SQLite index is exclusive).
        if let Some(closed) = preopen_mirror_status(&cfg.private_dir)
            .map_err(|e| OpenFailed(format!("mirror fence: {e}")))?
        {
            return Err(OpenFailed(closed.message()));
        }
        let (tx, rx) = std_mpsc::channel();
        let (ready_tx, ready_rx) = std_mpsc::channel();
        let (grant_changes_tx, grant_changes) = watch::channel(());
        let name = format!("collection-{}", crate::secrets::hex(&cfg.collection[..4]));
        let events = tx.clone();
        let fs_wake = tx.clone();
        let thread = std::thread::Builder::new()
            .name(name)
            .spawn(move || match open_replica(&cfg, secrets, source) {
                // The folder host lock is held until the runtime has stopped.
                Ok((rep, lock)) => {
                    // The transport starts only once the replica is open (trust
                    // validated), so its hello proof can be signed.
                    let link = match &cfg.sync {
                        None => None,
                        Some(sync) => match crate::logwire::Link::spawn(
                            crate::logwire::LinkConfig::new(
                                sync.log_url.clone(),
                                B16(cfg.collection),
                                Some(B16(cfg.device_id)),
                            ),
                            sync.tokens.clone(),
                            Box::new(move |e| {
                                let _ = events.send(Cmd::Log(e));
                            }),
                        ) {
                            Ok(l) => Some(l),
                            Err(e) => {
                                let _ = ready_tx.send(Err(OpenFailed(format!("log link: {e}"))));
                                return;
                            }
                        },
                    };
                    // No watcher (unsupported platform, limits): the periodic rescan
                    // still finds every change.
                    let watcher = crate::watch::Watcher::start(
                        &cfg.root,
                        Box::new(move || {
                            let _ = fs_wake.send(Cmd::FsWake);
                        }),
                    )
                    .map_err(|e| tracing::warn!(error = %e, "folder watcher unavailable"))
                    .ok();
                    let _ = ready_tx.send(Ok(()));
                    run(
                        rep,
                        rx,
                        GrantSignals {
                            grants,
                            changes: grant_changes_tx,
                        },
                        link,
                        watcher,
                        B16(cfg.collection),
                        lock,
                    );
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                }
            })
            .map_err(|e| OpenFailed(format!("thread: {e}")))?;
        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Runtime {
                tx,
                grant_changes,
                thread: std::sync::Mutex::new(Some(thread)),
                #[cfg(test)]
                capture_fixture_frozen: std::sync::Mutex::new(None),
            }),
            Ok(Err(e)) => {
                let _ = thread.join();
                Err(e)
            }
            Err(_) => Err(OpenFailed("runtime thread exited".into())),
        }
    }

    #[cfg(test)]
    pub(crate) async fn capture_fixture(
        &self,
        op: native_pending_fixture::Op,
    ) -> Result<native_pending_fixture::Reply, String> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Cmd::CaptureFixture(op, tx))
            .map_err(|_| "original actor stopped")?;
        rx.await
            .map_err(|_| "original actor dropped fixture reply")?
    }

    #[cfg(test)]
    pub(crate) fn capture_fixture_frozen(&self) -> Option<Option<Frozen>> {
        self.capture_fixture_frozen.lock().unwrap().clone()
    }

    /// Open a session with an encoded `hello` frame. Returns the session (if
    /// accepted), the encoded response, and the session's outbound frames.
    pub async fn hello(
        &self,
        auth: SessionAuth,
        frame: Vec<u8>,
    ) -> Option<(Option<SessionId>, Vec<u8>, mpsc::UnboundedReceiver<Vec<u8>>)> {
        let (out, out_rx) = mpsc::unbounded_channel();
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Cmd::Hello {
                auth,
                frame,
                out,
                reply,
            })
            .ok()?;
        let (s, r) = rx.await.ok()?;
        Some((s, r, out_rx))
    }

    /// Feed a frame from a session's client.
    pub fn frame(&self, session: SessionId, bytes: Vec<u8>) -> bool {
        self.tx.send(Cmd::Frame(session, bytes)).is_ok()
    }

    /// A wake hint from the serialized actor, never grant authority. Subscribe
    /// before querying Effective; every wake still requires a fresh policy query.
    pub(crate) fn grant_policy_changes(&self) -> watch::Receiver<()> {
        self.grant_changes.clone()
    }

    /// The access list changed: re-check open sessions now.
    pub fn grants_changed(&self) {
        let _ = self.tx.send(Cmd::GrantsChanged(None));
    }

    /// The access list changed: re-check open sessions, and return only once the
    /// runtime has done so. The runtime is single-threaded, so any apply or commit
    /// in flight under the old grants has finished first, and every later commit
    /// re-checks the (already published) new authority. A revoke is acknowledged
    /// only after this returns. Returns at once if the runtime has stopped.
    pub async fn grants_barrier(&self) {
        let (tx, rx) = oneshot::channel();
        if self.tx.send(Cmd::GrantsChanged(Some(tx))).is_ok() {
            let _ = rx.await;
        }
    }

    /// [`Runtime::stop`] for a plain (non-async) thread.
    pub fn stop_blocking(&self) {
        let (tx, rx) = oneshot::channel();
        if self.tx.send(Cmd::Stop(false, tx)).is_ok() {
            let _ = rx.blocking_recv();
        }
        let thread = self.thread.lock().ok().and_then(|mut t| t.take());
        if let Some(t) = thread {
            let _ = t.join();
        }
    }

    /// The status and whether the replica has read up to the head it heard in the
    /// current connection.
    pub async fn readiness(&self) -> Option<ReadinessView> {
        let (tx, rx) = oneshot::channel();
        self.tx.send(Cmd::Readiness(tx)).ok()?;
        rx.await.ok()
    }

    /// SEEDED-HOLD fixture only: None reads the original actor's real ledger;
    /// Some commits one typed hold on that same actor, without a client mutation.
    #[cfg(test)]
    pub(crate) async fn test_seed_hold(
        &self,
        hold: Option<mdbn_wire::client::Hold>,
    ) -> Option<TestHoldWitness> {
        let (tx, rx) = oneshot::channel();
        self.tx.send(Cmd::TestSeedHold(Box::new(hold), tx)).ok()?;
        rx.await.ok().flatten()
    }

    /// After a full rescan, the confirmed records and resource paths (the adopt
    /// inventory of a local collection), or `None` once stopped or unreadable.
    pub async fn inventory(&self) -> Option<Inventory> {
        let (tx, rx) = oneshot::channel();
        self.tx.send(Cmd::Inventory(tx)).ok()?;
        rx.await.ok().flatten()
    }

    /// Stop the runtime at a single point for adopt: sessions are closed first,
    /// so no write is admitted after the snapshot; the folder is rescanned; the
    /// inventory and hold counts are taken; then the runtime stops as
    /// [`Runtime::stop`] does. On failure, returns the allowlisted terminal
    /// diagnostic when known; an absent diagnostic never proves recovery safe.
    pub async fn freeze(&self) -> Result<Frozen, Option<crate::sync_failure::Failure>> {
        let (tx, rx) = oneshot::channel();
        let sent = self.tx.send(Cmd::Freeze(tx)).is_ok();
        let frozen = if sent {
            rx.await.unwrap_or(Err(None))
        } else {
            Err(None)
        };
        #[cfg(test)]
        {
            *self.capture_fixture_frozen.lock().unwrap() = Some(frozen.as_ref().ok().cloned());
        }
        let thread = self.thread.lock().ok().and_then(|mut t| t.take());
        if let Some(t) = thread {
            let _ = tokio::task::spawn_blocking(move || t.join()).await;
        }
        frozen
    }

    /// The replica's sync status (confirmed through, pending, holds, conflicts,
    /// connection, incidents), or `None` once stopped.
    pub async fn status(&self) -> Option<mdbn_wire::client::SyncStatus> {
        let (tx, rx) = oneshot::channel();
        self.tx.send(Cmd::Status(tx)).ok()?;
        rx.await.ok()
    }

    /// Current native authority is rechecked on the actor before persisting
    /// intent or returning/copying a verified private-mode choice.
    pub async fn private_switch(
        &self,
        op: PrivateSwitchOp,
        current: AccountKeyGuard,
    ) -> Option<Result<Option<B16>, String>> {
        let (tx, rx) = oneshot::channel();
        self.tx.send(Cmd::PrivateSwitch(op, current, tx)).ok()?;
        rx.await.ok()
    }

    /// Read the actor's local privacy generation for durable consent binding.
    pub async fn mode_generation(
        &self,
        current: AccountKeyGuard,
    ) -> Option<mdbn_wire::common::B32> {
        let (tx, rx) = oneshot::channel();
        self.tx.send(Cmd::ModeGeneration(current, tx)).ok()?;
        rx.await.ok().flatten()
    }
    pub(crate) async fn mode_source(
        &self,
        private: bool,
        receipt: bool,
        current: AccountKeyGuard,
    ) -> Option<(u64, mdbn_replica::store::Head, Vec<B16>)> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Cmd::ModeSource {
                private,
                receipt,
                current,
                reply,
            })
            .ok()?;
        rx.await.ok().flatten()
    }

    /// Locally accepted, still-active switch-set signers under current authority.
    pub(crate) async fn private_switch_signers(
        &self,
        current: AccountKeyGuard,
    ) -> Option<Vec<B16>> {
        let (tx, rx) = oneshot::channel();
        self.tx.send(Cmd::PrivateSigners(current, tx)).ok()?;
        rx.await.ok()
    }

    /// `(count, SHA-256)` over the confirmed records' `(id, path, revision,
    /// modified_seq)`, in ID order: equal on two replicas exactly when their confirmed
    /// state is. Content-free (revisions are already hashes). `None` once stopped or
    /// on a store error.
    pub async fn confirmed_digest(&self) -> Option<(u64, [u8; 32])> {
        let (tx, rx) = oneshot::channel();
        self.tx.send(Cmd::Digest(tx)).ok()?;
        rx.await.ok().flatten()
    }

    /// Read-only counters and digests at one actor observation, or None once stopped.
    /// Diagnostic only: this is not a grant, prefix certificate or key-delivery ACK.
    pub async fn telemetry(
        &self,
    ) -> Option<(crate::control::SyncCounters, Vec<crate::control::Notice>)> {
        let (tx, rx) = oneshot::channel();
        self.tx.send(Cmd::Telemetry(tx)).ok()?;
        rx.await.ok()
    }

    /// Locally observed paths awaiting ingestion, for a terminal diagnostic.
    pub async fn pending_ingest_paths(&self) -> Vec<String> {
        let (tx, rx) = oneshot::channel();
        if self.tx.send(Cmd::PendingIngestPaths(tx)).is_err() {
            return Vec::new();
        }
        rx.await.unwrap_or_default()
    }

    /// Run an account-key operation; `None` once stopped. `Ok(true)`: keyed (status),
    /// or the unlock was accepted.
    pub async fn account_key(
        &self,
        op: AccountKeyOp,
    ) -> Option<Result<bool, mdbn_replica::replica::AccountKeyRefusal>> {
        let (tx, rx) = oneshot::channel();
        self.tx.send(Cmd::AccountKey(op, None, tx)).ok()?;
        rx.await.ok()
    }

    /// Account-key use with a live native custody fence at the actor boundary.
    pub(crate) async fn account_key_guarded(
        &self,
        op: AccountKeyOp,
        current: AccountKeyGuard,
    ) -> Option<Result<bool, mdbn_replica::replica::AccountKeyRefusal>> {
        let (tx, rx) = oneshot::channel();
        self.tx.send(Cmd::AccountKey(op, Some(current), tx)).ok()?;
        rx.await.ok()
    }

    /// Native-only applied witness; None when stopped, pending, stale or unhealthy.
    pub async fn strict_witness(
        &self,
        account: B16,
        recovery: B16,
        version: u64,
        revoked_at: u64,
    ) -> Option<mdbn_replica::replica::StrictWitness> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Cmd::StrictWitness {
                account,
                recovery,
                version,
                revoked_at,
                reply,
            })
            .ok()?;
        rx.await.ok().flatten()
    }

    /// Run a grant-approval operation; `None` once stopped.
    pub async fn grant_approval(&self, op: GrantApprovalOp) -> Option<GrantApprovalReply> {
        let (tx, rx) = oneshot::channel();
        self.tx.send(Cmd::GrantApproval(op, tx)).ok()?;
        rx.await.ok()
    }

    /// Run a device-approval operation; `None` once stopped.
    pub async fn device_approval(
        &self,
        op: DeviceApprovalOp,
    ) -> Option<Result<DeviceApprovalReply, Box<mdbn_wire::client::Problem>>> {
        let (tx, rx) = oneshot::channel();
        self.tx.send(Cmd::DeviceApproval(op, tx)).ok()?;
        rx.await.ok()
    }

    /// The client's transport closed.
    pub fn close(&self, session: SessionId) {
        let _ = self.tx.send(Cmd::Close(session));
    }

    /// Stop: close every session (their transports end), flush and close the
    /// replica, and wait for the thread. Works through any shared handle: sessions
    /// holding the runtime do not keep it serving. Later calls are refused.
    pub async fn stop(&self) {
        self.stop_with_deletion(false).await;
    }

    /// Stop after an authoritative collection deletion, telling open apps why.
    pub async fn stop_deleted(&self) {
        self.stop_with_deletion(true).await;
    }

    async fn stop_with_deletion(&self, deleted: bool) {
        let (tx, rx) = oneshot::channel();
        if self.tx.send(Cmd::Stop(deleted, tx)).is_ok() {
            let _ = rx.await;
        }
        let thread = self.thread.lock().ok().and_then(|mut t| t.take());
        if let Some(t) = thread {
            let _ = tokio::task::spawn_blocking(move || t.join()).await;
        }
    }
}
