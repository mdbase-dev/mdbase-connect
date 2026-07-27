use crate::ConnectError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use tempfile::NamedTempFile;

const SERVICE: &str = "dev.mdbase.connect";

#[derive(Debug, Clone)]
pub struct SystemSecretStore {
    profile: String,
    backend: SecretBackend,
}

#[derive(Debug, Clone)]
enum SecretBackend {
    System,
    InsecureTestFile(PathBuf),
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct TestSecrets {
    values: BTreeMap<String, String>,
}

impl SystemSecretStore {
    pub fn new(state_dir: &Path) -> Self {
        let digest = Sha256::digest(state_dir.to_string_lossy().as_bytes());
        Self {
            profile: digest[..12]
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect(),
            backend: if std::env::var("MDBASE_CONNECT_ENV").as_deref() == Ok("test")
                && std::env::var("MDBASE_CONNECT_SECRET_BACKEND").as_deref()
                    == Ok("insecure-test-file")
            {
                SecretBackend::InsecureTestFile(state_dir.join("test-secrets.json"))
            } else {
                SecretBackend::System
            },
        }
    }

    #[cfg(test)]
    pub(crate) fn insecure_test(state_dir: &Path) -> Self {
        let mut store = Self::new(state_dir);
        store.backend = SecretBackend::InsecureTestFile(state_dir.join("test-secrets.json"));
        store
    }

    pub fn connector_token(&self) -> Result<Option<String>, ConnectError> {
        self.get("connector")
    }

    pub fn set_connector_token(&self, token: &str) -> Result<(), ConnectError> {
        Self::validate_connector_token(token)?;
        self.set("connector", token)
    }

    pub fn validate_connector_token(token: &str) -> Result<(), ConnectError> {
        if valid_secret(token, "con_") {
            Ok(())
        } else {
            Err(ConnectError::Settings(
                "Connector credential is invalid.".to_string(),
            ))
        }
    }

    pub fn clear_connector_token(&self) -> Result<(), ConnectError> {
        self.delete("connector")
    }

    pub fn pending_connector_token(&self) -> Result<Option<String>, ConnectError> {
        self.get("connector:pending")
    }

    pub fn set_pending_connector_token(&self, token: &str) -> Result<(), ConnectError> {
        Self::validate_connector_token(token)?;
        self.set("connector:pending", token)
    }

    pub fn clear_pending_connector_token(&self) -> Result<(), ConnectError> {
        self.delete("connector:pending")
    }

    pub fn mirror_credentials(
        &self,
        replica_id: uuid::Uuid,
    ) -> Result<Option<String>, ConnectError> {
        self.get(&format!("mirror:{replica_id}"))
    }

    pub fn set_mirror_credentials(
        &self,
        replica_id: uuid::Uuid,
        credentials_json: &str,
    ) -> Result<(), ConnectError> {
        if credentials_json.trim().is_empty() {
            return Err(ConnectError::Settings(
                "Mirror credentials are empty.".to_string(),
            ));
        }
        self.set(&format!("mirror:{replica_id}"), credentials_json)
    }

    pub fn clear_mirror_credentials(&self, replica_id: uuid::Uuid) -> Result<(), ConnectError> {
        self.delete(&format!("mirror:{replica_id}"))
    }

    fn entry(&self, name: &str) -> Result<keyring::Entry, ConnectError> {
        keyring::Entry::new(SERVICE, &format!("{}:{name}", self.profile))
            .map_err(|error| secret_error("open", error))
    }

    fn get(&self, name: &str) -> Result<Option<String>, ConnectError> {
        if let SecretBackend::InsecureTestFile(path) = &self.backend {
            return Ok(read_test_secrets(path)?.values.get(name).cloned());
        }
        match self.entry(name)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(secret_error("read", error)),
        }
    }

    fn set(&self, name: &str, secret: &str) -> Result<(), ConnectError> {
        if let SecretBackend::InsecureTestFile(path) = &self.backend {
            let mut secrets = read_test_secrets(path)?;
            secrets.values.insert(name.to_string(), secret.to_string());
            return write_test_secrets(path, &secrets);
        }
        self.entry(name)?
            .set_password(secret)
            .map_err(|error| secret_error("store", error))
    }

    fn delete(&self, name: &str) -> Result<(), ConnectError> {
        if let SecretBackend::InsecureTestFile(path) = &self.backend {
            let mut secrets = read_test_secrets(path)?;
            secrets.values.remove(name);
            return write_test_secrets(path, &secrets);
        }
        match self.entry(name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(secret_error("delete", error)),
        }
    }
}

fn read_test_secrets(path: &Path) -> Result<TestSecrets, ConnectError> {
    let value = match std::fs::read(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(TestSecrets::default());
        }
        Err(error) => return Err(ConnectError::Io(error)),
    };
    serde_json::from_slice(&value).map_err(|error| {
        ConnectError::CredentialStore(format!("Test secret file is invalid: {error}"))
    })
}

fn write_test_secrets(path: &Path, secrets: &TestSecrets) -> Result<(), ConnectError> {
    let parent = path.parent().ok_or_else(|| {
        ConnectError::CredentialStore("Test secret file path is invalid.".to_string())
    })?;
    std::fs::create_dir_all(parent)?;
    let mut temporary = NamedTempFile::new_in(parent)?;
    temporary.write_all(&serde_json::to_vec_pretty(secrets)?)?;
    temporary.as_file().sync_all()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    temporary.persist(path).map_err(|error| error.error)?;
    Ok(())
}

fn valid_secret(secret: &str, prefix: &str) -> bool {
    secret.starts_with(prefix) && secret.len() >= 24 && !secret.chars().any(char::is_whitespace)
}

fn secret_error(action: &str, error: keyring::Error) -> ConnectError {
    ConnectError::CredentialStore(format!(
        "Could not {action} the Connect credential in the operating-system credential store: {error}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profiles_are_stable_and_distinct() {
        let first = SystemSecretStore::new(Path::new("/state/one"));
        let same = SystemSecretStore::new(Path::new("/state/one"));
        let second = SystemSecretStore::new(Path::new("/state/two"));
        assert_eq!(first.profile, same.profile);
        assert_ne!(first.profile, second.profile);
        assert!(!first.profile.contains('/'));
    }

    #[test]
    fn connector_tokens_are_validated_before_keyring_access() {
        let store = SystemSecretStore::new(Path::new("/state/test"));
        let error = store.set_connector_token("not-a-token").unwrap_err();
        assert_eq!(error.code(), "invalid_config");
        assert!(
            SystemSecretStore::validate_connector_token("con_123456789012345678901234").is_ok()
        );
        assert!(
            SystemSecretStore::validate_connector_token("con_12345678901234567890 bad").is_err()
        );
    }
}
