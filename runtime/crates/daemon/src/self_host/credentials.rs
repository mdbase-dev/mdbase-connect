use std::fs::{self, DirBuilder, OpenOptions};
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use crate::fsutil::{euid, verify_owner_only};
use mdbn_local_host::host::{OsEntropy, now_ms, uuid_v7};
use mdbn_wire::common::{B16, Uuid};
use mdbn_wire::render::hex;
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, params};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
pub(super) mod calendar;
use zeroize::Zeroizing;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const TTL_MS: u64 = 180_000;
const ATTEMPTS: u8 = 5;

pub(super) struct Credentials {
    connection: Mutex<Connection>,
    path: PathBuf,
    identity: (u64, u64),
    pub(super) guided_feedback: bool,
}

fn file_identity(path: &Path) -> io::Result<(u64, u64)> {
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_file() || meta.uid() != euid() || meta.mode() & 0o7777 != 0o600 || meta.nlink() != 1
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "unsafe credential database",
        ));
    }
    Ok((meta.dev(), meta.ino()))
}

fn window_current(opened: u64) -> bool {
    now_ms().checked_sub(opened).is_some_and(|age| age < TTL_MS)
}

// Keep printable ASCII (including debug's three escaped punctuation characters)
// and printable Unicode sequences, including accents composed of multiple scalars.
// Reject escapes for terminal controls, bidi overrides and invisible separators.
fn valid_label(label: &str) -> bool {
    !label.trim().is_empty()
        && label.len() <= 80
        && label
            .split(['\\', '"', '\''])
            .all(|part| part.escape_debug().eq(part.chars()))
}

impl Credentials {
    pub fn open(dir: &Path, root: &Path, serving: Option<(Uuid, &[String])>) -> Result<Self> {
        let name = dir
            .file_name()
            .ok_or("expected a dedicated authorization directory")?;
        let parent = dir
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."))
            .canonicalize()?;
        if parent.join(name).starts_with(root) {
            return Err("authorization directory must be outside the collection".into());
        }
        verify_owner_only(&parent)?;
        let dir = parent.join(name);
        if serving.is_some() {
            match DirBuilder::new().mode(0o700).create(&dir) {
                Err(err) if err.kind() == io::ErrorKind::AlreadyExists => (),
                result => result?,
            }
        }
        let meta = fs::symlink_metadata(&dir)?;
        if !meta.is_dir() || meta.uid() != euid() || meta.mode() & 0o7777 != 0o700 {
            return Err("authorization directory must be owned by this user and mode 0700".into());
        }
        let path = dir.join("credentials.sqlite");
        if serving.is_some() {
            match OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(&path)
            {
                Err(err) if err.kind() == io::ErrorKind::AlreadyExists => (),
                result => {
                    result?;
                }
            }
        }
        let identity = file_identity(&path)?;
        let mut db = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        db.pragma_update(None, "foreign_keys", true)?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let root = root.as_os_str().as_bytes();
        let version: u32 = tx.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version != 1 {
            let empty: bool = tx.query_row(
                "SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema)",
                [],
                |row| row.get(0),
            )?;
            let Some((collection, _)) = serving.filter(|_| version == 0 && empty) else {
                return Err(format!(
                    "unsupported pairing state in {}; move it aside and pair again",
                    dir.display()
                )
                .into());
            };
            tx.execute_batch("CREATE TABLE scope(singleton INTEGER PRIMARY KEY CHECK(singleton=1), root BLOB NOT NULL, collection BLOB NOT NULL);
                CREATE TABLE allowed(origin TEXT PRIMARY KEY NOT NULL);
                CREATE TABLE pairing(origin TEXT PRIMARY KEY NOT NULL REFERENCES allowed ON DELETE CASCADE, digest BLOB UNIQUE NOT NULL, opened INTEGER NOT NULL, attempts INTEGER NOT NULL, label TEXT NOT NULL);
                CREATE TABLE browser(owner BLOB PRIMARY KEY NOT NULL, origin TEXT NOT NULL REFERENCES allowed ON DELETE CASCADE, digest BLOB UNIQUE NOT NULL, label TEXT NOT NULL, UNIQUE(origin,label));
                CREATE TABLE webtransport_calendar(singleton INTEGER PRIMARY KEY CHECK(singleton=1), first INTEGER NOT NULL, pins BLOB NOT NULL);
                CREATE TABLE webtransport_leaf(slot INTEGER PRIMARY KEY, cert BLOB NOT NULL, key BLOB NOT NULL);
                PRAGMA user_version=1;")?;
            tx.execute(
                "INSERT INTO scope VALUES(1,?1,?2)",
                params![root, collection.0],
            )?;
        }
        let bound: [u8; 16] = tx
            .query_row(
                "SELECT collection FROM scope WHERE root=?1",
                [root],
                |row| row.get(0),
            )
            .optional()?
            .ok_or("authorization directory bound to another collection")?;
        if let Some((collection, origins)) = serving {
            if collection.0 != bound {
                return Err("collection identity changed".into());
            }
            let previous = tx
                .prepare("SELECT origin FROM allowed")?
                .query_map([], |row| row.get(0))?
                .collect::<rusqlite::Result<Vec<String>>>()?;
            for origin in previous.iter().filter(|origin| !origins.contains(origin)) {
                tx.execute("DELETE FROM allowed WHERE origin=?1", [origin])?;
                // The cascade is deliberate, but never silent: the operator may have
                // dropped an --origin by mistake.
                eprintln!("{origin} is no longer served. Its paired browsers are revoked.");
            }
            for origin in origins {
                tx.execute(
                    "INSERT INTO allowed VALUES(?1) ON CONFLICT DO NOTHING",
                    [origin],
                )?;
            }
        }
        tx.commit()?;
        Ok(Self {
            connection: Mutex::new(db),
            path,
            identity,
            guided_feedback: false,
        })
    }

    fn db(&self) -> Result<MutexGuard<'_, Connection>> {
        if file_identity(&self.path)? != self.identity {
            return Err("credential database was replaced".into());
        }
        self.connection
            .lock()
            .map_err(|_| "credential database unavailable".into())
    }

