//! Offline append-only history qualification. The caller MUST authenticate the
//! complete retained-context ledger and its digest before invocation. This binary
//! never discovers history, authenticates its own input, fetches, signs or publishes.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::io::Read;
use std::path::Path;
use std::process::ExitCode;

use mdbn_trust::{
    Context, Invalid, MAX_BYTES, MAX_HISTORY_ASSETS, Source, Trust, hex_exact, normalized_json,
    require_append_only, verify,
};
use serde::Deserialize;
use sha2::Digest;

const MAX_LEDGER_BYTES: usize = 1_048_576;
const USAGE: &str =
    "usage: mdbn-trust-history <complete-authenticated-ledger.json> <authenticated-ledger-sha256>";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Ledger {
    schema: String,
    environment: String,
    current: Asset,
    history: Vec<Asset>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Asset {
    asset: String,
    sha256: String,
    control_plane_origin: String,
    log_origin: String,
    source: Source,
}

fn read(path: &Path, limit: usize) -> Result<Vec<u8>, Invalid> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .and_then(|file| file.take(limit as u64 + 1).read_to_end(&mut bytes))
        .map_err(|_| Invalid("history input read failed".into()))?;
    if bytes.is_empty() || bytes.len() > limit {
        return Err(Invalid(
            "history input exceeds byte bound or is empty".into(),
        ));
    }
    Ok(bytes)
}

fn relative_asset_path(asset: &str) -> Result<&Path, Invalid> {
    if asset.is_empty()
        || asset.len() > 1024
        || asset.contains(['\\', ':'])
        || asset.chars().any(char::is_control)
        || asset.split('/').any(|part| matches!(part, "" | "." | ".."))
        || Path::new(asset)
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err(Invalid(
            "history asset path must be normalized relative".into(),
        ));
    }
    Ok(Path::new(asset))
}

fn verify_asset_context(
    asset: Asset,
    directory: &Path,
    environment: &str,
    now: u64,
) -> Result<(Trust, Context), Invalid> {
    let context = Context {
        sha256: hex_exact(&asset.sha256, "history asset SHA256")?,
        environment: environment.into(),
        control_plane_origin: asset.control_plane_origin,
        log_origin: asset.log_origin,
        source: asset.source,
    };
    let relative = relative_asset_path(&asset.asset)?;
    let path = directory
        .join(relative)
        .canonicalize()
        .map_err(|_| Invalid("history asset path resolution failed".into()))?;
    if !path.starts_with(directory) {
        return Err(Invalid("history asset escaped ledger directory".into()));
    }
    let bytes = read(&path, MAX_BYTES)?;
    Ok((verify(&bytes, &context, now)?, context))
}

fn qualify(path: &Path, expected_digest: [u8; 32], now: u64) -> Result<String, Invalid> {
    let bytes = read(path, MAX_LEDGER_BYTES)?;
    if sha2::Sha256::digest(&bytes).as_slice() != expected_digest {
        return Err(Invalid(
            "history ledger differs from authenticated digest".into(),
        ));
    }
    let ledger: Ledger = serde_json::from_slice(&bytes)
        .map_err(|_| Invalid("history ledger JSON/duplicate/unknown fields".into()))?;
    if ledger.schema != "mdbn-trust/history/1"
        || !matches!(
            ledger.environment.as_str(),
            "lab" | "staging" | "production"
        )
        || ledger.history.is_empty()
        || ledger.history.len() > MAX_HISTORY_ASSETS
    {
        return Err(Invalid(
            "history schema/environment/count; missing history is not bootstrap".into(),
        ));
    }
    // Validate all lexical paths BEFORE opening any asset. Canonical containment
    // below also refuses symlink escape. Caller owns an immutable staging directory.
    for asset in std::iter::once(&ledger.current).chain(&ledger.history) {
        relative_asset_path(&asset.asset)?;
    }
    let directory = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
        .canonicalize()
        .map_err(|_| Invalid("history ledger directory resolution failed".into()))?;
    let (current, context) =
        verify_asset_context(ledger.current, &directory, &ledger.environment, now)?;
    let mut history = Vec::with_capacity(ledger.history.len());
    for asset in ledger.history {
        history.push(verify_asset_context(asset, &directory, &ledger.environment, now)?.0);
    }
    require_append_only(&current, &history)?;
    normalized_json(&current, &context)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() != 2
        || args
            .iter()
            .any(|arg| arg.is_empty() || arg.starts_with('-'))
    {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    }
    let digest = match hex_exact(&args[1], "authenticated ledger SHA256") {
        Ok(digest) => digest,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::from(2);
        }
    };
    let now = match std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
    {
        Some(now) => now,
        None => return ExitCode::from(1),
    };
    match qualify(Path::new(&args[0]), digest, now) {
        Ok(line) => {
            println!("{line}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{error}");
            ExitCode::from(1)
        }
    }
}
