//! Hermetic strict schema/transport checks; never a deployed producer or admission.
use super::*;
use crate::{
    cloud::{CONNECTOR_TOKEN, tls_config},
    secrets::{MemoryStore, SecretStore},
};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
fn valid() -> Value {
    json!({"collection_id":ID,"legacy_collection_id":ID,"ids_preserved":true,
        "s_final":"42","cutover_seq":"10","barrier_f":"12","final_digest":"ab".repeat(32),
        "cutover_at":"2026-10-08T12:00:00.000Z"})
}
fn parsed(body: &str) -> Result<MigrationRecord, CloudError> {
    parse(
        body.as_bytes(),
        canonical_id(ID).unwrap(),
        canonical_id(ID).unwrap(),
    )
}

#[test]
fn byte_grammar_has_exact_length_and_exhaustive_position_classes() {
    // Exercise ONLY the pure predicate, never the legacy decoder or transport.
    // Includes all non-ASCII bytes without constructing malformed UTF-8 strings.
    for len in 0..=72 {
        let mut bytes = ID.as_bytes().to_vec();
        bytes.resize(len, b'a');
        assert_eq!(canonical_id_shape(&bytes), len == 36);
    }
    for at in 0..36 {
        for byte in u8::MIN..=u8::MAX {
            let mut bytes = *ID.as_bytes().first_chunk::<36>().unwrap();
            bytes[at] = byte;
            let expected = if [8, 13, 18, 23].contains(&at) {
                byte == b'-'
            } else {
                b"0123456789abcdef".contains(&byte)
            };
            assert_eq!(canonical_id_shape(&bytes), expected, "position {at}");
        }
    }
}

#[test]
fn canonical_identity_accepts_only_lowercase_ascii_uuid_shape() {
    assert!(canonical_id(ID).is_some());
    for value in [
        "",
        "é",
        "東京",
        "uuid-😀",
        "aaaaaaaa_aaaa_4aaa_8aaa_aaaaaaaaaaaa",
        "gaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
        "00000000-0000-0000-0000-000000000000",
    ] {
        assert_eq!(canonical_id(value), None);
    }
}

#[test]
fn non_ascii_record_identities_are_schema_refusals() {
    for field in ["collection_id", "legacy_collection_id"] {
        for value in ["é", "東京", "uuid-😀"] {
            let mut body = valid();
            body[field] = json!(value);
            assert!(matches!(
                parsed(&body.to_string()),
                Err(CloudError::Server(200, code)) if code == "invalid_migration_record"
            ));
        }
    }
}

#[tokio::test]
async fn non_ascii_request_identities_refuse_before_currentness_or_transport() {
    let keys = MemoryStore::default();
    keys.set(CONNECTOR_TOKEN, b"fixture-token").unwrap();
    let tls = tls_config().unwrap();
    let cloud = Cloud::new(&tls, "http://127.0.0.1:1", &keys).unwrap();
    let checked = AtomicBool::new(false);
    let current = || {
        checked.store(true, Ordering::SeqCst);
        Ok(())
    };
    for value in ["é", "東京", "uuid-😀"] {
        assert!(matches!(
            cloud.migration_record(&tls, value, ID, &current).await,
            Err(CloudError::Local(code)) if code == "invalid_collection_identity"
        ));
        assert!(matches!(
            cloud.migration_record(&tls, ID, value, &current).await,
            Err(CloudError::Local(code)) if code == "invalid_legacy_identity"
        ));
        assert!(!checked.load(Ordering::SeqCst));
    }
}

#[test]
fn record_is_exactly_bound_and_legacy_sequence_is_lossless_separate_domain() {
    let mut body = valid();
    body["s_final"] = json!(u64::MAX.to_string());
    let record = parsed(&body.to_string()).unwrap();
    assert_eq!(record.collection_id(), canonical_id(ID).unwrap());
    assert_eq!(record.legacy_collection_id(), canonical_id(ID).unwrap());
    assert_eq!(record.s_final(), u64::MAX);
    assert_eq!(record.cutover_seq(), 10);
    assert_eq!(record.barrier_f(), 12);
    assert_eq!(record.final_digest(), [0xab; 32]);
    assert_eq!(record.cutover_at().offset(), UtcOffset::UTC);
    body["s_final"] = json!("0"); // Not numerically ordered with Next C/F.
    assert_eq!(parsed(&body.to_string()).unwrap().s_final(), 0);
    body["cutover_seq"] = json!(u64::MAX.to_string());
    body["barrier_f"] = json!(u64::MAX.to_string());
    assert_eq!(parsed(&body.to_string()).unwrap().barrier_f(), u64::MAX);
}

