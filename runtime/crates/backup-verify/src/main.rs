//! Native-only offline verifier executable. No service/provider integration.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) use mdbn_backup_verify::Refusal;
#[cfg(not(target_arch = "wasm32"))]
use std::io::Write;
#[cfg(not(target_arch = "wasm32"))]
mod cli;
#[cfg(not(target_arch = "wasm32"))]
mod memory {
    pub(crate) fn poison(work: &mdbn_log_service::OfflineDecodeBudget) {
        let _ = work.reserve_owned(u64::MAX);
    }
}
// Same private admission implementation as the library; CLI uses only push.
#[cfg(not(target_arch = "wasm32"))]
#[allow(dead_code)]
mod memory_vec;
#[cfg(not(target_arch = "wasm32"))]
fn main() {
    let result = cli::run(std::env::args_os().skip(1));
    let (line, exit) = match result {
        Ok(verified) => (verified.json_line(), 0),
        Err(error) => (error.json_line(), error.exit_code()),
    };
    if std::io::stdout().lock().write_all(line.as_bytes()).is_err() {
        std::process::exit(2);
    }
    std::process::exit(i32::from(exit));
}
#[cfg(target_arch = "wasm32")]
fn main() { // native CLI intentionally unavailable; no WASM dependencies
}
