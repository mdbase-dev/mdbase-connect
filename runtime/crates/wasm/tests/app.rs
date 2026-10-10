//! Bootstrap and authenticating-host scope tests. SQL host here is a schema-only
//! mock: real persistence/key rebuild qualification is in platform-native's suite.
#![cfg(feature = "app-runtime")]
use mdbn_core::host::{Clock, Entropy};
use mdbn_replica::{
    Host,
    crypto::CsprngEntropy,
    log::{CallId, EndpointId},
};
use mdbn_store_file::index::StmtResult;
use mdbn_store_file::index_codec::{IndexReply, IndexRequest, decode_request, encode_reply};
use mdbn_wasm::{
    app::{AppRuntime, Bootstrap, device::DeviceIdentity},
    app_index::{AppSqlHost, LIMITS},
};
use mdbn_wire::{
    cbor::{self, Cbor},
    common::{B16, B32},
    schema::Wire,
};
use std::{cell::Cell, rc::Rc};

fn root() -> [u8; 32] {
    mdbn_replica::crypto::sign::DeviceSigner::from_seed(&[9; 32]).public()
}
fn policy_pins() -> Cbor {
    let pk = mdbn_replica::crypto::sign::DeviceSigner::from_seed(&[10; 32]).public();
    let rid = mdbn_replica::policy::key_id(&root());
    Cbor::Array(vec![
        Cbor::Array(vec![Cbor::Array(vec![
            rid.to_cbor(),
            B32(root()).to_cbor(),
        ])]),
        Cbor::Array(vec![Cbor::Array(vec![
            mdbn_replica::policy::key_id(&pk).to_cbor(),
            B32(pk).to_cbor(),
            rid.to_cbor(),
        ])]),
    ])
}
fn config() -> Vec<u8> {
    cbor::encode(&Cbor::Map(vec![
        (Cbor::Uint(0), Cbor::Uint(3)),
        (Cbor::Uint(1), B16([1; 16]).to_cbor()),
        (Cbor::Uint(2), B16([2; 16]).to_cbor()),
        (Cbor::Uint(3), B16([3; 16]).to_cbor()),
        (Cbor::Uint(4), Cbor::Uint(37)),
        (Cbor::Uint(5), Cbor::Array(vec![B32(root()).to_cbor()])),
        (Cbor::Uint(6), Cbor::Array(vec![B16([3; 16]).to_cbor()])),
        (Cbor::Uint(7), B32([8; 32]).to_cbor()),
        (Cbor::Uint(8), Cbor::Uint(0)),
        (Cbor::Uint(9), Cbor::Bool(false)),
        (Cbor::Uint(10), B32([4; 32]).to_cbor()),
        (Cbor::Uint(11), B32([5; 32]).to_cbor()),
        (Cbor::Uint(12), Cbor::Uint(0)),
        (Cbor::Uint(13), Cbor::Uint(3_053_004)),
        (
            Cbor::Uint(16),
            Cbor::Bytes(cbor::encode(&policy_pins()).unwrap()),
        ),
    ]))
    .unwrap()
}
struct Fixed;
impl Clock for Fixed {
    fn now_ms(&self) -> u64 {
        1_800_000_000_000
    }
}
impl Entropy for Fixed {
    fn fill(&mut self, bytes: &mut [u8]) {
        bytes.fill(7);
    }
}
// Deterministic bytes only in this local test fixture, not an app host default.
impl CsprngEntropy for Fixed {}
fn host() -> Host {
    Host {
        clock: Box::new(Fixed),
        entropy: Box::new(Fixed),
        zones: Box::new(mdbn_replica::replica::UtcOnly),
    }
}
struct Schema(Rc<Cell<usize>>);
impl AppSqlHost for Schema {
    fn run(&mut self, request: &[u8]) -> Option<Vec<u8>> {
        self.0.set(self.0.get() + 1);
        let IndexRequest::Run(batch) = decode_request(request, LIMITS).ok()? else {
            panic!("automatic reset forbidden")
        };
        // None of the host's SQL writes may carry the epoch keyring.
        assert!(!batch.stmts.iter().any(|s| s.params.iter().any(|p| matches!(p, mdbn_store_file::index::SqlValue::Text(v) if v == mdbn_replica::store::meta_keys::KEYRING)) && !s.sql.starts_with("SELECT")));
        encode_reply(
            &IndexReply::Results(
                batch
                    .stmts
                    .iter()
                    .map(|stmt| {
                        if stmt.sql.contains("n,bytes FROM st_retained_stats") {
                            StmtResult {
                                columns: 4,
                                values: vec![
                                    mdbn_store_file::index::SqlValue::Null,
                                    mdbn_store_file::index::SqlValue::Null,
                                    mdbn_store_file::index::SqlValue::Integer(0),
                                    mdbn_store_file::index::SqlValue::Integer(0),
                                ],
                                ..StmtResult::default()
                            }
                        } else {
                            StmtResult::default()
                        }
                    })
                    .collect(),
            ),
            LIMITS,
        )
        .ok()
    }
}
fn device_config(mode: u64, envelope: Vec<u8>) -> Vec<u8> {
    cbor::encode(&Cbor::Map(vec![
        (Cbor::Uint(0), Cbor::Uint(1)),
        (Cbor::Uint(1), B16([6; 16]).to_cbor()),
        (Cbor::Uint(2), B16([3; 16]).to_cbor()),
        (Cbor::Uint(3), B16([7; 16]).to_cbor()),
        (Cbor::Uint(4), Cbor::Uint(mode)),
        (Cbor::Uint(5), B32([4; 32]).to_cbor()),
        (Cbor::Uint(6), B32([5; 32]).to_cbor()),
        (Cbor::Uint(7), Cbor::Bytes(envelope)),
    ]))
    .unwrap()
}
fn device_fields(bytes: &[u8]) -> Vec<(Cbor, Cbor)> {
    let Cbor::Map(f) = cbor::decode(bytes).unwrap() else {
        panic!("map")
    };
    f
}
fn adoption() -> Vec<u8> {
    let mut f = device_fields(&config());
    f[0].1 = Cbor::Uint(4);
    f[10].1 = Cbor::Null;
    f[11].1 = Cbor::Null;
    f.push((Cbor::Uint(14), B16([6; 16]).to_cbor()));
    f.push((Cbor::Uint(15), B16([7; 16]).to_cbor()));
    f.sort_by_key(|(k, _)| {
        if let Cbor::Uint(k) = k {
            *k
        } else {
            unreachable!()
        }
    });
    cbor::encode(&Cbor::Map(f)).unwrap()
}
fn registration_receipt(public: &[u8]) -> Vec<u8> {
    let f = device_fields(public);
    cbor::encode(&Cbor::Map(vec![
        (Cbor::Uint(0), B16([6; 16]).to_cbor()),
        (Cbor::Uint(1), B16([3; 16]).to_cbor()),
        (Cbor::Uint(2), B16([7; 16]).to_cbor()),
        (Cbor::Uint(3), f[0].1.clone()),
        (Cbor::Uint(4), f[1].1.clone()),
        (Cbor::Uint(5), f[2].1.clone()),
    ]))
    .unwrap()
}
fn registered_device() -> (DeviceIdentity, Vec<u8>) {
    let (mut d, public) =
        DeviceIdentity::open_consuming(&mut device_config(0, vec![]), &mut Fixed).unwrap();
    assert!(!d.sign_cp_enrol_consuming(&mut [11; 32]).is_empty());
    let mut receipt = registration_receipt(&public);
    assert!(d.acknowledge_registration_consuming(&mut receipt));
    assert!(receipt.iter().all(|b| *b == 0));
    (d, public)
}
#[test]
fn device_phase_needs_no_collection_and_partial_secret_envelopes_are_wiped() {
    let original = device_config(0, vec![]);
    for end in 0..original.len() {
        let mut bytes = original[..end].to_vec();
        assert!(DeviceIdentity::open_consuming(&mut bytes, &mut Fixed).is_err());
        assert!(bytes.iter().all(|b| *b == 0));
    }
    let mut bytes = original;
    bytes.push(0);
    assert!(DeviceIdentity::open_consuming(&mut bytes, &mut Fixed).is_err());
    assert!(bytes.iter().all(|b| *b == 0));
}
#[test]
fn adopting_before_actual_registration_is_denied_before_sql() {
    let (d, _) = DeviceIdentity::open_consuming(&mut device_config(0, vec![]), &mut Fixed).unwrap();
    let calls = Rc::new(Cell::new(0));
    let mut bytes = adoption();
    assert!(
        d.adopt_consuming(&mut bytes, Box::new(Schema(calls.clone())), host())
            .is_err()
    );
    assert_eq!(calls.get(), 0);
    assert!(bytes.iter().all(|b| *b == 0));
}
#[test]
fn prospective_collection_scope_mismatch_refuses_before_any_sql_effect() {
    let (mut d, _) = registered_device();
    let mut pin = cbor::encode(&Cbor::Map(vec![
        (Cbor::Uint(0), B16([99; 16]).to_cbor()),
        (Cbor::Uint(1), Cbor::Uint(1)),
    ]))
    .unwrap();
    assert!(d.pin_private_collection_consuming(&mut pin, &mut Fixed));
    assert!(pin.iter().all(|b| *b == 0));
    assert_eq!(d.private_enrol_commitment().len(), 32);
    let calls = Rc::new(Cell::new(0));
    let mut metadata = adoption();
    assert!(
        d.adopt_consuming(&mut metadata, Box::new(Schema(calls.clone())), host())
            .is_err()
    );
    assert_eq!(calls.get(), 0);
    assert!(metadata.iter().all(|b| *b == 0));
}
#[test]
fn metadata_adoption_refuses_identity_version_seed_override_and_missing_trust_before_sql() {
    let mutations = [
        (0, Cbor::Uint(1)),
        (1, B16([0; 16]).to_cbor()),
        (3, B16([8; 16]).to_cbor()),
        (5, Cbor::Array(vec![])),
        (7, B32([0; 32]).to_cbor()),
        (9, Cbor::Bool(true)),
        (10, B32([4; 32]).to_cbor()),
        (11, B32([5; 32]).to_cbor()),
        (14, B16([9; 16]).to_cbor()),
        (15, B16([9; 16]).to_cbor()),
    ];
    for (k, v) in mutations {
        let (d, _) = registered_device();
        let mut f = device_fields(&adoption());
        f[k].1 = v;
        let mut bytes = cbor::encode(&Cbor::Map(f)).unwrap();
        let calls = Rc::new(Cell::new(0));
        assert!(
            d.adopt_consuming(&mut bytes, Box::new(Schema(calls.clone())), host())
                .is_err(),
            "field{k}"
        );
        assert_eq!(calls.get(), 0, "field{k}");
        assert!(bytes.iter().all(|b| *b == 0));
    }
    let (d, _) = registered_device();
    let mut legacy = config();
    let calls = Rc::new(Cell::new(0));
    assert!(
        d.adopt_consuming(&mut legacy, Box::new(Schema(calls.clone())), host())
            .is_err()
    );
    assert_eq!(calls.get(), 0);
    assert!(legacy.iter().all(|b| *b == 0));
}
#[test]
fn consuming_adoption_moves_original_signer_connector_noise_and_preserves_v1_gates() {
    let (d, _) = registered_device();
    let mut bytes = adoption();
    let calls = Rc::new(Cell::new(0));
    let mut r = d
        .adopt_consuming(&mut bytes, Box::new(Schema(calls.clone())), host())
        .unwrap();
    assert!(calls.get() > 0);
    assert!(bytes.iter().all(|b| *b == 0));
    assert!(!r.bind_cp_connector(B16([9; 16])));
    assert!(r.bind_cp_connector(B16([6; 16])));
    assert!(!r.bind_cp_connector(B16([6; 16])));
    let mut challenge = [11; 32];
    let sig = r.sign_cp_log_token_consuming(&mut challenge);
    assert_eq!(challenge, [0; 32]);
    let transcript = cbor::encode(&Cbor::Array(vec![
        Cbor::Bytes(vec![11; 32]),
        B16([6; 16]).to_cbor(),
        B16([3; 16]).to_cbor(),
        B16([1; 16]).to_cbor(),
    ]))
    .unwrap();
    let signer = mdbn_replica::crypto::sign::DeviceSigner::from_seed(&[4; 32]);
    assert_eq!(
        sig,
        signer.sign_digest(&mdbn_wire::hash::h("mdbase/v1/collection-log-token", &transcript).0)
    );
    assert!(r.bind_log(EndpointId(37), B16([1; 16])));
    r.retire_log();
    assert!(r.sign_cp_log_token_consuming(&mut [11; 32]).is_empty());
    assert!(r.healthy());
}
#[test]
fn offline_reopen_requires_exact_protected_registration_receipt_not_ciphertext_possession() {
    let (_, public) = registered_device();
    let f = device_fields(&public);
    let Cbor::Bytes(cipher) = &f[3].1 else {
        panic!("cipher")
    };
    let (mut d, reopened) =
        DeviceIdentity::open_consuming(&mut device_config(1, cipher.clone()), &mut Fixed).unwrap();
    assert_eq!(reopened, public);
    // No challenge/network on offline reopen: receipt was captured from the
    // previous real authenticated registration and protected by platform custody.
    assert!(d.acknowledge_registration_consuming(&mut registration_receipt(&public)));
    assert!(
        d.adopt_consuming(
            &mut adoption(),
            Box::new(Schema(Rc::new(Cell::new(0)))),
            host()
        )
        .is_ok()
    );
    let (mut d, _) =
        DeviceIdentity::open_consuming(&mut device_config(1, cipher.clone()), &mut Fixed).unwrap();
    let mut bad = registration_receipt(&public);
    *bad.last_mut().unwrap() ^= 1;
    assert!(!d.acknowledge_registration_consuming(&mut bad));
    assert!(bad.iter().all(|b| *b == 0));
    assert!(d.sign_cp_enrol_consuming(&mut [11; 32]).is_empty());
}
fn open() -> AppRuntime {
    AppRuntime::open_consuming(
        &mut config(),
        Box::new(Schema(Rc::new(Cell::new(0)))),
        host(),
    )
    .unwrap()
}
#[test]
fn protected_account_loan_requires_real_policy_and_always_wipes_without_keyed_inference() {
    let mut runtime = open();
    for size in [0, 31, 33, 4096] {
        let mut r = vec![3; size];
        assert!(runtime.unlock_account_key_consuming(&mut r).is_empty());
        assert!(r.iter().all(|v| *v == 0));
    }
    let mut setup = [3; 32];
    let setup_reply = runtime.setup_account_key_device_consuming(&mut setup);
    assert_eq!(setup, [0; 32]);
    assert_eq!(
        cbor::decode(&setup_reply).unwrap(),
        Cbor::Map(vec![
            (Cbor::Uint(0), Cbor::Uint(2)),
            (Cbor::Uint(1), Cbor::Text("not_enrolled".into()))
        ])
    );
    let mut r = [3; 32];
    let reply = runtime.unlock_account_key_consuming(&mut r);
    assert_eq!(r, [0; 32]);
    assert_eq!(
        cbor::decode(&reply).unwrap(),
        Cbor::Map(vec![
            (Cbor::Uint(0), Cbor::Uint(2)),
            (Cbor::Uint(1), Cbor::Text("not_ready".into()))
        ])
    );
    let state = cbor::decode(&runtime.account_key_state()).unwrap();
    assert_ne!(
        state,
        Cbor::Map(vec![
            (Cbor::Uint(0), Cbor::Uint(1)),
            (Cbor::Uint(1), Cbor::Null)
        ])
    );
    runtime.retire_log();
    let mut r = [3; 32];
    assert!(runtime.unlock_account_key_consuming(&mut r).is_empty());
    assert_eq!(r, [0; 32]);
    assert!(runtime.account_key_state().is_empty());
}
#[test]
fn handover_refusal_consumes_both_inputs_without_fencing_healthy_sql() {
    let mut r = open();
    for (mut device, mut witness) in [(vec![7; 16], vec![1, 2, 3]), (vec![7; 15], vec![8; 65_537])]
    {
        assert!(
            r.verify_handover_consuming(0, &mut device, &mut witness)
                .is_empty()
        );
        assert!(device.iter().all(|b| *b == 0));
        assert!(witness.iter().all(|b| *b == 0));
    }
    let Cbor::Map(observed) = cbor::decode(&r.observations()).unwrap() else {
        unreachable!()
    };
    assert_eq!(
        observed
            .iter()
            .find(|(k, _)| *k == Cbor::Uint(4))
            .unwrap()
            .1,
        Cbor::Bool(false)
    );
    r.retire_log();
    let mut device = vec![7; 16];
    let mut witness = vec![8; 64];
    assert!(
        r.verify_handover_consuming(0, &mut device, &mut witness)
            .is_empty()
    );
    assert!(device.iter().all(|b| *b == 0) && witness.iter().all(|b| *b == 0));
}
#[test]
fn bootstrap_keeps_all_identity_authority_pins_and_wipes_input() {
    let mut bytes = config();
    let b = Bootstrap::decode_consuming(&mut bytes).unwrap();
    assert!(bytes.iter().all(|b| *b == 0));
    assert_eq!(b.cfg.collection, B16([1; 16]));
    assert_eq!(b.cfg.device_id, B16([3; 16]));
    assert!(b.cfg.verify && b.cfg.e2e);
    assert_eq!(b.cfg.expected_genesis, Some(B32([8; 32])));
    assert_eq!(b.cfg.trusted_roots, vec![root()]);
    let pins = b.cfg.policy_pins.as_ref().unwrap();
    assert!(pins.validate().is_ok());
    assert_eq!(pins.roots[0].root_pk, B32(root()));
    assert_eq!(pins.policy_keys[0].root_id, pins.roots[0].root_id);
    assert_eq!(b.cfg.trusted_signers, vec![B16([3; 16])]);
    assert_eq!(b.cfg.log_endpoint, EndpointId(37));
    assert!(!b.cfg.user_enabled_cloud_copy);
    assert_eq!(b.secrets.sign_sk, [4; 32]);
    assert_eq!(b.secrets.kem_sk, [5; 32]);
}
#[test]
fn required_environment_pins_refuse_legacy_malformed_or_widened_authority_before_sql() {
    let Cbor::Array(parts) = policy_pins() else {
        unreachable!()
    };
    let Cbor::Array(roots) = &parts[0] else {
        unreachable!()
    };
    let Cbor::Array(keys) = &parts[1] else {
        unreachable!()
    };
    let mut variants = vec![Cbor::Null, Cbor::Bytes(vec![]), Cbor::Array(vec![])];
    for part in 0..2 {
        let mut bad = parts.clone();
        bad[part] = Cbor::Array(vec![]);
        variants.push(Cbor::Bytes(cbor::encode(&Cbor::Array(bad)).unwrap()));
    }
    for (part, slot, value) in [
        (0, 0, B16([0; 16]).to_cbor()),
        (0, 1, B32([0; 32]).to_cbor()),
        (1, 0, B16([0; 16]).to_cbor()),
        (1, 1, B32([0; 32]).to_cbor()),
        (1, 2, B16([0; 16]).to_cbor()),
    ] {
        let mut bad = parts.clone();
        let Cbor::Array(rows) = &mut bad[part] else {
            unreachable!()
        };
        let Cbor::Array(row) = &mut rows[0] else {
            unreachable!()
        };
        row[slot] = value;
        variants.push(Cbor::Bytes(cbor::encode(&Cbor::Array(bad)).unwrap()));
    }
    for part in 0..2 {
        let mut bad = parts.clone();
        let row = if part == 0 {
            roots[0].clone()
        } else {
            keys[0].clone()
        };
        bad[part] = Cbor::Array(vec![row.clone(), row]);
        variants.push(Cbor::Bytes(cbor::encode(&Cbor::Array(bad)).unwrap()));
    }
    let good = cbor::encode(&policy_pins()).unwrap();
    variants.push(Cbor::Bytes([good.clone(), vec![0]].concat()));
    variants.push(Cbor::Bytes([vec![0x98, 2], good[1..].to_vec()].concat()));
    for adopting in [false, true] {
        for value in &variants {
            let mut f = device_fields(&if adopting { adoption() } else { config() });
            f.iter_mut().find(|(k, _)| *k == Cbor::Uint(16)).unwrap().1 = value.clone();
            let mut bytes = cbor::encode(&Cbor::Map(f)).unwrap();
            let calls = Rc::new(Cell::new(0));
            if adopting {
                assert!(
                    registered_device()
                        .0
                        .adopt_consuming(&mut bytes, Box::new(Schema(calls.clone())), host())
                        .is_err()
                );
            } else {
                assert!(
                    AppRuntime::open_consuming(&mut bytes, Box::new(Schema(calls.clone())), host())
                        .is_err()
                );
            }
            assert_eq!(calls.get(), 0);
            assert!(bytes.iter().all(|b| *b == 0));
        }
        // Even syntactically valid pins cannot differ from the environment roots.
        for version in [if adopting { 2 } else { 1 }, if adopting { 4 } else { 3 }] {
            let mut f = device_fields(&if adopting { adoption() } else { config() });
            f[0].1 = Cbor::Uint(version);
            if version < 3 {
                f.retain(|(k, _)| *k != Cbor::Uint(16));
            } else {
                f[5].1 = Cbor::Array(vec![
                    B32(mdbn_replica::crypto::sign::DeviceSigner::from_seed(&[99; 32]).public())
                        .to_cbor(),
                ]);
            }
            let mut bytes = cbor::encode(&Cbor::Map(f)).unwrap();
            let calls = Rc::new(Cell::new(0));
            if adopting {
                assert!(
                    registered_device()
                        .0
                        .adopt_consuming(&mut bytes, Box::new(Schema(calls.clone())), host())
                        .is_err()
                );
            } else {
                assert!(
                    AppRuntime::open_consuming(&mut bytes, Box::new(Schema(calls.clone())), host())
                        .is_err()
                );
            }
            assert_eq!(calls.get(), 0);
            assert!(bytes.iter().all(|b| *b == 0));
        }
    }
}
#[test]
fn missing_wrong_roots_genesis_state_or_secrets_refuses_before_sql_and_wipes() {
    for key in [0, 5, 7, 8, 9, 10, 11, 16] {
        let Cbor::Map(mut fields) = cbor::decode(&config()).unwrap() else {
            unreachable!()
        };
        fields.retain(|(k, _)| *k != Cbor::Uint(key));
        let mut bytes = cbor::encode(&Cbor::Map(fields)).unwrap();
        let count = Rc::new(Cell::new(0));
        assert!(
            AppRuntime::open_consuming(&mut bytes, Box::new(Schema(count.clone())), host())
                .is_err()
        );
        assert!(bytes.iter().all(|b| *b == 0));
        assert_eq!(count.get(), 0);
    }
    let mut bytes = vec![0; 65_537];
    assert!(Bootstrap::decode_consuming(&mut bytes).is_err());
    assert!(bytes.iter().all(|b| *b == 0));
}
#[test]
fn partial_noncanonical_and_trailing_bootstrap_refuse_and_wipe() {
    let valid = config();
    for end in 0..valid.len() {
        let mut bytes = valid[..end].to_vec();
        assert!(Bootstrap::decode_consuming(&mut bytes).is_err());
        assert!(bytes.iter().all(|b| *b == 0));
    }
    // Nonminimal map length, indefinite map, nonminimal version and extra bytes.
    let cases = [
        [vec![0xb8, 15], valid[1..].to_vec()].concat(),
        [vec![0xbf], valid[1..].to_vec(), vec![0xff]].concat(),
        [valid[..2].to_vec(), vec![0x18, 3], valid[3..].to_vec()].concat(),
        [valid, vec![0]].concat(),
    ];
    for mut bytes in cases {
        assert!(Bootstrap::decode_consuming(&mut bytes).is_err());
        assert!(bytes.iter().all(|b| *b == 0));
    }
}
#[test]
fn opens_tentative_sql_and_staging_without_a_keyring_or_implicit_transport() {
    let mut bytes = config();
    let count = Rc::new(Cell::new(0));
    let mut r =
        AppRuntime::open_consuming(&mut bytes, Box::new(Schema(count.clone())), host()).unwrap();
    assert!(bytes.iter().all(|b| *b == 0));
    assert!(count.get() > 0);
    assert_eq!(
        cbor::decode(&r.log_calls_encoded()).unwrap(),
        Cbor::Array(vec![])
    );
    let Cbor::Map(observed) = cbor::decode(&r.observations()).unwrap() else {
        unreachable!()
    };
    assert_eq!(
        observed
            .iter()
            .find(|(k, _)| *k == Cbor::Uint(3))
            .unwrap()
            .1,
        Cbor::Bool(true)
    );
    assert!(r.healthy());
}
#[test]
fn original_log_scopes_are_bound_before_send_and_retired_before_replacement() {
    let mut r = open();
    let mut cp_nonce = vec![0x11; 32];
    assert!(r.sign_cp_log_token_consuming(&mut cp_nonce).is_empty());
    assert!(cp_nonce.iter().all(|b| *b == 0));
    assert!(r.bind_cp_connector(B16([6; 16])));
    assert!(!r.bind_cp_connector(B16([6; 16])));
    let mut cp_nonce = vec![0x11; 32];
    assert_eq!(r.sign_cp_log_token_consuming(&mut cp_nonce).len(), 64);
    assert!(cp_nonce.iter().all(|b| *b == 0));
    let mut malformed = vec![0x11; 33];
    assert!(r.sign_cp_log_token_consuming(&mut malformed).is_empty());
    assert!(malformed.iter().all(|b| *b == 0));
    assert!(!r.bind_log(EndpointId(38), B16([1; 16])));
    assert!(!r.bind_log(EndpointId(37), B16([7; 16])));
    assert!(r.bind_log(EndpointId(37), B16([1; 16])));
    let Cbor::Array(calls) = cbor::decode(&r.log_calls_encoded()).unwrap() else {
        unreachable!()
    };
    assert!(!calls.is_empty());
    let Cbor::Map(first) = &calls[0] else {
        unreachable!()
    };
    let Cbor::Bytes(frame) = &first.iter().find(|(k, _)| *k == Cbor::Uint(1)).unwrap().1 else {
        unreachable!()
    };
    let mdbn_wire::log_service::LsFrame::Request(request) =
        mdbn_wire::log_service::LsFrame::from_bytes(frame).unwrap()
    else {
        unreachable!()
    };
    assert_eq!(request.method, "head"); // NATIVE unary adapter, original scope is Subscribe.
    let id = request.id;
    let proof = cbor::encode(&Cbor::Map(vec![
        (Cbor::Uint(0), Cbor::Bytes(frame.clone())),
        (Cbor::Uint(1), Cbor::Text("public-fixture-token".into())),
        (Cbor::Uint(2), Cbor::Bytes(vec![0x11; 32])),
    ]))
    .unwrap();
    assert_eq!(r.log_generation(), 1);
    let mut owned = proof.clone();
    assert_eq!(
        r.sign_http_consuming(EndpointId(37), 1, CallId(id), &mut owned)
            .len(),
        64
    );
    assert!(owned.iter().all(|b| *b == 0));
    let mut caller_relabelled = request.clone();
    caller_relabelled.method = "subscribe".into();
    let mut relabelled = cbor::encode(&Cbor::Map(vec![
        (
            Cbor::Uint(0),
            Cbor::Bytes(
                mdbn_wire::log_service::LsFrame::Request(caller_relabelled)
                    .to_bytes()
                    .unwrap(),
            ),
        ),
        (Cbor::Uint(1), Cbor::Text("public-fixture-token".into())),
        (Cbor::Uint(2), Cbor::Bytes(vec![0x11; 32])),
    ]))
    .unwrap();
    assert!(
        r.sign_http_consuming(EndpointId(37), 1, CallId(id), &mut relabelled)
            .is_empty()
    );
    assert!(relabelled.iter().all(|b| *b == 0));
    for end in 0..proof.len() {
        let mut owned = proof[..end].to_vec();
        assert!(
            r.sign_http_consuming(EndpointId(37), 1, CallId(id), &mut owned)
                .is_empty()
        );
        assert!(owned.iter().all(|b| *b == 0));
    }
    assert!(!r.reconnect_log(EndpointId(38), B16([1; 16])));
    assert_eq!(r.log_generation(), 1);
    assert!(r.reconnect_log(EndpointId(37), B16([1; 16])));
    assert_eq!(r.log_generation(), 2);
    let mut stale = proof.clone();
    assert!(
        r.sign_http_consuming(EndpointId(37), 1, CallId(id), &mut stale)
            .is_empty()
    );
    assert!(!r.log_reply(CallId(id), &[]));
    let Cbor::Array(new_calls) = cbor::decode(&r.log_calls_encoded()).unwrap() else {
        unreachable!()
    };
    assert!(!new_calls.is_empty());
    r.retire_log();
    let mut cp_nonce = vec![0x11; 32];
    assert!(r.sign_cp_log_token_consuming(&mut cp_nonce).is_empty());
    assert!(cp_nonce.iter().all(|b| *b == 0));
    assert!(!r.bind_cp_connector(B16([6; 16])));
    let mut owned = proof;
    assert!(
        r.sign_http_consuming(EndpointId(37), 1, CallId(id), &mut owned)
            .is_empty()
    );
    assert!(owned.iter().all(|b| *b == 0));
    assert!(!r.log_reply(CallId(id), &[0]));
    // Terminal retirement zeroizes the replica and HTTP signer. A fresh module
    // and protected key unwrap are mandatory; no hidden key-preserving rebind.
    assert!(!r.bind_log(EndpointId(37), B16([1; 16])));
    assert_eq!(r.log_generation(), 0);
    assert!(!r.log_reply(CallId(id), &[0]));
    assert!(!r.log_push(&[0]));
    assert!(r.healthy());
}
