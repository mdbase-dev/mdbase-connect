//! Device identity and secret storage.
//!
//! **Where secrets live.** Private keys are kept in the OS credential store: the
//! macOS Keychain, the Windows Credential Manager, or the Secret Service (GNOME
//! Keyring, KWallet) on Linux, through the `keyring` crate. They never appear in
//! files, process arguments, logs, status output or control errors. Production
//! never falls back to a plaintext file: an unavailable credential store makes the
//! daemon report `credential_store_unavailable`.
//!
//! Debug builds and unit tests may select an owner-only file backend with **both**
//! `MDBASE_ENV=test` and `MDBASE_SECRET_BACKEND=insecure-test-file`. The type and
//! selector are not compiled into a non-test release library/binary; environment
//! variables cannot enable plaintext custody in a production artifact.
//!
//! **The device identity** (`sealed-envelope.md` §5.1) is minted once per profile:
//! - a device ID;
//! - an Ed25519 signing key (entries, `key_grant`, `rekey`);
//! - an X25519 KEM key (HPKE unwrap of epoch keys);
//! - an X25519 Noise static key (`replica-client-api.md` §12; local IPC and relay).
//!
//! The public half is mirrored in `<state>/daemon.json` so status and enrolment can
//! show it without touching the keychain. On startup the two must agree. A
//! `daemon.json` with no matching keychain entry fails closed: minting a new
//! identity would silently orphan this device's enrolments and key grants.

use std::path::Path;
#[cfg(any(test, debug_assertions))]
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

use crate::fsutil;

/// Keychain service name for every mdbase-next secret.
pub const KEYCHAIN_SERVICE: &str = "dev.mdbase.daemon";

/// Secret-store failures. Messages never contain secret material.
#[derive(Debug)]
pub enum SecretError {
    /// The credential store could not be reached or refused access.
    Unavailable(String),
    /// A stored value is malformed or does not match `daemon.json`.
    Invalid(String),
    /// I/O on the non-secret mirror.
    Io(std::io::Error),
}

impl std::fmt::Display for SecretError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SecretError::Unavailable(m) => write!(f, "credential store unavailable: {m}"),
            SecretError::Invalid(m) => write!(f, "stored identity is invalid: {m}"),
            SecretError::Io(e) => write!(f, "device metadata I/O: {e}"),
        }
    }
}

impl std::error::Error for SecretError {}

impl From<std::io::Error> for SecretError {
    fn from(e: std::io::Error) -> Self {
        SecretError::Io(e)
    }
}

/// A store of named secret byte strings, scoped to one profile.
pub trait SecretStore: Send + Sync {
    /// Read a secret.
    fn get(&self, name: &str) -> Result<Option<Zeroizing<Vec<u8>>>, SecretError>;
    /// Write a secret (replacing any previous value).
    fn set(&self, name: &str, value: &[u8]) -> Result<(), SecretError>;
    /// Delete a secret; deleting a missing one is not an error.
    fn delete(&self, name: &str) -> Result<(), SecretError>;
    /// Short backend name for status (`keychain`, `insecure-test-file`, `memory`).
    fn backend(&self) -> &'static str;
}

impl<T: SecretStore + ?Sized> SecretStore for std::sync::Arc<T> {
    fn get(&self, name: &str) -> Result<Option<Zeroizing<Vec<u8>>>, SecretError> {
        (**self).get(name)
    }
    fn set(&self, name: &str, value: &[u8]) -> Result<(), SecretError> {
        (**self).set(name, value)
    }
    fn delete(&self, name: &str) -> Result<(), SecretError> {
        (**self).delete(name)
    }
    fn backend(&self) -> &'static str {
        (**self).backend()
    }
}

