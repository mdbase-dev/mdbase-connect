use super::*;
use serde::Serialize;
use std::collections::HashSet;
use std::fs::File;

pub(super) const RECEIPT_REFERENCE_PREFIX: &str = "receipt-v1:sha256:";

#[derive(Clone, Debug, Default, Serialize)]
pub struct AuthorityReceiptDiagnostics {
    pub referenced_count: u64,
    pub referenced_bytes: u64,
    pub stored_count: u64,
    pub stored_bytes: u64,
    pub orphaned_count: u64,
    pub orphaned_bytes: u64,
}

pub(super) fn receipt_diagnostics(
    state_dir: &Path,
    authority: &Connection,
) -> Result<AuthorityReceiptDiagnostics, ConnectError> {
    let mut authority_references = HashSet::new();
    let mut statement = authority.prepare(
        "SELECT final_receipt FROM mutation_journal WHERE final_receipt IS NOT NULL
         UNION ALL
         SELECT json_extract(result_metadata, '$.response_receipt')
         FROM mutation_journal
         WHERE json_extract(result_metadata, '$.response_receipt') IS NOT NULL",
    )?;
    for reference in statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?
    {
        if reference.starts_with(RECEIPT_REFERENCE_PREFIX) {
            authority_references.insert(reference);
        }
    }
    let mut legacy_read_references = HashSet::new();
    let mut statement = authority.prepare(
        "SELECT response_receipt FROM grant_crypto_requests
         WHERE response_receipt IS NOT NULL",
    )?;
    for reference in statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?
    {
        if reference.starts_with(RECEIPT_REFERENCE_PREFIX) {
            legacy_read_references.insert(reference);
        }
    }
    let referenced_bytes = authority_references
        .iter()
        .chain(legacy_read_references.iter())
        .try_fold(0_u64, |total, reference| {
            let (_, bytes) = parse_receipt_reference(reference).ok_or_else(|| {
                ConnectError::AuthorityReceipt {
                    detail: "authority store contains an invalid receipt reference".to_string(),
                }
            })?;
            Ok::<_, ConnectError>(total.saturating_add(bytes))
        })?;

    let mut result = AuthorityReceiptDiagnostics {
        referenced_count: authority_references
            .len()
            .saturating_add(legacy_read_references.len()) as u64,
        referenced_bytes,
        ..AuthorityReceiptDiagnostics::default()
    };
    scan_receipt_root(
        &state_dir.join("authority-receipts"),
        &authority_references,
        &mut result,
    )?;
    scan_receipt_root(
        &state_dir.join("authority-legacy-read-receipts"),
        &legacy_read_references,
        &mut result,
    )?;
    Ok(result)
}

fn scan_receipt_root(
    root: &Path,
    references: &HashSet<String>,
    result: &mut AuthorityReceiptDiagnostics,
) -> Result<(), ConnectError> {
    let Ok(shards) = fs::read_dir(root) else {
        return Ok(());
    };
    for shard in shards {
        let shard = shard?;
        if !shard.file_type()?.is_dir() {
            continue;
        }
        let prefix = shard.file_name().to_string_lossy().into_owned();
        for entry in fs::read_dir(shard.path())? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let Some(suffix) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.strip_suffix(".receipt"))
                .map(str::to_owned)
            else {
                continue;
            };
            let bytes = entry.metadata()?.len();
            let reference = receipt_reference(&format!("{prefix}{suffix}"), bytes);
            result.stored_count = result.stored_count.saturating_add(1);
            result.stored_bytes = result.stored_bytes.saturating_add(bytes);
            if !references.contains(&reference) {
                result.orphaned_count = result.orphaned_count.saturating_add(1);
                result.orphaned_bytes = result.orphaned_bytes.saturating_add(bytes);
            }
        }
    }
    Ok(())
}

#[derive(Debug)]
pub(super) struct ReceiptStore {
    root: PathBuf,
}

impl ReceiptStore {
    pub(super) fn open(root: PathBuf) -> Result<Self, ConnectError> {
        ensure_private_state_dir(&root)?;
        Ok(Self { root })
    }

