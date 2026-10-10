//! The trusted side of the exact-frame network transport for a [`Node`].
//!
//! A node with a real transport keeps its credentials here: the caller-owned
//! [`CallerHello`] signs each connection's challenge, canonical RPC frames are
//! encoded at this boundary ([`request_frame`]) and replies are decoded against
//! the retained original request ([`response_frame`]), so no typed payload
//! travels to, or is trusted from, the untrusted service actor.
//!
//! Connection phases are explicit so nothing is acknowledged early. The node
//! takes calls from the replica only through an authenticated session
//! (`bind_authenticated_log` after each admitted hello), so nothing is sent
//! before admission and a connection loss retires the session, which classifies
//! every transmitted call as `NoResponse` (outcome unknown). Replies are decoded
//! only inside the replica's scoped callback, against the retained original
//! request; a frame for an unknown or retired call never reaches a decoder.
//!
//! Direct object transfers (`RpcStep::Upload` / `RpcStep::Download`) are not
//! modelled over the simulated network yet: such a reply is counted as a harness
//! gap and failed, never completed as if the transfer had happened.
//!
//! [`Node`]: super::node::Node

use std::collections::BTreeMap;

use mdbn_replica::log::{LogCall, LogError, LogErrorCode, LogReply, LogRequest};
use mdbn_replica::replica::LogReplyScope;
use mdbn_wire::log_service::{LsFrame, LsPush};
use mdbn_wire::schema::Wire;

use mdbn_wire::common::B32;
use mdbn_wire::hash::sha256;

use super::real_log::{RpcStep, request_frame, response_frame};
use super::real_log_net::{CallerHello, direct};
use crate::world::World;

/// Hello frames take IDs from the top of the space; replica call IDs count up
/// from 1, so the two never collide within a run.
const HELLO_BASE: u64 = u64::MAX - (1 << 32);

/// Where the connection is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    /// No connection: calls fail `Offline` at once.
    Down,
    /// Upgrade sent, waiting for the server's challenge.
    Opening,
    /// Hello proof sent for this challenge, waiting for admission.
    Authenticating {
        /// The hello frame's call ID.
        call: u64,
    },
    /// Authenticated: frames flow.
    Up,
}

/// What became of a replica call handed to the transport.
pub enum Transmit {
    /// Send these exact frame bytes for this call.
    Send(u64, Vec<u8>),
    /// Failed without anything being sent (the scope comes back with it).
    Fail(u64, Option<LogReplyScope>, LogError),
}

/// Where a call's reply comes from.
pub enum ReplySource {
    /// The service's exact response frame, to decode against the retained
    /// original request inside the replica's scoped callback.
    Frame {
        /// The original request.
        request: LogRequest,
        /// The response frame bytes.
        bytes: Vec<u8>,
    },
    /// A reply the transport established itself: a committed upload, a
    /// verified download, or a transfer failure.
    Final(LogReply),
}

/// What an inbound frame meant.
pub enum Inbound {
    /// The hello was admitted: frames may flow.
    Admitted,
    /// Send these bytes as a direct transfer request (`WireEvent::Direct`).
    Direct(Vec<u8>),
    /// Send this exact raw RPC frame (`WireEvent::Frame`): the commit after an upload.
    Raw(Vec<u8>),
    /// The hello was refused by the service.
    Refused(LogError),
    /// The reply to a sent call, with the scope captured when it was sent.
    Reply {
        /// The call ID.
        call: u64,
        /// The replica's scope for it (`None` for a raw caller).
        scope: Option<LogReplyScope>,
        /// What to decode or deliver.
        source: ReplySource,
    },
    /// A production hub push, as received.
    Push(LsPush),
    /// Not for this connection (unknown call, hello out of phase, malformed).
    Stale,
}

/// A direct transfer the replica's call is waiting on; nothing is acknowledged
/// until the transfer and (for uploads) the commit reply both succeed.
enum Pending {
    /// Upload the exact original bytes, then `commit_object`.
    Upload {
        /// The original request (its bytes are what gets uploaded).
        request: LogRequest,
    },
    /// Uploaded; waiting for the `commit_object` reply (the raw call ID is in
    /// `commits`).
    Commit,
    /// Download, then verify against the advertised whole-object metadata.
    Download {
        /// The requested span, if any.
        range: Option<(u64, u64)>,
        /// Whole encoded object size.
        size: u64,
        /// Whole encoded object checksum.
        checksum: B32,
    },
}

/// Transport counters for oracles.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct WireStats {
    /// Hello proofs produced (one per challenge).
    pub hellos: u64,
    /// Hellos admitted.
    pub admitted: u64,
    /// Hellos refused.
    pub refused: u64,
    /// Stale or malformed inbound frames.
    pub stale: u64,
    /// Replies that required a direct transfer the harness does not model
    /// (none since direct transfers are modelled; kept for the oracle).
    pub unmodeled_direct: u64,
    /// Direct uploads completed (transfer + commit).
    pub uploads: u64,
    /// Direct downloads completed and verified.
    pub downloads: u64,
    /// Sent calls that lost their connection (outcome unknown).
    pub no_response: u64,
    /// Calls that failed `Offline` (nothing was sent).
    pub offline: u64,
}

/// The node's end of a real connection.
pub struct RealWire {
    hello: CallerHello,
    phase: Phase,
    /// Requests whose exact frame was transmitted on this connection, by call ID,
    /// retained to decode their replies, with the replica's scope.
    sent: BTreeMap<u64, (LogRequest, Option<LogReplyScope>)>,
    /// Direct transfers in progress, by the replica's call ID.
    pending: BTreeMap<u64, (Pending, Option<LogReplyScope>)>,
    /// Raw `commit_object` calls in flight: raw call ID → the replica's call ID.
    commits: BTreeMap<u64, u64>,
    /// Raw call IDs come from the same high range as hellos.
    raw_calls: u64,
    stats: WireStats,
}

impl RealWire {
    /// A transport for this caller.
    pub fn new(hello: CallerHello) -> Self {
        RealWire {
            hello,
            phase: Phase::Down,
            sent: BTreeMap::new(),
            pending: BTreeMap::new(),
            commits: BTreeMap::new(),
            raw_calls: 0,
            stats: WireStats::default(),
        }
    }

    fn raw_call_id(&mut self) -> u64 {
        self.raw_calls += 1;
        HELLO_BASE + (1 << 31) + self.raw_calls
    }

