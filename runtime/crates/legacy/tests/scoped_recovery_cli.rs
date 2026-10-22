//! Actual native stdin executable tests, with synthetic provider-format keys.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]
use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit, Payload},
};
use base64::Engine;
use serde_json::json;
use std::io::Write;
use std::process::{Command, Stdio};

fn run(input: &[u8], args: &[&str]) -> std::process::Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_mdbn-scoped-recovery-bytes"))
        .args(args)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    if let Some(mut pipe) = child.stdin.take() {
        let _ = pipe.write_all(input);
    }
    child.wait_with_output().unwrap()
}
fn seal(key: &[u8; 32], plain: &[u8], aad: &[u8]) -> String {
    let nonce = [42; 12]; // TEST ONLY
    let cipher = Aes256Gcm::new_from_slice(key).unwrap();
    let payload = cipher
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: plain, aad })
        .unwrap();
    let bytes = [&[1u8][..], &nonce, payload.as_slice()].concat();
    format!(
        "\\x{}",
        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
    )
}
const BODY: &[u8] = b"original SDK file body";
/// Framed stdin for one synthetic collection: `environment` data, `local`
/// legacy-only key custody (the provider default), wrapped with master `[9;32]`
/// and unwrapped with `[master;32]`.
fn wire(environment: &str, master: u8) -> Vec<u8> {
    use mdbn_legacy::hosted::aad;
    let (cid, fid, account) = (
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
        "33333333-3333-4333-8333-333333333333",
    );
    let body = BODY;
    let plain=serde_json::to_vec(&json!({"path":"private-metadata-path","content_digest":mdbn_legacy::revision_of(body),"media_type":null,"media_class":"other"})).unwrap();
    let current = json!({"file_id":fid,"sequence":"4","revision":"original-r","size":body.len(),"object_key":"original-opaque-key",
        "payload_ciphertext":seal(&[7;32],&plain,&aad::current_file(cid,fid,4))});
    let mut retained = current.clone();
    retained["payload_ciphertext"] = json!(seal(&[7; 32], &plain, &aad::file_version(cid, fid, 4)));
    let header=serde_json::to_vec(&json!({"schema":"mdbase-scoped-native-recovery-input/1","environment":environment,"source_rows_sha256":"a".repeat(64),
        "keys":{"environment":"local","legacy_master_key":base64::engine::general_purpose::STANDARD.encode([master;32]),"kms":[]},
        "collections":[{"collection_id":cid,"account_id":account,"wrapped_data_key":seal(&[9;32],&[7;32],&aad::collection_key(cid)),"current":[current],"retained":[retained]}],
        "objects":[{"object_key":"original-opaque-key","size_bytes":body.len(),"sha256":&mdbn_legacy::revision_of(body)[7..]}]})).unwrap();
    [
        &(header.len() as u32).to_be_bytes()[..],
        header.as_slice(),
        body,
    ]
    .concat()
}
const REFUSED: &str = "native recovered-byte proof refused; no archive acceptance\n";
fn assert_refused(output: &std::process::Output, code: i32) {
    assert_eq!(output.status.code(), Some(code));
    assert!(output.stdout.is_empty());
    assert_eq!(String::from_utf8_lossy(&output.stderr), REFUSED);
}
#[test]
fn real_cli_authenticates_metadata_and_recovers_original_bytes_not_fake_json() {
    // LAB, staging and production all admit legacy-only `local` key custody.
    for environment in ["lab", "staging", "production"] {
        let wire = wire(environment, 9);
        let output = run(&wire, &[]);
        assert!(output.status.success(), "{environment}");
        assert!(output.stderr.is_empty());
        let proof: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(proof["files"].as_array().unwrap().len(), 1);
        assert_eq!(proof["files"][0]["current"], true);
        assert_eq!(proof["files"][0]["retained"], true);
        assert_eq!(
            proof["files"][0]["plaintext"]["sha256"],
            mdbn_legacy::revision_of(BODY)[7..]
        );
        assert!(!String::from_utf8_lossy(&output.stdout).contains("private-metadata-path"));
        let mut corrupt = wire;
        *corrupt.last_mut().unwrap() ^= 1;
        assert_refused(&run(&corrupt, &[]), 4);
    }
}
#[test]
fn refusal_exit_code_names_the_stage_with_one_fixed_stderr_line() {
    // 2: header / data environment / key custody environment.
    assert_refused(&run(&wire("development", 9), &[]), 2);
    // 3: key and metadata preflight (wrong legacy master key).
    assert_refused(&run(&wire("staging", 8), &[]), 3);
    // 4: original object proof (truncated body).
    let mut truncated = wire("staging", 9);
    truncated.pop();
    assert_refused(&run(&truncated, &[]), 4);
    // 1: invocation / framing.
    assert_refused(&run(&wire("staging", 9), &["extra"]), 1);
    assert_refused(&run(&[0, 0, 0], &[]), 1);
}
#[test]
fn private_failure_values_never_appear_and_arguments_do_not_select_a_source() {
    let secret = b"PRIVATE_SOURCE_OR_KEY_SENTINEL";
    let frame = [&(secret.len() as u32).to_be_bytes()[..], secret].concat();
    for output in [
        run(&frame, &[]),
        run(&[], &["PRIVATE_SOURCE_OR_KEY_SENTINEL"]),
    ] {
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert_eq!(
            String::from_utf8_lossy(&output.stderr),
            "native recovered-byte proof refused; no archive acceptance\n"
        );
    }
}
#[test]
fn oversized_or_truncated_metadata_frame_refuses_without_output() {
    for wire in [
        vec![0, 0, 0],
        (64 * 1024 * 1024u32 + 1).to_be_bytes().to_vec(),
        vec![0, 0, 0, 3, b'{'],
    ] {
        let output = run(&wire, &[]);
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
    }
}
