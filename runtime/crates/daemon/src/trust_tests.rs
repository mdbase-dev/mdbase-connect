//! The embedded environment: the LAB and production assets are exactly the
//! authenticated ones, only their own builds embed them, and sign-in only reaches
//! the build's control plane.
//! (Payload verification itself is tested in `mdbn-trust`.)

use super::*;
use sha2::Digest;

#[cfg(feature = "lab")]
#[test]
fn lab_embeds_exactly_the_authenticated_asset() {
    let context = lab_context().unwrap();
    assert_eq!(LAB_ASSET.len(), 876);
    assert_eq!(sha2::Sha256::digest(LAB_ASSET).as_slice(), context.sha256);
    let trust = Environment::Lab.trust().unwrap();
    assert_eq!(trust.environment, "lab");
    assert_eq!(trust.cp_origin, Environment::Lab.control_plane());
    assert_eq!(trust.log_origin, context.log_origin);
    assert!(!trust.roots.is_empty());
    assert_eq!(trust.policy_pins.validate(), Ok(()));
    // Before the asset was issued, nothing verifies.
    assert!(Environment::Lab.trust_at(0).is_err());
}

#[cfg(not(any(feature = "lab", feature = "local-rehearsal")))]
#[test]
fn absent_lab_feature_refuses_lab_trust_without_a_fallback() {
    assert!(
        Environment::Lab
            .trust_at(0)
            .unwrap_err()
            .0
            .contains("--features lab")
    );
    assert!(Environment::Lab.trust().is_err());
    assert_eq!(Environment::embedded(), Environment::Production);
    assert_eq!(authenticated().unwrap().environment, "production");
}

#[test]
fn synthetic_fixture_pins_are_valid_and_do_not_authenticate_the_build() {
    let fixture = fixture_trust();
    assert_eq!(fixture.environment, "lab");
    assert_eq!(fixture.cp_origin, Environment::Lab.control_plane());
    assert_eq!(fixture.log_origin, "https://log.lab.example");
    assert_eq!(fixture.policy_pins.validate(), Ok(()));
    assert_eq!(fixture.roots.len(), 1);
    if let Ok(trust) = Environment::Production.trust() {
        assert!(!trust.roots.iter().any(|root| fixture.roots.contains(root)));
    }
}

#[cfg(not(any(feature = "lab", feature = "local-rehearsal")))]
#[test]
fn production_embeds_exactly_the_reviewed_asset() {
    assert_eq!(Environment::Production.name(), "production");
    assert_eq!(
        Environment::Production.control_plane(),
        "https://connect.mdbase.dev"
    );
    // The embedded bytes are the in-repo release input, pinned by digest.
    let context = production_context().unwrap();
    assert_eq!(PRODUCTION_ASSET.len(), 840);
    assert_eq!(
        sha2::Sha256::digest(PRODUCTION_ASSET).as_slice(),
        context.sha256
    );
    assert_eq!(
        PRODUCTION_ASSET,
        std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../config/next-trust/production.json"
        ))
        .unwrap()
    );
    let trust = Environment::Production.trust().unwrap();
    assert_eq!(trust.environment, "production");
    assert_eq!(trust.cp_origin, "https://connect.mdbase.dev");
    assert_eq!(trust.log_origin, "https://log.mdbase.dev");
    assert_eq!(trust.roots.len(), 1);
    assert_eq!(trust.policy_pins.validate(), Ok(()));
    assert_eq!(authenticated().unwrap().cp_origin, trust.cp_origin);
    // Before the asset was issued, nothing verifies.
    assert!(Environment::Production.trust_at(0).is_err());
}

#[cfg(not(any(feature = "lab", feature = "local-rehearsal")))]
#[test]
fn production_refuses_any_other_asset_bytes_or_context() {
    let now = 1_792_698_307_649 + 1;
    let context = production_context().unwrap();
    assert!(mdbn_trust::verify(PRODUCTION_ASSET, &context, now).is_ok());
    let mut changed = PRODUCTION_ASSET.to_vec();
    let at = changed.iter().position(|b| *b == b'7').unwrap();
    changed[at] = b'8';
    assert!(mdbn_trust::verify(&changed, &context, now).is_err());
    let edits: [fn(&mut Context); 4] = [
        |c: &mut Context| c.environment = "staging".into(),
        |c: &mut Context| c.log_origin = "https://log-staging.mdbase.dev".into(),
        |c: &mut Context| c.control_plane_origin = "https://connect-lab.mdbase.dev".into(),
        |c: &mut Context| c.source.version = "0.1.0-beta.140".into(),
    ];
    for edit in edits {
        let mut other = production_context().unwrap();
        edit(&mut other);
        assert!(mdbn_trust::verify(PRODUCTION_ASSET, &other, now).is_err());
    }
}

