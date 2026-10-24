//! The persisted replica identity: collection, replica and device IDs and the
//! device's key seeds. One file per replica state, created on first open and
//! reused afterwards, so the store's `replica.identity` always matches.
//!
//! The seeds only matter if the folder is ever adopted into sync (a local-only
//! replica seals nothing), but they are secrets all the same: the file is
//! created `0600` and lives in the host's private state dir, never among the
//! user's files.

use std::io::{Read, Write};
use std::path::Path;

use mdbn_core::host::Entropy;
use mdbn_replica::DeviceSecrets;
use mdbn_wire::common::{B16, Uuid};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::Error;

/// An identity file larger than this is refused.
pub const MAX_IDENTITY_BYTES: u64 = 4096;

/// Who this replica is.
#[derive(Clone)]
pub struct Identity {
    /// The collection ID.
    pub collection: Uuid,
    /// This replica's ID.
    pub replica_id: Uuid,
    /// This device's ID.
    pub device_id: Uuid,
    /// Device key seeds (signing, KEM).
    pub secrets: DeviceSecrets,
}

impl std::fmt::Debug for Identity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Identity")
            .field("collection", &hex(&self.collection.0))
            .field("replica_id", &hex(&self.replica_id.0))
            .field("device_id", &hex(&self.device_id.0))
            .finish_non_exhaustive()
    }
}

/// The on-disk form. The seed fields are `Zeroizing` so every decoded or
/// encoded copy is wiped on drop, including a partially deserialised one when
/// a later field fails. (Scope: the ordinary buffers this module owns; not
/// serde's or the allocator's transient copies.)
#[derive(Serialize, Deserialize)]
struct File {
    version: u32,
    collection: String,
    replica_id: String,
    device_id: String,
    sign_sk: Zeroizing<String>,
    kem_sk: Zeroizing<String>,
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn unhex<const N: usize>(s: &str, what: &str) -> Result<[u8; N], Error> {
    let bad = || Error::Identity(format!("`{what}` is not {N} bytes of hex"));
    let b = s.as_bytes();
    if b.len() != 2 * N || !b.iter().all(u8::is_ascii_hexdigit) {
        return Err(bad());
    }
    let nibble = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
    let mut out = [0u8; N];
    for (i, o) in out.iter_mut().enumerate() {
        *o = (nibble(b[2 * i]).ok_or_else(bad)? << 4) | nibble(b[2 * i + 1]).ok_or_else(bad)?;
    }
    Ok(out)
}

impl Identity {
    /// A fresh identity: new UUIDv7 IDs and random seeds.
    pub fn generate(now_ms: u64, entropy: &mut dyn Entropy) -> Identity {
        let mut sign_sk = [0u8; 32];
        let mut kem_sk = [0u8; 32];
        entropy.fill(&mut sign_sk);
        entropy.fill(&mut kem_sk);
        Identity {
            collection: B16(crate::host::uuid_v7(now_ms, entropy)),
            replica_id: B16(crate::host::uuid_v7(now_ms, entropy)),
            device_id: B16(crate::host::uuid_v7(now_ms, entropy)),
            secrets: DeviceSecrets { sign_sk, kem_sk },
        }
    }

    /// Read `path`: a regular file (never a symlink or reparse point), private
    /// to the user on Unix, at most [`MAX_IDENTITY_BYTES`].
    pub fn load(path: &Path) -> Result<Identity, Error> {
        if std::fs::symlink_metadata(path)?.file_type().is_symlink() {
            return Err(Error::Identity(format!("{} is a symlink", path.display())));
        }
        if !std::fs::symlink_metadata(path)?.file_type().is_file() {
            return Err(Error::Identity(format!(
                "{} is not a regular file",
                path.display()
            )));
        }
        let mut opts = std::fs::OpenOptions::new();
        opts.read(true);
        crate::host_lock::no_follow(&mut opts);
        let file = opts.open(path)?;
        let meta = file.metadata()?;
        if !meta.is_file() {
            return Err(Error::Identity(format!(
                "{} is not a regular file",
                path.display()
            )));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if meta.permissions().mode() & 0o077 != 0 {
                return Err(Error::Identity(format!(
                    "{} is readable by others (mode {:o}); it holds key seeds, make it 0600",
                    path.display(),
                    meta.permissions().mode() & 0o777
                )));
            }
        }
        // Read one byte past the limit: a file that grew after `stat` is refused.
        // The text is wiped on drop (it carries the seeds).
        let mut text = Zeroizing::new(String::new());
        file.take(MAX_IDENTITY_BYTES + 1)
            .read_to_string(&mut text)?;
        if text.len() as u64 > MAX_IDENTITY_BYTES {
            return Err(Error::Identity(format!("{} is too large", path.display())));
        }
        // The parse error is not echoed: the input holds seeds.
        let f: File = serde_json::from_str(&text).map_err(|_| {
            Error::Identity(format!("{} is not a valid identity file", path.display()))
        })?;
        if f.version != 1 {
            return Err(Error::Identity(format!(
                "{} is identity version {}; this build reads version 1",
                path.display(),
                f.version
            )));
        }
        Ok(Identity {
            collection: B16(unhex(&f.collection, "collection")?),
            replica_id: B16(unhex(&f.replica_id, "replica_id")?),
            device_id: B16(unhex(&f.device_id, "device_id")?),
            secrets: DeviceSecrets {
                sign_sk: unhex(&f.sign_sk, "sign_sk")?,
                kem_sk: unhex(&f.kem_sk, "kem_sk")?,
            },
        })
    }

