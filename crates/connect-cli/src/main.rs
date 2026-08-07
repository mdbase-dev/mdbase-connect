fn main() {
    rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .expect("the TLS crypto provider must be installed before starting mdbase");
    std::process::exit(mdbase_cli::run());
}
