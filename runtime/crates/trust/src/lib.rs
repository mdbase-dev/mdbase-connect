//! Environment trust assets: the NEXT release trust payload v1 (control's contract,
//! `docs/next-trust-payload.md` at mdbase-connect aba3133d), verified once, here,
//! for every consumer (the daemon, and the app's build step through the
//! `mdbn-trust` binary).
//!
//! The payload pins one environment (`lab`, `staging`, `production`) to its exact
//! control-plane and log origins, its control-plane roots and its published policy
//! keys (each with its root-signed certificate), plus the release source. It is
//! not a signed envelope and cannot authenticate itself: Ops publishes it as an
//! asset of the authenticated release bundle (pinned Sigstore identity). The caller
//! supplies that independently authenticated [`Context`] (digest, environment,
//! origins, source); [`verify`] checks the exact bytes against it. Nothing here
//! reads a file, fetches from a server, trusts on first use or has a default
//! context.
//!
//! **Release monotonicity rule:** a later asset for an environment
//! keeps pinning every policy key (and root) that has ever certified items in it.
//! Pins identify keys, not freshness: dropping a historical key makes warm
//! reopens refuse and cold replays void that key's items (enrolments, grants), so
//! replicas would diverge. Retire a key with `cp-key-revoke`, never by unpinning.
//!
//! The normalized output for other runtimes is [`policy_pins_cbor`]: canonical
//! CBOR `[[[root_id, root_pk], ...], [[key_id, policy_pk, root_id], ...]]`, both
//! lists ascending by ID, decoded (and validated) by [`policy_pins_from_cbor`].

use mdbn_replica::policy::{PolicyKeyPin, PolicyPins, RootPin, key_id};
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::common::{B16, B32, B64};
use mdbn_wire::policy::CpCert;
use serde::Deserialize;
use sha2::Digest;

/// Largest payload accepted.
pub const MAX_BYTES: usize = 65536;
/// The only release repository a payload may come from.
pub const REPOSITORY: &str = "mdbase-dev/mdbase-connect";
const MAX_SAFE: u64 = 9_007_199_254_740_991;
/// Largest normalized pin encoding accepted (the app's native receiver bound).
pub const MAX_PINS_BYTES: usize = 65536;
/// Most roots in a normalized pin encoding.
pub const MAX_PIN_ROOTS: usize = 64;
/// Most policy keys in a normalized pin encoding.
pub const MAX_PIN_KEYS: usize = 1024;

/// Why trust pins are unusable. Messages carry no secrets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invalid(pub String);

impl std::fmt::Display for Invalid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "trust asset: {}", self.0)
    }
}

impl std::error::Error for Invalid {}

fn bad<T>(m: impl Into<String>) -> Result<T, Invalid> {
    Err(Invalid(m.into()))
}

/// The release a payload must come from.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Source {
    /// Always [`REPOSITORY`].
    pub repository: String,
    /// Full lower-case commit.
    pub commit: String,
    /// Release version.
    pub version: String,
}

