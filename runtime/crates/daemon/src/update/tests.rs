use std::collections::BTreeMap;

use ed25519_dalek::{Signer, SigningKey};

use super::signature::{KEYSET_DOMAIN, MANIFEST_DOMAIN, digest};
use super::*;

const NOW: i64 = 1_704_067_200;

fn stamp(at: i64) -> String {
    time::OffsetDateTime::from_unix_timestamp(at)
        .unwrap()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap()
}

fn signing(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn signature(bytes: &[u8], tag: &str, id: &str, seed: u8) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({"key_id": id, "signature": hex(&signing(seed).sign(&digest(tag, bytes)).to_bytes())})).unwrap()
}
fn pins() -> PinnedKeys {
    pins_with_seeds([1, 2, 3])
}
fn pins_with_seeds(seeds: [u8; 3]) -> PinnedKeys {
    PinnedKeys::new(
        BTreeMap::from([
            (
                "ci-current".into(),
                signing(seeds[0]).verifying_key().to_bytes(),
            ),
            (
                "ci-next".into(),
                signing(seeds[1]).verifying_key().to_bytes(),
            ),
        ]),
        signing(seeds[2]).verifying_key().to_bytes(),
    )
    .unwrap()
}
fn foreign_families() -> [[u8; 3]; 6] {
    // All keys changed; shared recovery; shared CI; ID swap; unused next changed;
    // role swap. Equal document digests must not alias any of these families.
    [
        [4, 5, 6],
        [4, 5, 3],
        [1, 2, 6],
        [2, 1, 3],
        [1, 4, 3],
        [3, 2, 1],
    ]
}
fn keys_under(pins: &PinnedKeys, seeds: [u8; 3], sequence: u64) -> VerifiedKeyset {
    let bytes = serde_json::to_vec(&keyset(sequence)).unwrap();
    pins.verify_keyset(
        &bytes,
        &signature(&bytes, KEYSET_DOMAIN, "recovery", seeds[2]),
    )
    .unwrap()
}
fn manifest_under(
    pins: &PinnedKeys,
    seeds: [u8; 3],
    keys: &VerifiedKeyset,
    v: &str,
) -> VerifiedManifest {
    let bytes = serde_json::to_vec(&manifest(v, Channel::Beta, NOW)).unwrap();
    pins.verify_manifest(
        &bytes,
        &signature(&bytes, MANIFEST_DOMAIN, "ci-current", seeds[0]),
        Channel::Beta,
        NOW,
        keys,
    )
    .unwrap()
}
fn keyset(seq: u64) -> Keyset {
    Keyset {
        sequence: seq,
        revoked: vec![],
        added: vec![],
        halt: None,
    }
}
fn verified_keys(doc: &Keyset) -> VerifiedKeyset {
    let bytes = serde_json::to_vec(doc).unwrap();
    pins()
        .verify_keyset(&bytes, &signature(&bytes, KEYSET_DOMAIN, "recovery", 3))
        .unwrap()
}
fn manifest(v: &str, channel: Channel, at: i64) -> Manifest {
    let targets = [
        "x86_64-unknown-linux-gnu",
        "aarch64-unknown-linux-gnu",
        "universal-apple-darwin",
        "x86_64-pc-windows-msvc",
    ];
    Manifest {
        schema_version: 1, product: "mdbase-next-desktop".into(), channel, version: v.into(),
        published_at: stamp(NOW), signed_at: stamp(at), expires_at: stamp(at + 30 * 86400),
        rollout: Rollout { percentage: 100, seed: v.into() }, blocked_versions: vec![], minimum_version: None,
        min_soak_hours: 72,
        targets: targets.into_iter().map(|t| {
            let ending = if t == "x86_64-pc-windows-msvc" { "-UNSIGNED.zip" } else { ".tar.gz" };
            (t.into(), TargetArtifact { url: format!("https://github.com/mdbase-dev/mdbase-connect/releases/download/v{v}/mdbase-next-{v}-{t}{ending}"), sha256: "ab".repeat(32), size: 123 })
        }).collect(),
    }
}
fn verified(doc: &Manifest, now: i64, keys: &VerifiedKeyset) -> VerifiedManifest {
    let bytes = serde_json::to_vec(doc).unwrap();
    pins()
        .verify_manifest(
            &bytes,
            &signature(&bytes, MANIFEST_DOMAIN, "ci-current", 1),
            doc.channel,
            now,
            keys,
        )
        .unwrap()
}
fn state(keys: &VerifiedKeyset) -> PolicyState {
    let mut state = PolicyState::new(&pins(), "0.2.0-beta.1", NOW).unwrap();
    state.accept_keyset(keys).unwrap();
    state.set_channel(LocalChannel::Beta);
    state
}