    /// The answer to a direct transfer request (`WireEvent::DirectReply`).
    pub fn direct_reply(&mut self, bytes: &[u8]) -> Inbound {
        use mdbn_wire::log_service::{CommitObjectParams, LsFrame, LsRequest};
        let Some((call, status, body)) = direct::decode_reply(bytes) else {
            self.stats.stale += 1;
            return Inbound::Stale;
        };
        let Some((pending, scope)) = self.pending.remove(&call) else {
            self.stats.stale += 1;
            return Inbound::Stale;
        };
        let reply = |call: u64, scope: Option<LogReplyScope>, r: LogReply| Inbound::Reply {
            call,
            scope,
            source: ReplySource::Final(r),
        };
        let service_error = |code: LogErrorCode| LogError::Service {
            code,
            reason: Some("direct".into()),
            retry_after_ms: None,
            missing: Vec::new(),
        };
        match (pending, status) {
            (Pending::Upload { request }, direct::Status::Ok) => {
                // Staged; nothing is acknowledged until the commit reply.
                let LogRequest::PutObject {
                    collection,
                    address,
                    ..
                } = &request
                else {
                    return reply(call, scope, Err(LogError::code(LogErrorCode::Invalid)));
                };
                let commit = self.raw_call_id();
                let frame = LsFrame::Request(LsRequest {
                    id: commit,
                    method: "commit_object".into(),
                    params: CommitObjectParams {
                        collection: *collection,
                        address: *address,
                    }
                    .to_cbor(),
                });
                match frame.to_bytes() {
                    Ok(bytes) => {
                        self.pending.insert(call, (Pending::Commit, scope));
                        self.commits.insert(commit, call);
                        Inbound::Raw(bytes)
                    }
                    Err(_) => reply(call, scope, Err(LogError::code(LogErrorCode::Invalid))),
                }
            }
            (
                Pending::Download {
                    range,
                    size,
                    checksum,
                },
                direct::Status::Ok,
            ) => {
                let whole = match range {
                    None => body.len() as u64 == size && sha256(body) == checksum,
                    Some((_, len)) => body.len() as u64 == len,
                };
                if !whole {
                    return reply(call, scope, Err(LogError::code(LogErrorCode::Invalid)));
                }
                self.stats.downloads += 1;
                reply(
                    call,
                    scope,
                    Ok(mdbn_replica::log::LogResponse::GetObject {
                        bytes: body.to_vec(),
                        size,
                        checksum,
                    }),
                )
            }
            (Pending::Commit, _) => {
                self.stats.stale += 1;
                Inbound::Stale
            }
            (_, direct::Status::NotFound) => {
                reply(call, scope, Err(service_error(LogErrorCode::NotFound)))
            }
            (_, direct::Status::Unavailable) => {
                reply(call, scope, Err(service_error(LogErrorCode::Unavailable)))
            }
            (_, direct::Status::Refused) => {
                reply(call, scope, Err(service_error(LogErrorCode::Invalid)))
            }
        }
    }

    /// Where the connection is.
    pub fn phase(&self) -> Phase {
        self.phase
    }

    /// Counters.
    pub fn stats(&self) -> WireStats {
        self.stats
    }

    /// Register the caller's key with the tap (before anything is sent).
    pub fn register(&self, w: &World) {
        self.hello.register(w);
    }

    /// The upgrade was sent.
    pub fn opening(&mut self) {
        debug_assert_eq!(self.phase, Phase::Down);
        self.phase = Phase::Opening;
    }

    /// The server's challenge arrived: the caller-signed hello frame for it, if
    /// this connection is waiting for one.
    pub fn challenge(&mut self, w: &World, nonce: &[u8; 32]) -> Option<Vec<u8>> {
        if self.phase != Phase::Opening {
            self.stats.stale += 1;
            return None;
        }
        self.stats.hellos += 1;
        let call = HELLO_BASE + self.stats.hellos;
        self.phase = Phase::Authenticating { call };
        Some(self.hello.frame(w, nonce, call))
    }

    /// Hand a replica call (and its scope) to the transport. Only an admitted
    /// connection transmits; otherwise nothing is sent and the call fails
    /// `Offline`.
    pub fn transmit(&mut self, call: LogCall, scope: Option<LogReplyScope>) -> Transmit {
        match self.phase {
            Phase::Up => match request_frame(&call.request, call.id.0) {
                Ok(bytes) => {
                    self.sent.insert(call.id.0, (call.request, scope));
                    Transmit::Send(call.id.0, bytes)
                }
                Err(e) => Transmit::Fail(call.id.0, scope, e),
            },
            Phase::Opening | Phase::Authenticating { .. } | Phase::Down => {
                self.stats.offline += 1;
                Transmit::Fail(call.id.0, scope, LogError::Offline)
            }
        }
    }