#[cfg(any(feature = "lab", feature = "local-rehearsal"))]
#[test]
fn only_production_builds_embed_production_trust() {
    assert!(Environment::Production.trust().is_err());
}

#[test]
fn the_build_feature_selects_the_environment() {
    #[cfg(feature = "local-rehearsal")]
    let expected = Environment::Local;
    #[cfg(not(feature = "local-rehearsal"))]
    let expected = if cfg!(feature = "lab") {
        Environment::Lab
    } else {
        Environment::Production
    };
    assert_eq!(Environment::embedded(), expected);
    assert_eq!(
        authenticated().map(|t| t.environment),
        expected.trust().map(|t| t.environment)
    );
    assert_eq!(
        sign_in_server(None).unwrap(),
        expected.control_plane(),
        "sign-in defaults to the build's control plane"
    );
}

#[test]
fn sign_in_defaults_to_and_only_accepts_the_build_environment() {
    for env in [Environment::Lab, Environment::Production] {
        let other = if env == Environment::Lab {
            Environment::Production
        } else {
            Environment::Lab
        };
        assert_eq!(sign_in_server_for(env, None).unwrap(), env.control_plane());
        // The same origin in any accepted spelling.
        for spelling in [
            env.control_plane().to_string(),
            format!("{}/", env.control_plane()),
            env.control_plane()
                .to_ascii_uppercase()
                .replace("HTTPS", "https"),
        ] {
            assert_eq!(
                sign_in_server_for(env, Some(&spelling)).unwrap(),
                env.control_plane(),
                "{spelling}"
            );
        }
        let refused = sign_in_server_for(env, Some(other.control_plane())).unwrap_err();
        assert!(refused.contains(env.control_plane()), "{refused}");
        for wrong in [
            "https://connect.example",
            "https://connect.mdbase.dev.evil.example",
            "http://connect.mdbase.dev",
            "connect.mdbase.dev",
        ] {
            assert!(sign_in_server_for(env, Some(wrong)).is_err(), "{wrong}");
        }
    }
}

#[cfg(feature = "local-rehearsal")]
#[test]
fn local_embeds_signed_exact_stack_and_refuses_managed_or_other_origins() {
    let trust = authenticated().unwrap();
    assert_eq!(trust.environment, "local");
    assert_eq!(trust.cp_origin, Environment::Local.control_plane());
    assert_eq!(trust.log_origin, local_input::LOG_ORIGIN);
    assert_eq!(trust.roots.len(), 1);
    assert_eq!(trust.policy_pins.validate(), Ok(()));
    assert!(Environment::Local.trust_at(0).is_err());
    assert!(Environment::Lab.trust().is_err());
    assert!(Environment::Production.trust().is_err());
    assert_eq!(sign_in_server(None).unwrap(), trust.cp_origin);
    assert_eq!(
        sign_in_server(Some(&trust.cp_origin)).unwrap(),
        trust.cp_origin
    );
    for origin in [
        "https://connect-lab.mdbase.dev",
        "https://connect.mdbase.dev",
        "http://localhost:9",
        "http://127.0.0.1:0",
    ] {
        assert!(sign_in_server(Some(origin)).is_err(), "{origin}");
    }
    for suffix in ["/", "/path", "?query=1", "#fragment"] {
        assert!(sign_in_server(Some(&format!("{}{suffix}", trust.cp_origin))).is_err());
    }
}

#[test]
fn only_hermetic_tests_reach_a_loopback_control_plane() {
    // Unit tests (cfg(test)) are hermetic; https on loopback is still another origin.
    assert_eq!(
        sign_in_server_for(Environment::Production, Some("http://127.0.0.1:9")).unwrap(),
        "http://127.0.0.1:9"
    );
    assert!(sign_in_server_for(Environment::Production, Some("https://127.0.0.1:9")).is_err());
    // The shipped binary never enables the test hook.
    for (name, source) in [
        ("main.rs", include_str!("main.rs")),
        ("cli.rs", include_str!("cli.rs")),
        ("server.rs", include_str!("server.rs")),
    ] {
        assert!(
            !source.contains("allow_loopback_control_plane_for_tests"),
            "{name} enables the loopback test hook"
        );
    }
}