#[test]
fn supplied_recovery_public_pin_has_expected_fingerprint() {
    use sha2::{Digest, Sha256};
    assert_eq!(
        &hex(&Sha256::digest(RECOVERY_PUBLIC_KEY))[..16],
        RECOVERY_KEY_ID
    );
    assert!(
        !ed25519_dalek::VerifyingKey::from_bytes(&RECOVERY_PUBLIC_KEY)
            .unwrap()
            .is_weak()
    );
}

#[test]
fn independent_python_cryptography_golden_vectors() {
    let bytes = br#"{"sequence":1,"revoked":[],"added":[],"halt":null}"#;
    let expected_digest = "576d2447324dc34feb7a0295da7ba00a611fc759f3f0fd46896cf26f4960a88a";
    assert_eq!(hex(&digest(KEYSET_DOMAIN, bytes)), expected_digest);
    assert_eq!(
        hex(&digest(MANIFEST_DOMAIN, bytes)),
        "da04ed1976b449e0be4e51d9ab22a9146b9ede924f75fb02b3db43e278a98d31"
    );
    let envelope = br#"{"key_id":"recovery","signature":"6d3e499b342778c14ba5afc433034215d631a5997dae89bbe855b302c12160186807e55b5f95518767a76f2d4c72756459445c995ddbf650d5edf6d4d00dd307"}"#;
    assert_eq!(
        pins()
            .verify_keyset(bytes, envelope)
            .unwrap()
            .document()
            .sequence,
        1
    );
}

#[test]
fn general_rollout_zero_never_applies_even_after_soak() {
    let keys = verified_keys(&keyset(1));
    let mut s = state(&keys);
    let mut doc = manifest("0.2.0-beta.2", Channel::Beta, NOW);
    doc.rollout.percentage = 0;
    s.observe(&verified(&doc, NOW, &keys), NOW).unwrap();
    let now = NOW + 72 * 3600;
    let m = verified(&doc, now, &keys);
    assert_eq!(
        s.decision(&m, &keys, "0.2.0-beta.1", now).unwrap(),
        ApplyDecision::OutsideRollout
    );
}

#[test]
fn exact_bytes_and_domain_are_signed() {
    let keys = verified_keys(&keyset(1));
    let bytes = serde_json::to_vec(&manifest("0.2.0-beta.2", Channel::Beta, NOW)).unwrap();
    let sig = signature(&bytes, MANIFEST_DOMAIN, "ci-current", 1);
    let mut changed = bytes.clone();
    changed.push(b' ');
    assert!(
        pins()
            .verify_manifest(&changed, &sig, Channel::Beta, NOW, &keys)
            .is_err()
    );
    assert!(
        pins()
            .verify_manifest(
                &bytes,
                &signature(&bytes, KEYSET_DOMAIN, "ci-current", 1),
                Channel::Beta,
                NOW,
                &keys
            )
            .is_err()
    );
    assert!(
        pins()
            .verify_manifest(
                &bytes,
                &signature(&bytes, MANIFEST_DOMAIN, "recovery", 3),
                Channel::Beta,
                NOW,
                &keys
            )
            .is_err()
    );
    assert!(
        pins()
            .verify_manifest(&bytes, &sig, Channel::Stable, NOW, &keys)
            .is_err()
    );
}

#[test]
fn ci_cannot_sign_recovery_and_recovery_cannot_sign_manifest() {
    let bytes = serde_json::to_vec(&keyset(1)).unwrap();
    assert!(
        pins()
            .verify_keyset(&bytes, &signature(&bytes, KEYSET_DOMAIN, "ci-current", 1))
            .is_err()
    );
    assert!(
        pins()
            .verify_keyset(&bytes, &signature(&bytes, KEYSET_DOMAIN, "recovery", 1))
            .is_err()
    );
}