    /// Decode an inbound frame from the service.
    pub fn frame(&mut self, bytes: &[u8]) -> Inbound {
        let Ok(frame) = LsFrame::from_bytes(bytes) else {
            self.stats.stale += 1;
            return Inbound::Stale;
        };
        match frame {
            LsFrame::Response(r) => {
                if let Phase::Authenticating { call } = self.phase
                    && r.id == call
                {
                    return match r.error {
                        None => {
                            self.phase = Phase::Up;
                            self.stats.admitted += 1;
                            Inbound::Admitted
                        }
                        Some(e) => {
                            self.phase = Phase::Down;
                            self.stats.refused += 1;
                            Inbound::Refused(LogError::Service {
                                code: LogErrorCode::parse(&e.code)
                                    .unwrap_or(LogErrorCode::Unavailable),
                                reason: e.reason,
                                retry_after_ms: e.retry_after_ms,
                                missing: Vec::new(),
                            })
                        }
                    };
                }
                if let Some(call) = self.commits.remove(&r.id) {
                    // The commit after a staged upload: only `true` completes the
                    // replica's PutObject.
                    let ok = r.error.is_none()
                        && r.result.as_ref().is_some_and(|c| {
                            matches!(
                                c,
                                mdbn_wire::cbor::Cbor::Map(f)
                                    if f.iter().any(|(k, v)| *k == mdbn_wire::cbor::Cbor::Uint(0)
                                        && *v == mdbn_wire::cbor::Cbor::Bool(true))
                            )
                        });
                    let scope = self.pending.remove(&call).and_then(|(_, s)| s);
                    let reply = if ok {
                        self.stats.uploads += 1;
                        Ok(mdbn_replica::log::LogResponse::PutObject { existed: false })
                    } else {
                        Err(LogError::code(LogErrorCode::Invalid))
                    };
                    return Inbound::Reply {
                        call,
                        scope,
                        source: ReplySource::Final(reply),
                    };
                }
                let Some((request, scope)) = self.sent.remove(&r.id) else {
                    self.stats.stale += 1;
                    return Inbound::Stale;
                };
                // Classify only: a completed reply is decoded again inside the
                // replica's scoped callback; a pending transfer keeps its scope.
                match response_frame(&request, r.id, bytes) {
                    Ok(RpcStep::Complete(_)) | Err(_) => Inbound::Reply {
                        call: r.id,
                        scope,
                        source: ReplySource::Frame {
                            request,
                            bytes: bytes.to_vec(),
                        },
                    },
                    Ok(RpcStep::Upload(direct_transfer)) => {
                        // Upload the exact original bytes; the call completes only
                        // after the commit reply.
                        let LogRequest::PutObject { bytes: body, .. } = &request else {
                            return Inbound::Reply {
                                call: r.id,
                                scope,
                                source: ReplySource::Final(Err(LogError::code(
                                    LogErrorCode::Invalid,
                                ))),
                            };
                        };
                        let msg = direct::encode_request(&direct::Request {
                            call: r.id,
                            url: direct_transfer.url,
                            body: Some(body.clone()),
                            range: None,
                        });
                        self.pending
                            .insert(r.id, (Pending::Upload { request }, scope));
                        Inbound::Direct(msg)
                    }
                    Ok(RpcStep::Download {
                        direct: direct_transfer,
                        size,
                        checksum,
                    }) => {
                        let range = match &request {
                            LogRequest::GetObject { range, .. } => *range,
                            _ => None,
                        };
                        let msg = direct::encode_request(&direct::Request {
                            call: r.id,
                            url: direct_transfer.url,
                            body: None,
                            range,
                        });
                        self.pending.insert(
                            r.id,
                            (
                                Pending::Download {
                                    range,
                                    size,
                                    checksum,
                                },
                                scope,
                            ),
                        );
                        Inbound::Direct(msg)
                    }
                }
            }
            LsFrame::Push(p) => Inbound::Push(p),
            LsFrame::Request(_) => {
                self.stats.stale += 1;
                Inbound::Stale
            }
        }
    }

    /// The connection is gone: the IDs of the calls whose outcome is now
    /// unknown (transmitted, or mid-transfer). The replica learns that by
    /// retiring the session.
    pub fn down(&mut self) -> Vec<u64> {
        self.phase = Phase::Down;
        let mut sent: Vec<u64> = std::mem::take(&mut self.sent).into_keys().collect();
        sent.extend(std::mem::take(&mut self.pending).into_keys());
        self.commits.clear();
        self.stats.no_response += sent.len() as u64;
        sent
    }
}

/// Provisioning for scenarios and tests: real-keyed devices and a collection
/// created in the real service through the production control-plane session
/// (in process; test setup, not the path under test).
pub mod harness {
    use mdbn_log_service::auth::hello_digest;
    use mdbn_log_service::testkit::{ControlPlane, Device, id16, sign_digest};
    use mdbn_replica::crypto::hpke::KemKeyPair;
    use mdbn_replica::crypto::sign::DeviceSigner;
    use mdbn_replica::fake::FakeLogService;
    use mdbn_replica::policy::{SERVICE_ACCOUNT, key_id};
    use mdbn_replica::testkit::{
        SIGNED_CP_SEED, SIGNED_ROOT_SEED, TEST_OWNER, TestControlPlane, signed_root,
    };
    use mdbn_wire::cbor::Cbor;
    use mdbn_wire::common::{B32, B64, Bytes, Uuid, Version};
    use mdbn_wire::envelope::{Item, ItemKind};
    use mdbn_wire::hash::sha256;
    use mdbn_wire::log_service::AppendParams;
    use mdbn_wire::log_service::LsHelloParams;
    use mdbn_wire::policy::{CState, DeviceEnrol, DeviceKind, Genesis, MemberSet, PolicyOp, Role};
    use mdbn_wire::policy::{CpCert, PolicyPayload};
    use mdbn_wire::schema::Wire;

    use super::super::node::NodeCfg;
    use super::super::real_log::RealLogService;
    use super::super::real_log_net::CallerHello;
    use crate::world::World;

    /// A real-keyed device: the log service's helper (token, hello proof) and
    /// the replica's seeds, from the same key material.
    pub struct Dev {
        /// The service-side device helper (ID, token binding, hello proof).
        pub device: Device,
        /// The replica's signing seed (the helper's key seed).
        pub sign: [u8; 32],
        /// The replica's KEM secret.
        pub kem: [u8; 32],
    }

    /// A device whose keys derive from `label`/`name`.
    pub fn dev(label: &str, name: &str) -> Dev {
        let device = Device::new(&format!("{label}/{name}"), TEST_OWNER);
        // The replica signs with the device helper's key: same seed, same key.
        let sign = sha256(format!("device/{label}/{name}").as_bytes()).0;
        assert_eq!(DeviceSigner::from_seed(&sign).public(), device.pk().0);
        let kem = sha256(format!("{label}/{name}/kem").as_bytes()).0;
        Dev { device, sign, kem }
    }

    fn enrol(d: &Dev, kind: DeviceKind, account: Uuid) -> PolicyOp {
        PolicyOp::DeviceEnrol(DeviceEnrol {
            device: d.device.id,
            account,
            kind,
            sign_pk: B32(DeviceSigner::from_seed(&d.sign).public()),
            kem_pk: B32(KemKeyPair::from_secret(&d.kem).pk),
            noise_pk: B32([9; 32]),
            sas_commit: None,
            local_root: None,
        })
    }

    /// A provisioned collection in a real service.
    pub struct Provisioned {
        /// The control plane (tokens).
        pub cp: ControlPlane,
        /// The owner's desktops, in enrolment order.
        pub devs: Vec<Dev>,
        /// The passive escrow enrolled in cloud-copy state (its keys are held
        /// by nobody running; register them with the tap).
        pub escrow: Option<Dev>,
        /// Collection ID.
        pub collection: Uuid,
        /// The service (clone it into a `RealServiceActor`).
        pub service: RealLogService,
    }