/// Select the OS keychain. Only debug builds/unit tests compile the alternative
/// file backend, which additionally requires both test variables.
pub fn store_for(namespace: &str, _state_dir: &Path) -> Box<dyn SecretStore> {
    #[cfg(any(test, debug_assertions))]
    {
        let test_env = std::env::var("MDBASE_ENV").as_deref() == Ok("test");
        let file_backend =
            std::env::var("MDBASE_SECRET_BACKEND").as_deref() == Ok("insecure-test-file");
        if test_env && file_backend {
            return Box::new(TestFileStore {
                path: _state_dir.join("test-secrets.json"),
            });
        }
    }
    Box::new(KeychainStore {
        namespace: namespace.to_string(),
    })
}

/// The OS credential store.
#[derive(Debug)]
pub struct KeychainStore {
    namespace: String,
}

impl KeychainStore {
    fn entry(&self, name: &str) -> Result<keyring::Entry, SecretError> {
        keyring::Entry::new(KEYCHAIN_SERVICE, &format!("{}:{name}", self.namespace))
            .map_err(|e| SecretError::Unavailable(safe_keyring_error(&e)))
    }
}

fn safe_keyring_error(e: &keyring::Error) -> String {
    // Classify; never echo platform payloads.
    match e {
        keyring::Error::PlatformFailure(_) => "platform failure".into(),
        keyring::Error::NoStorageAccess(_) => "no storage access (locked or denied)".into(),
        keyring::Error::NoEntry => "no entry".into(),
        keyring::Error::BadEncoding(_) => "bad encoding".into(),
        keyring::Error::TooLong(..) => "value too long".into(),
        keyring::Error::Invalid(..) => "invalid attribute".into(),
        keyring::Error::Ambiguous(_) => "ambiguous entry".into(),
        _ => "unknown keyring error".into(),
    }
}

impl SecretStore for KeychainStore {
    fn get(&self, name: &str) -> Result<Option<Zeroizing<Vec<u8>>>, SecretError> {
        match self.entry(name)?.get_secret() {
            Ok(v) => Ok(Some(Zeroizing::new(v))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(SecretError::Unavailable(safe_keyring_error(&e))),
        }
    }

    fn set(&self, name: &str, value: &[u8]) -> Result<(), SecretError> {
        self.entry(name)?
            .set_secret(value)
            .map_err(|e| SecretError::Unavailable(safe_keyring_error(&e)))
    }

    fn delete(&self, name: &str) -> Result<(), SecretError> {
        match self.entry(name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(SecretError::Unavailable(safe_keyring_error(&e))),
        }
    }

    fn backend(&self) -> &'static str {
        "keychain"
    }
}

/// Owner-only JSON file of hex secrets. Not present in release artifacts.
#[cfg(any(test, debug_assertions))]
#[derive(Debug)]
pub struct TestFileStore {
    path: PathBuf,
}

#[cfg(any(test, debug_assertions))]
impl TestFileStore {
    fn load(&self) -> Result<std::collections::BTreeMap<String, String>, SecretError> {
        match fsutil::read_optional(&self.path)? {
            None => Ok(Default::default()),
            Some(b) => serde_json::from_slice(&b)
                .map_err(|_| SecretError::Invalid("test secret file".into())),
        }
    }
    fn save(&self, m: &std::collections::BTreeMap<String, String>) -> Result<(), SecretError> {
        let b = serde_json::to_vec(m).map_err(|_| SecretError::Invalid("encode".into()))?;
        fsutil::write_atomic(&self.path, &b)?;
        Ok(())
    }
}

#[cfg(any(test, debug_assertions))]
impl SecretStore for TestFileStore {
    fn get(&self, name: &str) -> Result<Option<Zeroizing<Vec<u8>>>, SecretError> {
        let m = self.load()?;
        m.get(name)
            .map(|h| hex_decode(h).map(Zeroizing::new))
            .transpose()
    }
    fn set(&self, name: &str, value: &[u8]) -> Result<(), SecretError> {
        let mut m = self.load()?;
        m.insert(name.to_string(), hex(value));
        self.save(&m)
    }
    fn delete(&self, name: &str) -> Result<(), SecretError> {
        let mut m = self.load()?;
        if m.remove(name).is_some() {
            self.save(&m)?;
        }
        Ok(())
    }
    fn backend(&self) -> &'static str {
        "insecure-test-file"
    }
}

