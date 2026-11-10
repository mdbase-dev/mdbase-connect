## Removed

- Remove the retired Candidate B hosted-storage benchmark (crate, scripts and
  recorded fixtures and results), the Candidate B staging-mission script and
  its evidence documents. They remain in git history.
- Stop treating the legacy root Rust crates and the mdbase-rs engine pin as
  desktop release inputs; the desktop bundles the daemon built from `runtime/`.