    pub(super) fn root(&self) -> &Path {
        &self.root
    }

    pub(super) fn store(&self, receipt: &str) -> Result<String, ConnectError> {
        self.store_with_hook(receipt, &mut |_| Ok(()))
    }

    fn store_with_hook(
        &self,
        receipt: &str,
        hook: &mut dyn FnMut(&'static str) -> Result<(), ConnectError>,
    ) -> Result<String, ConnectError> {
        let bytes = receipt.as_bytes();
        let digest = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let shard = self.root.join(&digest[..2]);
        ensure_private_state_dir(&shard)?;
        let destination = shard.join(format!("{}.receipt", &digest[2..]));

        if destination.exists() {
            verify_receipt_file(&destination, &digest, bytes.len() as u64)?;
            sync_directory(&shard)?;
            return Ok(receipt_reference(&digest, bytes.len() as u64));
        }

        let mut temporary = NamedTempFile::new_in(&shard)?;
        temporary.as_file_mut().write_all(bytes)?;
        hook("after_receipt_write")?;
        temporary.as_file().sync_all()?;
        hook("after_receipt_sync")?;
        match temporary.persist_noclobber(&destination) {
            Ok(_) => {
                hook("after_receipt_publish")?;
                sync_directory(&shard)?;
                hook("after_receipt_directory_sync")?;
            }
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                verify_receipt_file(&destination, &digest, bytes.len() as u64)?;
                sync_directory(&shard)?;
            }
            Err(error) => return Err(ConnectError::Io(error.error)),
        }
        Ok(receipt_reference(&digest, bytes.len() as u64))
    }

    pub(super) fn load(&self, reference: &str) -> Result<String, ConnectError> {
        let Some((digest, expected_size)) = parse_receipt_reference(reference) else {
            if reference.starts_with("receipt-v1:") {
                return Err(ConnectError::AuthorityReceipt {
                    detail: "receipt reference is malformed".to_string(),
                });
            }
            // A beta.55 journal may still be observed while a migration is being
            // resumed. Treat an inline value as its own exact receipt; every new
            // write uses a receipt reference.
            return Ok(reference.to_string());
        };
        let path = self
            .root
            .join(&digest[..2])
            .join(format!("{}.receipt", &digest[2..]));
        verify_receipt_file(&path, digest, expected_size)?;
        let encoded = fs::read(path)?;
        String::from_utf8(encoded).map_err(|error| ConnectError::AuthorityReceipt {
            detail: format!("receipt is not UTF-8: {error}"),
        })
    }

    pub(super) fn remove(&self, reference: &str) -> Result<(), ConnectError> {
        let Some((digest, _)) = parse_receipt_reference(reference) else {
            return Err(ConnectError::AuthorityReceipt {
                detail: "receipt reference is malformed".to_string(),
            });
        };
        let shard = self.root.join(&digest[..2]);
        let path = shard.join(format!("{}.receipt", &digest[2..]));
        match fs::remove_file(path) {
            Ok(()) => sync_directory(&shard),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(ConnectError::Io(error)),
        }
    }

    pub(super) fn externalize_metadata(&self, value: &Value) -> Result<Value, ConnectError> {
        let mut value = value.clone();
        let Some(object) = value.as_object_mut() else {
            return Ok(value);
        };
        let Some(response) = object.get("response_envelope") else {
            return Ok(value);
        };
        let Some(response) = response.as_str().map(str::to_owned) else {
            return Err(ConnectError::AuthorityReceipt {
                detail: "mutation response envelope must be a string".to_string(),
            });
        };
        object.remove("response_envelope");
        object.insert(
            "response_receipt".to_string(),
            Value::String(self.store(&response)?),
        );
        Ok(value)
    }

    pub(super) fn response_from_metadata(
        &self,
        value: &Value,
    ) -> Result<Option<String>, ConnectError> {
        if let Some(response) = value.get("response_envelope").and_then(Value::as_str) {
            return Ok(Some(response.to_string()));
        }
        value
            .get("response_receipt")
            .and_then(Value::as_str)
            .map(|reference| self.load(reference))
            .transpose()
    }
}