/// What the authenticated release manifest says about the asset, obtained
/// independently of the payload (never from a server reply or the payload).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Context {
    /// SHA-256 of the asset bytes, from the authenticated manifest.
    pub sha256: [u8; 32],
    /// Environment.
    pub environment: String,
    /// Control-plane origin.
    pub control_plane_origin: String,
    /// Log origin.
    pub log_origin: String,
    /// Release source.
    pub source: Source,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RootJson {
    key_id: String,
    public_key: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CertJson {
    policy_public_key: String,
    not_before: u64,
    not_after: u64,
    root_key_id: String,
    signature: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PolicyJson {
    key_id: String,
    certificate: CertJson,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Payload {
    schema_version: u32,
    environment: String,
    control_plane_origin: String,
    log_origin: String,
    issued_at: u64,
    source: Source,
    roots: Vec<RootJson>,
    policy_keys: Vec<PolicyJson>,
}

/// Validated pins for one environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Trust {
    /// Environment name.
    pub environment: String,
    /// Control-plane origin.
    pub cp_origin: String,
    /// Log origin.
    pub log_origin: String,
    /// Root public keys, ascending by key ID.
    pub roots: Vec<[u8; 32]>,
    /// Published roots and policy keys (validated), for a replica's `policy_pins`.
    pub policy_pins: PolicyPins,
}

/// Lower-case hex of `bytes`.
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Exactly `N` bytes of lower-case hex.
pub fn hex_exact<const N: usize>(s: &str, what: &str) -> Result<[u8; N], Invalid> {
    let err = || Invalid(format!("{what} must be {N} bytes of lower-case hex"));
    if s.len() != N * 2 || s.bytes().any(|b| !matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return Err(err());
    }
    let mut out = [0u8; N];
    for (i, pair) in s.as_bytes().chunks_exact(2).enumerate() {
        let digit = |c: u8| if c <= b'9' { c - b'0' } else { c - b'a' + 10 };
        out[i] = digit(pair[0]) << 4 | digit(pair[1]);
    }
    Ok(out)
}

/// The origin of `url` (`scheme://host[:port]`), if it is one: https, or http on
/// loopback (test transports only); no user info, path, query or fragment beyond a
/// single trailing `/`.
pub fn origin(url: &str) -> Result<String, Invalid> {
    let err = |m: &str| Invalid(format!("origin: {m}"));
    let (scheme, rest) = url.split_once("://").ok_or_else(|| err("missing scheme"))?;
    let host = rest.strip_suffix('/').unwrap_or(rest);
    if host.is_empty()
        || host.contains(['/', '?', '#', '@'])
        || host.chars().any(char::is_whitespace)
        || host != host.to_ascii_lowercase()
    {
        return Err(err("must be scheme://host[:port]"));
    }
    let hostname = host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host);
    let loopback = matches!(hostname, "localhost" | "127.0.0.1" | "[::1]");
    match scheme {
        "https" => {}
        "http" if loopback => {}
        _ => return Err(err("https is required")),
    }
    Ok(format!("{scheme}://{host}"))
}

/// Exactly a canonical https origin (the payload never pins http).
fn https_origin(url: &str, what: &str) -> Result<String, Invalid> {
    if url.len() > 512 || !url.starts_with("https://") || origin(url)? != url {
        return bad(format!("{what} must be exactly https://host[:port]"));
    }
    Ok(url.to_string())
}

/// Verify candidate asset bytes against an independently authenticated `expected`
/// context at time `now_ms` (Unix ms). The context is the authentication; this
/// checks the exact bytes, canonical form, schema, origins, source, derived key
/// IDs, ascending order, every policy certificate under its pinned root and a
/// certificate valid at `issued_at <= now_ms`.
pub fn verify(bytes: &[u8], expected: &Context, now_ms: u64) -> Result<Trust, Invalid> {
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return bad("payload size");
    }
    if sha2::Sha256::digest(bytes).as_slice() != expected.sha256 {
        return bad("payload differs from the authenticated asset digest");
    }
    let text = std::str::from_utf8(bytes).map_err(|_| Invalid("payload is not UTF-8".into()))?;
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|e| Invalid(format!("payload: {e}")))?;
    // Canonical: keys sorted, no whitespace. A duplicate key, a different key order,
    // whitespace or another number form changes the re-encoded bytes.
    if serde_json::to_vec(&value).map_err(|e| Invalid(e.to_string()))? != bytes {
        return bad("payload is not canonical");
    }
    let p: Payload = serde_json::from_value(value).map_err(|e| Invalid(format!("payload: {e}")))?;
    if p.schema_version != 1 {
        return bad("unsupported trust schema");
    }
    if !matches!(p.environment.as_str(), "lab" | "staging" | "production") {
        return bad("unknown environment");
    }
    let cp_origin = https_origin(&p.control_plane_origin, "control_plane_origin")?;
    let log_origin = https_origin(&p.log_origin, "log_origin")?;
    let commit_ok = p.source.commit.len() == 40
        && p.source
            .commit
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    let version_ok = (1..=64).contains(&p.source.version.len())
        && p.source
            .version
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'+' | b'-'));
    if p.source.repository != REPOSITORY || !commit_ok || !version_ok {
        return bad("source");
    }
    if p.environment != expected.environment
        || cp_origin != expected.control_plane_origin
        || log_origin != expected.log_origin
        || p.source != expected.source
    {
        return bad("payload differs from the authenticated release context");
    }
    if p.issued_at > MAX_SAFE || p.issued_at > now_ms {
        return bad("issued_at");
    }
    if !(1..=8).contains(&p.roots.len()) || !(1..=32).contains(&p.policy_keys.len()) {
        return bad("pin counts");
    }
    let mut roots = Vec::new();
    let mut root_pins: Vec<RootPin> = Vec::new();
    for r in &p.roots {
        let id: [u8; 16] = hex_exact(&r.key_id, "root key_id")?;
        let pk: [u8; 32] = hex_exact(&r.public_key, "root public_key")?;
        if key_id(&pk).0 != id {
            return bad("root key_id is not derived from its key");
        }
        if root_pins.last().is_some_and(|l| l.root_id.0 >= id) {
            return bad("roots must be strictly ascending by key_id");
        }
        roots.push(pk);
        root_pins.push(RootPin {
            root_id: B16(id),
            root_pk: B32(pk),
        });
    }
    let mut key_pins: Vec<PolicyKeyPin> = Vec::new();
    let mut current = false;
    for k in &p.policy_keys {
        let id: [u8; 16] = hex_exact(&k.key_id, "policy key_id")?;
        let c = &k.certificate;
        let pk: [u8; 32] = hex_exact(&c.policy_public_key, "policy_public_key")?;
        let root: [u8; 16] = hex_exact(&c.root_key_id, "root_key_id")?;
        let sig: [u8; 64] = hex_exact(&c.signature, "certificate signature")?;
        if key_id(&pk).0 != id {
            return bad("policy key_id is not derived from its key");
        }
        if key_pins.last().is_some_and(|l| l.key_id.0 >= id) {
            return bad("policy keys must be strictly ascending by key_id");
        }
        if roots.contains(&pk) {
            return bad("a policy key is also a root");
        }
        if c.not_before > MAX_SAFE || c.not_after > MAX_SAFE || c.not_before >= c.not_after {
            return bad("certificate window");
        }
        let Some(root_pk) = root_pins
            .iter()
            .find(|r| r.root_id.0 == root)
            .map(|r| r.root_pk)
        else {
            return bad("certificate root is not pinned");
        };
        let cert = CpCert {
            policy_pk: B32(pk),
            not_before: c.not_before as i64,
            not_after: c.not_after as i64,
            root: B16(root),
            sig: B64(sig),
        };
        let digest = cert.signed_digest().map_err(|e| Invalid(e.to_string()))?;
        if !mdbn_replica::crypto::sign::verify_digest(&root_pk.0, &digest.0, &sig) {
            return bad("certificate does not verify under its root");
        }
        current |= c.not_before <= p.issued_at && p.issued_at <= c.not_after;
        key_pins.push(PolicyKeyPin {
            key_id: B16(id),
            policy_pk: B32(pk),
            root_id: B16(root),
        });
    }
    if !current {
        return bad("no policy certificate valid at issue time");
    }
    let policy_pins = PolicyPins {
        roots: root_pins,
        policy_keys: key_pins,
    };
    // Strong canonical keys, derived IDs, certified by a pinned root.
    policy_pins.validate().map_err(|e| Invalid(e.into()))?;
    Ok(Trust {
        environment: p.environment,
        cp_origin,
        log_origin,
        roots,
        policy_pins,
    })
}

