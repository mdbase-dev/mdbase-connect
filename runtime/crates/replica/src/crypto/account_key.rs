//! The account key bundle (AK1, account-key bundle design):
//! the user's account secret `R` (a [`RecoveryKey`]) encrypted under their encryption
//! password, for the control plane to store and hand back to a signed-in device.
//!
//! ```text
//! key_id = H("mdbase/v1/account-key-id", R)
//! kek    = Argon2id(NFKC(password), salt, m_kib, t, p, out = 32)
//! aad    = H("mdbase/v1/account-key-bundle", cbor[1, account, key_id, kdf])
//! ct     = XChaCha20-Poly1305(kek, nonce, R, aad)
//! bundle = cbor{0: 1, 1: kdf, 2: nonce, 3: ct, 4: key_id}
//! kdf    = [1 (Argon2id v1.3), m_kib, t, p, salt(16)]
//! ```
//!
//! The control plane never sees `R` or the password. The KDF parameters are read from
//! the (untrusted) bundle, so they are bounded both ways before any work is done.

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::common::{B32, Uuid};
use unicode_normalization::UnicodeNormalization;
use zeroize::{Zeroize, Zeroizing};

use super::recovery::RecoveryKey;
use super::{CsprngEntropy, ct_eq};

/// Bundle format version.
pub const BUNDLE_VERSION: u64 = 1;
/// KDF algorithm id: Argon2id, version 1.3.
pub const KDF_ARGON2ID: u64 = 1;
/// Largest encoded bundle accepted anywhere.
pub const MAX_BUNDLE_BYTES: usize = 512;
/// Minimum password length, in Unicode scalar values after NFKC.
pub const MIN_PASSWORD_CHARS: usize = 12;
/// Maximum password length, in UTF-8 bytes after NFKC (bounds normalisation and
/// KDF input work before any allocation of the KDF memory).
pub const MAX_PASSWORD_BYTES: usize = 1024;

/// Argon2id cost parameters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KdfParams {
    /// Memory in KiB.
    pub m_kib: u32,
    /// Passes.
    pub t: u32,
    /// Lanes.
    pub p: u32,
    /// Random salt.
    pub salt: [u8; 16],
}

/// v1 defaults: within the 32 MiB mobile/webview budget.
pub const DEFAULT_M_KIB: u32 = 19_456;
/// v1 default passes.
pub const DEFAULT_T: u32 = 3;
/// v1 default lanes.
pub const DEFAULT_P: u32 = 1;

/// Parameters a client will run, whatever a bundle says.
const MIN_M_KIB: u32 = 19_456;
/// At most 24 MiB: every client, including the 32 MiB mobile/webview budget, can
/// open every bundle; a hostile bundle cannot ask for more before allocation.
const MAX_M_KIB: u32 = 24_576;
const MIN_T: u32 = 2;
const MAX_T: u32 = 10;
const MAX_P: u32 = 4;

impl KdfParams {
    /// The v1 defaults with a fresh salt.
    pub fn new(entropy: &mut dyn CsprngEntropy) -> KdfParams {
        let mut salt = [0u8; 16];
        entropy.fill(&mut salt);
        KdfParams {
            m_kib: DEFAULT_M_KIB,
            t: DEFAULT_T,
            p: DEFAULT_P,
            salt,
        }
    }

    fn check(&self) -> Result<(), AccountKeyError> {
        let ok = (MIN_M_KIB..=MAX_M_KIB).contains(&self.m_kib)
            && (MIN_T..=MAX_T).contains(&self.t)
            && (1..=MAX_P).contains(&self.p)
            && self.m_kib >= 8 * self.p;
        if ok {
            Ok(())
        } else {
            Err(AccountKeyError::Params)
        }
    }

    fn cbor(&self) -> Cbor {
        Cbor::Array(vec![
            Cbor::Uint(KDF_ARGON2ID),
            Cbor::Uint(u64::from(self.m_kib)),
            Cbor::Uint(u64::from(self.t)),
            Cbor::Uint(u64::from(self.p)),
            Cbor::Bytes(self.salt.to_vec()),
        ])
    }

