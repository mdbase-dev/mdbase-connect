use super::mirror_join_tests::{CP_LABEL, admin_log_rpc, create_log, device_token, record_doc};
use super::*;
use crate::approval_journal::RequesterJournal;
use crate::registry::Origin;
use crate::secrets::{MemoryStore, SecretError};
use crate::sync::SyncConfig;
use crate::testutil::{TestDir, json_reply, json_request};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use mdbn_log_server::{AnyService, Gateway};
use mdbn_log_service::Service;
use mdbn_log_service::mem::{MemBackend, MemObjects};
use mdbn_log_service::testkit::ControlPlane;
use mdbn_replica::crypto::keys::EnrolledKeys;
use mdbn_replica::replica::{ApprovalPeerEnvelope, ApprovalPeerMessage};
use mdbn_wire::common::{B16, B32, Bytes, Text};
use mdbn_wire::intent::{Create, Op};
use mdbn_wire::log_service::{AppendParams, HeadParams, HeadResult};
use mdbn_wire::policy::{
    ApprovalRequest, CState, DeviceEnrol, DeviceKind, Genesis, MemberSet, PolicyOp, Role,
};
use mdbn_wire::schema::Wire;
use tokio::net::TcpListener;

#[derive(Default)]
struct TestKeychain(MemoryStore);

impl SecretStore for TestKeychain {
    fn get(&self, key: &str) -> Result<Option<zeroize::Zeroizing<Vec<u8>>>, SecretError> {
        self.0.get(key)
    }

    fn set(&self, key: &str, value: &[u8]) -> Result<(), SecretError> {
        self.0.set(key, value)
    }

    fn delete(&self, key: &str) -> Result<(), SecretError> {
        self.0.delete(key)
    }

    fn backend(&self) -> &'static str {
        "keychain"
    }
}

pub(super) fn keys(d: &Daemon) -> EnrolledKeys {
    let identity = d.identity.get().unwrap();
    let public = identity.public();
    let decode = |hex: &str| secrets::hex_decode(hex).unwrap().try_into().unwrap();
    EnrolledKeys {
        device: B16(identity.device_id),
        sign_pk: decode(&public.sign_pk),
        kem_pk: decode(&public.kem_pk),
        noise_pk: decode(&public.noise_pk),
    }
}

pub(super) async fn pair(
    dir: &TestDir,
    trust: &Arc<crate::trust::Trust>,
    owner: B16,
) -> Arc<Daemon> {
    let mut d = daemon(dir);
    let owned = Arc::get_mut(&mut d).unwrap();
    owned.secrets = Arc::new(TestKeychain::default());
    owned.trust = Some(trust.clone());
    assert!(d.self_weak.set(Arc::downgrade(&d)).is_ok());
    let epoch = d.begin_pairing().await.unwrap();
    d.publish_pairing(
        epoch,
        crate::cloud::CloudConfig {
            schema_version: 1,
            account_epoch: epoch,
            connector_id: Some(B16(new_uuid_v7()).to_uuid_string()),
            server_url: trust.cp_origin.clone(),
            ..Default::default()
        },
        &owner.to_uuid_string(),
        b"con_hermetic_fixture",
    )
    .await
    .unwrap();
    d
}

