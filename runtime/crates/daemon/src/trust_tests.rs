//! The embedded environment: the LAB asset is exactly the authenticated one, the
//! production build embeds none, and sign-in only reaches the build's control plane.
//! (Payload verification itself is tested in `mdbn-trust`.)

use super::*;
#[cfg(feature = "lab")]
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

#[cfg(not(feature = "lab"))]
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
    assert!(authenticated().is_err());
}

#[test]
fn synthetic_fixture_pins_are_valid_and_do_not_authenticate_the_build() {
    let fixture = fixture_trust();
    assert_eq!(fixture.environment, "lab");
    assert_eq!(fixture.cp_origin, Environment::Lab.control_plane());
    assert_eq!(fixture.log_origin, "https://log.lab.example");
    assert_eq!(fixture.policy_pins.validate(), Ok(()));
    assert_eq!(fixture.roots.len(), 1);
    assert!(Environment::Production.trust().is_err());
}

#[test]
fn production_embeds_no_trust_yet() {
    assert_eq!(Environment::Production.name(), "production");
    assert_eq!(
        Environment::Production.control_plane(),
        "https://connect.mdbase.dev"
    );
    assert!(Environment::Production.trust().is_err());
}

#[test]
fn the_build_feature_selects_the_environment() {
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
        let other = match env {
            Environment::Lab => Environment::Production,
            Environment::Production => Environment::Lab,
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