    fn from_cbor(v: &Cbor) -> Result<KdfParams, AccountKeyError> {
        let Cbor::Array(a) = v else {
            return Err(AccountKeyError::Encoding);
        };
        let [
            Cbor::Uint(alg),
            Cbor::Uint(m),
            Cbor::Uint(t),
            Cbor::Uint(p),
            Cbor::Bytes(salt),
        ] = a.as_slice()
        else {
            return Err(AccountKeyError::Encoding);
        };
        if *alg != KDF_ARGON2ID {
            return Err(AccountKeyError::Params);
        }
        let n = |x: u64| u32::try_from(x).map_err(|_| AccountKeyError::Params);
        Ok(KdfParams {
            m_kib: n(*m)?,
            t: n(*t)?,
            p: n(*p)?,
            salt: salt
                .as_slice()
                .try_into()
                .map_err(|_| AccountKeyError::Encoding)?,
        })
    }
}

/// Why a bundle operation failed. Never carries secret material.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccountKeyError {
    /// The password is shorter than [`MIN_PASSWORD_CHARS`].
    WeakPassword,
    /// The password is longer than [`MAX_PASSWORD_BYTES`].
    PasswordTooLong,
    /// Wrong password or recovery key (authentication failed after the KDF), or a
    /// recovery key for another account key.
    WrongSecret,
    /// KDF parameters outside the bounds a client will run.
    Params,
    /// Not a well-formed, canonical v1 bundle.
    Encoding,
}

impl std::fmt::Display for AccountKeyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            AccountKeyError::WeakPassword => "the password is too short",
            AccountKeyError::PasswordTooLong => "the password is too long",
            AccountKeyError::WrongSecret => "wrong password or recovery key",
            AccountKeyError::Params => "unsupported key derivation parameters",
            AccountKeyError::Encoding => "not an account key bundle",
        })
    }
}

impl std::error::Error for AccountKeyError {}

/// The public id of an account key: which `R` a bundle wraps.
pub fn key_id(r: &RecoveryKey) -> B32 {
    mdbn_wire::hash::h("mdbase/v1/account-key-id", r.expose())
}

/// A sealed account key, as the control plane stores it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bundle {
    /// KDF parameters and salt.
    pub kdf: KdfParams,
    /// XChaCha20 nonce.
    pub nonce: [u8; 24],
    /// `R` sealed (32 + 16 bytes).
    pub ct: Vec<u8>,
    /// [`key_id`] of the sealed `R`.
    pub key_id: B32,
}

impl Bundle {
    /// Canonical encoding.
    pub fn to_bytes(&self) -> Vec<u8> {
        let v = Cbor::Map(vec![
            (Cbor::Uint(0), Cbor::Uint(BUNDLE_VERSION)),
            (Cbor::Uint(1), self.kdf.cbor()),
            (Cbor::Uint(2), Cbor::Bytes(self.nonce.to_vec())),
            (Cbor::Uint(3), Cbor::Bytes(self.ct.clone())),
            (Cbor::Uint(4), Cbor::Bytes(self.key_id.0.to_vec())),
        ]);
        // Every field is a fixed-shape integer or short byte string.
        cbor::encode(&v).unwrap_or_default()
    }

    /// Strict decoding: canonical bytes only, bounded size, exact shape.
    pub fn from_bytes(bytes: &[u8]) -> Result<Bundle, AccountKeyError> {
        if bytes.len() > MAX_BUNDLE_BYTES {
            return Err(AccountKeyError::Encoding);
        }
        let v = cbor::decode(bytes).map_err(|_| AccountKeyError::Encoding)?;
        let Cbor::Map(m) = &v else {
            return Err(AccountKeyError::Encoding);
        };
        let [
            (Cbor::Uint(0), Cbor::Uint(ver)),
            (Cbor::Uint(1), kdf),
            (Cbor::Uint(2), Cbor::Bytes(nonce)),
            (Cbor::Uint(3), Cbor::Bytes(ct)),
            (Cbor::Uint(4), Cbor::Bytes(key_id)),
        ] = m.as_slice()
        else {
            return Err(AccountKeyError::Encoding);
        };
        if *ver != BUNDLE_VERSION || ct.len() != 48 {
            return Err(AccountKeyError::Encoding);
        }
        let b = Bundle {
            kdf: KdfParams::from_cbor(kdf)?,
            nonce: nonce
                .as_slice()
                .try_into()
                .map_err(|_| AccountKeyError::Encoding)?,
            ct: ct.clone(),
            key_id: B32(key_id
                .as_slice()
                .try_into()
                .map_err(|_| AccountKeyError::Encoding)?),
        };
        if b.to_bytes() != bytes {
            return Err(AccountKeyError::Encoding);
        }
        Ok(b)
    }
}

