//! The `private` commands and reading secrets from the terminal or stdin.

use super::*;

/// A secret from the terminal (hidden) or, when stdin is not a terminal, one line of
/// stdin. Never an argument.
fn read_secret(prompt: &str) -> Result<zeroize::Zeroizing<String>, ClientError> {
    // Bounded before anything else sees it (AK1 passwords are at most 1024 bytes
    // after NFKC; recovery keys 64 characters).
    const MAX: usize = 4096;
    let secret = if std::io::stdin().is_terminal() {
        rpassword::prompt_password(prompt)
            .map(zeroize::Zeroizing::new)
            .map_err(ClientError::Io)?
    } else {
        let mut raw = zeroize::Zeroizing::new(Vec::new());
        std::io::stdin()
            .lock()
            .take(MAX as u64 + 1)
            .read_until(b'\n', &mut raw)
            .map_err(ClientError::Io)?;
        let line = std::str::from_utf8(&raw)
            .map_err(|_| ClientError::Protocol("the secret is not UTF-8".into()))?;
        zeroize::Zeroizing::new(line.trim_end_matches(['\r', '\n']).to_string())
    };
    if secret.len() > MAX {
        return Err(ClientError::Protocol("the secret is too long".into()));
    }
    Ok(secret)
}

/// A new password, entered twice on a terminal.
fn new_password() -> Result<zeroize::Zeroizing<String>, ClientError> {
    let a = read_secret("Encryption password (12+ characters): ")?;
    mdbn_replica::crypto::account_key::check_password(&a)
        .map_err(|e| ClientError::Protocol(e.to_string()))?;
    if std::io::stdin().is_terminal() {
        let b = read_secret("Repeat it: ")?;
        if *a != *b {
            return Err(ClientError::Protocol("the passwords do not match".into()));
        }
    }
    Ok(a)
}

pub(super) async fn private(
    profile: &Profile,
    out: &Output,
    cmd: PrivateCmd,
) -> Result<ExitCode, ClientError> {
    let v = match cmd {
        PrivateCmd::Status => call(profile, Method::PRIVATE_STATUS, json!({})).await?,
        PrivateCmd::Setup => {
            let pw = new_password()?;
            let v = call(
                profile,
                Method::PRIVATE_SETUP,
                json!({ "password": pw.as_str() }),
            )
            .await?;
            if !out.json {
                let key = v.get("recovery_key").and_then(Value::as_str).unwrap_or("");
                println!(
                    "Account key set up. Your recovery key (shown once; store it safely):\n\n  {key}\n\n\
                     A weak encryption password can be guessed if the server's copy leaks."
                );
                print_private_collections(&v);
                return Ok(ExitCode::SUCCESS);
            }
            v
        }
        PrivateCmd::Unlock { recovery_key } => {
            let params = if recovery_key {
                json!({ "recovery_key": read_secret("Recovery key: ")?.as_str() })
            } else {
                json!({ "password": read_secret("Encryption password: ")?.as_str() })
            };
            call(profile, Method::PRIVATE_UNLOCK, params).await?
        }
        PrivateCmd::Password { recovery_key } => {
            let key = if recovery_key {
                Some(read_secret("Recovery key: ")?)
            } else {
                None
            };
            let pw = new_password()?;
            let mut params = json!({ "password": pw.as_str() });
            if let Some(k) = &key {
                params["recovery_key"] = json!(k.as_str());
            }
            call(profile, Method::PRIVATE_PASSWORD, params).await?
        }
        PrivateCmd::Strict => call(profile, Method::PRIVATE_STRICT, json!({})).await?,
    };
    if out.json {
        out.value(&v);
    } else {
        println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
    }
    Ok(ExitCode::SUCCESS)
}

fn print_private_collections(v: &Value) {
    for c in v
        .get("collections")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        println!("  {}", c);
    }
}