#[test]
fn preservation_requires_one_collection_uuid_even_if_both_expected_ids_match() {
    let mut record = valid();
    record["legacy_collection_id"] = json!(OTHER);
    assert!(
        parse(
            record.to_string().as_bytes(),
            canonical_id(ID).unwrap(),
            canonical_id(OTHER).unwrap()
        )
        .is_err()
    );
    record["collection_id"] = json!(OTHER);
    record["legacy_collection_id"] = json!(ID);
    assert!(
        parse(
            record.to_string().as_bytes(),
            canonical_id(OTHER).unwrap(),
            canonical_id(ID).unwrap()
        )
        .is_err()
    );
}
#[test]
fn malformed_partial_duplicate_extra_and_wrong_identity_records_are_refused() {
    let good = valid();
    for key in good.as_object().unwrap().keys() {
        let mut missing = good.clone();
        missing.as_object_mut().unwrap().remove(key);
        assert!(parsed(&missing.to_string()).is_err(), "missing {key}");
        let mut null = good.clone();
        null[key] = Value::Null;
        assert!(parsed(&null.to_string()).is_err(), "null {key}");
    }
    for (key, value) in [
        ("future", json!(true)),
        ("ids_preserved", json!(false)),
        ("ids_preserved", json!("true")),
        ("collection_id", json!(OTHER)),
        ("legacy_collection_id", json!(OTHER)),
        ("collection_id", json!(ID.to_uppercase())),
        (
            "collection_id",
            json!("00000000-0000-0000-0000-000000000000"),
        ),
        ("legacy_collection_id", json!("not-a-uuid")),
        ("cutover_seq", json!("13")),
        ("final_digest", json!("AB".repeat(32))),
        ("final_digest", json!("g".repeat(64))),
        ("final_digest", json!("ab")),
        ("cutover_at", json!("2026-02-30T00:00:00Z")),
        ("cutover_at", json!("2026-10-08T12:00:00+01:00")),
        ("cutover_at", json!(123)),
    ] {
        let mut bad = good.clone();
        bad[key] = value;
        assert!(parsed(&bad.to_string()).is_err(), "invalid {key}");
    }
    for key in good.as_object().unwrap().keys() {
        // Duplicate even identical values is ambiguous, not accepted via Value.
        let duplicate = format!("{{\"{key}\":{},{}", good[key], &good.to_string()[1..]);
        assert!(parsed(&duplicate).is_err(), "duplicate {key}");
    }
    for bad in [
        "null".to_owned(),
        "[]".into(),
        "bad-json".into(),
        format!("{{\"record\":{good}}}"),
        format!("{good}{good}"),
    ] {
        assert!(parsed(&bad).is_err());
    }
}

#[test]
fn sequence_strings_never_coerce_or_round() {
    for field in ["s_final", "cutover_seq", "barrier_f"] {
        for value in [
            json!(0),
            json!(1.0),
            json!(true),
            json!(""),
            json!("00"),
            json!("01"),
            json!("-0"),
            json!("-1"),
            json!("+1"),
            json!(" 1"),
            json!("1 "),
            json!("1.0"),
            json!("1e2"),
            json!("18446744073709551616"),
            json!("١"),
            json!("9".repeat(256)),
        ] {
            let mut bad = valid();
            bad[field] = value;
            assert!(parsed(&bad.to_string()).is_err(), "noncanonical {field}");
        }
    }
}