/// In-memory store for unit tests.
#[derive(Debug, Default)]
pub struct MemoryStore {
    values: std::sync::Mutex<std::collections::BTreeMap<String, Vec<u8>>>,
}

impl SecretStore for MemoryStore {
    fn get(&self, name: &str) -> Result<Option<Zeroizing<Vec<u8>>>, SecretError> {
        Ok(self
            .values
            .lock()
            .map_err(|_| SecretError::Unavailable("poisoned".into()))?
            .get(name)
            .cloned()
            .map(Zeroizing::new))
    }
    fn set(&self, name: &str, value: &[u8]) -> Result<(), SecretError> {
        self.values
            .lock()
            .map_err(|_| SecretError::Unavailable("poisoned".into()))?
            .insert(name.to_string(), value.to_vec());
        Ok(())
    }
    fn delete(&self, name: &str) -> Result<(), SecretError> {
        self.values
            .lock()
            .map_err(|_| SecretError::Unavailable("poisoned".into()))?
            .remove(name);
        Ok(())
    }
    fn backend(&self) -> &'static str {
        "memory"
    }
}

/// Keychain entry name of the control key: proves a control
/// caller can read this user's mdbase keychain entries (the CLI and the desktop).
pub const CONTROL_KEY: &str = "control-key";

/// Load the control key, minting it on first use.
pub fn load_or_create_control_key(
    store: &dyn SecretStore,
) -> Result<Zeroizing<[u8; 32]>, SecretError> {
    if let Some(v) = store.get(CONTROL_KEY)? {
        let k: [u8; 32] = v[..]
            .try_into()
            .map_err(|_| SecretError::Invalid("control key length".into()))?;
        return Ok(Zeroizing::new(k));
    }
    let mut k = Zeroizing::new([0u8; 32]);
    getrandom::fill(&mut k[..])
        .map_err(|e| SecretError::Unavailable(format!("OS entropy: {e}")))?;
    store.set(CONTROL_KEY, &k[..])?;
    Ok(k)
}

/// Read the control key without minting one (clients).
pub fn read_control_key(
    store: &dyn SecretStore,
) -> Result<Option<Zeroizing<[u8; 32]>>, SecretError> {
    match store.get(CONTROL_KEY)? {
        None => Ok(None),
        Some(v) => {
            Ok(Some(Zeroizing::new(v[..].try_into().map_err(|_| {
                SecretError::Invalid("control key length".into())
            })?)))
        }
    }
}

/// The host session's Noise static key, derived from the control key:
/// `HMAC-SHA256(control_key, "mdbase/v1/host-noise")`. Only callers that can read
/// the keychain (the CLI, the desktop) can open host sessions over local IPC.
pub fn host_noise_secret(control_key: &[u8; 32]) -> Zeroizing<[u8; 32]> {
    use hmac::{Hmac, Mac};
    let mut m = <Hmac<sha2::Sha256> as Mac>::new_from_slice(control_key).expect("any key length");
    m.update(b"mdbase/v1/host-noise");
    Zeroizing::new(m.finalize().into_bytes().into())
}

/// The control-auth proof for a challenge:
/// `HMAC-SHA256(control_key, "mdbase/v1/control-auth" ‖ nonce)`.
pub fn control_proof(key: &[u8; 32], nonce: &[u8]) -> [u8; 32] {
    use hmac::{Hmac, Mac};
    let mut m = <Hmac<sha2::Sha256> as Mac>::new_from_slice(key).expect("any key length");
    m.update(b"mdbase/v1/control-auth");
    m.update(nonce);
    m.finalize().into_bytes().into()
}

/// Keychain entry name of the device identity.
const DEVICE_IDENTITY: &str = "device-identity";
const IDENTITY_FORMAT: u8 = 1;
const IDENTITY_LEN: usize = 1 + 16 + 32 * 3;

