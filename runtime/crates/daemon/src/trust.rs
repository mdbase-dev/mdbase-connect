//! The Connect environment this binary is built for, and its embedded release
//! trust asset.
//!
//! A build belongs to exactly one environment, fixed at compile time: the default
//! build is **production**; the `lab` cargo feature makes a **LAB** build and
//! requires both authenticated LAB release files at compile time. The distinct
//! `local-rehearsal` feature embeds signed PUBLIC per-stack local trust inputs,
//! verified against an independently supplied stack root. It cannot be combined
//! with LAB; neither managed profile compiles or reads those inputs. A public tree
//! without those files can build and test the default production profile; it
//! cannot build LAB or supply replacement trust at runtime. The environment decides
//! the default control plane for `mdbase account sign-in`, the
//! only control plane sign-in accepts, and the trust pins synced collections use.
//! There is no runtime flag, file, environment variable or server reply that
//! changes it.
//!
//! Verification is [`mdbn_trust::verify`] (the one verifier, shared with the app
//! build step). This module only supplies the embedded asset bytes and their
//! independently authenticated context (from the authenticated release manifest,
//! never from the payload; see `trust/lab-authentication.md`). The production
//! build embeds the reviewed in-repo asset `config/next-trust/production.json`,
//! pinned here by digest together with the context its authenticated release
//! bundle binds (environment, origins, release source). LAB and local-rehearsal
//! builds do not compile it.

#[cfg(any(test, debug_assertions))]
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(all(feature = "lab", feature = "local-rehearsal"))]
compile_error!("LAB and local-rehearsal are distinct artifacts; choose exactly one");

use mdbn_trust::{Context, REPOSITORY, Source};

#[cfg(feature = "local-rehearsal")]
mod local_input {
    // Public build inputs generated only after signed per-stack verification.
    // Missing inputs are a compile error, never a runtime fallback/root source.
    include!("../trust/local-context.rs");
}
#[cfg(feature = "local-rehearsal")]
const LOCAL_ASSET: &[u8] = include_bytes!("../trust/local.json");
pub use mdbn_trust::{Invalid, Trust, origin};

/// A Connect environment a build can belong to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Environment {
    /// The production service.
    Production,
    /// The isolated LAB service (`lab` feature builds only).
    Lab,
    /// Per-stack local service (explicit local-rehearsal artifact only).
    #[cfg(feature = "local-rehearsal")]
    Local,
}

impl Environment {
    /// The environment this binary was built for.
    pub const fn embedded() -> Environment {
        #[cfg(feature = "local-rehearsal")]
        return Environment::Local;
        #[cfg(not(feature = "local-rehearsal"))]
        if cfg!(feature = "lab") {
            Environment::Lab
        } else {
            Environment::Production
        }
    }

    /// Its name, as the trust payload spells it.
    pub const fn name(self) -> &'static str {
        match self {
            Environment::Production => "production",
            Environment::Lab => "lab",
            #[cfg(feature = "local-rehearsal")]
            Environment::Local => "local",
        }
    }

    /// Its control-plane origin: the sign-in default and the only one accepted.
    pub const fn control_plane(self) -> &'static str {
        match self {
            Environment::Production => "https://connect.mdbase.dev",
            Environment::Lab => "https://connect-lab.mdbase.dev",
            #[cfg(feature = "local-rehearsal")]
            Environment::Local => local_input::CP_ORIGIN,
        }
    }

    /// Its verified trust pins at the current time.
    pub fn trust(self) -> Result<Trust, Invalid> {
        let now = u64::try_from(crate::fsutil::now_ms()).map_err(|_| Invalid("clock".into()))?;
        self.trust_at(now)
    }

    fn trust_at(self, now_ms: u64) -> Result<Trust, Invalid> {
        match self {
            #[cfg(feature = "local-rehearsal")]
            Environment::Local => {
                let context = Context {
                    sha256: mdbn_trust::hex_exact(local_input::SHA256, "asset digest")?,
                    environment: "local".into(),
                    control_plane_origin: local_input::CP_ORIGIN.into(),
                    log_origin: local_input::LOG_ORIGIN.into(),
                    source: Source {
                        repository: REPOSITORY.into(),
                        commit: local_input::SOURCE_COMMIT.into(),
                        version: local_input::SOURCE_VERSION.into(),
                    },
                };
                mdbn_trust::verify_local(
                    LOCAL_ASSET,
                    &context,
                    now_ms,
                    &mdbn_trust::hex_exact(local_input::STACK_ROOT, "independent stack root")?,
                    &mdbn_trust::hex_exact(local_input::SIGNATURE, "local signature")?,
                )
            }
            #[cfg(feature = "lab")]
            Environment::Lab => mdbn_trust::verify(LAB_ASSET, &lab_context()?, now_ms),
            #[cfg(not(feature = "lab"))]
            Environment::Lab => Err(Invalid(
                "this build embeds no LAB trust asset; LAB requires --features lab and the authenticated release files".into(),
            )),
            #[cfg(not(any(feature = "lab", feature = "local-rehearsal")))]
            Environment::Production => {
                mdbn_trust::verify(PRODUCTION_ASSET, &production_context()?, now_ms)
            }
            #[cfg(any(feature = "lab", feature = "local-rehearsal"))]
            Environment::Production => Err(Invalid(
                "this is not a production build; it embeds no production trust asset".into(),
            )),
        }
    }
}

