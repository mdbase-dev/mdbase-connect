use crate::{registry::ensure_private_state_dir, secrets::SystemSecretStore, ConnectError};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tempfile::NamedTempFile;
use url::Url;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CloudConfiguration {
    pub version: u32,
    pub server_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StagedCloudConfiguration {
    version: u32,
    configuration: CloudConfiguration,
    connector_token_digest: String,
}

impl CloudConfiguration {
    pub fn new(server_url: &str) -> Result<Self, ConnectError> {
        let server_url = canonical_server_url(server_url)?;
        Ok(Self {
            version: 1,
            server_url,
        })
    }
}

pub fn load_cloud_configuration(
    state_dir: &Path,
) -> Result<Option<CloudConfiguration>, ConnectError> {
    load_configuration_file(&configuration_path(state_dir))
}

pub fn configure_cloud(
    state_dir: &Path,
    configuration: &CloudConfiguration,
    connector_token: &str,
) -> Result<(), ConnectError> {
    configure_cloud_with_store(
        state_dir,
        configuration,
        connector_token,
        &SystemSecretStore::new(state_dir),
    )
}

fn configure_cloud_with_store(
    state_dir: &Path,
    configuration: &CloudConfiguration,
    connector_token: &str,
    secrets: &SystemSecretStore,
) -> Result<(), ConnectError> {
    let validated = CloudConfiguration::new(&configuration.server_url)?;
    SystemSecretStore::validate_connector_token(connector_token)?;
    ensure_private_state_dir(state_dir)?;
    secrets.set_pending_connector_token(connector_token)?;
    write_serialized_file(
        &pending_configuration_path(state_dir),
        &StagedCloudConfiguration {
            version: 1,
            configuration: validated,
            connector_token_digest: credential_digest(connector_token),
        },
    )?;
    recover_staged_cloud_configuration_with_store(state_dir, secrets)
}

pub fn recover_staged_cloud_configuration(state_dir: &Path) -> Result<(), ConnectError> {
    recover_staged_cloud_configuration_with_store(state_dir, &SystemSecretStore::new(state_dir))
}

fn recover_staged_cloud_configuration_with_store(
    state_dir: &Path,
    secrets: &SystemSecretStore,
) -> Result<(), ConnectError> {
    let path = pending_configuration_path(state_dir);
    let value = match fs::read(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(ConnectError::Io(error)),
    };
    let staged = serde_json::from_slice::<StagedCloudConfiguration>(&value).map_err(|error| {
        ConnectError::Settings(format!("Staged cloud configuration is invalid: {error}"))
    })?;
    if staged.version != 1 {
        return Err(ConnectError::Settings(
            "Staged cloud configuration version is not supported.".to_string(),
        ));
    }
    let configuration = CloudConfiguration::new(&staged.configuration.server_url)?;
    let token = secrets.pending_connector_token()?.ok_or_else(|| {
        ConnectError::CredentialStore(
            "A staged Connect account is missing its operating-system credential.".to_string(),
        )
    })?;
    if credential_digest(&token) != staged.connector_token_digest {
        return Err(ConnectError::CredentialStore(
            "A staged Connect account does not match its operating-system credential.".to_string(),
        ));
    }
    secrets.set_connector_token(&token)?;
    save_cloud_configuration(state_dir, &configuration)?;
    remove_configuration_file(&pending_configuration_path(state_dir))?;
    secrets.clear_pending_connector_token()
}

pub fn disconnect_cloud(state_dir: &Path) -> Result<(), ConnectError> {
    remove_configuration_file(&pending_configuration_path(state_dir))?;
    let secrets = SystemSecretStore::new(state_dir);
    secrets.clear_pending_connector_token()?;
    clear_cloud_configuration(state_dir)?;
    secrets.clear_connector_token()
}

fn load_configuration_file(path: &Path) -> Result<Option<CloudConfiguration>, ConnectError> {
    let value = match fs::read(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(ConnectError::Io(error)),
    };
    let configuration = serde_json::from_slice::<CloudConfiguration>(&value).map_err(|error| {
        ConnectError::Settings(format!("Cloud configuration is invalid: {error}"))
    })?;
    if configuration.version != 1 {
        return Err(ConnectError::Settings(
            "Cloud configuration version is not supported.".to_string(),
        ));
    }
    CloudConfiguration::new(&configuration.server_url).map(Some)
}

pub fn save_cloud_configuration(
    state_dir: &Path,
    configuration: &CloudConfiguration,
) -> Result<(), ConnectError> {
    let validated = CloudConfiguration::new(&configuration.server_url)?;
    ensure_private_state_dir(state_dir)?;
    write_configuration_file(&configuration_path(state_dir), &validated)
}

fn write_configuration_file(
    path: &Path,
    configuration: &CloudConfiguration,
) -> Result<(), ConnectError> {
    write_serialized_file(path, configuration)
}

fn write_serialized_file<T: Serialize>(path: &Path, value: &T) -> Result<(), ConnectError> {
    let parent = path.parent().ok_or_else(|| {
        ConnectError::Settings("Cloud configuration path is invalid.".to_string())
    })?;
    let mut temporary = NamedTempFile::new_in(parent)?;
    temporary.write_all(&serde_json::to_vec_pretty(value)?)?;
    temporary.as_file().sync_all()?;
    temporary.persist(path).map_err(|error| error.error)?;
    #[cfg(unix)]
    fs::File::open(parent)?.sync_all()?;
    Ok(())
}

pub fn clear_cloud_configuration(state_dir: &Path) -> Result<(), ConnectError> {
    remove_configuration_file(&configuration_path(state_dir))
}

fn remove_configuration_file(path: &Path) -> Result<(), ConnectError> {
    match fs::remove_file(path) {
        Ok(()) => {
            #[cfg(unix)]
            if let Some(parent) = path.parent() {
                fs::File::open(parent)?.sync_all()?;
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(ConnectError::Io(error)),
    }
}

fn configuration_path(state_dir: &Path) -> PathBuf {
    state_dir.join("cloud.json")
}

fn pending_configuration_path(state_dir: &Path) -> PathBuf {
    state_dir.join("cloud.pending.json")
}

fn credential_digest(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn canonical_server_url(value: &str) -> Result<String, ConnectError> {
    let mut url = Url::parse(value.trim())
        .map_err(|_| ConnectError::Settings("Connect server URL is invalid.".to_string()))?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    if url.host_str().is_none()
        || (url.scheme() != "https" && !(url.scheme() == "http" && loopback))
    {
        return Err(ConnectError::Settings(
            "Remote Connect servers must use HTTPS.".to_string(),
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(ConnectError::Settings(
            "Connect server URL must not contain credentials.".to_string(),
        ));
    }
    url.set_path("/");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.as_str().trim_end_matches('/').to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configuration_round_trips_without_secrets() {
        let temporary = tempfile::tempdir().unwrap();
        let configuration = CloudConfiguration::new("https://connect.example/path?secret=no")
            .expect("origin should normalize");
        assert_eq!(configuration.server_url, "https://connect.example");
        save_cloud_configuration(temporary.path(), &configuration).unwrap();
        assert_eq!(
            load_cloud_configuration(temporary.path()).unwrap(),
            Some(configuration)
        );
        let raw = fs::read_to_string(temporary.path().join("cloud.json")).unwrap();
        assert!(!raw.contains("token"));
        clear_cloud_configuration(temporary.path()).unwrap();
        assert_eq!(load_cloud_configuration(temporary.path()).unwrap(), None);
    }

    #[test]
    fn insecure_remote_origins_are_rejected() {
        let error = CloudConfiguration::new("http://connect.example").unwrap_err();
        assert_eq!(error.code(), "invalid_config");
        assert!(CloudConfiguration::new("http://127.0.0.1:3000").is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn saving_configuration_protects_the_state_directory() {
        use std::os::unix::fs::PermissionsExt;

        let temporary = tempfile::tempdir().unwrap();
        let state_dir = temporary.path().join("state");
        fs::create_dir(&state_dir).unwrap();
        fs::set_permissions(&state_dir, fs::Permissions::from_mode(0o755)).unwrap();
        save_cloud_configuration(
            &state_dir,
            &CloudConfiguration::new("https://connect.example").unwrap(),
        )
        .unwrap();

        assert_eq!(
            fs::metadata(state_dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }

    #[test]
    fn staged_account_configuration_recovers_after_interruption() {
        let temporary = tempfile::tempdir().unwrap();
        let state_dir = temporary.path().join("state");
        ensure_private_state_dir(&state_dir).unwrap();
        let secrets = SystemSecretStore::insecure_test(&state_dir);
        let configuration = CloudConfiguration::new("https://connect.example").unwrap();
        let token = "con_123456789012345678901234";
        secrets.set_pending_connector_token(token).unwrap();
        write_serialized_file(
            &pending_configuration_path(&state_dir),
            &StagedCloudConfiguration {
                version: 1,
                configuration: configuration.clone(),
                connector_token_digest: credential_digest(token),
            },
        )
        .unwrap();

        recover_staged_cloud_configuration_with_store(&state_dir, &secrets).unwrap();

        assert_eq!(
            load_cloud_configuration(&state_dir).unwrap(),
            Some(configuration)
        );
        assert_eq!(secrets.connector_token().unwrap().as_deref(), Some(token));
        assert_eq!(secrets.pending_connector_token().unwrap(), None);
        assert!(!pending_configuration_path(&state_dir).exists());
    }

    #[test]
    fn account_configuration_never_writes_the_credential_to_configuration() {
        let temporary = tempfile::tempdir().unwrap();
        let state_dir = temporary.path().join("state");
        let secrets = SystemSecretStore::insecure_test(&state_dir);
        let configuration = CloudConfiguration::new("https://connect.example").unwrap();
        let token = "con_123456789012345678901234";

        configure_cloud_with_store(&state_dir, &configuration, token, &secrets).unwrap();

        let configuration_bytes = fs::read(state_dir.join("cloud.json")).unwrap();
        assert!(!String::from_utf8_lossy(&configuration_bytes).contains(token));
        assert!(!state_dir.join("cloud.pending.json").exists());
    }

    #[test]
    fn staged_account_configuration_fails_closed_on_a_torn_replacement() {
        let temporary = tempfile::tempdir().unwrap();
        let state_dir = temporary.path().join("state");
        ensure_private_state_dir(&state_dir).unwrap();
        let secrets = SystemSecretStore::insecure_test(&state_dir);
        let old_token = "con_123456789012345678901234";
        let new_token = "con_abcdefghijklmnopqrstuvwx";
        secrets.set_pending_connector_token(new_token).unwrap();
        write_serialized_file(
            &pending_configuration_path(&state_dir),
            &StagedCloudConfiguration {
                version: 1,
                configuration: CloudConfiguration::new("https://old.example").unwrap(),
                connector_token_digest: credential_digest(old_token),
            },
        )
        .unwrap();

        let error =
            recover_staged_cloud_configuration_with_store(&state_dir, &secrets).unwrap_err();

        assert_eq!(error.code(), "credential_store_unavailable");
        assert_eq!(load_cloud_configuration(&state_dir).unwrap(), None);
        assert_eq!(secrets.connector_token().unwrap(), None);
    }
}