pub(super) fn receipt_reference(digest: &str, size: u64) -> String {
    format!("{RECEIPT_REFERENCE_PREFIX}{digest}:{size}")
}

pub(super) fn parse_receipt_reference(reference: &str) -> Option<(&str, u64)> {
    let encoded = reference.strip_prefix(RECEIPT_REFERENCE_PREFIX)?;
    let (digest, size) = encoded.rsplit_once(':')?;
    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    Some((digest, size.parse().ok()?))
}

fn verify_receipt_file(
    path: &Path,
    expected_digest: &str,
    expected_size: u64,
) -> Result<(), ConnectError> {
    let bytes = fs::read(path).map_err(|error| ConnectError::AuthorityReceipt {
        detail: format!("could not read {}: {error}", path.display()),
    })?;
    if bytes.len() as u64 != expected_size {
        return Err(ConnectError::AuthorityReceipt {
            detail: format!(
                "{} has {} bytes; expected {expected_size}",
                path.display(),
                bytes.len()
            ),
        });
    }
    let digest = Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    if digest != expected_digest {
        return Err(ConnectError::AuthorityReceipt {
            detail: format!("{} failed its SHA-256 check", path.display()),
        });
    }
    Ok(())
}

fn sync_directory(path: &Path) -> Result<(), ConnectError> {
    #[cfg(unix)]
    File::open(path)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn receipts_are_content_addressed_and_verified() {
        let directory = tempfile::tempdir().unwrap();
        let store = ReceiptStore::open(directory.path().join("receipts")).unwrap();
        let reference = store.store("encrypted-response").unwrap();
        assert!(reference.starts_with(RECEIPT_REFERENCE_PREFIX));
        assert_eq!(store.store("encrypted-response").unwrap(), reference);
        assert_eq!(store.load(&reference).unwrap(), "encrypted-response");
        assert!(matches!(
            store.load("receipt-v1:sha256:not-a-digest:4"),
            Err(ConnectError::AuthorityReceipt { .. })
        ));

        let (digest, _) = parse_receipt_reference(&reference).unwrap();
        let path = store
            .root()
            .join(&digest[..2])
            .join(format!("{}.receipt", &digest[2..]));
        fs::write(path, "tampered").unwrap();
        assert!(matches!(
            store.load(&reference),
            Err(ConnectError::AuthorityReceipt { .. })
        ));
    }

    #[test]
    fn response_metadata_externalizes_and_recovers_exactly() {
        let directory = tempfile::tempdir().unwrap();
        let store = ReceiptStore::open(directory.path().join("receipts")).unwrap();
        let metadata = serde_json::json!({ "response_envelope": "large-envelope" });
        let externalized = store.externalize_metadata(&metadata).unwrap();
        assert!(externalized.get("response_envelope").is_none());
        assert_eq!(
            store
                .response_from_metadata(&externalized)
                .unwrap()
                .as_deref(),
            Some("large-envelope")
        );
        assert!(matches!(
            store.externalize_metadata(&serde_json::json!({ "response_envelope": 42 })),
            Err(ConnectError::AuthorityReceipt { .. })
        ));
    }

    #[test]
    fn every_receipt_publication_phase_recovers_without_changing_identity() {
        for fault in [
            "after_receipt_write",
            "after_receipt_sync",
            "after_receipt_publish",
            "after_receipt_directory_sync",
        ] {
            let directory = tempfile::tempdir().unwrap();
            let store = ReceiptStore::open(directory.path().join("receipts")).unwrap();
            let first = store.store_with_hook("exact-response", &mut |point| {
                if point == fault {
                    Err(ConnectError::AuthorityReceipt {
                        detail: format!("injected process death at {point}"),
                    })
                } else {
                    Ok(())
                }
            });
            assert!(first.is_err(), "fault {fault}");
            let reference = store.store("exact-response").unwrap();
            assert_eq!(store.load(&reference).unwrap(), "exact-response");
            assert_eq!(store.store("exact-response").unwrap(), reference);
        }
    }
}