/// Immutable per-stack keychain partition. Managed artifacts do not compile
/// this selector and cannot read a local namespace through runtime options.
#[cfg(feature = "local-rehearsal")]
#[doc(hidden)]
pub const fn local_asset_digest() -> &'static str {
    local_input::SHA256
}

/// The verified trust pins of the environment this binary was built for.
pub fn authenticated() -> Result<Trust, Invalid> {
    Environment::embedded().trust()
}

/// The production asset: the reviewed, in-repo release input, byte for byte.
/// [`production_context`] pins its digest; any other bytes refuse to verify.
#[cfg(not(any(feature = "lab", feature = "local-rehearsal")))]
const PRODUCTION_ASSET: &[u8] = include_bytes!("../../../../config/next-trust/production.json");

/// The production asset's authenticated context, as the signed release trust
/// bundle for it binds (docs/next-trust-release.md), never read from the payload.
/// A trust rotation replaces the asset and these values in one reviewed change.
#[cfg(not(any(feature = "lab", feature = "local-rehearsal")))]
fn production_context() -> Result<Context, Invalid> {
    Ok(Context {
        sha256: mdbn_trust::hex_exact(PRODUCTION_ASSET_SHA256, "asset digest")?,
        environment: Environment::Production.name().into(),
        control_plane_origin: Environment::Production.control_plane().into(),
        log_origin: "https://log.mdbase.dev".into(),
        source: Source {
            repository: REPOSITORY.into(),
            commit: "36abd4b065be9495a7f5ae0808865a1f2279af04".into(),
            version: "0.1.0-beta.141".into(),
        },
    })
}

/// SHA-256 of [`PRODUCTION_ASSET`] (beta.141 production trust, 840 bytes).
#[cfg(not(any(feature = "lab", feature = "local-rehearsal")))]
const PRODUCTION_ASSET_SHA256: &str =
    "7912e40838213e60b65848350d319a48019021317b112e3326429b250f0133d7";

/// The LAB asset authenticated by Ops' guarded Sigstore/OIDC release verifier
/// before embedding (trust/lab-authentication.md).
#[cfg(feature = "lab")]
const LAB_ASSET: &[u8] = include_bytes!("../trust/lab.json");

// Compile-time release input, not a runtime context source. Requesting LAB
// without either signed file produces a compiler error naming the missing path.
#[cfg(feature = "lab")]
const _: &[u8] = include_bytes!("../trust/lab-release-manifest.json");

/// The LAB asset's authenticated context, from the authenticated release manifest
/// (trust/lab-release-manifest.json), never from the payload.
#[cfg(feature = "lab")]
fn lab_context() -> Result<Context, Invalid> {
    Ok(Context {
        sha256: mdbn_trust::hex_exact(
            "88fe5249be83d7db9999d88d4f62acaca79e8bdcabe2c9f236e2942014de3334",
            "asset digest",
        )?,
        environment: Environment::Lab.name().into(),
        control_plane_origin: Environment::Lab.control_plane().into(),
        log_origin: "https://mdbase-next-log-lab-20261005.callumalpass.workers.dev".into(),
        source: Source {
            repository: REPOSITORY.into(),
            commit: "8a014fe2abd2d9c6a8b1ed3e77c35cfda3392d3e".into(),
            version: "0.1.0-beta.129".into(),
        },
    })
}