#[test]
fn malformed_unknown_duplicate_and_oversized_json_fail() {
    for bytes in [
        b"{}".to_vec(),
        b"{\"sequence\":1,\"sequence\":2,\"revoked\":[],\"added\":[],\"halt\":null}".to_vec(),
        vec![b' '; 65537],
    ] {
        assert!(
            pins()
                .verify_keyset(&bytes, &signature(&bytes, KEYSET_DOMAIN, "recovery", 3))
                .is_err()
        );
    }
    let mut value = serde_json::to_value(keyset(1)).unwrap();
    value["future"] = true.into();
    let bytes = serde_json::to_vec(&value).unwrap();
    assert!(
        pins()
            .verify_keyset(&bytes, &signature(&bytes, KEYSET_DOMAIN, "recovery", 3))
            .is_err()
    );
}

#[test]
fn revoked_keys_and_key_role_aliases_are_rejected() {
    let mut doc = keyset(2);
    doc.revoked.push("ci-current".into());
    let keys = verified_keys(&doc);
    let bytes = serde_json::to_vec(&manifest("0.3.0", Channel::Stable, NOW)).unwrap();
    assert!(
        pins()
            .verify_manifest(
                &bytes,
                &signature(&bytes, MANIFEST_DOMAIN, "ci-current", 1),
                Channel::Stable,
                NOW,
                &keys
            )
            .is_err()
    );
    doc.added.push(AddedKey {
        id: "ci-new".into(),
        public_key: hex(&signing(3).verifying_key().to_bytes()),
        role: KeyRole::Ci,
    });
    let bytes = serde_json::to_vec(&doc).unwrap();
    assert!(
        pins()
            .verify_keyset(&bytes, &signature(&bytes, KEYSET_DOMAIN, "recovery", 3))
            .is_err()
    );
    assert!(
        PinnedKeys::new(
            BTreeMap::from([
                ("ci-current".into(), signing(1).verifying_key().to_bytes()),
                ("ci-next".into(), signing(1).verifying_key().to_bytes())
            ]),
            signing(3).verifying_key().to_bytes()
        )
        .is_err()
    );
}

#[test]
fn recovery_sequences_cannot_rollback_equivocate_or_omit_revocations() {
    let mut initial = keyset(2);
    initial.revoked.push("ci-next".into());
    let keys = verified_keys(&initial);
    let mut s = state(&keys);
    assert!(s.accept_keyset(&verified_keys(&keyset(1))).is_err());
    assert!(s.accept_keyset(&verified_keys(&keyset(2))).is_err());
    assert!(s.accept_keyset(&verified_keys(&keyset(3))).is_err());
    assert!(s.accept_keyset(&keys).is_ok());
    initial.sequence = 3;
    initial.halt = Some(Halt {
        reason: "incident".into(),
    });
    assert!(s.accept_keyset(&verified_keys(&initial)).is_ok());
}

#[test]
fn offline_client_can_skip_cumulative_keyset_sequences() {
    let mut doc = keyset(10);
    doc.revoked = vec!["ci-next".into()];
    doc.added = vec![AddedKey {
        id: "ci-new".into(),
        public_key: hex(&signing(4).verifying_key().to_bytes()),
        role: KeyRole::Ci,
    }];
    let keys = verified_keys(&doc);
    let bytes = serde_json::to_vec(&manifest("0.3.0", Channel::Stable, NOW)).unwrap();
    assert!(
        pins()
            .verify_manifest(
                &bytes,
                &signature(&bytes, MANIFEST_DOMAIN, "ci-new", 4),
                Channel::Stable,
                NOW,
                &keys
            )
            .is_ok()
    );
    doc.sequence = 11;
    doc.added.clear();
    assert!(state(&keys).accept_keyset(&verified_keys(&doc)).is_err());
}

