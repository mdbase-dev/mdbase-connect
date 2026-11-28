//! The `private` commands and reading secrets from the terminal or stdin.

use super::*;

// Bounded before anything else sees it (AK1 passwords are at most 1024 bytes
// after NFKC; recovery keys 64 characters).
const MAX_SECRET_BYTES: usize = 4096;

/// A secret from the terminal (hidden) or, when stdin is not a terminal, one line of
/// stdin. Never an argument.
fn read_secret(prompt: &str) -> Result<zeroize::Zeroizing<String>, ClientError> {
    let stdin = std::io::stdin();
    let secret = if stdin.is_terminal() {
        rpassword::prompt_password(prompt)
            .map(zeroize::Zeroizing::new)
            .map_err(|error| invalid_secret_input(format!(
                "could not read the secret from the terminal ({error}); enter it in a terminal or pipe it through stdin"
            )))?
    } else {
        return read_secret_line(stdin.lock());
    };
    if secret.len() > MAX_SECRET_BYTES {
        return Err(invalid_secret_input("the secret is too long"));
    }
    Ok(secret)
}

fn read_secret_line(input: impl BufRead) -> Result<zeroize::Zeroizing<String>, ClientError> {
    let mut raw = zeroize::Zeroizing::new(Vec::new());
    input
        .take(MAX_SECRET_BYTES as u64 + 1)
        .read_until(b'\n', &mut raw)
        .map_err(|error| invalid_secret_input(format!(
            "could not read the secret from stdin ({error}); provide it on one line from a readable file, a pipe, or an interactive terminal"
        )))?;
    let line = std::str::from_utf8(&raw)
        .map_err(|_| invalid_secret_input("the secret is not UTF-8"))?
        .trim_end_matches(['\r', '\n']);
    if line.len() > MAX_SECRET_BYTES {
        return Err(invalid_secret_input("the secret is too long"));
    }
    Ok(zeroize::Zeroizing::new(line.to_string()))
}

fn invalid_secret_input(message: impl Into<String>) -> ClientError {
    ControlError::invalid("invalid_secret_input", message).into()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "linux")]
    #[test]
    fn directory_on_stdin_reports_secret_input_failure() {
        let directory = std::fs::File::open(".").unwrap();
        let error = read_secret_line(std::io::BufReader::new(directory)).unwrap_err();
        assert!(matches!(error, ClientError::Remote(error)
            if error.reason.as_deref() == Some("invalid_secret_input")
                && error.message.contains("could not read the secret from stdin")
                && error.message.contains("readable file")));
    }

    #[test]
    fn redirected_secret_reads_one_line_without_exposing_bad_input() {
        assert_eq!(
            &*read_secret_line(&b"secret\r\nignored"[..]).unwrap(),
            "secret"
        );
        let invalid = read_secret_line(&b"\xffprivate-test-input"[..]).unwrap_err();
        assert!(!invalid.to_string().contains("private-test-input"));
        let long = vec![b'a'; MAX_SECRET_BYTES + 1];
        assert!(
            read_secret_line(long.as_slice())
                .unwrap_err()
                .to_string()
                .contains("too long")
        );
    }
}
