//! `replay <log>`: the native side of the determinism check. Prints exactly what
//! `scripts/wasm-replay.mjs` prints for the WASM build of the same function.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::process::ExitCode;

fn main() -> ExitCode {
    let Some(path) = std::env::args().nth(1) else {
        eprintln!("usage: replay <log>");
        return ExitCode::from(2);
    };
    match std::fs::read_to_string(&path) {
        Ok(input) => {
            println!("{}", mdbn_wasm::replay(&input));
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("{path}: {e}");
            ExitCode::FAILURE
        }
    }
}