#[test]
fn general_install_soaks_full_72_hours_even_after_roundtrip() {
    let keys = verified_keys(&keyset(1));
    let mut s = state(&keys);
    let doc = manifest("0.2.0-beta.2", Channel::Beta, NOW);
    s.observe(&verified(&doc, NOW, &keys), NOW).unwrap();
    let mut s = PolicyState::restore(&pins(), &serde_json::to_vec(&s).unwrap()).unwrap();
    for elapsed in [0, 24 * 3600, 72 * 3600 - 1, 72 * 3600] {
        let now = NOW + elapsed;
        let m = verified(&doc, now, &keys);
        s.observe(&m, now).unwrap();
        let expected = if elapsed < 72 * 3600 {
            ApplyDecision::Soaking {
                remaining_seconds: 72 * 3600 - elapsed,
            }
        } else {
            ApplyDecision::Eligible
        };
        assert_eq!(
            s.decision(&m, &keys, "0.2.0-beta.1", now).unwrap(),
            expected
        );
    }
}

#[test]
fn late_canary_opt_in_cannot_bypass_an_observed_release() {
    let keys = verified_keys(&keyset(1));
    let mut s = state(&keys);
    let doc = manifest("0.2.0-beta.2", Channel::Beta, NOW);
    let m = verified(&doc, NOW, &keys);
    s.observe(&m, NOW).unwrap();
    s.set_channel(LocalChannel::Early);
    assert_eq!(s.channel().remote(), Channel::Beta);
    s.observe(&m, NOW).unwrap();
    assert!(matches!(
        s.decision(&m, &keys, "0.2.0-beta.1", NOW).unwrap(),
        ApplyDecision::Soaking { .. }
    ));
    let m = verified(&manifest("0.2.0-beta.3", Channel::Beta, NOW), NOW, &keys);
    s.observe(&m, NOW).unwrap();
    assert_eq!(
        s.decision(&m, &keys, "0.2.0-beta.1", NOW).unwrap(),
        ApplyDecision::Eligible
    );
}

#[test]
fn early_honours_halt_and_blocks_but_skips_rollout() {
    let mut key_doc = keyset(1);
    key_doc.halt = Some(Halt {
        reason: "investigate".into(),
    });
    let keys = verified_keys(&key_doc);
    let mut s = state(&keys);
    s.set_channel(LocalChannel::Early);
    let doc = manifest("0.2.0-beta.2", Channel::Beta, NOW);
    let m = verified(&doc, NOW, &keys);
    s.observe(&m, NOW).unwrap();
    assert_eq!(
        s.decision(&m, &keys, "0.2.0-beta.1", NOW).unwrap(),
        ApplyDecision::Halted
    );
    key_doc.sequence = 2;
    key_doc.halt = None;
    let keys = verified_keys(&key_doc);
    s.accept_keyset(&keys).unwrap();
    let mut doc = manifest("0.2.0-beta.3", Channel::Beta, NOW);
    doc.blocked_versions.push(doc.version.clone());
    let m = verified(&doc, NOW, &keys);
    s.observe(&m, NOW).unwrap();
    assert_eq!(
        s.decision(&m, &keys, "0.2.0-beta.1", NOW).unwrap(),
        ApplyDecision::Blocked
    );
    let mut doc = manifest("0.2.0-beta.4", Channel::Beta, NOW);
    doc.rollout.percentage = 0;
    let m = verified(&doc, NOW, &keys);
    s.observe(&m, NOW).unwrap();
    assert_eq!(
        s.decision(&m, &keys, "0.2.0-beta.1", NOW).unwrap(),
        ApplyDecision::Eligible
    );
}

#[test]
fn resign_preserves_soak_and_only_times_may_change() {
    let keys = verified_keys(&keyset(1));
    let mut s = state(&keys);
    let mut doc = manifest("0.2.0-beta.2", Channel::Beta, NOW);
    s.observe(&verified(&doc, NOW, &keys), NOW).unwrap();
    let now = NOW + 3600;
    doc.signed_at = stamp(now);
    doc.expires_at = stamp(now + 30 * 86400);
    let m = verified(&doc, now, &keys);
    s.observe(&m, now).unwrap();
    assert_eq!(
        s.decision(&m, &keys, "0.2.0-beta.1", now).unwrap(),
        ApplyDecision::Soaking {
            remaining_seconds: 71 * 3600
        }
    );
    for field in [
        "rollout",
        "targets",
        "published_at",
        "blocked_versions",
        "min_soak_hours",
    ] {
        let mut changed = doc.clone();
        match field {
            "rollout" => changed.rollout.percentage = 99,
            "targets" => changed.targets.values_mut().next().unwrap().size += 1,
            "published_at" => changed.published_at = stamp(NOW - 1),
            "blocked_versions" => changed.blocked_versions.push("0.1.0".into()),
            _ => changed.min_soak_hours = 96,
        }
        assert!(
            s.observe(&verified(&changed, now, &keys), now).is_err(),
            "{field}"
        );
    }
}

