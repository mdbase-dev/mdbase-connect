use super::*;
use mdbn_wire::cbor::Cbor;

fn vectors() -> Vec<Vec<u8>> {
    let fixture: Value =
        serde_json::from_str(include_str!("cloud_approval_peer_test_vectors.json")).unwrap();
    assert_eq!(fixture["public_test_only"], true);
    fixture["vectors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| secrets::hex_decode(v["peer_hex"].as_str().unwrap()).unwrap())
        .collect()
}
fn row(bytes: &[u8], id: Uuid) -> Value {
    json!({"id":secrets::uuid_string(&id.0),"peer":URL_SAFE_NO_PAD.encode(bytes)})
}
fn bound(bytes: &[u8]) -> (Uuid, Uuid) {
    let envelope = ApprovalPeerEnvelope::from_bytes(bytes).unwrap();
    let binding = &envelope.message.challenge().binding;
    let recipient = match envelope.message {
        ApprovalPeerMessage::Challenge(_) => binding.requester.device,
        ApprovalPeerMessage::Reveal(_) => binding.approver.device,
    };
    (binding.collection, recipient)
}
#[test]
fn actual_rust269_candidates_preserve_exact_canonical_bytes_and_redact_debug() {
    for bytes in vectors() {
        let (collection, recipient) = bound(&bytes);
        let id = Uuid([9; 16]);
        let peers = candidates(
            json!({"messages":[row(&bytes,id)],"acknowledged":0}),
            collection,
            recipient,
        )
        .unwrap();
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].id(), id);
        assert_eq!(peers[0].signed_bytes(), bytes);
        assert!(peers[0].envelope().verify_signature());
        assert_eq!(peers[0].envelope().to_bytes().unwrap(), bytes);
        let text = format!("{:?} {:?}", peers[0], ApprovalPeerQueued { id });
        assert!(!text.contains(&secrets::hex(&bytes)));
        assert!(!text.contains(&secrets::uuid_string(&id.0)));
        assert!(!text.contains("r_a"));
    }
}
#[test]
fn candidates_refuse_route_recipient_duplicate_padding_and_bounds() {
    let bytes = vectors().remove(0);
    let (collection, recipient) = bound(&bytes);
    let id = Uuid([9; 16]);
    let good = json!({"messages":[row(&bytes,id)],"acknowledged":0});
    assert!(candidates(good.clone(), Uuid([88; 16]), recipient).is_err());
    assert!(candidates(good.clone(), collection, Uuid([88; 16])).is_err());
    let mut bad = good.clone();
    bad["acknowledged"] = json!(1);
    assert!(candidates(bad, collection, recipient).is_err());
    let mut bad = good.clone();
    bad["messages"] = json!([row(&bytes, id), row(&bytes, id)]);
    assert!(candidates(bad, collection, recipient).is_err());
    let mut bad = good.clone();
    bad["messages"][0]["peer"] = json!(format!("{}=", URL_SAFE_NO_PAD.encode(&bytes)));
    assert!(candidates(bad, collection, recipient).is_err());
    let mut bad = good.clone();
    bad["messages"][0]["peer"] = json!("A".repeat(MAX_ENCODED + 1));
    assert!(candidates(bad, collection, recipient).is_err());
    let mut bad = good.clone();
    bad["messages"] = json!(
        (0..17)
            .map(|n| row(&bytes, Uuid([n + 1; 16])))
            .collect::<Vec<_>>()
    );
    assert!(candidates(bad, collection, recipient).is_err());
    let mut bad = good.clone();
    bad["messages"][0]["extra"] = json!(true);
    assert!(candidates(bad, collection, recipient).is_err());
    let mut corrupt = bytes.clone();
    *corrupt.last_mut().unwrap() ^= 1;
    assert!(
        candidates(
            json!({"messages":[row(&corrupt,id)],"acknowledged":0}),
            collection,
            recipient
        )
        .is_err()
    );
}
#[test]
fn ack_domain_has_explicit_uuid_array_never_sas_commit_slot() {
    let challenge = [1; 32];
    let connector = [2; 16];
    let device = [3; 16];
    let collection = [4; 16];
    let ids = [Uuid([5; 16]), Uuid([6; 16])];
    // Independent literal mdb-cbor array construction: 5 fields, last field an
    // ARRAY of two bytes16 values, not a bytes32 or bootstrap SAS slot.
    let mut wire = vec![0x85, 0x58, 0x20];
    wire.extend(challenge);
    for value in [connector, device, collection] {
        wire.push(0x50);
        wire.extend(value);
    }
    wire.push(0x82);
    for id in ids {
        wire.push(0x50);
        wire.extend(id.0);
    }
    let digest = ReadProof::Ack(&ids)
        .digest(&challenge, &connector, &device, &collection)
        .unwrap();
    assert_eq!(
        digest,
        secrets::domain_hash("mdbase/v1/device-approval-peer-ack", &[&wire])
    );
    let inbox = ReadProof::Inbox
        .digest(&challenge, &connector, &device, &collection)
        .unwrap();
    assert_ne!(inbox, digest);
    assert_ne!(
        digest,
        mdbn_replica::crypto::proof::collection_proof_digest(
            mdbn_replica::crypto::proof::CollectionProof::PrivateApprovalRequest,
            &challenge,
            &Uuid(connector),
            &Uuid(device),
            &Uuid(collection),
            Some(&[5; 32])
        )
        .unwrap()
        .0
    );
    assert!(
        ReadProof::Ack(&[])
            .digest(&challenge, &connector, &device, &collection)
            .is_err()
    );
    assert!(validate_ids(&[ids[0], ids[0]]).is_err());
    assert!(validate_ids(&[Uuid([0; 16])]).is_err());
    assert!(validate_ids(&[Uuid([1; 16]); 17]).is_err());
}
#[tokio::test]
async fn peer_read_stale_source_and_invalid_ack_deny_before_any_io() {
    let cloud = Cloud {
        http: reqwest::Client::new(),
        server: "http://127.0.0.1:1".into(),
        token: Zeroizing::new("TEST-token".into()),
    };
    let identity = DeviceIdentity::generate().unwrap();
    let error = cloud
        .approval_peer_inbox(
            Uuid([7; 16]),
            "11111111-1111-4111-8111-111111111111",
            &identity,
            &|| Err("account_changed".into()),
        )
        .await
        .unwrap_err();
    assert!(matches!(error,CloudError::Local(ref code) if code=="account_changed"));
    let error = cloud
        .acknowledge_approval_peers(
            Uuid([7; 16]),
            "11111111-1111-4111-8111-111111111111",
            &identity,
            &[],
            &|| Ok(()),
        )
        .await
        .unwrap_err();
    assert!(matches!(error,CloudError::Local(ref code) if code=="invalid_peer_ids"));
}