#[cfg(any(test, debug_assertions))]
static LOOPBACK_CONTROL_PLANE: AtomicBool = AtomicBool::new(false);

/// Debug/unit-test builds only: sign-in also accepts an `http://` loopback
/// control plane (a fixture server). Not compiled into release artifacts.
/// The `mdbase` binary never calls this,
/// and no CLI flag, file or environment variable reaches it. Trust pins are
/// unaffected: synced collections still need the embedded environment's pins.
#[cfg(any(test, debug_assertions))]
#[doc(hidden)]
pub fn allow_loopback_control_plane_for_tests() {
    LOOPBACK_CONTROL_PLANE.store(true, Ordering::SeqCst);
}

fn loopback_allowed() -> bool {
    #[cfg(any(test, debug_assertions))]
    {
        cfg!(test) || LOOPBACK_CONTROL_PLANE.load(Ordering::SeqCst)
    }
    #[cfg(not(any(test, debug_assertions)))]
    {
        false
    }
}

/// The control plane `mdbase account sign-in` uses: the embedded environment's
/// when none is given; a requested one only when it is exactly that origin.
/// Refuses any other server (a production build cannot sign in to LAB and vice
/// versa).
pub fn sign_in_server(requested: Option<&str>) -> Result<String, String> {
    sign_in_server_for(Environment::embedded(), requested)
}

fn sign_in_server_for(env: Environment, requested: Option<&str>) -> Result<String, String> {
    #[cfg(feature = "local-rehearsal")]
    if env == Environment::Local {
        // Authenticate before even sign-in can send a bearer/browser to an origin.
        // No test hook or canonicalisation broadens this per-stack exact binding.
        let trust = env.trust().map_err(|error| error.0)?;
        let server = requested.unwrap_or(env.control_plane());
        return if server == trust.cp_origin && server == env.control_plane() {
            Ok(trust.cp_origin)
        } else {
            Err("local artifacts sign in only to their exact verified stack origin".into())
        };
    }
    let Some(requested) = requested else {
        return Ok(env.control_plane().to_string());
    };
    let server = crate::cloud::canonical_server_url(requested).map_err(|e| e.to_string())?;
    if server == env.control_plane() || (loopback_allowed() && server.starts_with("http://")) {
        return Ok(server);
    }
    Err(format!(
        "this is a {} build: it signs in only to {}",
        env.name(),
        env.control_plane()
    ))
}

/// One root and one policy key certified by it, as pins (tests).
#[cfg(test)]
pub(crate) fn pins_for(root: [u8; 32], policy: [u8; 32]) -> mdbn_replica::policy::PolicyPins {
    use mdbn_replica::policy::{PolicyKeyPin, PolicyPins, RootPin, key_id};
    use mdbn_wire::common::B32;
    PolicyPins {
        roots: vec![RootPin {
            root_id: key_id(&root),
            root_pk: B32(root),
        }],
        policy_keys: vec![PolicyKeyPin {
            key_id: key_id(&policy),
            policy_pk: B32(policy),
            root_id: key_id(&root),
        }],
    }
}

/// Public, synthetic pins for hermetic daemon tests. Never compiled into a
/// non-test library and never returned by authenticated() or Environment::trust.
#[cfg(test)]
pub(crate) fn fixture_trust() -> Trust {
    let public = |seed: u8| {
        ed25519_dalek::SigningKey::from_bytes(&[seed; 32])
            .verifying_key()
            .to_bytes()
    };
    Trust {
        environment: Environment::Lab.name().into(),
        cp_origin: Environment::Lab.control_plane().into(),
        log_origin: "https://log.lab.example".into(),
        roots: vec![public(0xab)],
        policy_pins: pins_for(public(0xab), public(0xcd)),
    }
}

#[cfg(test)]
#[path = "trust_tests.rs"]
mod tests;
