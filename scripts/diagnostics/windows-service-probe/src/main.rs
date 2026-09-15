#![cfg(windows)]
#![allow(dead_code)]

#[path = "../../../../crates/connect-cli/src/service.rs"]
mod service;

fn main() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let result = match args.first().and_then(|value| value.to_str()) {
        Some("install") if args.len() == 3 => service::install(
            std::path::Path::new(&args[1]),
            std::path::Path::new(&args[2]),
        ),
        Some("start") if args.len() == 1 => service::start(),
        Some("stop") if args.len() == 1 => service::stop(),
        Some("uninstall") if args.len() == 1 => service::uninstall(),
        _ => Err("Expected install EXECUTABLE STATE_DIR, start, stop, or uninstall.".into()),
    };
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
    println!("service_installed={}", service::installed());
}