/// Check the password policy (length after NFKC; the strength meter is the UI's).
pub fn check_password(password: &str) -> Result<(), AccountKeyError> {
    let normalized = normalize(password)?;
    if normalized.chars().count() < MIN_PASSWORD_CHARS {
        return Err(AccountKeyError::WeakPassword);
    }
    Ok(())
}

/// NFKC, bounded before and after normalisation (NFKC expands at most 18x).
fn normalize(password: &str) -> Result<Zeroizing<String>, AccountKeyError> {
    if password.len() > MAX_PASSWORD_BYTES {
        return Err(AccountKeyError::PasswordTooLong);
    }
    let pw: Zeroizing<String> = Zeroizing::new(password.nfkc().collect());
    if pw.len() > MAX_PASSWORD_BYTES {
        return Err(AccountKeyError::PasswordTooLong);
    }
    Ok(pw)
}

fn aad(account: &Uuid, key_id: &B32, kdf: &KdfParams) -> B32 {
    let v = Cbor::Array(vec![
        Cbor::Uint(BUNDLE_VERSION),
        Cbor::Bytes(account.0.to_vec()),
        Cbor::Bytes(key_id.0.to_vec()),
        kdf.cbor(),
    ]);
    mdbn_wire::hash::h(
        "mdbase/v1/account-key-bundle",
        &cbor::encode(&v).unwrap_or_default(),
    )
}

fn kek(password: &str, kdf: &KdfParams) -> Result<Zeroizing<[u8; 32]>, AccountKeyError> {
    kdf.check()?;
    let pw = normalize(password)?;
    let params = argon2::Params::new(kdf.m_kib, kdf.t, kdf.p, Some(32))
        .map_err(|_| AccountKeyError::Params)?;
    let a = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let mut out = Zeroizing::new([0u8; 32]);
    // Memory is bounded by `check` (at most 24 MiB); wiped after use.
    let mut blocks = vec![argon2::Block::default(); a.params().block_count()];
    let r = a.hash_password_into_with_memory(pw.as_bytes(), &kdf.salt, out.as_mut(), &mut blocks);
    for b in blocks.iter_mut() {
        zeroize::Zeroize::zeroize(b);
    }
    r.map_err(|_| AccountKeyError::Params)?;
    Ok(out)
}

/// Seal `r` under `password` for `account`, with fresh salt and nonce.
pub fn seal(
    r: &RecoveryKey,
    password: &str,
    account: &Uuid,
    entropy: &mut dyn CsprngEntropy,
) -> Result<Bundle, AccountKeyError> {
    check_password(password)?;
    let kdf = KdfParams::new(entropy);
    let mut nonce = [0u8; 24];
    entropy.fill(&mut nonce);
    seal_with(r, password, account, kdf, nonce)
}

/// [`seal`] with explicit parameters and nonce (conformance vectors).
fn seal_with(
    r: &RecoveryKey,
    password: &str,
    account: &Uuid,
    kdf: KdfParams,
    nonce: [u8; 24],
) -> Result<Bundle, AccountKeyError> {
    let id = key_id(r);
    let k = kek(password, &kdf)?;
    let cipher = XChaCha20Poly1305::new(k.as_ref().into());
    let ad = aad(account, &id, &kdf);
    let ct = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: r.expose(),
                aad: &ad.0,
            },
        )
        .map_err(|_| AccountKeyError::Encoding)?;
    Ok(Bundle {
        kdf,
        nonce,
        ct,
        key_id: id,
    })
}

/// Open a bundle with `password` for `account`; checks the key id of what it opens.
pub fn open(b: &Bundle, password: &str, account: &Uuid) -> Result<RecoveryKey, AccountKeyError> {
    let k = kek(password, &b.kdf)?;
    let cipher = XChaCha20Poly1305::new(k.as_ref().into());
    let ad = aad(account, &b.key_id, &b.kdf);
    let mut plain = Zeroizing::new(
        cipher
            .decrypt(
                XNonce::from_slice(&b.nonce),
                Payload {
                    msg: &b.ct,
                    aad: &ad.0,
                },
            )
            .map_err(|_| AccountKeyError::WrongSecret)?,
    );
    let raw: [u8; 32] = plain
        .as_slice()
        .try_into()
        .map_err(|_| AccountKeyError::WrongSecret)?;
    plain.zeroize();
    let r = RecoveryKey::from_bytes(raw);
    if !ct_eq(&key_id(&r).0, &b.key_id.0) {
        return Err(AccountKeyError::WrongSecret);
    }
    Ok(r)
}