async fn request(listener: &tokio::net::TcpListener) -> (tokio::net::TcpStream, String, Value) {
    use tokio::io::AsyncReadExt;
    let (mut socket, _) = listener.accept().await.unwrap();
    let mut bytes = Vec::new();
    let end = loop {
        let mut chunk = [0; 1024];
        let read = socket.read(&mut chunk).await.unwrap();
        assert!(read > 0);
        bytes.extend_from_slice(&chunk[..read]);
        assert!(bytes.len() <= 8192);
        if let Some(end) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
            break end + 4;
        }
    };
    let headers = String::from_utf8(bytes[..end].to_vec()).unwrap();
    let length: usize = headers
        .lines()
        .find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-length: ")
                .map(str::to_owned)
        })
        .unwrap()
        .parse()
        .unwrap();
    assert!(length + end <= 8192);
    while bytes.len() < end + length {
        let mut chunk = [0; 1024];
        let read = socket.read(&mut chunk).await.unwrap();
        assert!(read > 0);
        bytes.extend_from_slice(&chunk[..read]);
    }
    let path = headers
        .lines()
        .next()
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap()
        .to_owned();
    (
        socket,
        path,
        serde_json::from_slice(&bytes[end..end + length]).unwrap(),
    )
}
async fn reply(mut socket: tokio::net::TcpStream, value: Value) {
    use tokio::io::AsyncWriteExt;
    let body = serde_json::to_string(&value).unwrap();
    socket
        .write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .as_bytes(),
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn actual_native_http_inbox_and_ack_sign_the_published_distinct_proofs() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let cloud = Cloud {
        http: reqwest::Client::new(),
        server: format!("http://{}", listener.local_addr().unwrap()),
        token: Zeroizing::new("TEST-token".into()),
    };
    let identity = DeviceIdentity::generate().unwrap();
    let pk: [u8; 32] = secrets::hex_decode(&identity.public().sign_pk)
        .unwrap()
        .try_into()
        .unwrap();
    let device = identity.device_id;
    let collection = Uuid([7; 16]);
    let connector = [1; 16];
    let ids = [Uuid([9; 16])];
    let mock = tokio::spawn(async move {
        for action in ["inbox", "ack"] {
            let (socket, path, body) = request(&listener).await;
            assert_eq!(path, "/v1/next/devices/challenge");
            assert_eq!(body, json!({}));
            reply(socket, json!({"challenge":secrets::hex(&[2;32])})).await;
            let (socket, path, body) = request(&listener).await;
            assert_eq!(
                path,
                format!(
                    "/v1/next/collections/{}/device-approval/{action}",
                    secrets::uuid_string(&collection.0)
                )
            );
            assert!(body.get("sas_commit").is_none());
            assert_eq!(body["device_id"], secrets::uuid_string(&device));
            let mut fields = vec![
                Cbor::Bytes(vec![2; 32]),
                Cbor::Bytes(connector.to_vec()),
                Cbor::Bytes(device.to_vec()),
                Cbor::Bytes(collection.0.to_vec()),
            ];
            let domain = if action == "ack" {
                assert_eq!(body["ids"], json!([secrets::uuid_string(&ids[0].0)]));
                fields.push(Cbor::Array(vec![Cbor::Bytes(ids[0].0.to_vec())]));
                "mdbase/v1/device-approval-peer-ack"
            } else {
                assert!(body.get("ids").is_none());
                "mdbase/v1/device-approval-peer-inbox"
            };
            let wire = mdbn_wire::cbor::encode(&Cbor::Array(fields)).unwrap();
            let digest = secrets::domain_hash(domain, &[&wire]);
            let sig: [u8; 64] = secrets::hex_decode(body["sig"].as_str().unwrap())
                .unwrap()
                .try_into()
                .unwrap();
            ed25519_dalek::VerifyingKey::from_bytes(&pk)
                .unwrap()
                .verify_strict(&digest, &ed25519_dalek::Signature::from_bytes(&sig))
                .unwrap();
            reply(
                socket,
                json!({"messages":[],"acknowledged":if action=="ack" {1} else {0}}),
            )
            .await;
        }
    });
    let connector_text = secrets::uuid_string(&connector);
    assert!(
        cloud
            .approval_peer_inbox(collection, &connector_text, &identity, &|| Ok(()))
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        cloud
            .acknowledge_approval_peers(collection, &connector_text, &identity, &ids, &|| Ok(()))
            .await
            .unwrap(),
        1
    );
    mock.await.unwrap();
}

