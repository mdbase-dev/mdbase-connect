//! The runtime thread's event loop.

use super::*;

/// Wait after a watcher batch before observing (the store's quiescence window).
const WATCH_SETTLE: Duration = Duration::from_millis(120);

/// Local diagnostics only: no collection/record identity, note path or content.
pub(super) fn log_retention_reclaims(rep: &mut Replica<Store>) {
    for reclaimed in rep.store_mut().inner_mut().take_reclaimed() {
        tracing::warn!(
            size = ?reclaimed.size,
            since = reclaimed.since,
            "checked same-launch retained-file release; changed bytes remain evidence"
        );
    }
}

pub(super) fn run(
    mut rep: Replica<Store>,
    rx: std_mpsc::Receiver<Cmd>,
    signals: GrantSignals,
    link: Option<crate::logwire::Link>,
    watcher: Option<crate::watch::Watcher>,
    collection: B16,
    mut lock: mdbn_local_host::HostLock,
) {
    let GrantSignals { grants, changes } = signals;
    let mut ingest = VecDeque::new();
    let mut active_log = None;
    let mut last_heartbeat = std::time::Instant::now();
    let mut observe_due: Option<std::time::Instant> = None;
    let observe_every = if watcher.is_some() {
        OBSERVE_EVERY_WATCHED
    } else {
        OBSERVE_EVERY
    };
    let lease_of = || grants.read().map(|g| g.lease_expires_ms).unwrap_or(0);
    let mut lease_checked = lease_of();
    let mut frames = Frames::new();
    let mut outs: BTreeMap<SessionId, mpsc::UnboundedSender<Vec<u8>>> = BTreeMap::new();
    let mut last_observe = std::time::Instant::now();
    let mut acks: Vec<oneshot::Sender<()>> = Vec::new();
    let mut last_status = std::time::Instant::now();
    let mut adopting = rep.adopt_status() == Some(mdbn_replica::AdoptStatus::Pending);
    loop {
        if last_heartbeat.elapsed() >= HOST_HEARTBEAT {
            last_heartbeat = std::time::Instant::now();
            if let Err(e) = lock.heartbeat(crate::fsutil::now_ms() as u64) {
                tracing::warn!(error = %e, "folder host descriptor refresh failed");
            }
        }
        let now = crate::fsutil::now_ms() as i64;
        let wake = rep
            .next_wakeup()
            .map(|t| Duration::from_millis(t.saturating_sub(now).max(0) as u64))
            .unwrap_or(observe_every)
            .min(HOST_HEARTBEAT.saturating_sub(last_heartbeat.elapsed()));
        let wake = if ingest.is_empty() {
            wake.min(observe_every.saturating_sub(last_observe.elapsed()))
                .min(
                    observe_due
                        .map(|d| d.saturating_duration_since(std::time::Instant::now()))
                        .unwrap_or(observe_every),
                )
        } else {
            wake
        };
        // Wake at the lease expiry to close sessions on time.
        let lease = lease_of();
        let wake = if lease > now as u64 {
            wake.min(Duration::from_millis(lease - now as u64))
        } else {
            wake
        };
        let wake = if !ingest.is_empty() && rep.ingest_ready() {
            Duration::ZERO
        } else {
            wake
        };
        let received = rx.recv_timeout(wake);
        // Pure state queries must not wake their own waiters into a busy loop.
        let notify_grants = !matches!(
            &received,
            Ok(Cmd::GrantApproval(
                GrantApprovalOp::State(_) | GrantApprovalOp::Effective(_),
                _
            ))
        );
        retire_stale_log(&mut rep, &mut active_log);
        match received {
            #[cfg(test)]
            Ok(Cmd::CaptureFixture(op, reply)) => {
                let _ = reply.send(native_pending_fixture::handle(&mut rep, op));
            }
            Ok(Cmd::Hello {
                auth,
                frame,
                out,
                reply,
            }) => {
                let o = frames.hello(&mut rep, auth, &frame);
                if let Some(s) = o.session {
                    outs.insert(s, out);
                }
                let _ = reply.send((o.session, o.response));
            }
            Ok(Cmd::Frame(s, bytes)) => frames.on_frame(&mut rep, s, &bytes),
            Ok(Cmd::GrantsChanged(ack)) => {
                rep.grants_changed();
                lease_checked = lease_of();
                acks.extend(ack);
            }
            Ok(Cmd::Close(s)) => {
                frames.close(&mut rep, s);
                outs.remove(&s);
            }
            Ok(Cmd::Log(e)) => on_log_event(&mut rep, collection, &mut active_log, e),
            Ok(Cmd::Status(reply)) => {
                let _ = reply.send(rep.sync_status());
            }
            Ok(Cmd::ModeGeneration(current, reply)) => {
                let _ = reply.send(if current() {
                    rep.mode_generation()
                } else {
                    None
                });
            }
            Ok(Cmd::ModeSource {
                private,
                receipt,
                current,
                reply,
            }) => {
                if current() {
                    rep.refresh_mode_history();
                }
                let material = if !current() {
                    None
                } else if receipt {
                    rep.mode_switch_receipt(private)
                        .map(|(epoch, head)| (epoch, head, Vec::new()))
                } else {
                    rep.mode_switch_source(private).map(|epoch| {
                        (
                            epoch,
                            rep.head(),
                            if private {
                                rep.mode_switch_members()
                            } else {
                                Vec::new()
                            },
                        )
                    })
                };
                let _ = reply.send(material);
            }
            Ok(Cmd::PrivateSigners(current, reply)) => {
                let _ = reply.send(if current() {
                    rep.private_switch_trusted_signers()
                } else {
                    Vec::new()
                });
            }
            Ok(Cmd::PrivateSwitch(op, current, reply)) => {
                use mdbn_replica::api::ClientApi;
                let result = if !current() {
                    Err("account_changed".into())
                } else if matches!(op, PrivateSwitchOp::CloudCandidate) {
                    Ok(rep.cloud_copy_candidate())
                } else if matches!(op, PrivateSwitchOp::CloudSelected) {
                    Ok(rep.cloud_copy_selected())
                } else if matches!(op, PrivateSwitchOp::CloudRead) {
                    Ok(rep.cloud_read_owner())
                } else if matches!(op, PrivateSwitchOp::Accepted) {
                    Ok(rep.accepted_private_switch())
                } else {
                    rep.hello(
                        SessionAuth::Host,
                        mdbn_wire::client::HelloParams {
                            versions: vec![mdbn_wire::common::Version { major: 1, minor: 0 }],
                            client_name: "mdbase".into(),
                            client_version: env!("CARGO_PKG_VERSION").into(),
                            features: None,
                            timezone: None,
                        },
                    )
                    .map_err(|_| "private_switch_unavailable".to_string())
                    .and_then(|(session, _)| {
                        let result = match op {
                            PrivateSwitchOp::Request => rep.request_private_switch(session),
                            PrivateSwitchOp::Cancel => rep.cancel_private_switch(session),
                            PrivateSwitchOp::ChooseCloud => rep.choose_cloud_copy(session),
                            PrivateSwitchOp::ChooseCloudAt(generation) => {
                                rep.choose_cloud_copy_at(session, generation)
                            }
                            PrivateSwitchOp::CancelCloud => rep.cancel_cloud_copy(session),
                            PrivateSwitchOp::Acknowledge => rep.acknowledge_private_switch(session),
                            PrivateSwitchOp::Accepted
                            | PrivateSwitchOp::CloudCandidate
                            | PrivateSwitchOp::CloudRead
                            | PrivateSwitchOp::CloudSelected => {
                                unreachable!()
                            }
                        };
                        rep.close(session);
                        result.map(|()| None).map_err(|e| e.to_string())
                    })
                };
                let _ = reply.send(result);
            }
            Ok(Cmd::Readiness(reply)) => {
                let _ = reply.send((rep.sync_status(), rep.caught_up(), rep.adopt_status()));
            }
            #[cfg(test)]
            Ok(Cmd::TestSeedHold(hold, reply)) => {
                use mdbn_replica::store::Store as _;
                let result = (|| {
                    // Per-original Runtime command, never a global hook. No
                    // synced store or borrowed application grant is admissible.
                    if rep.sync_status().mode != mdbn_wire::client::SyncMode::LocalOnly {
                        return None;
                    }
                    if let Some(hold) = *hold {
                        if rep.store().pending_count().ok()? != 0 {
                            return None;
                        }
                        let record = rep.store().record(&hold.id).ok()??;
                        if record.path != hold.path {
                            return None;
                        }
                        rep.store_mut()
                            .commit(mdbn_replica::store::Tx {
                                holds_put: vec![hold],
                                ..Default::default()
                            })
                            .ok()?;
                    }
                    test_hold_witness(&rep)
                })();
                let _ = reply.send(result);
            }
            Ok(Cmd::Inventory(reply)) => {
                if rep.ingest_ready() {
                    rep.ingest(ingest.drain(..).collect());
                }
                rep.store_mut().inner_mut().request_rescan();
                if let Err(e) = rep.observe(None) {
                    tracing::warn!(error = ?e, "observe failed");
                }
                let _ = reply.send(if ingest.is_empty() {
                    inventory(&rep)
                } else {
                    None
                });
            }
            Ok(Cmd::Digest(reply)) => {
                let _ = reply.send(confirmed_digest(&rep));
            }
            Ok(Cmd::PendingIngestPaths(reply)) => {
                let _ = reply.send(rep.resource_ingest_paths());
            }
            // The caller stopped waiting (status timed out): skip the record scan.
            Ok(Cmd::Telemetry(reply)) if reply.is_closed() => {}
            Ok(Cmd::Telemetry(reply)) => {
                use mdbn_replica::store::Store as _;
                let status = rep.sync_status();
                let head_digest = rep
                    .store()
                    .head()
                    .ok()
                    .filter(|h| h.seq == status.confirmed_through)
                    .map(|h| crate::secrets::hex(&h.chain.0));
                let records = confirmed_digest(&rep);
                let mut counters = sync_counters(&status, rep.caught_up(), head_digest, records);
                counters.pending += ingest.len() as u64 + rep.pending_file_transfers();
                counters.unsupported_entries = rep.store().inner().stats.unsupported_entries;
                let _ = reply.send((counters, file_notices(&rep)));
            }
            Ok(Cmd::StrictWitness {
                account,
                recovery,
                version,
                revoked_at,
                reply,
            }) => {
                let _ = reply
                    .send(rep.account_key_strict_witness(account, recovery, version, revoked_at));
            }
            Ok(Cmd::AccountKey(op, current, reply)) => {
                if !account_key_allowed(&op, current.as_ref()) {
                    let _ =
                        reply.send(Err(mdbn_replica::replica::AccountKeyRefusal::NotAuthorized));
                } else {
                    let _ = reply.send(match op {
                        AccountKeyOp::Status(r) => {
                            rep.account_key_device_keyed(&r.derive(&collection))
                        }
                        AccountKeyOp::Key(r) => rep
                            .key_account_key_device(&r.derive(&collection))
                            .map(|()| false),
                        AccountKeyOp::Unlock(r) => rep
                            .self_grant_with_account_key(r.derive(&collection))
                            .map(|()| true),
                        AccountKeyOp::Unlocked => rep.account_key_unlock_state(),
                        AccountKeyOp::CanKey => rep.account_key_can_key(),
                        // Never enrolled here: no account-key device to revoke.
                        AccountKeyOp::RevokedAndRekeyed(d) => {
                            Ok(rep.account_key_revoked_and_rekeyed(&d).unwrap_or(true))
                        }
                    });
                }
            }
            Ok(Cmd::GrantApproval(op, reply)) => {
                let _ = reply.send(match op {
                    GrantApprovalOp::Pending => {
                        GrantApprovalReply::Pending(rep.pending_grant_infos())
                    }
                    GrantApprovalOp::Approve {
                        grant,
                        capabilities,
                        folders,
                    } => GrantApprovalReply::Approve(
                        rep.queue_grant_approval(grant, capabilities, folders)
                            .map_err(|e| {
                                e.problem()
                                    .reason
                                    .clone()
                                    .unwrap_or_else(|| e.problem().code.clone())
                            }),
                    ),
                    GrantApprovalOp::State(grant) => {
                        GrantApprovalReply::State(rep.grant_approval_state(&grant))
                    }
                    GrantApprovalOp::Effective(grant) => {
                        GrantApprovalReply::Effective(rep.grant_effective(&grant))
                    }
                });
            }
            Ok(Cmd::DeviceApproval(op, reply)) => {
                let _ = reply.send(device_approval::handle(&mut rep, op));
            }
            Ok(Cmd::FsWake) => {
                if let Some(w) = &watcher {
                    let events = w.take();
                    tracing::debug!(events = events.len(), "watcher batch");
                    if !events.is_empty() {
                        rep.store_mut().inner_mut().on_events(&events);
                        // After this batch's own quiescence window.
                        observe_due = Some(std::time::Instant::now() + WATCH_SETTLE);
                    }
                }
            }
            Ok(Cmd::Freeze(reply)) => {
                // Writers first: every frame queued before this command has been
                // handled; closing the sessions admits nothing after it.
                if let Some(session) = active_log.take() {
                    rep.retire_authenticated_log(session.authenticated());
                }
                for s in outs.keys().copied().collect::<Vec<_>>() {
                    frames.close(&mut rep, s);
                }
                drop(watcher);
                if rep.ingest_ready() {
                    rep.ingest(ingest.drain(..).collect());
                }
                rep.store_mut().inner_mut().request_rescan();
                let mut failure = None;
                let frozen = match rep.observe(None) {
                    Ok(_) => {
                        // observe() can return Ok after ingest records a terminal
                        // incident. An empty confirmed index is NOT a successful
                        // source capture in that case. Nor is pending work a
                        // quiescent cut: do not drop its ownership into a Base.
                        let status = rep.sync_status();
                        let terminal = status.incidents.iter().any(|i| {
                            matches!(
                                i.kind,
                                mdbn_wire::client::IncidentKind::Integrity
                                    | mdbn_wire::client::IncidentKind::VerificationMismatch
                                    | mdbn_wire::client::IncidentKind::KeyInconsistent
                                    | mdbn_wire::client::IncidentKind::AccessRevoked
                                    | mdbn_wire::client::IncidentKind::Gone
                                    | mdbn_wire::client::IncidentKind::UpgradeRequired
                            )
                        });
                        // SyncStatus is a display projection: count read errors
                        // there become zero and acknowledged resurrection rows
                        // are subtracted. Capture must prove ALL ownership/count
                        // reads successful directly, not treat masked zero as a
                        // quiescence or holds/completeness fence.
                        let counts = capture_counts(rep.store());
                        match (terminal, counts) {
                            (false, Some((holds, unresolved))) if ingest.is_empty() => {
                                inventory(&rep).map(|inventory| Frozen {
                                    inventory,
                                    holds,
                                    unresolved,
                                })
                            }
                            _ => {
                                failure = crate::sync_failure::Failure::project(
                                    &status,
                                    &rep.adopt_status(),
                                );
                                if let Some(failure) = &mut failure
                                    && failure.cause
                                        == Some(crate::sync_failure::Cause::ResourceIngestDeferred)
                                {
                                    failure.paths = rep.resource_ingest_paths();
                                }
                                tracing::warn!(
                                    pending = status.pending,
                                    terminal,
                                    "freeze source capture incomplete"
                                );
                                None
                            }
                        }
                    }
                    Err(e) => {
                        tracing::warn!(error = ?e, "observe failed");
                        None
                    }
                };
                drop(link);
                drop(rep);
                let _ = reply.send(frozen.ok_or(failure));
                return;
            }
            Ok(Cmd::Stop(deleted, done)) => {
                if deleted {
                    use mdbn_wire::client::{ClientFrame, ClientPush};
                    use mdbn_wire::schema::Wire;
                    let mut problem = mdbn_replica::api::ErrorCode::Forbidden
                        .problem("collection deleted by its owner");
                    problem.reason = Some("collection_deleted".into());
                    problem.recovery = mdbn_wire::client::Recovery::None;
                    let closed = ClientFrame::Push(ClientPush {
                        kind: "closed".into(),
                        payload: problem.to_cbor(),
                    })
                    .to_bytes()
                    .expect("closed problem encodes");
                    for out in outs.values() {
                        let _ = out.send(closed.clone());
                    }
                }
                // Classify original in-flight outcomes while the Store is still
                // alive, before cancellation/join drops the transport and actor.
                if let Some(session) = active_log.take() {
                    rep.retire_authenticated_log(session.authenticated());
                }
                for s in outs.keys().copied().collect::<Vec<_>>() {
                    frames.close(&mut rep, s);
                }
                drop(watcher);
                drop(link);
                drop(rep);
                let _ = done.send(());
                return;
            }
            Err(std_mpsc::RecvTimeoutError::Timeout) => {}
            Err(std_mpsc::RecvTimeoutError::Disconnected) => return,
        }
        if ingest.is_empty() && observe_due.is_some_and(|d| std::time::Instant::now() >= d) {
            // Watcher-queued paths whose quiescence window has passed.
            observe_due = None;
            tracing::debug!("watcher observe");
            match rep.observe_changes() {
                Ok(changes) => ingest.extend(changes),
                Err(e) => tracing::warn!(error = ?e, "observe failed"),
            }
            log_retention_reclaims(&mut rep);
            // Paths still inside their quiescence window: observe again when due.
            if let Some(t) = rep.store_mut().inner_mut().next_wakeup() {
                let now = crate::fsutil::now_ms() as u64;
                observe_due = Some(
                    std::time::Instant::now() + Duration::from_millis(t.saturating_sub(now).max(5)),
                );
            }
        }
        if ingest.is_empty()
            && adopting
            && rep.adopt_status() != Some(mdbn_replica::AdoptStatus::Pending)
        {
            // The base is applied: ingest what changed meanwhile now, not at the
            // next periodic rescan.
            adopting = false;
            rep.store_mut().inner_mut().request_rescan();
            match rep.observe_changes() {
                Ok(changes) => ingest.extend(changes),
                Err(e) => tracing::warn!(error = ?e, "observe failed"),
            }
            last_observe = std::time::Instant::now();
        }
        if ingest.is_empty() && last_observe.elapsed() >= observe_every {
            // No watcher yet: `observe(None)` only walks the folder when a rescan is
            // requested; without one, external edits were never seen.
            rep.store_mut().inner_mut().request_rescan();
            match rep.observe_changes() {
                Ok(changes) => ingest.extend(changes),
                Err(e) => tracing::warn!(error = ?e, "observe failed"),
            }
            log_retention_reclaims(&mut rep);
            last_observe = std::time::Instant::now();
        }
        if !ingest.is_empty() && rep.ingest_ready() {
            let batch = ingest.drain(..ingest.len().min(64)).collect();
            rep.ingest(batch);
        }
        let now_ms = crate::fsutil::now_ms() as u64;
        if lease_checked != 0 && now_ms >= lease_checked {
            rep.grants_changed(); // the lease lapsed: sessions under it close now
            lease_checked = 0;
        }
        rep.tick();
        frames.tick(&mut rep, crate::fsutil::now_ms() as i64);
        frames.pump(&mut rep);
        if let Some(link) = &link {
            send_log_calls(&mut rep, link, &mut active_log);
            if last_status.elapsed() >= Duration::from_secs(5) {
                last_status = std::time::Instant::now();
                let st = rep.sync_status();
                tracing::debug!(
                    confirmed_through = st.confirmed_through,
                    head_known = st.head_known,
                    pending = st.pending,
                    holds = st.holds,
                    unresolved = st.unresolved,
                    connection = ?st.connection,
                    incidents = ?st.incidents,
                    "synced status"
                );
            }
        }
        for (s, bytes) in frames.take_outgoing() {
            if let Some(o) = outs.get(&s)
                && o.send(bytes).is_err()
            {
                frames.close(&mut rep, s);
            }
        }
        for s in frames.take_closed() {
            outs.remove(&s);
        }
        // Sessions closed by a grant change have been told before it is answered.
        for a in acks.drain(..) {
            let _ = a.send(());
        }
        if notify_grants {
            changes.send_modify(|_| {});
        }
    }
}
