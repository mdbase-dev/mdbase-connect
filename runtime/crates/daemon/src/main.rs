//! The `mdbase` binary: see [`mdbn_daemon::cli`].

// Release packaging ALWAYS supplies MDBN_RELEASE_VERSION. Check the compiler's
// effective cfg, not just the profile name: profile/env/RUSTFLAGS overrides must
// not turn fixture custody/origin hooks back on in a version-stamped artifact.
const _: () = assert!(
    option_env!("MDBN_RELEASE_VERSION").is_none() || !cfg!(debug_assertions),
    "version-stamped artifacts must disable debug assertions"
);

fn main() -> std::process::ExitCode {
    mdbn_daemon::cli::main()
}