#[tokio::test]
async fn changed_source_after_ack_sent_denies_result_without_claiming_not_sent() {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let active = Arc::new(AtomicBool::new(true));
    let changed = active.clone();
    let cloud = Cloud {
        http: reqwest::Client::new(),
        server: format!("http://{}", listener.local_addr().unwrap()),
        token: Zeroizing::new("TEST-token".into()),
    };
    let mock = tokio::spawn(async move {
        let (socket, path, _) = request(&listener).await;
        assert_eq!(path, "/v1/next/devices/challenge");
        reply(socket, json!({"challenge":secrets::hex(&[2;32])})).await;
        let (socket, path, body) = request(&listener).await;
        assert!(path.ends_with("/ack"));
        assert!(body.get("ids").is_some());
        changed.store(false, Ordering::SeqCst);
        reply(socket, json!({"messages":[],"acknowledged":1})).await;
        true // Request was actually observed. A denied result is not rollback.
    });
    let identity = DeviceIdentity::generate().unwrap();
    let current = || {
        if active.load(Ordering::SeqCst) {
            Ok(())
        } else {
            Err("account_changed".into())
        }
    };
    let error = cloud
        .acknowledge_approval_peers(
            Uuid([7; 16]),
            "11111111-1111-4111-8111-111111111111",
            &identity,
            &[Uuid([9; 16])],
            &current,
        )
        .await
        .unwrap_err();
    assert!(matches!(error,CloudError::Local(ref code) if code=="account_changed"));
    assert!(mock.await.unwrap());
}

#[tokio::test]
async fn signed_foreign_device_metadata_denied_before_send_io() {
    let cloud = Cloud {
        http: reqwest::Client::new(),
        server: "http://127.0.0.1:1".into(),
        token: Zeroizing::new("TEST-token".into()),
    };
    let mut identity = DeviceIdentity::generate().unwrap();
    let envelope = ApprovalPeerEnvelope::from_bytes(&vectors()[0]).unwrap();
    let collection = envelope.message.challenge().binding.collection;
    let error = cloud
        .send_approval_peer(collection, &envelope, &identity, &|| Ok(()))
        .await
        .unwrap_err();
    assert!(matches!(error,CloudError::Local(ref code) if code=="invalid_peer_sender"));
    // A matching device label cannot adopt an embedded replacement signing key.
    identity.device_id = envelope.sender_device().0;
    let error = cloud
        .send_approval_peer(collection, &envelope, &identity, &|| Ok(()))
        .await
        .unwrap_err();
    assert!(matches!(error,CloudError::Local(ref code) if code=="invalid_peer_sender"));
}