#[test]
fn semver_precedence_is_shared_across_channels() {
    let keys = verified_keys(&keyset(1));
    let mut s = state(&keys);
    for (v, channel) in [
        ("0.2.0-beta.9", Channel::Beta),
        ("0.2.0-beta.10", Channel::Next),
        ("0.2.0", Channel::Stable),
    ] {
        s.set_channel(match channel {
            Channel::Stable => LocalChannel::Stable,
            Channel::Beta => LocalChannel::Beta,
            Channel::Next => LocalChannel::Next,
        });
        s.observe(&verified(&manifest(v, channel, NOW), NOW, &keys), NOW)
            .unwrap();
    }
    s.set_channel(LocalChannel::Beta);
    assert!(
        s.observe(
            &verified(&manifest("0.2.0-beta.11", Channel::Beta, NOW), NOW, &keys),
            NOW
        )
        .is_err()
    );
    assert!(super::model::version("0.2.0+alias").is_err());
}

#[test]
fn stale_proof_or_recovery_state_never_authorizes_apply() {
    let keys = verified_keys(&keyset(1));
    let mut s = state(&keys);
    let doc = manifest("0.2.0-beta.2", Channel::Beta, NOW);
    let m = verified(&doc, NOW, &keys);
    s.observe(&m, NOW).unwrap();
    assert!(
        s.decision(&m, &keys, "0.2.0-beta.1", NOW + 72 * 3600)
            .is_err()
    );
    assert!(
        s.decision(&m, &verified_keys(&keyset(2)), "0.2.0-beta.1", NOW)
            .is_err()
    );
    s.accept_keyset(&verified_keys(&keyset(2))).unwrap();
    assert!(s.observe(&m, NOW).is_err());
}

#[test]
fn clock_rollback_fails_closed() {
    let keys = verified_keys(&keyset(1));
    let mut s = state(&keys);
    let doc = manifest("0.2.0-beta.2", Channel::Beta, NOW);
    s.observe(&verified(&doc, NOW + 100, &keys), NOW + 100)
        .unwrap();
    assert!(s.observe(&verified(&doc, NOW, &keys), NOW).is_err());
}

#[test]
fn validity_window_urls_sizes_and_soak_are_strict() {
    let keys = verified_keys(&keyset(1));
    for case in 0..10 {
        let mut doc = manifest("0.2.0-beta.2", Channel::Beta, NOW);
        match case {
            0 => doc.expires_at = stamp(NOW),
            1 => doc.signed_at = stamp(NOW + 1),
            2 => doc.expires_at = stamp(NOW + 30 * 86400 + 1),
            3 => doc.published_at = stamp(NOW + 1),
            4 => doc.min_soak_hours = 0,
            5 => doc.rollout.percentage = 101,
            6 => doc
                .targets
                .values_mut()
                .next()
                .unwrap()
                .url
                .push_str("?redirect=evil"),
            7 => doc.targets.values_mut().next().unwrap().sha256 = "AB".repeat(32),
            8 => doc.targets.values_mut().next().unwrap().size = 0,
            _ => {
                doc.targets.remove("universal-apple-darwin");
            }
        }
        let bytes = serde_json::to_vec(&doc).unwrap();
        assert!(
            pins()
                .verify_manifest(
                    &bytes,
                    &signature(&bytes, MANIFEST_DOMAIN, "ci-current", 1),
                    Channel::Beta,
                    NOW,
                    &keys
                )
                .is_err(),
            "case {case}"
        );
    }
}