/// The device's private keys. Zeroized on drop; `Debug` shows only public data.
pub struct DeviceIdentity {
    /// Device ID.
    pub device_id: [u8; 16],
    sign_seed: [u8; 32],
    kem_sk: [u8; 32],
    noise_sk: [u8; 32],
}

impl Drop for DeviceIdentity {
    fn drop(&mut self) {
        self.sign_seed.zeroize();
        self.kem_sk.zeroize();
        self.noise_sk.zeroize();
    }
}

impl std::fmt::Debug for DeviceIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeviceIdentity")
            .field("public", &self.public())
            .finish_non_exhaustive()
    }
}

/// The daemon identity file (`<state>/daemon.json`): non-secret.
///
/// ```json
/// {"schema_version": 1, "device": "<uuid>", "noise_pk": "<64 hex>",
///  "sign_pk": "<64 hex>", "kem_pk": "<64 hex>"}
/// ```
///
/// Local clients read `device` and `noise_pk` to build the Noise prologue and pin
/// the responder key. Readers ignore unknown fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DevicePublic {
    /// Schema version.
    pub schema_version: u32,
    /// Device ID (UUID).
    pub device: String,
    /// Ed25519 public key, hex.
    pub sign_pk: String,
    /// X25519 KEM public key, hex.
    pub kem_pk: String,
    /// X25519 Noise static public key, hex.
    pub noise_pk: String,
}

impl DeviceIdentity {
    /// Mint a new identity from OS entropy.
    pub fn generate() -> Result<DeviceIdentity, SecretError> {
        let mut raw = Zeroizing::new([0u8; 16 + 96]);
        getrandom::fill(&mut raw[..])
            .map_err(|e| SecretError::Unavailable(format!("OS entropy: {e}")))?;
        let mut id = [0u8; 16];
        id.copy_from_slice(&raw[..16]);
        // UUID v4 layout.
        id[6] = (id[6] & 0x0f) | 0x40;
        id[8] = (id[8] & 0x3f) | 0x80;
        let mut s = DeviceIdentity {
            device_id: id,
            sign_seed: [0; 32],
            kem_sk: [0; 32],
            noise_sk: [0; 32],
        };
        s.sign_seed.copy_from_slice(&raw[16..48]);
        s.kem_sk.copy_from_slice(&raw[48..80]);
        s.noise_sk.copy_from_slice(&raw[80..112]);
        Ok(s)
    }

    fn encode(&self) -> Zeroizing<Vec<u8>> {
        let mut v = Zeroizing::new(Vec::with_capacity(IDENTITY_LEN));
        v.push(IDENTITY_FORMAT);
        v.extend_from_slice(&self.device_id);
        v.extend_from_slice(&self.sign_seed);
        v.extend_from_slice(&self.kem_sk);
        v.extend_from_slice(&self.noise_sk);
        v
    }

    fn decode(b: &[u8]) -> Result<DeviceIdentity, SecretError> {
        if b.len() != IDENTITY_LEN || b[0] != IDENTITY_FORMAT {
            return Err(SecretError::Invalid("unknown identity format".into()));
        }
        let mut s = DeviceIdentity {
            device_id: [0; 16],
            sign_seed: [0; 32],
            kem_sk: [0; 32],
            noise_sk: [0; 32],
        };
        s.device_id.copy_from_slice(&b[1..17]);
        s.sign_seed.copy_from_slice(&b[17..49]);
        s.kem_sk.copy_from_slice(&b[49..81]);
        s.noise_sk.copy_from_slice(&b[81..113]);
        Ok(s)
    }

    /// Sign a 32-byte digest with the device's Ed25519 key (pure Ed25519 over the
    /// digest bytes, as the control plane verifies).
    pub fn sign_digest(&self, digest: &[u8; 32]) -> [u8; 64] {
        use ed25519_dalek::Signer;
        ed25519_dalek::SigningKey::from_bytes(&self.sign_seed)
            .sign(digest)
            .to_bytes()
    }

    /// Ed25519 signing key seed (for the replica's `DeviceSecrets`).
    pub fn sign_seed(&self) -> &[u8; 32] {
        &self.sign_seed
    }