pub(super) async fn open(d: &Daemon, collection: B16, pin: B32, origin: Origin) {
    let trust = d.trust.as_ref().unwrap();
    let id = collection.to_uuid_string();
    let device = keys(d).device.to_uuid_string();
    let ctx = d.host_ctx().unwrap();
    let root = d.profile.state_dir.join("notes");
    std::fs::create_dir_all(&root).unwrap();
    let link = SyncConfig::path(&ctx.collections_dir, &id);
    std::fs::create_dir_all(link.parent().unwrap()).unwrap();
    SyncConfig {
        schema_version: 2,
        environment: trust.environment.clone(),
        collection_id: id.clone(),
        log_url: trust.log_origin.clone(),
        genesis_hash: secrets::hex(&pin.0),
        chosen_state: "private".into(),
        trusted_signers: vec![device.clone()],
        user_enabled_cloud_copy: false,
    }
    .save(&link, &collection.0, trust)
    .unwrap();
    let entry = crate::registry::Entry {
        id,
        name: "Private notes".into(),
        root,
        replica_id: B16(new_uuid_v7()).to_uuid_string(),
        mode: SyncMode::SyncedE2e,
        origin,
        description: None,
        added_at_ms: 0,
        paused: false,
        ever_e2e: true,
        owner_account: d
            .authority
            .active_account()
            .map(|account| account.to_uuid_string()),
        device: Some(device),
    };
    let mut inner = d.inner.lock().await;
    inner.registry.collections = vec![entry.clone()];
    d.authority.publish_registry(&inner.registry);
    inner.hosts.push(CollectionHost::open(entry, Some(ctx)));
}

async fn control(d: &Arc<Daemon>, method: &str, params: Value) -> Result<Value, ControlError> {
    d.handle(
        &Request {
            v: PROTOCOL,
            id: 1,
            method: method.into(),
            params,
        },
        &mut dispatch::ConnAuth {
            privileged: true,
            ..Default::default()
        },
    )
    .await
}

pub(super) async fn collection_status(d: &Arc<Daemon>) -> Value {
    control(d, "status", json!({})).await.unwrap()["collections"][0].clone()
}