#[test]
fn foreign_verified_keysets_cannot_cross_pin_families() {
    let local = pins();
    let local_keys = verified_keys(&keyset(1));
    let bytes = serde_json::to_vec(&manifest("0.2.0-beta.2", Channel::Beta, NOW)).unwrap();
    for seeds in foreign_families() {
        let foreign = pins_with_seeds(seeds);
        let keys = keys_under(&foreign, seeds, 1);
        assert_eq!(keys.digest, local_keys.digest);
        let sig = signature(&bytes, MANIFEST_DOMAIN, "ci-current", seeds[0]);
        assert!(
            foreign
                .verify_manifest(&bytes, &sig, Channel::Beta, NOW, &keys)
                .is_ok()
        );
        assert_eq!(
            local
                .verify_manifest(&bytes, &sig, Channel::Beta, NOW, &keys)
                .err(),
            Some(UpdateError(
                "proof belongs to different original pin family"
            )),
            "{seeds:?}"
        );
    }
    // Independent instances with identical original pins are the same family.
    assert!(
        local
            .verify_manifest(
                &bytes,
                &signature(&bytes, MANIFEST_DOMAIN, "ci-current", 1),
                Channel::Beta,
                NOW,
                &local_keys
            )
            .is_ok()
    );
}

#[test]
fn policy_rejects_foreign_proofs_before_any_mutation() {
    let local = pins();
    let keys = verified_keys(&keyset(1));
    let m = verified(&manifest("0.2.0-beta.2", Channel::Beta, NOW), NOW, &keys);
    for seeds in foreign_families() {
        let foreign = pins_with_seeds(seeds);
        let foreign_keys = keys_under(&foreign, seeds, 1);
        let mut s = PolicyState::new(&local, "0.2.0-beta.1", NOW).unwrap();
        let before = serde_json::to_vec(&s).unwrap();
        assert!(s.accept_keyset(&foreign_keys).is_err()); // even first acceptance
        assert_eq!(serde_json::to_vec(&s).unwrap(), before);
        s.accept_keyset(&keys).unwrap();
        s.set_channel(LocalChannel::Early);
        s.observe(&m, NOW).unwrap();
        let foreign_m = manifest_under(&foreign, seeds, &foreign_keys, "0.2.0-beta.2");
        let foreign_new = manifest_under(&foreign, seeds, &foreign_keys, "0.2.0-beta.3");
        let before = serde_json::to_vec(&s).unwrap();
        for mut reopened in [s.clone(), PolicyState::restore(&local, &before).unwrap()] {
            assert!(reopened.accept_keyset(&foreign_keys).is_err()); // equal digest/sequence
            assert!(
                reopened
                    .accept_keyset(&keys_under(&foreign, seeds, 2))
                    .is_err()
            ); // higher sequence
            assert!(reopened.observe(&foreign_new, NOW).is_err());
            for (manifest, fresh_keys) in [
                (&m, &foreign_keys),
                (&foreign_m, &keys),
                (&foreign_m, &foreign_keys),
            ] {
                assert!(
                    reopened
                        .decision(manifest, fresh_keys, "0.2.0-beta.1", NOW)
                        .is_err()
                );
            }
            assert_eq!(serde_json::to_vec(&reopened).unwrap(), before);
            assert_eq!(
                reopened.decision(&m, &keys, "0.2.0-beta.1", NOW).unwrap(),
                ApplyDecision::Eligible
            );
        }
    }
}