    /// X25519 KEM secret key (for the replica's `DeviceSecrets`).
    pub fn kem_secret(&self) -> &[u8; 32] {
        &self.kem_sk
    }

    /// Noise static secret key (local IPC and relay responder).
    pub fn noise_secret(&self) -> &[u8; 32] {
        &self.noise_sk
    }

    /// The public half.
    pub fn public(&self) -> DevicePublic {
        let sign_pk = ed25519_dalek::SigningKey::from_bytes(&self.sign_seed)
            .verifying_key()
            .to_bytes();
        let kem_pk = x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from(self.kem_sk));
        let noise_pk =
            x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from(self.noise_sk));
        DevicePublic {
            schema_version: 1,
            device: uuid_string(&self.device_id),
            sign_pk: hex(&sign_pk),
            kem_pk: hex(kem_pk.as_bytes()),
            noise_pk: hex(noise_pk.as_bytes()),
        }
    }

    /// Load this profile's identity, or mint and store one on first start.
    ///
    /// Fails closed when `daemon.json` exists but the keychain has no identity, or
    /// when the two disagree.
    pub fn load_or_create(
        store: &dyn SecretStore,
        device_file: &Path,
    ) -> Result<DeviceIdentity, SecretError> {
        let mirror: Option<DevicePublic> = match fsutil::read_optional(device_file)? {
            None => None,
            Some(b) => Some(
                serde_json::from_slice(&b)
                    .map_err(|_| SecretError::Invalid("daemon.json does not parse".into()))?,
            ),
        };
        match (store.get(DEVICE_IDENTITY)?, mirror) {
            (Some(raw), Some(public)) => {
                let id = DeviceIdentity::decode(&raw)?;
                if id.public() != public {
                    return Err(SecretError::Invalid(
                        "the keychain identity does not match daemon.json".into(),
                    ));
                }
                Ok(id)
            }
            (Some(raw), None) => {
                let id = DeviceIdentity::decode(&raw)?;
                write_public(device_file, &id.public())?;
                Ok(id)
            }
            (None, Some(_)) => Err(SecretError::Invalid(
                "daemon.json exists but the keychain has no device identity; \
                 refusing to mint a new one (it would orphan this device's enrolments)"
                    .into(),
            )),
            (None, None) => {
                let id = DeviceIdentity::generate()?;
                store.set(DEVICE_IDENTITY, &id.encode())?;
                let back = store.get(DEVICE_IDENTITY)?.ok_or_else(|| {
                    SecretError::Unavailable("identity did not read back after storing".into())
                })?;
                let back = DeviceIdentity::decode(&back)?;
                if back.public() != id.public() {
                    return Err(SecretError::Unavailable(
                        "identity changed while it was being stored".into(),
                    ));
                }
                write_public(device_file, &id.public())?;
                Ok(id)
            }
        }
    }
}

/// Read and verify the daemon's identity for a local client.
///
/// The state directory and `daemon.json` must both pass
/// [`fsutil::verify_owner_only`]; anything else is refused, so a file planted by
/// another user can never redirect a client's Noise handshake. The path comes from
/// the profile ([`crate::paths::Profile::identity_file`]), never from the socket or
/// pipe name.
pub fn read_daemon_identity(state_dir: &Path, file: &Path) -> Result<DevicePublic, SecretError> {
    fsutil::verify_owner_only(state_dir)
        .and_then(|()| fsutil::verify_owner_only(file))
        .map_err(|e| SecretError::Invalid(format!("untrusted daemon identity: {e}")))?;
    let b = std::fs::read(file)?;
    let p: DevicePublic = serde_json::from_slice(&b)
        .map_err(|_| SecretError::Invalid("daemon.json does not parse".into()))?;
    if p.noise_pk.len() != 64 || hex_decode(&p.noise_pk).is_err() || p.device.len() != 36 {
        return Err(SecretError::Invalid("daemon.json is incomplete".into()));
    }
    Ok(p)
}

