# Native staging daemon

`cargo build -p mdbn-daemon --features staging` builds the `mdbase` daemon for
the staging service. Runtime CI builds it, and staging qualification uses it to
run the native two-computer S0 lane against staging with the exact candidate source. It is never a shipped
artifact (`runtime/scripts/check-release-features.sh` denies the feature).

## Environment

A staging build embeds the reviewed in-repo asset
`config/next-trust/staging.json`, the same bytes the staging SDK pins in
`config/release-components.json`. `runtime/crates/daemon/src/trust.rs` pins its
digest and the context its authenticated release bundle binds: environment
`staging`, control plane `https://connect-staging.mdbase.dev`, log
`https://log-staging.mdbase.dev`, and the image release source. This is the same
model as the production build. There is no runtime trust file, flag, override or
origin relabeling, and no new trust authority. A trust rotation replaces the
asset and the pins in one reviewed change; a test requires the daemon pins to
equal the release-component pins.

`staging`, `lab` and `local-rehearsal` exclude one another: combining any two is a
compile error. A staging build compiles in neither the production nor the LAB
asset, and refuses either environment's trust.

- `mdbase account sign-in` accepts only `https://connect-staging.mdbase.dev`
  (the default). Production, LAB, look-alike and plain-HTTP origins are refused.
- Startup reconnects only account state signed in to this build's control plane.
  State another environment's build left in the same data directory is not
  resumed: the relay does not start and `mdbase status` reports that the computer
  is signed in to a different environment. `mdbase account sign-out` clears it.
  The same rule applies to production and LAB builds.

## Build, record and check

`runtime/scripts/native-staging-artifact.mjs` owns the supported build and binds
the result to its source and trust handoff. It does no network, signing or
verification of its own: the daemon verifies its asset with the compiled-in
`mdbn-trust`.

1. **Build** from a clean checkout of the candidate commit:

   ```sh
   node runtime/scripts/native-staging-artifact.mjs build ./mdbase
   ```

   This runs, in `runtime/`,
   `cargo build --locked --release -p mdbn-daemon --bin mdbase --features staging`
   with two `--config` arguments that remap the checkout to `/source` and the
   Cargo home to `/cargo`, for Rust (`--remap-path-prefix`) and C dependencies
   (`-ffile-prefix-map`). A remote cargo runner can run the same arguments
   (`cargoArgs(checkout, cargoHome)`, with the paths as the runner sees them).
   With the pinned toolchain (`runtime/rust-toolchain.toml`), the same host C
   toolchain and the same builder Cargo configuration, every checkout path gives
   the same bytes.

2. **Record** the artifact against the Ops handoff for the embedded asset:

   ```sh
   node runtime/scripts/native-staging-artifact.mjs record HANDOFF ./mdbase receipt.json
   ```

   `HANDOFF` is the unchanged output directory of cloud-ops
   `bin/release staging verify-trust` for the pinned staging asset: the two
   release bundles, their Sigstore bundles, `next-trust/staging.json` and
   `next-trust/staging-context.json`, and nothing else. Recording refuses unless:

   - the checkout is clean;
   - the handoff is complete and its custody hashes match;
   - its context is the commit's staging pin;
   - its asset is byte for byte the embedded asset;
   - the artifact is an x86-64 ELF that embeds the staging asset and neither the
     production nor the LAB asset.

   The receipt (`mdbase-native-staging-artifact/1`, written create-only) records:

   - the source repository, commit, tree, `Cargo.lock` and toolchain digests;
   - the build;
   - the trust environment, origins, asset digest and image source;
   - the handoff context digest, proof digests and publication and qualification
     runs;
   - the artifact's size and SHA-256.

3. **Check** each computer's copy, or an independent rebuild, before S0:

   ```sh
   node runtime/scripts/native-staging-artifact.mjs check receipt.json ./mdbase
   ```

   This re-runs the built-byte checks against the receipt commit's assets and
   requires the recorded size and SHA-256. A computer without a checkout compares
   `sha256sum mdbase` with the receipt's `artifact.sha256`.

The receipt is custody evidence for one artifact, not release authentication or
staging qualification. The staging release gate and the Ops runbook own when the
lane runs and what it must show.