/// Most retained authenticated assets accepted by one history qualification.
/// Exhaustion requires a reviewed inventory/format change, never dropping history.
pub const MAX_HISTORY_ASSETS: usize = 256;

/// Require every historical root and (policy ID, public key, certifying root)
/// tuple to remain in the candidate. Inputs must come from [`verify`] under
/// independently authenticated contexts covering the COMPLETE retained inventory.
/// This comparison cannot authenticate a manifest or detect an omitted old asset.
/// Empty history refuses; initial-environment bootstrap is a separate reviewed
/// transition, not a flag that bypasses this release gate.
///
/// Origins may change through an independently authorized environment migration;
/// environment identity and every historical pin must still be preserved. Expiry
/// or `cp-key-revoke` never removes a pin. Certificate freshness remains [`verify`]'s
/// responsibility; this gate compares immutable identities, not certificate bytes.
pub fn require_append_only(current: &Trust, history: &[Trust]) -> Result<(), Invalid> {
    if history.is_empty() || history.len() > MAX_HISTORY_ASSETS {
        return bad("history inventory missing or exceeds bound; never truncate history");
    }
    fn consistent(trust: &Trust) -> Result<(), Invalid> {
        if !matches!(trust.environment.as_str(), "lab" | "staging" | "production") {
            return bad("history environment");
        }
        if trust.policy_pins.roots.len() > MAX_PIN_ROOTS
            || trust.policy_pins.policy_keys.len() > MAX_PIN_KEYS
        {
            return bad("history pin capacity; reviewed format change required");
        }
        // Reuse the ONE canonical codec/validator, including order/count checks.
        policy_pins_from_cbor(&policy_pins_cbor(&trust.policy_pins)?)?;
        let roots: Vec<_> = trust
            .policy_pins
            .roots
            .iter()
            .map(|root| root.root_pk.0)
            .collect();
        if roots != trust.roots {
            return bad("history roots and policy pins differ");
        }
        Ok(())
    }
    consistent(current)?;
    for previous in history {
        consistent(previous)?;
        if previous.environment != current.environment {
            return bad("history belongs to another environment");
        }
        for root in &previous.policy_pins.roots {
            if !current.policy_pins.roots.contains(root) {
                return bad("historical root missing or rebound; preserve all pins");
            }
        }
        for key in &previous.policy_pins.policy_keys {
            if !current.policy_pins.policy_keys.contains(key) {
                return bad("historical policy tuple missing or rebound; preserve all pins");
            }
        }
    }
    Ok(())
}