    /// A collection with `n` real-keyed desktops of the owner in `state`. The
    /// genesis item is built by the replica engine's own signing test control
    /// plane, so the real service and the real engine verify the same bytes. In
    /// cloud-copy state it also enrols a passive escrow with real keys, which
    /// both sides require there (the initial rekey must reach the escrow).
    pub fn provision(label: &str, n: usize, state: CState) -> Provisioned {
        provision_with(label, n, n, state)
    }

    /// [`provision`], with only the first `enrolled` desktops in the genesis; the
    /// rest join later ([`Provisioned::enrol_late`]).
    pub fn provision_with(label: &str, n: usize, enrolled: usize, state: CState) -> Provisioned {
        let cp = ControlPlane::new(label);
        let devs: Vec<Dev> = (0..n)
            .map(|i| dev(label, &format!("node-{}", (b'a' + i as u8) as char)))
            .collect();
        let escrow = (state == CState::CloudCopy).then(|| dev(label, "escrow"));
        let collection = id16(&format!("{label}/collection"));
        let items = {
            let fake = FakeLogService::new();
            let mut ops = vec![
                PolicyOp::Genesis(Genesis {
                    owner: TEST_OWNER,
                    root: key_id(&signed_root()),
                    state,
                }),
                PolicyOp::MemberSet(MemberSet {
                    account: TEST_OWNER,
                    role: Role::Owner,
                }),
            ];
            for d in devs.iter().take(enrolled) {
                ops.push(enrol(d, DeviceKind::Desktop, TEST_OWNER));
            }
            if let Some(e) = &escrow {
                ops.push(enrol(e, DeviceKind::Escrow, SERVICE_ACCOUNT));
            }
            TestControlPlane::signed(collection).append(&fake, ops);
            fake.items(&collection)
        };
        assert_eq!(items.len(), 1, "one genesis item enrolling every device");
        let service = RealLogService::new(mdbn_log_service::Config {
            roots: vec![B32(signed_root())],
            token_issuers: vec![cp.issuer_pk()],
            url_secret: vec![0x5a; 32],
            public_base: "https://sim.invalid".into(),
        });
        let mut control = control_session(&service, &cp, &format!("{label}/bootstrap"));
        control
            .request(
                "create_log",
                Cbor::Map(vec![
                    (Cbor::Uint(0), collection.to_cbor()),
                    (Cbor::Uint(1), Cbor::Bytes(items[0].clone())),
                ]),
            )
            .expect("create_log with the engine's genesis");
        Provisioned {
            cp,
            devs,
            escrow,
            collection,
            service,
        }
    }

    /// An authenticated control-plane session on the real service (in process).
    fn control_session(
        service: &RealLogService,
        cp: &ControlPlane,
        nonce_label: &str,
    ) -> super::super::real_log::RealLog {
        let mut control = service.connect(sha256(nonce_label.as_bytes()).0);
        let token = cp.cp_token(i64::MAX);
        let sig = sign_digest(
            cp.transport_key(),
            &hello_digest(&control.server_nonce(), &token),
        );
        control
            .request(
                "hello",
                LsHelloParams {
                    version: Version { major: 1, minor: 0 },
                    token,
                    device: None,
                    sig,
                }
                .to_cbor(),
            )
            .expect("control-plane hello");
        control
    }

    impl Provisioned {
        /// Append one signed control-plane policy item with `ops` at the real
        /// service's current head (the replica engine's signing test control
        /// plane, so every replica verifies it). Returns its position. Lets a
        /// scenario revoke, enrol or freeze mid-run, as the control plane would.
        pub fn append_policy(&self, ops: Vec<mdbn_wire::policy::PolicyOp>) -> Result<u64, String> {
            let (head, chain) = self
                .service
                .stored_head_chain(&self.collection)
                .ok_or("no stored head")?;
            let cp_pk = DeviceSigner::from_seed(&SIGNED_CP_SEED).public();
            let mut cert = CpCert {
                policy_pk: B32(cp_pk),
                not_before: 0,
                not_after: i64::MAX,
                root: key_id(&signed_root()),
                sig: B64([0; 64]),
            };
            let d = cert.signed_digest().map_err(|e| format!("{e:?}"))?;
            cert.sig = B64(DeviceSigner::from_seed(&SIGNED_ROOT_SEED).sign_digest(&d.0));
            let payload = PolicyPayload {
                cert,
                // Strictly after the genesis item's issued_at.
                issued_at: 1_000 + head as i64,
                ops,
            };
            let mut item = Item {
                kind: ItemKind::Policy,
                collection: self.collection,
                seq: Some(head + 1),
                prev: Some(chain),
                epoch: None,
                signer: Some(key_id(&cp_pk)),
                salt: None,
                idem: None,
                refs: None,
                stream: None,
                body: Bytes(payload.to_bytes().map_err(|e| format!("{e:?}"))?),
                sig: Some(B64([0; 64])),
            };
            DeviceSigner::from_seed(&SIGNED_CP_SEED)
                .sign_item(&mut item)
                .map_err(|e| format!("{e:?}"))?;
            let bytes = item.to_bytes().map_err(|e| format!("{e:?}"))?;
            let mut control = control_session(
                &self.service,
                &self.cp,
                &format!("{}/policy/{}", self.collection.to_hex(), head + 1),
            );
            control
                .request(
                    "append",
                    AppendParams {
                        collection: self.collection,
                        expect_seq: head + 1,
                        expect_prev: chain,
                        items: vec![Bytes(bytes)],
                    }
                    .to_cbor(),
                )
                .map(|_| head + 1)
                .map_err(|e| e.to_string())
        }

        /// The control plane enrols desktop `i` after the genesis.
        pub fn enrol_late(&self, i: usize) -> Result<u64, String> {
            self.append_policy(vec![enrol(&self.devs[i], DeviceKind::Desktop, TEST_OWNER)])
        }