pub(super) async fn serve_connect(
    listener: TcpListener,
    collection: B16,
    devices: [EnrolledKeys; 2],
    challenged: Arc<tokio::sync::Notify>,
) {
    let mut mail = Vec::<(B16, Value)>::new();
    loop {
        let (socket, path, body) = json_request(&listener).await;
        let answer = if path.ends_with("/devices/challenge") {
            json!({"challenge": "ab".repeat(32)})
        } else if path.ends_with("/log-token") {
            let device = devices
                .iter()
                .find(|device| body["device_id"] == device.device.to_uuid_string())
                .unwrap();
            let expires = fsutil::now_ms() as i64 + 900_000;
            json!({"token": device_token(device.device.0, device.sign_pk, collection.0, expires), "expires_at": expires})
        } else if path.ends_with("/device-approval/peer") {
            let peer = body["peer"].as_str().unwrap();
            let envelope =
                ApprovalPeerEnvelope::from_bytes(&URL_SAFE_NO_PAD.decode(peer).unwrap()).unwrap();
            let binding = &envelope.message.challenge().binding;
            let target = match envelope.message {
                ApprovalPeerMessage::Challenge(_) => binding.requester.device,
                ApprovalPeerMessage::Reveal(_) => binding.approver.device,
            };
            let id = B16(new_uuid_v7()).to_uuid_string();
            mail.push((target, json!({"id": id, "peer": peer})));
            if matches!(envelope.message, ApprovalPeerMessage::Challenge(_)) {
                challenged.notify_one();
            }
            json!({"outcome": "queued", "id": id})
        } else if path.ends_with("/device-approval/inbox") {
            let messages: Vec<_> = mail
                .iter()
                .filter_map(|(target, row)| {
                    (body["device_id"] == target.to_uuid_string()).then_some(row)
                })
                .collect();
            json!({"acknowledged": 0, "messages": messages})
        } else if path.ends_with("/device-approval/ack") {
            let before = mail.len();
            let ids = body["ids"].as_array().unwrap();
            mail.retain(|(target, row)| {
                body["device_id"] != target.to_uuid_string() || !ids.contains(&row["id"])
            });
            json!({"acknowledged": before - mail.len(), "messages": []})
        } else {
            json!({})
        };
        json_reply(socket, answer).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn opening_private_host_answers_approval_and_shows_matching_code() {
    private_join_with_history(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn opening_private_host_trusts_approver_after_commitment_renewal() {
    private_join_with_history(true).await;
}

async fn private_join_with_history(renewed: bool) {
    let cp = ControlPlane::new(CP_LABEL);
    let log_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let log = format!("http://{}", log_listener.local_addr().unwrap());
    let log_server = tokio::spawn(mdbn_log_server::serve(
        Gateway::new(
            AnyService::Mem(Service::new(
                MemBackend::default(),
                MemObjects::default(),
                mdbn_log_server::testkit_config(CP_LABEL, &log),
            )),
            false,
        ),
        log_listener,
    ));
    let cp_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let trust = Arc::new(crate::trust::Trust {
        environment: crate::trust::Environment::Lab.name().into(),
        cp_origin: format!("http://{}", cp_listener.local_addr().unwrap()),
        log_origin: log.clone(),
        roots: vec![cp.root_pk().0],
        policy_pins: crate::trust::pins_for(
            cp.root_pk().0,
            cp.transport_key().verifying_key().to_bytes(),
        ),
    });
    let (dir_a, dir_b) = (TestDir::new("sas-a"), TestDir::new("sas-b"));
    let (collection, owner) = (B16(new_uuid_v7()), B16(new_uuid_v7()));
    let (a, b) = (
        pair(&dir_a, &trust, owner).await,
        pair(&dir_b, &trust, owner).await,
    );
    let (keys_a, keys_b) = (keys(&a), keys(&b));
    let commitment = RequesterJournal::new(
        b.secrets.clone(),
        collection.0,
        owner.0,
        keys_b.device.0,
        b.authority.incarnation().unwrap().epoch,
    )
    .unwrap()
    .join_commitment(collection, keys_b, &mut mdbn_local_host::OsEntropy)
    .unwrap();
    let enrol = |keys: &EnrolledKeys, commitment| {
        PolicyOp::DeviceEnrol(DeviceEnrol {
            device: keys.device,
            account: owner,
            kind: DeviceKind::Desktop,
            sign_pk: B32(keys.sign_pk),
            kem_pk: B32(keys.kem_pk),
            noise_pk: B32(keys.noise_pk),
            sas_commit: commitment,
            local_root: None,
        })
    };
    let mut genesis_ops = vec![
        PolicyOp::Genesis(Genesis {
            owner,
            root: mdbn_log_service::policy::key_id(&cp.root_pk()),
            state: CState::E2e,
        }),
        PolicyOp::MemberSet(MemberSet {
            account: owner,
            role: Role::Owner,
        }),
        enrol(&keys_a, None),
    ];
    if renewed {
        genesis_ops.push(enrol(&keys_b, Some(B32([0x42; 32]))));
    }
    let genesis = cp.policy_item(collection, 1, B32([0; 32]), genesis_ops, 1);
    let pin = mdbn_wire::hash::chain_hash(&genesis);
    create_log(&log, &cp, collection, genesis).await;
    let target = keys_b.device.to_uuid_string();
    let challenged = Arc::new(tokio::sync::Notify::new());
    let cp_server = tokio::spawn(serve_connect(
        cp_listener,
        collection,
        [keys_a, keys_b],
        challenged.clone(),
    ));
    open(&a, collection, pin, Origin::Created).await;
    tokio::time::timeout(Duration::from_secs(15), async {
        while collection_status(&a).await["state"] != "ready" {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("A never became ready");
    let runtime_a = a.inner.lock().await.hosts[0].runtime().unwrap();
    let document = "# Private history\n";
    assert_eq!(
        submit_as(
            &runtime_a,
            vec![Op::Create(Create {
                id: B16(new_uuid_v7()),
                path: Some("private.md".into()),
                type_name: None,
                frontmatter: None,
                body: None,
                document: Some(Text::Inline(document.into())),
            })],
            new_uuid_v7(),
        )
        .await
        .unwrap(),
        crate::takeover::held::Outcome::Confirmed
    );
    let head = HeadResult::from_cbor(
        &admin_log_rpc(
            &log,
            &cp,
            collection,
            "head",
            HeadParams { collection }.to_cbor(),
        )
        .await,
    )
    .unwrap();
    let registration = if renewed {
        PolicyOp::ApprovalRequest(ApprovalRequest {
            device: keys_b.device,
            sas_commit: B32(commitment),
        })
    } else {
        enrol(&keys_b, Some(B32(commitment)))
    };
    let registration = cp.policy_item(
        collection,
        head.head + 1,
        head.head_chain,
        vec![registration],
        mdbn_log_server::now_ms(),
    );
    admin_log_rpc(
        &log,
        &cp,
        collection,
        "append",
        AppendParams {
            collection,
            expect_seq: head.head + 1,
            expect_prev: head.head_chain,
            items: vec![Bytes(registration)],
        }
        .to_cbor(),
    )
    .await;
    open(&b, collection, pin, Origin::Joined).await;

    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    let waiting = loop {
        let status_a = collection_status(&a).await;
        let status_b = collection_status(&b).await;
        if status_b["sync"]["last_error"] == "waiting_for_key" && status_a["state"] == "ready" {
            break status_b;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "A must serve while B waits for its key; A: {status_a}, B: {status_b}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    assert_eq!(waiting["state"], "opening");
    assert!(waiting["approval_code"].is_null());
    assert_eq!(
        control(&b, "device.pending", json!({})).await.unwrap(),
        json!([])
    );
    for (method, params) in [
        (
            "device.pending",
            json!({"collection": collection.to_uuid_string()}),
        ),
        (
            "device.approve",
            json!({"collection": collection.to_uuid_string(), "device": target, "sas": "000000"}),
        ),
        (
            "device.reject",
            json!({"collection": collection.to_uuid_string(), "device": target}),
        ),
    ] {
        assert_eq!(
            control(&b, method, params)
                .await
                .unwrap_err()
                .reason
                .as_deref(),
            Some("not_serving")
        );
    }

    let preparing = control(&a, "device.pending", json!({})).await.unwrap();
    assert_eq!(preparing[0]["device"], target);
    assert!(preparing[0]["sas"].is_null());
    tokio::time::timeout(Duration::from_secs(15), challenged.notified())
        .await
        .expect("A never queued its signed challenge");
    let request_task = tokio::spawn(b.clone().device_approval_requests());
    let sas = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let pending = control(&a, "device.pending", json!({})).await.unwrap();
            if let Some(code) = pending[0]["sas"].as_str() {
                assert_eq!(pending[0]["device"], target);
                break code.to_owned();
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("A never received B's signed reveal");
    assert_eq!(sas.len(), 6);
    assert!(sas.bytes().all(|digit| digit.is_ascii_digit()));
    let status = collection_status(&b).await;
    assert_eq!(status["state"], "opening");
    assert_eq!(status["sync"]["last_error"], "waiting_for_key");
    assert_eq!(status["approval_code"], sas);
    let list = control(&b, "collection.list", json!({})).await.unwrap();
    assert_eq!(list[0]["approval_code"], sas);

    assert_eq!(
        control(&a, "device.approve", json!({"device": target, "sas": sas}))
            .await
            .unwrap(),
        json!({"approved": [collection.to_uuid_string()]})
    );
    let ready = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let status = collection_status(&b).await;
            if status["state"] == "ready" {
                break status;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("B never became ready after the key grant");
    assert!(ready["approval_code"].is_null());
    let runtime_b = b.inner.lock().await.hosts[0].runtime().unwrap();
    assert_eq!(
        record_doc(&runtime_b, "private.md").await.unwrap().1,
        document
    );
    assert_ne!(ready["sync"]["last_error"], "waiting_for_key");
    assert_eq!(
        control(&a, "device.pending", json!({})).await.unwrap(),
        json!([])
    );

    b.shutdown.send_replace(true);
    request_task.await.unwrap();
    for d in [a, b] {
        d.shutdown.send_replace(true);
        d.stop_tasks().await;
        d.inner.lock().await.hosts[0].close().await;
    }
    cp_server.abort();
    log_server.abort();
}