#[test]
fn persisted_family_reopen_is_checked_and_never_reset() {
    let keys = verified_keys(&keyset(1));
    let mut s = state(&keys);
    s.observe(
        &verified(&manifest("0.2.0-beta.2", Channel::Beta, NOW), NOW, &keys),
        NOW,
    )
    .unwrap();
    let bytes = serde_json::to_vec(&s).unwrap();
    assert_eq!(
        serde_json::to_vec(&PolicyState::restore(&pins(), &bytes).unwrap()).unwrap(),
        bytes
    );
    for seeds in foreign_families() {
        let foreign = pins_with_seeds(seeds);
        assert!(PolicyState::restore(&foreign, &bytes).is_err());
        let foreign_keys = keys_under(&foreign, seeds, 1);
        let mut foreign_state = PolicyState::new(&foreign, "0.2.0-beta.1", NOW).unwrap();
        foreign_state.accept_keyset(&foreign_keys).unwrap();
        assert!(
            PolicyState::restore(&pins(), &serde_json::to_vec(&foreign_state).unwrap()).is_err()
        );
    }
    let fresh = PolicyState::new(&pins(), "0.2.0-beta.1", NOW).unwrap();
    assert!(PolicyState::restore(&pins(), &serde_json::to_vec(&fresh).unwrap()).is_ok());
    for case in 0..11 {
        let mut value = serde_json::to_value(&s).unwrap();
        match case {
            0 => {
                value.as_object_mut().unwrap().remove("pins");
            }
            1 => value["schema_version"] = 1.into(),
            2 => value["pins"]["ci-current"]["role"] = "recovery".into(),
            3 => {
                let current = value["pins"]["ci-current"].clone();
                value["pins"]["ci-current"] = value["pins"]["ci-next"].clone();
                value["pins"]["ci-next"] = current;
            }
            4 => value["pins"]["unrecognized-slot"] = value["pins"]["recovery"].clone(),
            5 => {
                let byte = value["pins"]["ci-current"]["public_key"][0]
                    .as_u64()
                    .unwrap();
                value["pins"]["ci-current"]["public_key"][0] = (byte ^ 1).into();
            }
            6 => {
                value.as_object_mut().unwrap().remove("keyset");
            }
            7 => {
                value.as_object_mut().unwrap().remove("keyset_digest");
            }
            8 => {
                value.as_object_mut().unwrap().remove("keyset");
                value.as_object_mut().unwrap().remove("keyset_digest");
            }
            9 => {
                value["keyset"] = serde_json::Value::Null;
                value["keyset_digest"] = serde_json::Value::Null;
            }
            _ => value["schema_version"] = 3.into(),
        }
        assert!(
            PolicyState::restore(&pins(), &serde_json::to_vec(&value).unwrap()).is_err(),
            "case {case}"
        );
    }
}

#[test]
fn same_family_added_key_rotation_preserves_history_after_reopen() {
    let keys = verified_keys(&keyset(1));
    let mut s = state(&keys);
    let mut doc = manifest("0.2.0-beta.2", Channel::Beta, NOW);
    s.observe(&verified(&doc, NOW, &keys), NOW).unwrap();
    let mut recovery = keyset(2);
    recovery.revoked.push("ci-current".into());
    recovery.added.push(AddedKey {
        id: "ci-new".into(),
        public_key: hex(&signing(4).verifying_key().to_bytes()),
        role: KeyRole::Ci,
    });
    let rotated = verified_keys(&recovery);
    let mut s = PolicyState::restore(&pins(), &serde_json::to_vec(&s).unwrap()).unwrap();
    s.accept_keyset(&rotated).unwrap();
    let now = NOW + 3600;
    doc.signed_at = stamp(now);
    doc.expires_at = stamp(now + 30 * 86400);
    let bytes = serde_json::to_vec(&doc).unwrap();
    let sig = signature(&bytes, MANIFEST_DOMAIN, "ci-new", 4);
    let m = pins()
        .verify_manifest(&bytes, &sig, Channel::Beta, now, &rotated)
        .unwrap();
    s.observe(&m, now).unwrap();
    let saved = serde_json::to_vec(&s).unwrap();
    let mut s = PolicyState::restore(&pins(), &saved).unwrap();
    assert_eq!(
        s.decision(&m, &rotated, "0.2.0-beta.1", now).unwrap(),
        ApplyDecision::Soaking {
            remaining_seconds: 71 * 3600
        }
    );
    assert!(s.accept_keyset(&keys).is_err());
    assert_eq!(serde_json::to_vec(&s).unwrap(), saved);
    let at_end = NOW + 72 * 3600;
    let fresh = pins()
        .verify_manifest(&bytes, &sig, Channel::Beta, at_end, &rotated)
        .unwrap();
    assert_eq!(
        s.decision(&fresh, &rotated, "0.2.0-beta.1", at_end)
            .unwrap(),
        ApplyDecision::Eligible
    );
}

#[test]
fn signed_soak_can_only_raise_compiled_floor() {
    let keys = verified_keys(&keyset(1));
    let mut s = state(&keys);
    let mut doc = manifest("0.2.0-beta.2", Channel::Beta, NOW);
    doc.min_soak_hours = 96;
    s.observe(&verified(&doc, NOW, &keys), NOW).unwrap();
    let now = NOW + 72 * 3600;
    let m = verified(&doc, now, &keys);
    assert_eq!(
        s.decision(&m, &keys, "0.2.0-beta.1", now).unwrap(),
        ApplyDecision::Soaking {
            remaining_seconds: 24 * 3600
        }
    );
}