fn write_public(path: &Path, p: &DevicePublic) -> Result<(), SecretError> {
    let mut b = serde_json::to_vec_pretty(p).map_err(|_| SecretError::Invalid("encode".into()))?;
    b.push(b'\n');
    fsutil::write_atomic(path, &b)?;
    Ok(())
}

/// The control plane's domain-separated hash:
/// `SHA-256(u8(len(tag)) ‖ tag ‖ m)`.
pub fn domain_hash(tag: &str, parts: &[&[u8]]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut d = Sha256::new();
    d.update([tag.len() as u8]);
    d.update(tag.as_bytes());
    for p in parts {
        d.update(p);
    }
    d.finalize().into()
}

/// Lower-case hex.
pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Decode lower- or upper-case hex.
pub fn hex_decode(s: &str) -> Result<Vec<u8>, SecretError> {
    if !s.len().is_multiple_of(2) {
        return Err(SecretError::Invalid("odd hex length".into()));
    }
    (0..s.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(&s[i..i + 2], 16).map_err(|_| SecretError::Invalid("hex".into()))
        })
        .collect()
}

/// Hyphenated lower-case UUID text.
pub fn uuid_string(b: &[u8; 16]) -> String {
    let h = hex(b);
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

/// A fresh random UUID v4 string (collection and replica IDs minted by the daemon).
pub fn new_uuid() -> Result<String, SecretError> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).map_err(|e| SecretError::Unavailable(format!("OS entropy: {e}")))?;
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    Ok(uuid_string(&b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_is_minted_once_and_reloaded() {
        let dir = crate::testutil::TestDir::new("secrets");
        let file = dir.path().join("daemon.json");
        let store = MemoryStore::default();
        let a = DeviceIdentity::load_or_create(&store, &file).unwrap();
        let b = DeviceIdentity::load_or_create(&store, &file).unwrap();
        assert_eq!(a.public(), b.public());
        assert_eq!(a.public().device.len(), 36);
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(
            !text.contains(&hex(a.noise_secret())),
            "no secrets in daemon.json"
        );
    }

    #[test]
    fn missing_keychain_entry_fails_closed() {
        let dir = crate::testutil::TestDir::new("secrets2");
        let file = dir.path().join("daemon.json");
        let store = MemoryStore::default();
        DeviceIdentity::load_or_create(&store, &file).unwrap();
        store.delete(DEVICE_IDENTITY).unwrap();
        let err = DeviceIdentity::load_or_create(&store, &file).unwrap_err();
        assert!(matches!(err, SecretError::Invalid(_)));
        assert!(
            store.get(DEVICE_IDENTITY).unwrap().is_none(),
            "nothing minted"
        );
    }

    #[cfg(unix)]
    #[test]
    fn clients_refuse_an_identity_file_others_can_write() {
        use std::os::unix::fs::PermissionsExt;
        let dir = crate::testutil::TestDir::new("ident");
        let state = dir.path().join("state");
        crate::fsutil::ensure_private_dir(&state).unwrap();
        let file = state.join("daemon.json");
        let store = MemoryStore::default();
        let id = DeviceIdentity::load_or_create(&store, &file).unwrap();
        assert_eq!(read_daemon_identity(&state, &file).unwrap(), id.public());

        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o666)).unwrap();
        assert!(read_daemon_identity(&state, &file).is_err());
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::set_permissions(&state, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(read_daemon_identity(&state, &file).is_err());
        std::fs::set_permissions(&state, std::fs::Permissions::from_mode(0o700)).unwrap();

        let link = dir.path().join("link.json");
        std::os::unix::fs::symlink(&file, &link).unwrap();
        assert!(read_daemon_identity(&state, &link).is_err());
    }

    #[test]
    fn debug_never_prints_secrets() {
        let id = DeviceIdentity::generate().unwrap();
        let dbg = format!("{id:?}");
        assert!(!dbg.contains(&hex(id.sign_seed())));
        assert!(!dbg.contains(&hex(id.noise_secret())));
    }
}