        /// The escrow keys desktop `i` (`sealed-envelope.md` §7.1: account-approved
        /// join with no hosted enrolled): it unwraps the current epoch key from the
        /// stored rekeys with its real KEM key and appends a signed `key_grant`, as
        /// the escrow replica does. Returns its position.
        pub fn escrow_grant(&self, i: usize) -> Result<u64, String> {
            use mdbn_replica::crypto::keys::Recipient;
            use mdbn_replica::seal::{KeyringSealer, Sealer};
            use mdbn_wire::envelope::RekeyPayload;
            let e = self.escrow.as_ref().ok_or("no escrow")?;
            let mut sealer = KeyringSealer::new(self.collection, e.device.id, &e.sign, &e.kem);
            let mut epoch = 0;
            for (_, bytes) in self.service.stored_items(&self.collection) {
                let Ok(item) = Item::from_bytes(&bytes) else {
                    continue;
                };
                if item.kind == ItemKind::Rekey
                    && let Ok(rk) = RekeyPayload::from_bytes(&item.body.0)
                {
                    sealer.accept_rekey(&rk);
                    epoch = epoch.max(rk.epoch);
                }
            }
            let d = &self.devs[i];
            let payload = sealer
                .build_key_grant(
                    epoch,
                    &Recipient {
                        device: d.device.id,
                        kem_pk: KemKeyPair::from_secret(&d.kem).pk,
                    },
                    &mut mdbn_replica::crypto::TestEntropy::new(0x6e),
                )
                .map_err(|e| format!("{e:?}"))?;
            let (head, chain) = self
                .service
                .stored_head_chain(&self.collection)
                .ok_or("no stored head")?;
            let mut item = Item {
                kind: ItemKind::KeyGrant,
                collection: self.collection,
                seq: Some(head + 1),
                prev: Some(chain),
                epoch: None,
                signer: Some(e.device.id),
                salt: None,
                idem: None,
                refs: None,
                stream: None,
                body: Bytes(payload.to_bytes().map_err(|e| format!("{e:?}"))?),
                sig: None,
            };
            sealer.sign(&mut item).map_err(|e| format!("{e:?}"))?;
            let bytes = item.to_bytes().map_err(|e| format!("{e:?}"))?;
            // The escrow's own authenticated device session.
            let mut session = self.service.connect(
                sha256(format!("{}/grant/{}", self.collection.to_hex(), head + 1).as_bytes()).0,
            );
            let token = self
                .cp
                .device_token_for(&e.device, i64::MAX, Some(self.collection));
            let sig = sign_digest(
                e.device.signing_key(),
                &hello_digest(&session.server_nonce(), &token),
            );
            session
                .request(
                    "hello",
                    LsHelloParams {
                        version: Version { major: 1, minor: 0 },
                        token,
                        device: Some(e.device.id),
                        sig,
                    }
                    .to_cbor(),
                )
                .map_err(|e| format!("escrow hello: {e}"))?;
            session
                .request(
                    "append",
                    AppendParams {
                        collection: self.collection,
                        expect_seq: head + 1,
                        expect_prev: chain,
                        items: vec![Bytes(bytes)],
                    }
                    .to_cbor(),
                )
                .map(|_| head + 1)
                .map_err(|e| e.to_string())
        }

        /// Register every key the devices hold with the tap: any of them on
        /// the wire is a key exposure.
        pub fn register_secrets(&self, w: &World) {
            let mut tap = w.shared.tap.borrow_mut();
            for (i, d) in self.devs.iter().enumerate() {
                tap.secret(&format!("device {i} signing seed"), &d.sign);
                tap.secret(&format!("device {i} KEM secret"), &d.kem);
            }
            if let Some(e) = &self.escrow {
                tap.secret("escrow signing seed", &e.sign);
                tap.secret("escrow KEM secret", &e.kem);
            }
        }

        /// Caller-owned hello material for device `i` (a device token bound to
        /// this collection, signed with the device's own key).
        pub fn hello(&self, i: usize) -> CallerHello {
            let d = &self.devs[i];
            CallerHello::new(
                self.cp
                    .device_token_for(&d.device, i64::MAX, Some(self.collection)),
                Some(d.device.id),
                &d.sign,
            )
        }