async fn fixture(status: u16, body: &str, extra: &str) -> (Cloud, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let (body, extra) = (body.to_owned(), extra.to_owned());
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        while !request.windows(4).any(|w| w == b"\r\n\r\n") {
            let mut buf = [0; 1024];
            let n = socket.read(&mut buf).await.unwrap();
            assert!(n > 0);
            request.extend_from_slice(&buf[..n]);
        }
        let request = String::from_utf8(request).unwrap().to_ascii_lowercase();
        assert!(request.starts_with(&format!("get /v1/next/collections/{ID}/migration-record ")));
        assert!(request.contains("authorization: bearer fixture-token\r\n"));
        assert!(request.contains("cache-control: no-cache, no-store\r\n"));
        let response = format!(
            "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n{body}",
            body.len()
        );
        let _ = socket.write_all(response.as_bytes()).await;
    });
    let keys = MemoryStore::default();
    keys.set(CONNECTOR_TOKEN, b"fixture-token").unwrap();
    (
        Cloud::new(&tls_config().unwrap(), &origin, &keys).unwrap(),
        task,
    )
}

#[tokio::test]
async fn only_strict200_bounded_current_body_yields_a_record() {
    for status in [200, 201, 204, 302, 401, 403, 404, 409, 503] {
        let (cloud, task) = fixture(status, &valid().to_string(), "").await;
        let result = cloud
            .migration_record(&tls_config().unwrap(), ID, ID, &|| Ok(()))
            .await;
        assert_eq!(result.is_ok(), status == 200);
        task.await.unwrap();
    }
    for body in [
        "bad-json".to_owned(),
        " ".repeat(256 * 1024 + 1),
        format!("{{\"ids_preserved\":true,{}", &valid().to_string()[1..]),
    ] {
        let (cloud, task) = fixture(200, &body, "").await;
        assert!(
            cloud
                .migration_record(&tls_config().unwrap(), ID, ID, &|| Ok(()))
                .await
                .is_err()
        );
        task.await.unwrap();
    }
}

#[tokio::test]
async fn redirects_never_forward_native_token_or_yield_record() {
    let target = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let extra = format!(
        "Location: http://{}/target\r\n",
        target.local_addr().unwrap()
    );
    let (cloud, task) = fixture(302, &valid().to_string(), &extra).await;
    assert!(
        cloud
            .migration_record(&tls_config().unwrap(), ID, ID, &|| Ok(()))
            .await
            .is_err()
    );
    task.await.unwrap();
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(100), target.accept())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn stale_identity_before_send_and_after_headers_body_or_decode_is_refused() {
    for stage in [1, 2, 3, 4] {
        let (cloud, task) = fixture(200, &valid().to_string(), "").await;
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let current = || {
            if calls.fetch_add(1, Ordering::SeqCst) < stage {
                Ok(())
            } else {
                Err("current_pairing_or_capture_changed".into())
            }
        };
        assert!(
            cloud
                .migration_record(&tls_config().unwrap(), ID, ID, &current)
                .await
                .is_err()
        );
        task.await.unwrap();
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let keys = MemoryStore::default();
    keys.set(CONNECTOR_TOKEN, b"fixture-token").unwrap();
    let cloud = Cloud::new(&tls_config().unwrap(), &origin, &keys).unwrap();
    let checked = AtomicBool::new(false);
    let stale = || {
        checked.store(true, Ordering::SeqCst);
        Err("stale_account".into())
    };
    assert!(
        cloud
            .migration_record(&tls_config().unwrap(), ID, ID, &stale)
            .await
            .is_err()
    );
    assert!(checked.load(Ordering::SeqCst));
    assert!(
        cloud
            .migration_record(&tls_config().unwrap(), ID, OTHER, &|| Ok(()))
            .await
            .is_err()
    );
    assert!(
        cloud
            .migration_record(&tls_config().unwrap(), OTHER, ID, &|| Ok(()))
            .await
            .is_err()
    );
    for bad in [
        "../escape",
        "not-uuid",
        "00000000-0000-0000-0000-000000000000",
    ] {
        assert!(
            cloud
                .migration_record(&tls_config().unwrap(), bad, ID, &|| Ok(()))
                .await
                .is_err()
        );
        assert!(
            cloud
                .migration_record(&tls_config().unwrap(), ID, bad, &|| Ok(()))
                .await
                .is_err()
        );
    }
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(100), listener.accept())
            .await
            .is_err()
    );
}
