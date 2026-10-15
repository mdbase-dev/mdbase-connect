//! Private stdin native byte recovery component; no archive acceptance/authentication.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]
use std::io::{Read, Write};
use std::process::ExitCode;
use zeroize::Zeroizing;

fn run() -> Result<(), ()> {
    if std::env::args_os().count() != 1 {
        return Err(());
    }
    let mut input = std::io::stdin().lock();
    let mut length = [0u8; 4];
    input.read_exact(&mut length).map_err(|_| ())?;
    let length = u32::from_be_bytes(length) as usize;
    if length == 0 || length > 64 * 1024 * 1024 {
        return Err(());
    }
    let mut header = Zeroizing::new(Vec::new());
    header.try_reserve_exact(length).map_err(|_| ())?;
    header.resize(length, 0);
    input.read_exact(&mut header).map_err(|_| ())?;
    let proof =
        mdbn_legacy::hosted::recovery::recover_inventory(&header, &mut input).map_err(|_| ())?;
    let mut out = std::io::stdout().lock();
    out.write_all(&proof).map_err(|_| ())?;
    out.write_all(b"\n").map_err(|_| ())?;
    out.flush().map_err(|_| ())
}
fn main() -> ExitCode {
    if run().is_ok() {
        ExitCode::SUCCESS
    } else {
        // Never format serde/native/IO errors: metadata, paths and keys stay private.
        eprintln!("native recovered-byte proof refused; no archive acceptance");
        ExitCode::FAILURE
    }
}
