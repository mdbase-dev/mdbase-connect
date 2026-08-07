use mdbase_connect_core::{
    load_cloud_configuration, recover_staged_cloud_configuration, CloudConfiguration, ConnectError,
    SystemSecretStore,
};
use mdbase_connect_protocol::crypto::RelayIdentity;
use std::path::{Path, PathBuf};
use std::time::Duration;

const SECRET_BOOTSTRAP_TIMEOUT: Duration = Duration::from_secs(2);

pub(crate) enum SecretBootstrap {
    Available {
        server_url: Option<String>,
        connector_token: Option<String>,
        relay_identity: RelayIdentity,
    },
    Unavailable(String),
}

pub(crate) fn bounded_secret_bootstrap(
    state_dir: PathBuf,
    server_url: Option<String>,
    connector_token: Option<String>,
    relay_identity: Option<RelayIdentity>,
) -> Result<SecretBootstrap, ConnectError> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("mdbase-secret-bootstrap".to_string())
        .spawn(move || {
            let result = (|| {
                let (server_url, connector_token) =
                    resolve_cloud_credentials(&state_dir, server_url, connector_token)?;
                let relay_identity = match relay_identity {
                    Some(identity) => identity,
                    None => SystemSecretStore::new(&state_dir)
                        .load_or_create_relay_identity(&state_dir)?,
                };
                Ok(SecretBootstrap::Available {
                    server_url,
                    connector_token,
                    relay_identity,
                })
            })();
            let _ = sender.send(result);
        })
        .map_err(ConnectError::Io)?;
    receive_secret_bootstrap(receiver, SECRET_BOOTSTRAP_TIMEOUT)
}

fn resolve_cloud_credentials(
    state_dir: &Path,
    server_url: Option<String>,
    connector_token: Option<String>,
) -> Result<(Option<String>, Option<String>), ConnectError> {
    recover_staged_cloud_configuration(state_dir)?;
    match (server_url, connector_token) {
        (Some(server_url), Some(connector_token)) => {
            let server_url = CloudConfiguration::new(&server_url)?.server_url;
            SystemSecretStore::validate_connector_token(&connector_token)?;
            Ok((Some(server_url), Some(connector_token)))
        }
        (None, None) => {
            let Some(configuration) = load_cloud_configuration(state_dir)? else {
                return Ok((None, None));
            };
            let token = SystemSecretStore::new(state_dir)
                .connector_token()?
                .ok_or_else(|| {
                    ConnectError::CredentialStore(
                        "Connect is configured but its operating-system credential is missing."
                            .into(),
                    )
                })?;
            Ok((Some(configuration.server_url), Some(token)))
        }
        _ => Err(ConnectError::Settings(
            "Both server URL and connector credential are required for cloud relay".into(),
        )),
    }
}

fn receive_secret_bootstrap(
    receiver: std::sync::mpsc::Receiver<Result<SecretBootstrap, ConnectError>>,
    timeout: Duration,
) -> Result<SecretBootstrap, ConnectError> {
    match receiver.recv_timeout(timeout) {
        Ok(Ok(bootstrap)) => Ok(bootstrap),
        Ok(Err(error)) if error.code() == "credential_store_unavailable" => {
            Ok(SecretBootstrap::Unavailable(error.to_string()))
        }
        Ok(Err(error)) => Err(error),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Ok(SecretBootstrap::Unavailable(
            "The operating-system credential store did not respond before the two-second startup deadline."
                .into(),
        )),
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Err(
            ConnectError::CredentialStore(
                "The credential bootstrap worker stopped without a result.".into(),
            ),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_cloud_credentials_are_validated_before_use() {
        let temporary = tempfile::tempdir().unwrap();
        assert!(resolve_cloud_credentials(
            temporary.path(),
            Some("http://connect.example".to_string()),
            Some("con_123456789012345678901234".to_string()),
        )
        .is_err());
        assert!(resolve_cloud_credentials(
            temporary.path(),
            Some("https://connect.example".to_string()),
            Some("not-a-credential".to_string()),
        )
        .is_err());
    }

    #[test]
    fn a_stalled_credential_store_becomes_a_bounded_degraded_bootstrap() {
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        let started = std::time::Instant::now();
        let result = receive_secret_bootstrap(receiver, Duration::from_millis(20)).unwrap();
        assert!(matches!(result, SecretBootstrap::Unavailable(_)));
        assert!(started.elapsed() < Duration::from_secs(1));
        drop(sender);
    }

    #[test]
    fn credential_store_errors_degrade_but_configuration_errors_remain_fatal() {
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        sender
            .send(Err(ConnectError::CredentialStore("locked".into())))
            .unwrap();
        assert!(matches!(
            receive_secret_bootstrap(receiver, Duration::from_secs(1)).unwrap(),
            SecretBootstrap::Unavailable(message) if message == "Credential store error: locked"
        ));

        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        sender
            .send(Err(ConnectError::Settings("invalid".into())))
            .unwrap();
        match receive_secret_bootstrap(receiver, Duration::from_secs(1)) {
            Err(error) => assert_eq!(error.code(), "invalid_config"),
            Ok(_) => panic!("configuration errors must not degrade credential bootstrap"),
        }
    }
}