        /// Node parameters for device `i` with real keys; every desktop is a
        /// trusted signer.
        pub fn node_cfg(
            &self,
            i: usize,
            replica_id: Uuid,
            work: bool,
            snapshot_every: Option<u64>,
        ) -> NodeCfg {
            let d = &self.devs[i];
            NodeCfg {
                collection: self.collection,
                replica_id,
                device: d.device.id,
                work,
                work_every_ms: 150,
                reconnect_storm: false,
                snapshot_every,
                trusted: self.devs.iter().map(|d| d.device.id).collect(),
                keys: Some((d.sign, d.kem)),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::harness::{Provisioned as Fixture, provision};
    use super::*;
    use mdbn_wire::client::IncidentKind;
    use mdbn_wire::common::B16;
    use mdbn_wire::policy::CState;

    use std::rc::Rc;

    use mdbn_replica::log::{LogCall, LogReply, LogRequest};

    use crate::platform::Os;
    use crate::sut::node::{Node, confirmed_tokens};
    use crate::sut::real_log_net::{RealServiceActor, WireEvent};
    use crate::world::{ActorId, Ev, HookCfg, Payload, World};

    fn node(w: &mut World, f: &Fixture, i: usize, machine: usize, server: ActorId) -> ActorId {
        let name = ["A", "B", "C"][i];
        let me = w.actor_count() as ActorId;
        w.spawn(Box::new(
            Node::new(
                name,
                machine,
                me,
                server,
                f.node_cfg(i, B16([0x41 + i as u8; 16]), true, None),
            )
            .with_real_transport(f.hello(i)),
        ))
    }

    /// A world with the real service actor and `n` provisioned devices in
    /// `state`; node `A` is spawned, the others are left to the test
    /// (`node(w, &f, i, ..)`).
    fn world(
        seed: u64,
        label: &str,
        n: usize,
        state: CState,
    ) -> (World, Fixture, ActorId, ActorId) {
        let mut w = World::new(seed, true);
        let f = provision(label, n, state);
        f.register_secrets(&w);
        {
            let mut tap = w.shared.tap.borrow_mut();
            for m in ["title", "status", "tags", "Body ", "notes/"] {
                tap.marker(&format!("field or text {m:?}"), m.as_bytes());
            }
            for p in ["real:request", "real:response"] {
                tap.require(p);
            }
        }
        let ma = w.add_machine("ma", Os::Linux, HookCfg::default());
        w.chaos.restart_ms = (200, 500);
        let server = w.actor_count() as ActorId;
        assert_eq!(
            w.spawn(Box::new(RealServiceActor::new(server, f.service.clone()))),
            server
        );
        let a = node(&mut w, &f, 0, ma, server);
        (w, f, server, a)
    }

    fn confirmed(w: &World) -> u64 {
        w.shared
            .counters
            .borrow()
            .get("slice.confirmed")
            .copied()
            .unwrap_or(0)
    }

    /// Quiesce, then: every node is caught up with the service's stored head and
    /// holds the same records, every acknowledged write's tokens are in every
    /// node's confirmed state, nothing crossed the wire in the clear, and no
    /// oracle fired. Returns each node's transport counters.
    fn check(
        w: &mut World,
        f: &Fixture,
        server: ActorId,
        nodes: &[ActorId],
        seed: u64,
    ) -> Vec<WireStats> {
        if !w.quiesce(200, 5, 30_000) {
            let r = w.report("real-node", String::new());
            let tail: Vec<&String> = r.trace.iter().rev().take(80).collect();
            panic!(
                "seed {seed}: no quiescence; stats {:?}; pending {:?}; counters {:?}; trace tail (newest first):\n{}",
                nodes
                    .iter()
                    .map(|n| w.actor::<Node>(*n).and_then(Node::wire_stats))
                    .collect::<Vec<_>>(),
                nodes
                    .iter()
                    .map(|n| w
                        .actor::<Node>(*n)
                        .and_then(|n| n.replica().map(|r| r.sync_status().pending)))
                    .collect::<Vec<_>>(),
                r.counters,
                tail.iter()
                    .map(|l| l.as_str())
                    .collect::<Vec<_>>()
                    .join("\n")
            );
        }
        let head = w
            .actor::<RealServiceActor>(server)
            .unwrap()
            .head(&f.collection)
            .expect("stored head");
        let mut digests = Vec::new();
        let mut stats = Vec::new();
        for n in nodes {
            let node = w.actor::<Node>(*n).expect("node");
            let (node_head, records) = node.digest().expect("replica up");
            assert_eq!(
                node_head.seq,
                head,
                "seed {seed}: {} not caught up",
                w.name(*n)
            );
            let tokens = confirmed_tokens(node);
            {
                let acks = w.shared.acks.borrow();
                assert!(!acks.acks.is_empty(), "seed {seed}: nothing acknowledged");
                assert!(
                    acks.conflicts.is_empty(),
                    "seed {seed}: {:?}",
                    acks.conflicts
                );
                for ack in acks.acks.values() {
                    assert!(ack.seq > 0 && ack.seq <= head, "seed {seed}: ack {ack:?}");
                    for t in &ack.tokens {
                        assert!(
                            tokens.contains(t),
                            "seed {seed}: {} lost token {t} (acked by {} at {})",
                            w.name(*n),
                            ack.client,
                            ack.seq
                        );
                    }
                }
            }
            let st = node.wire_stats().expect("real transport");
            assert_eq!(st.refused, 0, "seed {seed}: {st:?}");
            assert_eq!(st.unmodeled_direct, 0, "seed {seed}: {st:?}");
            assert_eq!(st.stale, 0, "seed {seed}: {st:?}");
            digests.push((node_head, records));
            stats.push(st);
        }
        for d in &digests[1..] {
            assert_eq!(d.0, digests[0].0, "seed {seed}: heads differ");
            assert_eq!(d.1, digests[0].1, "seed {seed}: records differ");
        }
        assert!(
            w.shared.tap.borrow().hits.is_empty(),
            "seed {seed}: {:?}",
            w.shared.tap.borrow().hits
        );
        let report = w.report("real-node", String::new());
        assert!(
            report.violations.is_empty(),
            "seed {seed}: {:?}",
            report.violations
        );
        stats
    }

    #[test]
    fn node_syncs_acknowledged_writes_over_the_authenticated_frame_network() {
        for seed in 0..10 {
            let (mut w, f, server, a) = world(seed, "real-node-calm", 1, CState::E2e);
            w.run_chaos(3_000);
            let stats = check(&mut w, &f, server, &[a], seed)[0];
            assert_eq!(
                (stats.hellos, stats.admitted),
                (1, 1),
                "seed {seed}: {stats:?}"
            );
            assert_eq!(
                stats.no_response + stats.offline,
                0,
                "seed {seed}: {stats:?}"
            );
            assert!(confirmed(&w) > 0, "seed {seed}");
        }
    }

    /// A partition resets the stream (`World::partition`), which both ends observe
    /// as `Closed`: sent calls become `NoResponse`, the replica sees
    /// `Disconnected`, and nothing flows again until a fresh hello is admitted on
    /// the new connection.
    #[test]
    fn connection_loss_fails_sent_calls_as_unknown_and_reauthenticates_before_resuming() {
        let mut unknown_outcomes = 0;
        for seed in 0..10 {
            let (mut w, f, server, a) = world(seed, "real-node-partition", 1, CState::E2e);
            w.run_chaos(1_500);
            let before = confirmed(&w);
            assert!(
                before > 0,
                "seed {seed}: nothing confirmed before the partition"
            );
            w.partition(a, 300);
            w.run_chaos(2_500);
            let stats = check(&mut w, &f, server, &[a], seed)[0];
            assert_eq!(stats.admitted, 2, "seed {seed}: {stats:?}");
            unknown_outcomes += stats.no_response;
            assert_eq!(
                w.shared.counters.borrow().get("real.reconnected").copied(),
                Some(1),
                "seed {seed}: the replica must see one Disconnected/Reconnected pair"
            );
            assert!(
                confirmed(&w) > before,
                "seed {seed}: no writes confirmed after reconnecting"
            );
        }
        // Non-vacuity: some partition caught a call in flight, so the unknown
        // outcome path (`NoResponse`, same-bytes retry) was exercised.
        assert!(unknown_outcomes > 0, "no partition caught a call in flight");
    }

    /// After a process crash the restarted node opens a fresh connection and
    /// authenticates again; every write acknowledged before the crash is in its
    /// confirmed state. (The in-process client does not resume generating work
    /// after a restart: its timer died with the process; see
    /// the client-timer restart regression.)
    fn crash_and_check_pending_outcomes(seed: u64) -> usize {
        use mdbn_replica::Store;
        use std::collections::BTreeSet;

        let (mut w, f, server, a) = world(seed, "real-node-crash", 1, CState::E2e);
        w.crashable.push(a);
        w.run_chaos(1_500);
        let before = confirmed(&w);
        assert!(
            before > 0,
            "seed {seed}: nothing confirmed before the crash"
        );
        let before_acks = w.shared.acks.borrow().acks.clone();
        let attempts = |w: &World| {
            let counters = w.shared.counters.borrow();
            [
                "slice.submitted",
                "slice.rejected_at_submit",
                "slice.submit_error",
            ]
            .map(|key| counters.get(key).copied().unwrap_or(0))
        };
        let before_attempts = attempts(&w);
        // Snapshot the durable pending inventory, not the client's volatile
        // outstanding map. Only these mutations may newly ACK after restart.
        let store = w.actor::<Node>(a).unwrap().replica().unwrap().store();
        let mut pending = BTreeSet::new();
        let mut after = None;
        loop {
            let page = store.pending(after, 128).unwrap();
            if page.is_empty() {
                break;
            }
            after = page.last().map(|row| row.order);
            pending.extend(page.into_iter().map(|row| row.mutation.id.to_hex()));
        }
        w.crash(a);
        w.run_chaos(2_500);
        // check() still asserts transport reauthentication, convergence, every
        // acknowledged token is present, no plaintext leakage and no oracle violations.
        let stats = check(&mut w, &f, server, &[a], seed)[0];
        assert_eq!(stats.admitted, 2, "seed {seed}: {stats:?}");
        assert_eq!(
            attempts(&w),
            before_attempts,
            "seed {seed}: new submissions after crash"
        );
        let acks = w.shared.acks.borrow();
        for (id, ack) in &before_acks {
            assert_eq!(
                acks.acks.get(id),
                Some(ack),
                "seed {seed}: lost or changed pre-crash ACK"
            );
        }
        let newly_acked: Vec<_> = acks
            .acks
            .keys()
            .filter(|id| !before_acks.contains_key(*id))
            .collect();
        for id in &newly_acked {
            assert!(
                pending.contains(*id),
                "seed {seed}: post-restart ACK was not durably pending: {id}"
            );
        }
        assert_eq!(
            confirmed(&w) - before,
            newly_acked.len() as u64,
            "seed {seed}: a post-restart ACK was delivered more than once"
        );
        newly_acked.len()
    }

    #[test]
    fn a_crashed_node_reauthenticates_on_restart_and_converges() {
        for seed in 0..10 {
            crash_and_check_pending_outcomes(seed);
        }
    }

    #[test]
    fn seed_7_delivers_only_durable_pre_crash_pending_outcomes_once() {
        assert!(
            crash_and_check_pending_outcomes(7) > 0,
            "seed 7 must exercise receipt recovery, not only reconnection"
        );
    }

    /// A scripted caller owning a `RealWire`: authenticates, then runs its calls
    /// one at a time through the exact-frame network, including direct object
    /// transfers (upload then commit; download then verify).
    struct DirectCaller {
        me: ActorId,
        server: ActorId,
        wire: RealWire,
        script: Vec<LogRequest>,
        next: usize,
        replies: Vec<(u64, LogReply)>,
    }
    impl DirectCaller {
        fn send(&self, w: &mut World, bytes: Vec<u8>, event: WireEvent) {
            w.send_obj(self.me, self.server, bytes, Some(Payload(Rc::new(event))));
        }
        fn act(&mut self, w: &mut World, inbound: Inbound) {
            match inbound {
                Inbound::Admitted => self.next_call(w),
                Inbound::Direct(msg) => self.send(w, msg, WireEvent::Direct),
                Inbound::Raw(frame) => self.send(w, frame, WireEvent::Frame),
                Inbound::Reply { call, source, .. } => {
                    let reply = match source {
                        ReplySource::Frame { request, bytes } => {
                            match response_frame(&request, call, &bytes) {
                                Ok(RpcStep::Complete(r)) => Ok(r),
                                Ok(_) => Err(LogError::code(LogErrorCode::Invalid)),
                                Err(e) => Err(e),
                            }
                        }
                        ReplySource::Final(r) => r,
                    };
                    self.replies.push((call, reply));
                    self.next_call(w);
                }
                Inbound::Push(_) | Inbound::Stale | Inbound::Refused(_) => {}
            }
        }
        fn next_call(&mut self, w: &mut World) {
            let Some(request) = self.script.get(self.next).cloned() else {
                return;
            };
            self.next += 1;
            let call = LogCall {
                id: mdbn_replica::log::CallId(self.next as u64),
                endpoint: mdbn_replica::log::EndpointId(1),
                request,
            };
            match self.wire.transmit(call, None) {
                Transmit::Send(_, bytes) => self.send(w, bytes, WireEvent::Frame),
                Transmit::Fail(..) => panic!("the caller is admitted"),
            }
        }
    }
    impl crate::world::Actor for DirectCaller {
        fn name(&self) -> &str {
            "direct-caller"
        }
        fn handle(&mut self, w: &mut World, ev: Ev) {
            match ev {
                Ev::Start => {
                    self.wire.register(w);
                    self.wire.opening();
                    self.send(w, Vec::new(), WireEvent::Open);
                }
                Ev::Msg { from, bytes, obj } if from == self.server => {
                    match obj.as_ref().and_then(|p| p.get::<WireEvent>()).copied() {
                        Some(WireEvent::Challenge) => {
                            let nonce: [u8; 32] = bytes.try_into().expect("wire nonce");
                            if let Some(frame) = self.wire.challenge(&*w, &nonce) {
                                self.send(w, frame, WireEvent::Frame);
                            }
                        }
                        Some(WireEvent::Frame) => {
                            let inbound = self.wire.frame(&bytes);
                            self.act(w, inbound);
                        }
                        Some(WireEvent::DirectReply) => {
                            let inbound = self.wire.direct_reply(&bytes);
                            self.act(w, inbound);
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
        fn as_any(&self) -> &dyn std::any::Any {
            self
        }
        fn as_any_mut(&mut self) -> &mut dyn std::any::Any {
            self
        }
    }

    /// Direct object transfers over the network: an object above the inline
    /// ceiling is uploaded to the signed URL and acknowledged only after the
    /// commit reply; a download is served from the signed URL and verified
    /// against the advertised size and checksum (whole) or exact length (span).
    /// The bodies cross the wire and the tap scans them; nothing is in the clear.
    #[test]
    fn direct_object_transfers_complete_only_after_commit_and_verification() {
        use mdbn_log_service::testkit::object;
        use mdbn_replica::log::{LogRequest, LogResponse};
        use mdbn_wire::envelope::ItemKind;
        let (mut w, f, server, _a) = world(0, "real-node-direct", 2, CState::CloudCopy);
        // A keys the collection (objects carry an epoch); B's credentials drive the caller.
        w.run_chaos(1_000);
        let collection = f.collection;
        let body = object(collection, ItemKind::Chunk, 1, vec![0x5c; (1 << 20) + 1]);
        let address = sha256(&body);
        let script = vec![
            LogRequest::PutObject {
                collection,
                address,
                kind: ItemKind::Chunk,
                bytes: body.clone(),
            },
            LogRequest::GetObject {
                collection,
                address,
                range: None,
            },
            LogRequest::GetObject {
                collection,
                address,
                range: Some((10, 100)),
            },
        ];
        let me = w.actor_count() as ActorId;
        let caller = w.spawn(Box::new(DirectCaller {
            me,
            server,
            wire: RealWire::new(f.hello(1)),
            script,
            next: 0,
            replies: Vec::new(),
        }));
        w.run_chaos(1_500);
        let c = w.actor::<DirectCaller>(caller).unwrap();
        let stats = c.wire.stats();
        // The whole object goes through the signed URL; the service serves a
        // byte span inline, so only one download is direct.
        assert_eq!(
            (stats.admitted, stats.uploads, stats.downloads),
            (1, 1, 1),
            "{stats:?}"
        );
        assert_eq!(c.replies.len(), 3, "{:?}", c.replies);
        assert!(matches!(
            c.replies[0],
            (1, Ok(LogResponse::PutObject { existed: false }))
        ));
        match &c.replies[1] {
            (
                2,
                Ok(LogResponse::GetObject {
                    bytes,
                    size,
                    checksum,
                }),
            ) => {
                assert_eq!(bytes, &body);
                assert_eq!(*size, body.len() as u64);
                assert_eq!(*checksum, address);
            }
            other => panic!("{other:?}"),
        }
        match &c.replies[2] {
            (3, Ok(LogResponse::GetObject { bytes, size, .. })) => {
                assert_eq!(bytes, &body[10..110]);
                assert_eq!(*size, body.len() as u64);
            }
            other => panic!("{other:?}"),
        }
        let tap = w.shared.tap.borrow();
        assert!(tap.per_path.get("real:direct:upload").copied().unwrap_or(0) > 0);
        assert!(
            tap.per_path
                .get("real:object:download")
                .copied()
                .unwrap_or(0)
                > 0
        );
        assert!(tap.hits.is_empty(), "{:?}", tap.hits);
    }

    /// Two real-keyed desktops of the owner on their own machines, each
    /// authenticating with its own proof, in cloud-copy state (with a passive
    /// escrow enrolled): there the owner's desktop's initial rekey wraps the
    /// epoch key for every active desktop (`append.rs`, initial rekey), so B,
    /// joining after A has written, unwraps A's key from the log (A is a trusted
    /// signer) and both converge on the service's stored head with identical
    /// records; every acknowledged token is on both. (In private state B needs
    /// a SAS approval and key grant first, which the engine does not expose to
    /// hosts yet: see the next test.)
    #[test]
    fn two_devices_converge_over_the_authenticated_network() {
        for seed in 0..10 {
            let (mut w, f, server, a) = world(seed, "real-node-two", 2, CState::CloudCopy);
            w.run_chaos(1_500);
            assert!(
                confirmed(&w) > 0,
                "seed {seed}: A wrote nothing before B joined"
            );
            let mb = w.add_machine("mb", Os::Linux, HookCfg::default());
            let b = node(&mut w, &f, 1, mb, server);
            w.run_chaos(3_000);
            let stats = check(&mut w, &f, server, &[a, b], seed);
            assert_eq!(
                (stats[0].admitted, stats[1].admitted),
                (1, 1),
                "seed {seed}: {stats:?}"
            );
            let by_client: Vec<String> = w
                .shared
                .acks
                .borrow()
                .acks
                .values()
                .map(|a| a.client.clone())
                .collect();
            assert!(
                by_client.iter().any(|c| c == "A") && by_client.iter().any(|c| c == "B"),
                "seed {seed}: both devices must have acknowledged writes: {by_client:?}"
            );
        }
    }

    /// In private (e2e) state the initial rekey keys only the device that made
    /// it: an enrolled but unapproved second desktop must NOT obtain the epoch
    /// key from the log. B authenticates, applies the control prefix (the genesis
    /// enrolling it, A's rekey) and then reports `WaitingForKey` with nothing of A's
    /// content applied and nothing in the clear on the wire. (B keeps re-reading
    /// the unapplicable item on every reply meanwhile; repeated reads are a
    /// waiting-for-key diagnostic rather than a bounded-read invariant,
    /// so it is counted here, not asserted.)
    #[test]
    fn an_unapproved_device_in_private_state_waits_for_a_key() {
        for seed in 0..3 {
            let (mut w, f, server, a) = world(seed, "real-node-private-join", 2, CState::E2e);
            w.run_chaos(1_500);
            assert!(
                confirmed(&w) > 0,
                "seed {seed}: A wrote nothing before B joined"
            );
            let mb = w.add_machine("mb", Os::Linux, HookCfg::default());
            let b = node(&mut w, &f, 1, mb, server);
            w.run_chaos(1_000);
            let head = w
                .actor::<RealServiceActor>(server)
                .unwrap()
                .head(&f.collection)
                .expect("stored head");
            let nb = w.actor::<Node>(b).expect("B");
            let status = nb.replica().expect("B up").sync_status();
            // The control prefix: the genesis item (which enrols B) and A's
            // initial rekey; item 3 is A's first sealed entry.
            assert_eq!(
                status.confirmed_through, 2,
                "seed {seed}: B must apply only the control prefix: {status:?}"
            );
            assert_eq!(status.head_known, head, "seed {seed}: {status:?}");
            assert!(
                status
                    .incidents
                    .iter()
                    .any(|i| i.kind == IncidentKind::WaitingForKey),
                "seed {seed}: {status:?}"
            );
            let stats = nb.wire_stats().unwrap();
            assert_eq!(
                (stats.admitted, stats.refused),
                (1, 0),
                "seed {seed}: {stats:?}"
            );
            // The tap counts paths as it scans; `shared.counters` only gets them
            // in the report.
            let reads = w
                .shared
                .tap
                .borrow()
                .per_path
                .get("real:request")
                .copied()
                .unwrap_or(0);
            w.shared.count("finding.waiting_for_key_requests", reads);
            assert!(
                reads > 0,
                "seed {seed}: the request count must be observable"
            );
            assert!(
                w.shared.tap.borrow().hits.is_empty(),
                "seed {seed}: {:?}",
                w.shared.tap.borrow().hits
            );
            let na = w.actor::<Node>(a).expect("A");
            assert_eq!(na.digest().map(|(h, _)| h.seq), Some(head), "seed {seed}");
        }
    }
}