/// The normalized pins: canonical CBOR
/// `[[[root_id b16, root_pk b32], ...], [[key_id b16, policy_pk b32, root_id b16], ...]]`.
/// Only validated pins are encoded.
pub fn policy_pins_cbor(pins: &PolicyPins) -> Result<Vec<u8>, Invalid> {
    pins.validate().map_err(|e| Invalid(e.into()))?;
    let b = |x: &[u8]| Cbor::Bytes(x.to_vec());
    let roots = pins
        .roots
        .iter()
        .map(|r| Cbor::Array(vec![b(&r.root_id.0), b(&r.root_pk.0)]))
        .collect();
    let keys = pins
        .policy_keys
        .iter()
        .map(|k| Cbor::Array(vec![b(&k.key_id.0), b(&k.policy_pk.0), b(&k.root_id.0)]))
        .collect();
    cbor::encode(&Cbor::Array(vec![Cbor::Array(roots), Cbor::Array(keys)]))
        .map_err(|e| Invalid(format!("encode: {e:?}")))
}

/// Decode [`policy_pins_cbor`]: exact shape, canonical bytes, ascending IDs, and
/// [`PolicyPins::validate`]. Anything else is refused.
pub fn policy_pins_from_cbor(bytes: &[u8]) -> Result<PolicyPins, Invalid> {
    let shape = || Invalid("policy pins: unexpected shape".into());
    if bytes.len() > MAX_PINS_BYTES {
        return bad("policy pins: too large");
    }
    let value = cbor::decode(bytes).map_err(|_| shape())?;
    let Cbor::Array(top) = &value else {
        return Err(shape());
    };
    let [Cbor::Array(roots), Cbor::Array(keys)] = top.as_slice() else {
        return Err(shape());
    };
    if !(1..=MAX_PIN_ROOTS).contains(&roots.len()) || !(1..=MAX_PIN_KEYS).contains(&keys.len()) {
        return bad("policy pins: counts");
    }
    fn bytes_n<const N: usize>(c: &Cbor) -> Option<[u8; N]> {
        match c {
            Cbor::Bytes(b) => b.as_slice().try_into().ok(),
            _ => None,
        }
    }
    let mut out = PolicyPins {
        roots: Vec::new(),
        policy_keys: Vec::new(),
    };
    for r in roots {
        let Cbor::Array(f) = r else {
            return Err(shape());
        };
        let [id, pk] = f.as_slice() else {
            return Err(shape());
        };
        let root_id = B16(bytes_n(id).ok_or_else(shape)?);
        if out
            .roots
            .last()
            .is_some_and(|l: &RootPin| l.root_id >= root_id)
        {
            return bad("policy pins: roots not ascending");
        }
        out.roots.push(RootPin {
            root_id,
            root_pk: B32(bytes_n(pk).ok_or_else(shape)?),
        });
    }
    for k in keys {
        let Cbor::Array(f) = k else {
            return Err(shape());
        };
        let [id, pk, root] = f.as_slice() else {
            return Err(shape());
        };
        let key_id = B16(bytes_n(id).ok_or_else(shape)?);
        if out
            .policy_keys
            .last()
            .is_some_and(|l: &PolicyKeyPin| l.key_id >= key_id)
        {
            return bad("policy pins: keys not ascending");
        }
        out.policy_keys.push(PolicyKeyPin {
            key_id,
            policy_pk: B32(bytes_n(pk).ok_or_else(shape)?),
            root_id: B16(bytes_n(root).ok_or_else(shape)?),
        });
    }
    out.validate().map_err(|e| Invalid(e.into()))?;
    if policy_pins_cbor(&out)? != bytes {
        return bad("policy pins: not canonical");
    }
    Ok(out)
}

/// The build-step output: one canonical JSON object (keys sorted, no spaces).
pub fn normalized_json(trust: &Trust, context: &Context) -> Result<String, Invalid> {
    let value = serde_json::json!({
        "asset_sha256": hex(&context.sha256),
        "control_plane_origin": trust.cp_origin,
        "environment": trust.environment,
        "log_origin": trust.log_origin,
        "policy_pins_cbor_hex": hex(&policy_pins_cbor(&trust.policy_pins)?),
        "roots": trust.roots.iter().map(|r| hex(r)).collect::<Vec<_>>(),
        "schema": "mdbn-trust/normalized/1",
        "source": {
            "commit": context.source.commit,
            "repository": context.source.repository,
            "version": context.source.version,
        },
    });
    serde_json::to_string(&value).map_err(|e| Invalid(e.to_string()))
}

#[cfg(test)]
mod history_tests;
#[cfg(test)]
mod public_tests;

// This private source and its authenticated asset are optional public-tree inputs.
// An inline include keeps rustfmt's module traversal independent of their presence.
#[cfg(all(test, feature = "lab"))]
mod lab_tests {
    include!("tests.rs");
}
