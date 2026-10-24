//! Private stdin native byte recovery component; no archive acceptance/authentication.
//!
//! Exit codes: 0 success; 1 invocation, framing or output I/O; 2 header,
//! data environment or key custody environment; 3 key and metadata preflight;
//! 4 original object proof. Every refusal prints the SAME fixed stderr line.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]
use std::io::{Read, Write};
use std::process::ExitCode;
use zeroize::Zeroizing;

const INVOCATION: u8 = 1;

fn run() -> Result<(), u8> {
    if std::env::args_os().count() != 1 {
        return Err(INVOCATION);
    }
    let mut input = std::io::stdin().lock();
    let mut length = [0u8; 4];
    input.read_exact(&mut length).map_err(|_| INVOCATION)?;
    let length = u32::from_be_bytes(length) as usize;
    if length == 0 || length > 64 * 1024 * 1024 {
        return Err(INVOCATION);
    }
    let mut header = Zeroizing::new(Vec::new());
    header.try_reserve_exact(length).map_err(|_| INVOCATION)?;
    header.resize(length, 0);
    input.read_exact(&mut header).map_err(|_| INVOCATION)?;
    let proof = mdbn_legacy::hosted::recovery::recover_inventory_staged(&header, &mut input)
        .map_err(|(stage, _)| stage.exit_code())?;
    let mut out = std::io::stdout().lock();
    out.write_all(&proof).map_err(|_| INVOCATION)?;
    out.write_all(b"\n").map_err(|_| INVOCATION)?;
    out.flush().map_err(|_| INVOCATION)
}
fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(code) => {
            // Never format serde/native/IO errors: metadata, paths and keys stay private.
            eprintln!("native recovered-byte proof refused; no archive acceptance");
            ExitCode::from(code)
        }
    }
}
