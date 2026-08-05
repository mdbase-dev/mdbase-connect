use super::*;

#[derive(Debug, serde::Deserialize)]
struct PairingBegin {
    pairing_id: Uuid,
    pairing_secret: String,
    verification_uri: String,
    expires_in: u64,
}

#[derive(Debug, serde::Deserialize)]
struct PairingExchange {
    status: String,
    token: Option<String>,
    connector: Option<Value>,
    error: Option<PairingError>,
}

#[derive(Debug, serde::Deserialize)]
struct PairingError {
    message: Option<String>,
}

pub(super) async fn login(
    state_dir: &Path,
    endpoint: &str,
    target: DaemonTarget,
    server: &str,
    requested_name: Option<&str>,
    no_open: bool,
) -> Result<Value, CliError> {
    let configuration =
        CloudConfiguration::new(server).map_err(|error| CliError::usage(error.to_string()))?;
    let connector_name = requested_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(default_computer_name);
    if connector_name.chars().count() > 100 {
        return Err(CliError::usage(
            "Computer name must be between 1 and 100 characters.",
        ));
    }
    let client = reqwest::Client::new();
    let response = client
        .post(format!("{}/v1/pairing-requests", configuration.server_url))
        .json(&serde_json::json!({"connector_name": connector_name}))
        .send()
        .await
        .map_err(|error| {
            CliError::unavailable(format!("Could not reach the Connect server: {error}"))
        })?;
    let status = response.status();
    let value = response.json::<Value>().await.map_err(|error| {
        CliError::internal(format!(
            "Connect returned an invalid pairing response: {error}"
        ))
    })?;
    if !status.is_success() {
        return Err(CliError {
            code: value
                .pointer("/error/code")
                .and_then(Value::as_str)
                .unwrap_or("pairing_failed")
                .to_string(),
            message: value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("Computer pairing could not begin.")
                .to_string(),
            exit_code: 1,
        });
    }
    let pairing = serde_json::from_value::<PairingBegin>(value).map_err(|error| {
        CliError::internal(format!("Connect returned invalid pairing details: {error}"))
    })?;
    if pairing.expires_in == 0
        || pairing.expires_in > 86_400
        || !valid_secret(&pairing.pairing_secret, "pair_")
    {
        return Err(CliError::internal(
            "Connect returned unsafe pairing details.",
        ));
    }
    let verification = url::Url::parse(&pairing.verification_uri)
        .map_err(|_| CliError::internal("Connect returned an invalid verification address."))?;
    let expected = url::Url::parse(&configuration.server_url)
        .map_err(|_| CliError::internal("Configured Connect server is invalid."))?;
    if verification.origin() != expected.origin()
        || !verification.username().is_empty()
        || verification.password().is_some()
    {
        return Err(CliError::internal(
            "Connect returned a verification address on another origin.",
        ));
    }
    eprintln!("Approve this computer in your browser:\n{verification}");
    if !no_open {
        service::open_url(verification.as_str()).map_err(CliError::internal)?;
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(pairing.expires_in);
    loop {
        if std::time::Instant::now() >= deadline {
            return Err(CliError {
                code: "pairing_expired".to_string(),
                message: "Computer approval expired before it was completed.".to_string(),
                exit_code: 1,
            });
        }
        let response = client
            .post(format!(
                "{}/v1/pairing-requests/{}/exchange",
                configuration.server_url, pairing.pairing_id
            ))
            .bearer_auth(&pairing.pairing_secret)
            .send()
            .await;
        match response {
            Ok(response) if response.status().as_u16() == 202 => {}
            Ok(response) => {
                let status = response.status();
                let exchange = response.json::<PairingExchange>().await.map_err(|error| {
                    CliError::internal(format!(
                        "Connect returned an invalid pairing result: {error}"
                    ))
                })?;
                if !status.is_success() {
                    return Err(CliError {
                        code: "pairing_failed".to_string(),
                        message: exchange
                            .error
                            .and_then(|error| error.message)
                            .unwrap_or_else(|| {
                                format!("Computer pairing failed with HTTP {status}.")
                            }),
                        exit_code: 1,
                    });
                }
                if exchange.status != "paired" {
                    return Err(CliError::internal(
                        "Connect returned an invalid pairing state.",
                    ));
                }
                let token = exchange.token.ok_or_else(|| {
                    CliError::internal("Connect returned no connector credential.")
                })?;
                let loopback_port = current_loopback_port(endpoint).await;
                let configured = send(
                    endpoint,
                    ControlRequest::new(ControlCommand::AccountConfigure(
                        mdbase_connect_protocol::AccountConfigureParams {
                            server_url: configuration.server_url.clone(),
                            connector_token: token.clone(),
                        },
                    )),
                )
                .await
                .is_ok_and(|response| response.ok);
                if !configured {
                    configure_cloud(state_dir, &configuration, &token)
                        .map_err(|error| CliError::internal(error.to_string()))?;
                }
                restart_daemon(state_dir, endpoint, target, loopback_port).await?;
                return Ok(serde_json::json!({
                    "configured": true,
                    "server_url": configuration.server_url,
                    "account": exchange.connector
                }));
            }
            Err(_) => {}
        }
        tokio::time::sleep(std::time::Duration::from_millis(1_500)).await;
    }
}

fn default_computer_name() -> String {
    std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "This computer".to_string())
        .chars()
        .take(100)
        .collect()
}

fn valid_secret(secret: &str, prefix: &str) -> bool {
    secret.starts_with(prefix) && secret.len() >= 24 && !secret.chars().any(char::is_whitespace)
}
