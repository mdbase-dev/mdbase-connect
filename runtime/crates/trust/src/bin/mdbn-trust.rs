//! `mdbn-trust verify`: the build-step front end of [`mdbn_trust::verify`].
//!
//! ```text
//! mdbn-trust verify --asset <file> --sha256 <64 hex> --environment <lab|staging|production> \
//!     --cp-origin <https://..> --log-origin <https://..> \
//!     --source-commit <40 hex> --source-version <version> [--now-ms <ms>]
//! ```
//!
//! Every context value is required and comes from the authenticated release
//! manifest, never from the asset; there is no default context and no network.
//! On success prints one canonical JSON line ([`mdbn_trust::normalized_json`]);
//! on any failure prints the reason to stderr and exits 1 (2 for usage).
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::collections::BTreeMap;
use std::io::{self, Read};
use std::process::ExitCode;

use mdbn_trust::{Context, MAX_BYTES, REPOSITORY, Source, hex_exact, normalized_json, verify};

const USAGE: &str = "usage: mdbn-trust verify --asset <file> --sha256 <hex> --environment <env> \
--cp-origin <origin> --log-origin <origin> --source-commit <hex> --source-version <v> [--now-ms <ms>]";

fn options(args: &[String]) -> Option<BTreeMap<&str, &str>> {
    if args.first().map(String::as_str) != Some("verify") || args.len().is_multiple_of(2) {
        return None;
    }
    let known = [
        "--asset",
        "--sha256",
        "--environment",
        "--cp-origin",
        "--log-origin",
        "--source-commit",
        "--source-version",
        "--now-ms",
    ];
    let mut values = BTreeMap::new();
    for pair in args[1..].chunks_exact(2) {
        let (name, value) = (pair[0].as_str(), pair[1].as_str());
        if !known.contains(&name)
            || value.is_empty()
            || value.starts_with("--")
            || values.insert(name, value).is_some()
        {
            return None;
        }
    }
    Some(values)
}

// Bound the read BEFORE hashing/parsing, not after an unbounded fs::read.
fn read_bounded(reader: impl Read) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader.take(MAX_BYTES as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > MAX_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "trust asset exceeds byte bound",
        ));
    }
    Ok(bytes)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(values) = options(&args) else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    let get = |name: &str| values.get(name).map(|value| (*value).to_string());
    let required = |name: &str| {
        get(name).ok_or_else(|| {
            eprintln!("missing {name}\n{USAGE}");
            ExitCode::from(2)
        })
    };
    let run = || -> Result<String, ExitCode> {
        let asset = required("--asset")?;
        let sha256 = required("--sha256")?;
        let context = Context {
            sha256: hex_exact(&sha256, "--sha256").map_err(|e| {
                eprintln!("{e}");
                ExitCode::from(2)
            })?,
            environment: required("--environment")?,
            control_plane_origin: required("--cp-origin")?,
            log_origin: required("--log-origin")?,
            source: Source {
                repository: REPOSITORY.into(),
                commit: required("--source-commit")?,
                version: required("--source-version")?,
            },
        };
        let now_ms = match get("--now-ms") {
            Some(v) => v.parse::<u64>().map_err(|_| {
                eprintln!("--now-ms must be an integer");
                ExitCode::from(2)
            })?,
            None => std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| ExitCode::from(1))?
                .as_millis() as u64,
        };
        let bytes = std::fs::File::open(&asset)
            .and_then(read_bounded)
            .map_err(|e| {
                eprintln!("read {asset}: {e}");
                ExitCode::from(1)
            })?;
        let fail = |e: mdbn_trust::Invalid| {
            eprintln!("{e}");
            ExitCode::from(1)
        };
        let trust = verify(&bytes, &context, now_ms).map_err(fail)?;
        normalized_json(&trust, &context).map_err(fail)
    };
    match run() {
        Ok(line) => {
            println!("{line}");
            ExitCode::SUCCESS
        }
        Err(code) => code,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn options_accept_known_pairs_in_any_order() {
        let input = args(&["verify", "--now-ms", "10000", "--asset", "asset.json"]);
        let parsed = options(&input).unwrap();
        assert_eq!(parsed.get("--asset"), Some(&"asset.json"));
        assert_eq!(parsed.get("--now-ms"), Some(&"10000"));
    }

    #[test]
    fn duplicate_options_are_refused_even_if_identical() {
        for flag in [
            "--asset",
            "--sha256",
            "--environment",
            "--cp-origin",
            "--log-origin",
            "--source-commit",
            "--source-version",
            "--now-ms",
        ] {
            for second in ["first", "different"] {
                assert!(options(&args(&["verify", flag, "first", flag, second])).is_none());
            }
        }
    }

    #[test]
    fn malformed_command_flag_or_value_is_refused() {
        for input in [
            vec![],
            vec!["other"],
            vec!["verify", "--asset"],
            vec!["verify", "--unknown", "value"],
            vec!["verify", "--asset", "--sha256"],
            vec!["verify", "--asset", ""],
        ] {
            assert!(options(&args(&input)).is_none(), "{input:?}");
        }
    }

    #[test]
    fn read_accepts_exact_byte_limit() {
        let bytes = vec![b'x'; MAX_BYTES];
        assert_eq!(read_bounded(bytes.as_slice()).unwrap(), bytes);
    }

    #[test]
    fn oversized_read_stops_at_limit_plus_one() {
        let mut input = io::Cursor::new(vec![b'x'; MAX_BYTES * 16]);
        assert_eq!(
            read_bounded(&mut input).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(input.position(), MAX_BYTES as u64 + 1);
    }

    #[test]
    fn read_propagates_io_errors() {
        struct Broken;
        impl Read for Broken {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                Err(io::Error::new(io::ErrorKind::PermissionDenied, "fixture"))
            }
        }
        assert_eq!(
            read_bounded(Broken).unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
    }
}