    /// Write `path` (`0600`, atomic: temp file `sync_data`, rename, then a
    /// directory fsync on Unix). Durability limits: the directory barrier is
    /// plain `fsync` (not `F_FULLFSYNC` on macOS) and does not exist on Windows,
    /// so this is "survives a process crash", not a portable power-loss
    /// guarantee. An error means the identity may not be on disk.
    pub fn save(&self, path: &Path) -> Result<(), Error> {
        let f = File {
            version: 1,
            collection: hex(&self.collection.0),
            replica_id: hex(&self.replica_id.0),
            device_id: hex(&self.device_id.0),
            sign_sk: Zeroizing::new(hex(&self.secrets.sign_sk)),
            kem_sk: Zeroizing::new(hex(&self.secrets.kem_sk)),
        };
        let text = Zeroizing::new(serde_json::to_string_pretty(&f).map_err(std::io::Error::other)?);
        let tmp = path.with_extension("json.tmp");
        // Never follow a planted symlink: remove any stale temp file, then
        // `create_new`, which fails instead of opening an existing path.
        let _ = std::fs::remove_file(&tmp);
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        {
            let mut file = opts.open(&tmp)?;
            file.write_all(text.as_bytes())?;
            file.sync_data()?;
        }
        std::fs::rename(&tmp, path)?;
        // The identity must survive a crash: the directory barrier is required.
        if let Some(dir) = path.parent() {
            crate::host_lock::sync_dir(dir)?;
        }
        Ok(())
    }

    /// Load `path`, or generate and save a new identity when it does not exist.
    pub fn load_or_create(
        path: &Path,
        now_ms: u64,
        entropy: &mut dyn Entropy,
    ) -> Result<Identity, Error> {
        match std::fs::metadata(path) {
            Ok(_) => Identity::load(path),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let id = Identity::generate(now_ms, entropy);
                id.save(path)?;
                Ok(id)
            }
            Err(e) => Err(Error::Io(e)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_is_stable() {
        let dir = std::env::temp_dir().join(format!("mdbn-identity-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("identity.json");
        let a = Identity::load_or_create(&p, 1, &mut crate::OsEntropy).unwrap();
        let b = Identity::load_or_create(&p, 2, &mut crate::OsEntropy).unwrap();
        assert_eq!(a.collection, b.collection);
        assert_eq!(a.replica_id, b.replica_id);
        assert_eq!(a.secrets.sign_sk, b.secrets.sign_sk);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&p).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(all(test, unix))]
mod regular_file_tests {
    use super::*;

    #[test]
    fn a_fifo_is_refused_before_open() {
        let dir = std::env::temp_dir().join(format!("mdbn-identity-fifo-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("identity.json");
        let ok = std::process::Command::new("mkfifo")
            .arg(&p)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        assert!(ok, "mkfifo");
        // Opening a FIFO for reading would block forever; the pre-open check refuses it.
        assert!(matches!(Identity::load(&p), Err(Error::Identity(_))));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod unhex_tests {
    use super::*;

    #[test]
    fn malformed_hex_is_an_error_not_a_panic() {
        assert!(unhex::<2>("zz11", "x").is_err());
        // "é11" is 4 bytes (é is two), so it passes the length guard and must be
        // rejected by the ASCII filter, not by a char-boundary panic.
        assert_eq!("é11".len(), 4);
        assert!(unhex::<2>("é11", "x").is_err());
        assert!(unhex::<2>("abc", "x").is_err());
        assert_eq!(unhex::<2>("0aFf", "x").unwrap(), [0x0a, 0xff]);
    }
}