/// The account key's proof signer: Ed25519 from
/// `HKDF(R, salt = account, info = "mdbase/v1/account-key-proof")`. Its public key
/// is registered with the first bundle; replacing a bundle needs its signature.
pub fn proof_signer(r: &RecoveryKey, account: &Uuid) -> super::sign::DeviceSigner {
    let seed = super::hkdf32(r.expose(), &account.0, b"mdbase/v1/account-key-proof");
    super::sign::DeviceSigner::from_seed(seed.expose())
}

/// The digest a bundle replacement is signed over:
/// `H("mdbase/v1/account-key-rewrap", cbor[account, sha256(bundle), expected_version])`.
pub fn rewrap_digest(account: &Uuid, bundle: &[u8], expected_version: u64) -> [u8; 32] {
    let v = Cbor::Array(vec![
        Cbor::Bytes(account.0.to_vec()),
        Cbor::Bytes(mdbn_wire::hash::sha256(bundle).0.to_vec()),
        Cbor::Uint(expected_version),
    ]);
    mdbn_wire::hash::h(
        "mdbase/v1/account-key-rewrap",
        &cbor::encode(&v).unwrap_or_default(),
    )
    .0
}

/// Accept a typed recovery key as the account key of `bundle` (forgotten password).
pub fn check_recovery_key(r: &RecoveryKey, b: &Bundle) -> Result<(), AccountKeyError> {
    if ct_eq(&key_id(r).0, &b.key_id.0) {
        Ok(())
    } else {
        Err(AccountKeyError::WrongSecret)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::TestEntropy;

    const ACCOUNT: Uuid = mdbn_wire::common::B16([7; 16]);

    fn setup() -> (RecoveryKey, Bundle) {
        let mut e = TestEntropy::new(1);
        let r = RecoveryKey::generate(&mut e);
        let b = seal(&r, "correct horse battery staple", &ACCOUNT, &mut e).unwrap();
        (r, b)
    }

    #[test]
    fn round_trips_and_binds_the_account() {
        let (r, b) = setup();
        let bytes = b.to_bytes();
        assert!(bytes.len() <= MAX_BUNDLE_BYTES);
        let b2 = Bundle::from_bytes(&bytes).unwrap();
        assert_eq!(b2, b);
        let opened = open(&b2, "correct horse battery staple", &ACCOUNT).unwrap();
        assert_eq!(opened.expose(), r.expose());
        // NFKC: a compatibility form (fullwidth letters) of the same password opens it.
        assert_eq!(
            open(&b2, "\u{ff43}\u{ff4f}rrect horse battery staple", &ACCOUNT).map(|k| *k.expose()),
            Ok(*r.expose())
        );
        assert_eq!(
            open(&b2, "correct horse battery stapl3", &ACCOUNT).map(|_| ()),
            Err(AccountKeyError::WrongSecret)
        );
        let other = mdbn_wire::common::B16([8; 16]);
        assert_eq!(
            open(&b2, "correct horse battery staple", &other).map(|_| ()),
            Err(AccountKeyError::WrongSecret),
            "a bundle moved to another account does not open"
        );
        assert_eq!(check_recovery_key(&r, &b2), Ok(()));
        let mut e = TestEntropy::new(9);
        assert_eq!(
            check_recovery_key(&RecoveryKey::generate(&mut e), &b2),
            Err(AccountKeyError::WrongSecret)
        );
    }

    #[test]
    fn tampering_and_downgrades_fail() {
        let (_, b) = setup();
        let mut weaker = b.clone();
        weaker.kdf.t = MIN_T;
        assert_eq!(
            open(&weaker, "correct horse battery staple", &ACCOUNT).map(|_| ()),
            Err(AccountKeyError::WrongSecret),
            "the parameters are authenticated"
        );
        let mut swapped = b.clone();
        swapped.key_id = B32([1; 32]);
        assert_eq!(
            open(&swapped, "correct horse battery staple", &ACCOUNT).map(|_| ()),
            Err(AccountKeyError::WrongSecret)
        );
        for (m, t, p) in [
            (1024, 3, 1),
            (19_456, 1, 1),
            (1 << 20, 3, 1),
            (19_456, 50, 1),
            (19_456, 3, 9),
        ] {
            let mut hostile = b.clone();
            hostile.kdf.m_kib = m;
            hostile.kdf.t = t;
            hostile.kdf.p = p;
            assert_eq!(
                open(&hostile, "correct horse battery staple", &ACCOUNT).map(|_| ()),
                Err(AccountKeyError::Params),
                "bounded before any work: {m} {t} {p}"
            );
        }
        let mut bytes = b.to_bytes();
        bytes.push(0);
        assert_eq!(Bundle::from_bytes(&bytes), Err(AccountKeyError::Encoding));
        assert_eq!(
            Bundle::from_bytes(&[0u8; MAX_BUNDLE_BYTES + 1]),
            Err(AccountKeyError::Encoding)
        );
    }

    /// The shared vector (`conformance/crypto/account-key/`), computed independently.
    #[test]
    fn shared_vector() {
        let v: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../conformance/crypto/account-key/vector-1.json"
        ))
        .unwrap();
        let hexb = |k: &str| -> Vec<u8> {
            let s = v[k].as_str().unwrap();
            (0..s.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
                .collect()
        };
        let account = mdbn_wire::common::B16(
            hex_bytes(&v["account"].as_str().unwrap().replace('-', ""))
                .try_into()
                .unwrap(),
        );
        let r = RecoveryKey::from_bytes(hexb("secret").try_into().unwrap());
        let password = v["password"].as_str().unwrap();
        let bundle = Bundle::from_bytes(&hexb("bundle")).unwrap();
        assert_eq!(bundle.key_id.0.to_vec(), hexb("key_id"));
        assert_eq!(key_id(&r).0.to_vec(), hexb("key_id"));
        assert_eq!(
            open(&bundle, password, &account).unwrap().expose(),
            r.expose()
        );
        let k = &v["kdf"];
        let kdf = KdfParams {
            m_kib: k["m_kib"].as_u64().unwrap() as u32,
            t: k["t"].as_u64().unwrap() as u32,
            p: k["p"].as_u64().unwrap() as u32,
            salt: hex_bytes(k["salt"].as_str().unwrap()).try_into().unwrap(),
        };
        let resealed = seal_with(
            &r,
            password,
            &account,
            kdf,
            hexb("nonce").try_into().unwrap(),
        )
        .unwrap();
        assert_eq!(resealed.to_bytes(), hexb("bundle"));
        assert_eq!(
            aad(&account, &resealed.key_id, &kdf).0.to_vec(),
            hexb("aad")
        );
    }

    fn hex_bytes(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    /// Connect #635's `accountKeyRewrapDigest` for the same inputs.
    #[test]
    fn rewrap_digest_matches_the_control_plane() {
        let account = mdbn_wire::common::B16([
            0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x43, 0x33, 0x83, 0x33, 0x33, 0x33, 0x33, 0x33,
            0x33, 0x33,
        ]);
        let d = rewrap_digest(&account, &[6u8; 100], 3);
        let hex: String = d.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(
            hex,
            "74681c1a46f7d3aefc16a5ad665cc61da891bfcbfba11f02b713831a238f5155"
        );
        let mut e = TestEntropy::new(3);
        let r = RecoveryKey::generate(&mut e);
        assert_eq!(
            proof_signer(&r, &account).public(),
            proof_signer(&RecoveryKey::from_bytes(*r.expose()), &account).public()
        );
        assert_ne!(
            proof_signer(&r, &account).public(),
            proof_signer(&r, &ACCOUNT).public(),
            "bound to the account"
        );
    }

    #[test]
    fn short_passwords_are_refused() {
        let mut e = TestEntropy::new(2);
        let r = RecoveryKey::generate(&mut e);
        assert_eq!(
            seal(&r, "short pass", &ACCOUNT, &mut e).map(|_| ()),
            Err(AccountKeyError::WeakPassword)
        );
        assert_eq!(
            seal(&r, &"x".repeat(MAX_PASSWORD_BYTES + 1), &ACCOUNT, &mut e).map(|_| ()),
            Err(AccountKeyError::PasswordTooLong)
        );
    }
}