    pub fn pair(&self, origin: &str, label: &str) -> Result<String> {
        if !valid_label(label) {
            return Err(io::Error::new(io::ErrorKind::InvalidInput,
                "Use a visible browser label of up to 80 UTF-8 bytes, without control or formatting characters.").into());
        }
        let code = loop {
            let value = getrandom::u32().map_err(|_| "OS entropy unavailable")?;
            if value < u32::MAX - u32::MAX % 100_000_000 {
                break format!("{:08}", value % 100_000_000);
            }
        };
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = tx.execute(
            "INSERT INTO pairing SELECT origin,?2,?3,?4,?5 FROM allowed WHERE origin=?1
             AND NOT EXISTS(SELECT 1 FROM browser WHERE origin=?1 AND label=?5)
             ON CONFLICT(origin) DO UPDATE SET digest=excluded.digest, opened=excluded.opened, attempts=excluded.attempts, label=excluded.label",
            params![origin, Sha256::digest(code.as_bytes()).as_slice(), now_ms(), ATTEMPTS, label],
        )?;
        if changed != 1 {
            let enabled: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM allowed WHERE origin=?1)",
                [origin],
                |r| r.get(0),
            )?;
            if !enabled {
                return Err("This app site is not enabled. Select an approved HTTPS site.".into());
            }
            return Err(io::Error::new(io::ErrorKind::AlreadyExists,
                format!("A browser named {label:?} already has access at {origin}. Choose a different label, or revoke the old browser first.")).into());
        }
        tx.commit()?;
        Ok(code)
    }

    pub fn redeem(
        &self,
        origin: &str,
        code: &[u8],
        window: Option<&calendar::Pins>,
    ) -> Result<Option<String>> {
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let pending = tx
            .query_row(
                "SELECT digest,opened,label,attempts FROM pairing WHERE origin=?1 AND attempts>0",
                [origin],
                |row| {
                    Ok((
                        row.get::<_, [u8; 32]>(0)?,
                        row.get::<_, u64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, u8>(3)?,
                    ))
                },
            )
            .optional()?;
        let Some((digest, opened, label, attempts)) = pending else {
            return Ok(None);
        };
        let current = window_current(opened);
        let matches = current
            && code.len() == 8
            && code.iter().all(u8::is_ascii_digit)
            && bool::from(digest.ct_eq(&Sha256::digest(code)));
        if !matches && current {
            tx.execute(
                "UPDATE pairing SET attempts=attempts-1 WHERE origin=?1",
                [origin],
            )?;
        } else {
            tx.execute("DELETE FROM pairing WHERE origin=?1", [origin])?;
        }
        let mut issued = None;
        if matches {
            if let Some(window) = window {
                window.verify_for_pairing(&tx, calendar::current_slot())?;
            }
            let mut random = Zeroizing::new([0u8; 32]);
            getrandom::fill(&mut *random).map_err(|_| "OS entropy unavailable")?;
            let token = hex(&*random);
            tx.execute(
                "INSERT INTO browser VALUES(?1,?2,?3,?4)",
                params![
                    uuid_v7(now_ms(), &mut OsEntropy),
                    origin,
                    Sha256::digest(token.as_bytes()).as_slice(),
                    label
                ],
            )?;
            issued = Some(token);
        }
        tx.commit()?;
        drop(db);
        // At most one message per consumed attempt. Traffic outside an operator-
        // opened window is silent, and the remote candidate is never displayed.
        if self.guided_feedback {
            if matches {
                println!("\nPaired {label:?} at {origin}. If this was unexpected, choose revoke.");
            } else if !current {
                println!(
                    "\nPairing expired for {label:?} at {origin}. Choose pair for a new code."
                );
            } else if attempts == 1 {
                println!(
                    "\nNo attempts left for {label:?} at {origin}. Choose pair for a new code."
                );
            } else {
                println!(
                    "\nIncorrect code for {label:?} at {origin}. Attempts left: {}.",
                    attempts - 1
                );
            }
        }
        Ok(issued)
    }

    pub fn authenticate(&self, origin: &str, token: &[u8]) -> Result<Option<Uuid>> {
        if token.len() != 64
            || !token
                .iter()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
        {
            return Ok(None);
        }
        Ok(self
            .db()?
            .query_row(
                "SELECT owner FROM browser WHERE origin=?1 AND digest=?2",
                params![origin, Sha256::digest(token).as_slice()],
                |row| Ok(B16(row.get(0)?)),
            )
            .optional()?)
    }

    pub fn live(&self, owner: Uuid) -> bool {
        self.browser_exists(owner).unwrap_or(false)
    }

    pub(super) fn browser_exists(&self, owner: Uuid) -> Result<bool> {
        Ok(self.db()?.query_row(
            "SELECT EXISTS(SELECT 1 FROM browser WHERE owner=?1)",
            [owner.0],
            |row| row.get(0),
        )?)
    }

    pub(super) fn origins(&self) -> Result<Vec<String>> {
        let db = self.db()?;
        let mut query = db.prepare("SELECT origin FROM allowed ORDER BY origin")?;
        Ok(query
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?)
    }

    pub(super) fn remove_site(&self, origin: &str) -> Result<()> {
        // Foreign keys cascade to this exact origin's grants and pairing window.
        self.db()?
            .execute("DELETE FROM allowed WHERE origin=?1", [origin])?;
        Ok(())
    }

    pub(super) fn window_status(&self, origin: &str) -> Result<Option<String>> {
        Ok(self
            .db()?
            .query_row(
                "SELECT label,opened,attempts FROM pairing WHERE origin=?1",
                [origin],
                |row| {
                    let label: String = row.get(0)?;
                    let opened = row.get(1)?;
                    let attempts: u8 = row.get(2)?;
                    Ok(if attempts == 0 {
                        format!("Pairing closed for {label:?}: no attempts left.")
                    } else if window_current(opened) {
                        format!("Waiting for {label:?}. Attempts left: {attempts}.")
                    } else {
                        format!("Pairing expired for {label:?}.")
                    })
                },
            )
            .optional()?)
    }

    pub fn list(&self, origin: &str) -> Result<Vec<(String, String)>> {
        let db = self.db()?;
        let mut query = db.prepare(
            "SELECT lower(hex(owner)), label FROM browser WHERE origin=?1 ORDER BY owner",
        )?;
        Ok(query
            .query_map([origin], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?)
    }

    pub fn revoke(&self, origin: &str, owner: &str) -> Result<()> {
        if self.db()?.execute(
            "DELETE FROM browser WHERE origin=?1 AND lower(hex(owner))=?2",
            [origin, owner],
        )? != 1
        {
            return Err("unknown browser ID".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_status_uses_the_same_attempt_and_time_bounds_as_redemption() {
        use std::os::unix::fs::PermissionsExt;
        let home = crate::testutil::TestDir::new("pairing-status");
        fs::set_permissions(home.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let site = "https://status.invalid";
        let store = Credentials::open(
            &home.path().join("auth"),
            &home.path().join("notes"),
            Some((B16([1; 16]), &[site.to_owned()])),
        )
        .unwrap();
        assert!(store.window_status(site).unwrap().is_none());
        let code = store.pair(site, "Téléphone").unwrap();
        for left in (1..=ATTEMPTS).rev() {
            let status = store.window_status(site).unwrap().unwrap();
            assert!(
                status.contains("Téléphone")
                    && status.ends_with(&format!("Attempts left: {left}."))
            );
            assert!(store.redeem(site, b"invalid", None).unwrap().is_none());
        }
        assert!(
            store
                .window_status(site)
                .unwrap()
                .unwrap()
                .contains("no attempts left")
        );
        assert!(store.redeem(site, code.as_bytes(), None).unwrap().is_none());
        let code = store.pair(site, "Fresh").unwrap();
        store
            .db()
            .unwrap()
            .execute("UPDATE pairing SET opened=opened-?1", [TTL_MS])
            .unwrap();
        assert!(
            store
                .window_status(site)
                .unwrap()
                .unwrap()
                .contains("expired")
        );
        assert!(store.redeem(site, code.as_bytes(), None).unwrap().is_none());
        assert!(store.window_status(site).unwrap().is_none());
    }

    #[test]
    fn unicode_labels_keep_the_byte_limit_and_terminal_boundaries() {
        for valid in [
            "Téléphone",
            "Te\u{301}le\u{301}phone",
            "東京 📱",
            "Kid's tablet",
            "{}",
            &"é".repeat(40),
        ] {
            assert!(valid_label(valid));
        }
        for invalid in [
            "",
            "  ",
            "A\tB",
            "A\nB",
            "A\x1b[31mB",
            "A\u{2028}B",
            "A\u{2029}B",
            "A\u{202e}B",
            "A\u{2066}B",
            "A\u{200b}B",
            &"é".repeat(41),
        ] {
            assert!(!valid_label(invalid));
        }
    }
}
