use super::*;
use mdbn_replica::crypto::sign::DeviceSigner;

fn local_asset() -> (Vec<u8>, Context, DeviceSigner, [u8; 64]) {
    let root = DeviceSigner::from_seed(&[21; 32]);
    let policy = DeviceSigner::from_seed(&[22; 32]);
    let cert = CpCert {
        policy_pk: B32(policy.public()),
        not_before: 1000,
        not_after: 9000,
        root: key_id(&root.public()),
        sig: B64([0; 64]),
    };
    let cert_signature = root.sign_digest(&cert.signed_digest().unwrap().0);
    let source = Source {
        repository: REPOSITORY.into(),
        commit: "b".repeat(40),
        version: "local".into(),
    };
    let bytes = serde_json::to_vec(&serde_json::json!({
        "schema_version": 1, "environment": "local", "control_plane_origin": "http://127.0.0.1:8111",
        "log_origin": "http://127.0.0.1:8222", "issued_at": 2000,
        "source": { "repository": source.repository, "commit": source.commit, "version": source.version },
        "roots": [{ "key_id": hex(&key_id(&root.public()).0), "public_key": hex(&root.public()) }],
        "policy_keys": [{ "key_id": hex(&key_id(&policy.public()).0), "certificate": {
            "policy_public_key": hex(&policy.public()), "not_before": 1000, "not_after": 9000,
            "root_key_id": hex(&cert.root.0), "signature": hex(&cert_signature) } }]
    })).unwrap();
    let context = Context {
        sha256: sha2::Sha256::digest(&bytes).into(),
        environment: "local".into(),
        control_plane_origin: "http://127.0.0.1:8111".into(),
        log_origin: "http://127.0.0.1:8222".into(),
        source,
    };
    let signature = sign_asset(&root, &bytes);
    (bytes, context, root, signature)
}

fn sign_asset(root: &DeviceSigner, bytes: &[u8]) -> [u8; 64] {
    let mut digest = sha2::Sha256::new();
    digest.update(b"mdbase/local-release-trust/1\n");
    digest.update(bytes);
    root.sign_digest(&digest.finalize().into())
}

#[test]
fn signed_local_asset_uses_the_exact_independent_stack_root() {
    let (bytes, context, root, signature) = local_asset();
    let trust = verify_local(&bytes, &context, 2000, &root.public(), &signature).unwrap();
    assert_eq!(trust.environment, "local");
    assert_eq!(trust.roots, [root.public()]);
    assert!(
        verify(&bytes, &context, 2000).is_err(),
        "managed API rejects even in local-feature builds"
    );
    let other = DeviceSigner::from_seed(&[23; 32]);
    assert!(verify_local(&bytes, &context, 2000, &other.public(), &signature).is_err());
    assert!(
        verify_local(
            &bytes,
            &context,
            2000,
            &other.public(),
            &sign_asset(&other, &bytes)
        )
        .is_err(),
        "signature alone cannot substitute policy root"
    );
    let mut bad_signature = signature;
    bad_signature[0] ^= 1;
    assert!(verify_local(&bytes, &context, 2000, &root.public(), &bad_signature).is_err());
}

#[test]
fn local_assets_never_cross_managed_environments_or_origins() {
    let (bytes, context, root, signature) = local_asset();
    for environment in ["lab", "staging", "production"] {
        let expected = Context {
            environment: environment.into(),
            ..context.clone()
        };
        assert!(verify_local(&bytes, &expected, 2000, &root.public(), &signature).is_err());
        assert!(verify(&bytes, &expected, 2000).is_err());
    }
    for origin in [
        "http://localhost:8111",
        "http://127.1:8111",
        "http://127.0.0.1:0",
        "http://127.0.0.1:08111",
        "https://127.0.0.1:8111",
        "http://127.0.0.1:8111/",
        "http://external.test:8111",
        "http://127.0.0.1:8111?x",
    ] {
        let mut payload: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        payload["control_plane_origin"] = origin.into();
        let edited = serde_json::to_vec(&payload).unwrap();
        let expected = Context {
            sha256: sha2::Sha256::digest(&edited).into(),
            control_plane_origin: origin.into(),
            ..context.clone()
        };
        assert!(
            verify_local(
                &edited,
                &expected,
                2000,
                &root.public(),
                &sign_asset(&root, &edited)
            )
            .is_err(),
            "{origin}"
        );
    }
}
