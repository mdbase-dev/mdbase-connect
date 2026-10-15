use super::*;
use crate::hosted::{CollectionKey, aad, testing};
use serde_json::{Value, json};
use std::io::Cursor;

// Synthetic fixture helper only; original native provider-format envelope.
fn seal(key: &CollectionKey, plain: &[u8], aad: &[u8]) -> Vec<u8> {
    testing::seal(&key.0, plain, aad, 42)
}

const CID: &str = "11111111-1111-4111-8111-111111111111";
const FID: &str = "22222222-2222-4222-8222-222222222222";
const ACCOUNT: &str = "33333333-3333-4333-8333-333333333333";
fn pghex(value: &[u8]) -> String {
    format!(
        "\\x{}",
        value.iter().map(|b| format!("{b:02x}")).collect::<String>()
    )
}
fn b64(value: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(value)
}
fn fixture() -> (Value, Vec<u8>) {
    let master = CollectionKey::from_bytes([9; 32]);
    let key = CollectionKey::from_bytes([7; 32]);
    let wrapped = seal(&master, &[7; 32], &aad::collection_key(CID));
    let row = |seq: u64, bytes: &[u8], current: bool| {
        let payload=serde_json::to_vec(&json!({"path":format!("secret-path-{seq}"),"content_digest":crate::revision_of(bytes),"media_type":"text/plain","media_class":"other"})).unwrap();
        let aad = if current {
            aad::current_file(CID, FID, seq)
        } else {
            aad::file_version(CID, FID, seq)
        };
        json!({"file_id":FID,"sequence":seq.to_string(),"revision":format!("original-revision-{seq}"),"size":bytes.len(),
            "object_key":format!("v1/blobs/{CID}/{FID}/{seq}"),"payload_ciphertext":pghex(&seal(&key,&payload,&aad))})
    };
    let (old, current) = (
        b"original historical SDK bytes",
        b"original current SDK bytes",
    );
    let objects=[(1,old.as_slice()),(2,current.as_slice())].into_iter().map(|(seq,bytes)|json!({
        "object_key":format!("v1/blobs/{CID}/{FID}/{seq}"),"size_bytes":bytes.len(),"sha256":&crate::revision_of(bytes)[7..]})).collect::<Vec<_>>();
    (
        json!({"schema":"mdbase-scoped-native-recovery-input/1","environment":"lab","source_rows_sha256":"a".repeat(64),
        "keys":{"environment":"local","legacy_master_key":b64(&[9;32]),"kms":[]},
        "collections":[{"account_id":ACCOUNT,"collection_id":CID,"wrapped_data_key":pghex(&wrapped),
            "current":[row(2,current,true)],"retained":[row(1,old,false),row(2,current,false)]}],"objects":objects}),
        [old.as_slice(), current.as_slice()].concat(),
    )
}
struct CountReader {
    bytes: Cursor<Vec<u8>>,
    calls: usize,
}
impl Read for CountReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        self.calls += 1;
        self.bytes.read(buffer)
    }
}
fn reject_before_objects(value: &Value) {
    let mut reader = CountReader {
        bytes: Cursor::new(Vec::new()),
        calls: 0,
    };
    assert!(recover_inventory(&serde_json::to_vec(value).unwrap(), &mut reader).is_err());
    assert_eq!(
        reader.calls, 0,
        "invalid complete metadata must precede ANY object read"
    );
}
#[test]
fn native_current_and_retained_authentication_and_original_plaintext_proof() {
    let (value, body) = fixture();
    let result =
        recover_inventory(&serde_json::to_vec(&value).unwrap(), &mut Cursor::new(body)).unwrap();
    let result: Value = serde_json::from_slice(&result).unwrap();
    assert_eq!(result["schema"], "mdbase-scoped-recovery-inventory/1");
    assert_eq!(result["source_rows_sha256"], "a".repeat(64));
    let files = result["files"].as_array().unwrap();
    assert_eq!(files.len(), 2);
    assert_eq!(files[0]["sequence"], "1");
    assert_eq!(files[0]["current"], false);
    assert_eq!(files[0]["retained"], true);
    assert_eq!(files[1]["sequence"], "2");
    assert_eq!(files[1]["current"], true);
    assert_eq!(files[1]["retained"], true);
    for (i, file) in files.iter().enumerate() {
        assert_eq!(file["account_id"], ACCOUNT);
        assert_eq!(file["collection_id"], CID);
        assert_eq!(file["file_id"], FID);
        assert_eq!(file["plaintext"]["sha256"], value["objects"][i]["sha256"]);
        assert_eq!(
            file["plaintext"]["size_bytes"],
            value["objects"][i]["size_bytes"]
        );
        assert_eq!(file["ciphertext"], file["plaintext"]); // actual legacy R2 format is unencrypted
        assert!(file.get("path").is_none());
        assert!(file.get("payload_ciphertext").is_none());
    }
    assert!(
        !String::from_utf8(result.to_string().into_bytes())
            .unwrap()
            .contains("secret-path")
    );
}
#[test]
fn malformed_whole_scope_or_metadata_stops_before_blob_io() {
    let (original, _) = fixture();
    for kind in [
        "missing-retained",
        "reorder",
        "duplicate",
        "unknown",
        "foreign-owner",
        "foreign-file",
        "sequence",
        "size",
        "object-key",
        "native-digest",
        "unsafe-size",
        "environment",
        "wrong-master",
        "wrong-aad",
        "tampered-auth",
    ] {
        let mut value = original.clone();
        match kind {
            "missing-retained" => {
                value["collections"][0]["retained"]
                    .as_array_mut()
                    .unwrap()
                    .pop();
            }
            "reorder" => value["collections"][0]["retained"]
                .as_array_mut()
                .unwrap()
                .reverse(),
            "duplicate" => {
                let row = value["collections"][0]["retained"][1].clone();
                value["collections"][0]["retained"]
                    .as_array_mut()
                    .unwrap()
                    .push(row);
            }
            "unknown" => value["collections"][0]["current"][0]["adopt_run"] = json!(true),
            "foreign-owner" => value["collections"][0]["account_id"] = json!("not-a-uuid"),
            "foreign-file" => {
                value["collections"][0]["retained"][0]["file_id"] =
                    json!("44444444-4444-4444-8444-444444444444")
            }
            "sequence" => value["collections"][0]["retained"][0]["sequence"] = json!("01"),
            "size" => value["collections"][0]["current"][0]["size"] = json!(1),
            "object-key" => value["objects"][0]["object_key"] = json!("foreign-original-key"),
            "native-digest" => value["objects"][0]["sha256"] = json!("f".repeat(64)),
            "unsafe-size" => value["collections"][0]["current"][0]["size"] = json!(1073741825u64),
            "environment" => value["environment"] = json!("production"),
            "wrong-master" => value["keys"]["legacy_master_key"] = json!(b64(&[8; 32])),
            "wrong-aad" => {
                let ct = value["collections"][0]["current"][0]["payload_ciphertext"].clone();
                value["collections"][0]["retained"][1]["payload_ciphertext"] = ct;
            }
            "tampered-auth" => {
                let ct = value["collections"][0]["retained"][0]["payload_ciphertext"]
                    .as_str()
                    .unwrap();
                let mut ct = ct.to_owned();
                let last = if ct.ends_with('0') { "1" } else { "0" };
                ct.replace_range(ct.len() - 1.., last);
                value["collections"][0]["retained"][0]["payload_ciphertext"] = json!(ct);
            }
            _ => unreachable!(),
        }
        reject_before_objects(&value);
    }
}
#[test]
fn complete_object_closure_before_reads_and_original_body_check() {
    let (original, body) = fixture();
    for kind in ["missing", "extra", "reorder", "duplicate"] {
        let mut value = original.clone();
        let objects = value["objects"].as_array_mut().unwrap();
        match kind {
            "missing" => {
                objects.pop();
            }
            "extra" | "duplicate" => objects.push(objects[0].clone()),
            "reorder" => objects.reverse(),
            _ => unreachable!(),
        }
        reject_before_objects(&value);
    }
    for kind in ["tamper", "truncated", "extra"] {
        let mut bytes = body.clone();
        match kind {
            "tamper" => bytes[0] ^= 1,
            "truncated" => {
                bytes.pop();
            }
            "extra" => bytes.push(1),
            _ => unreachable!(),
        }
        assert!(
            recover_inventory(
                &serde_json::to_vec(&original).unwrap(),
                &mut Cursor::new(bytes)
            )
            .is_err()
        );
    }
}
#[test]
fn kms_context_identity_and_native_authenticated_metadata_use_existing_unwrapper() {
    // KMS TRANSPORT is an I/O double; AES unwrap/decode and object proofs are real.
    let (mut value, body) = fixture();
    let key_ref = "arn:aws:kms:ap-southeast-2:445617516211:key/mrk-synthetic";
    let ciphertext = b"synthetic AWS KMS blob";
    let mut envelope = b"MDBK\x01\x01".to_vec();
    envelope.extend((key_ref.len() as u16).to_be_bytes());
    envelope.extend((ciphertext.len() as u32).to_be_bytes());
    envelope.extend(key_ref.as_bytes());
    envelope.extend(ciphertext);
    value["keys"]["environment"] = json!("lab");
    value["keys"]["legacy_master_key"] = Value::Null;
    value["collections"][0]["wrapped_data_key"] = json!(pghex(&envelope));
    value["keys"]["kms"] = json!([{"ciphertext_sha256":&crate::revision_of(ciphertext)[7..],"key_id":key_ref,
        "plaintext":b64(&[7;32]),"context":super::super::kms_context("lab",CID)}]);
    assert!(
        recover_inventory(&serde_json::to_vec(&value).unwrap(), &mut Cursor::new(body)).is_ok()
    );
    for kind in ["context", "key-id", "plain", "blob", "duplicate"] {
        let mut invalid = value.clone();
        match kind {
            "context" => {
                invalid["keys"]["kms"][0]["context"]["mdbase:environment"] = json!("staging")
            }
            "key-id" => {
                invalid["keys"]["kms"][0]["key_id"] =
                    json!("arn:aws:kms:ap-southeast-2:445617516211:key/different")
            }
            "plain" => invalid["keys"]["kms"][0]["plaintext"] = json!(b64(&[8; 32])),
            "blob" => invalid["keys"]["kms"][0]["ciphertext_sha256"] = json!("0".repeat(64)),
            "duplicate" => {
                let reply = invalid["keys"]["kms"][0].clone();
                invalid["keys"]["kms"].as_array_mut().unwrap().push(reply);
            }
            _ => unreachable!(),
        }
        reject_before_objects(&invalid);
    }
}
#[test]
fn empty_collection_still_requires_real_key_unwrap() {
    let (mut value, _) = fixture();
    value["collections"][0]["current"] = json!([]);
    value["collections"][0]["retained"] = json!([]);
    value["objects"] = json!([]);
    assert!(
        recover_inventory(
            &serde_json::to_vec(&value).unwrap(),
            &mut Cursor::new(Vec::<u8>::new())
        )
        .is_ok()
    );
    value["keys"]["legacy_master_key"] = json!(b64(&[8; 32]));
    reject_before_objects(&value);
}
#[test]
fn original_int8_sequence_never_rounds_in_json_proof() {
    let (mut value, _) = fixture();
    let seq = i64::MAX as u64;
    let body = b"int8-max bytes";
    let key = CollectionKey::from_bytes([7; 32]);
    let payload=serde_json::to_vec(&json!({"path":"private","content_digest":crate::revision_of(body),"media_type":null,"media_class":"other"})).unwrap();
    let current = json!({"file_id":FID,"sequence":seq.to_string(),"revision":"original-max","size":body.len(),"object_key":"opaque-max-key", "payload_ciphertext":pghex(&seal(&key,&payload,&aad::current_file(CID,FID,seq)))});
    let mut retained = current.clone();
    retained["payload_ciphertext"] = json!(pghex(&seal(
        &key,
        &payload,
        &aad::file_version(CID, FID, seq)
    )));
    value["collections"][0]["current"] = json!([current]);
    value["collections"][0]["retained"] = json!([retained]);
    value["objects"] = json!([{"object_key":"opaque-max-key","size_bytes":body.len(),"sha256":&crate::revision_of(body)[7..]}]);
    let proof =
        recover_inventory(&serde_json::to_vec(&value).unwrap(), &mut Cursor::new(body)).unwrap();
    let proof: Value = serde_json::from_slice(&proof).unwrap();
    assert_eq!(proof["files"][0]["sequence"], i64::MAX.to_string());
}
