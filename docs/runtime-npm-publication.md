# Runtime npm publication

The SDK version is computed by its own CI publication workflow; the other runtime
packages retain their own versions:

| Package | Initial manifest version | Source |
| --- | --- | --- |
| `@mdbase-dev/sdk` | CI-computed (first cut `0.1.0-beta.149`) | `runtime/packages/sdk` |
| `@mdbase-dev/obsidian-runtime` | `0.0.0` | `runtime/packages/obsidian-runtime` |
| `@mdbase-dev/mdbase` | `0.5.0` (universal WebAssembly helpers only) | `runtime/packages/mdbase` |

The existing `publish-npm.yml` does not publish these packages. The SDK now uses
the separate source-build `publish-sdk-npm.yml` workflow from the production-verified
release tag; see [SDK publication](sdk-publication.md). Only production is
published to npmjs; staging/LAB use attested GitHub prerelease assets, not a
registry. **Do not use the archive preparation,
local-bootstrap or dispatch instructions below for any SDK package.**

For `@mdbase-dev/mdbase` and `@mdbase-dev/obsidian-runtime` only, use the separate
`publish-runtime-npm.yml` manual workflow. It publishes one reviewed, committed
archive unchanged, using GitHub-hosted runners and npm OIDC, without a token.
It does not build runtime assets and rejects SDK archive identities.
Provenance identifies the public repository and publishing workflow, **not** a
claim that this job rebuilt the archive from source.

## Prepare an archive

Build using the existing package build paths. The `@mdbase-dev/mdbase@0.5.0` package contains
the universal helper declarations and JavaScript plus `wasm/mdbase-core.wasm`.
Do not include native addons or `dist/node`; collections on Node are deferred.
Build Rust release assets with `--remap-path-prefix` for the checkout and Cargo
home so compiler paths do not expose the builder's private directories.

Use the package metadata from this repository. Pack the complete Obsidian
runtime, not an app-storage-only subset. Review `npm pack
--dry-run --json`, README, LICENSE, exports, declarations and actual archive
contents (including nested archives and binaries) before committing the `.tgz`
under `runtime/npm/`. No `.npmrc`, environment files, credentials, private build
paths or local-only artifacts belong in a published archive. Run the existing
consumer tests against the exact archive. Source-only packs are not sufficient.

For `@mdbase-dev/mdbase@0.5.0`, run `cargo xtask mdbase-wasm` in `runtime/`
with the checkout, Cargo-home and rust-src sysroot path remaps in `RUSTFLAGS`.
This uses `wasm-release` and the pinned `wasm-opt -Oz` build path. Then run
`npm ci`, `npm run typecheck`, `npm run build`, `npm pack --dry-run --json` and
`npm pack --pack-destination ../../npm` in `runtime/packages/mdbase`. Keep npm's
default scoped filename: `runtime/npm/mdbase-dev-mdbase-0.5.0.tgz`.
The unscoped name was rejected by npm as too similar to `md-base`; nothing was
published, so the scoped package keeps version `0.5.0`.

Archive filenames may contain source hashes; npm identity comes from the
**embedded package.json version**, not that filename. The first full archives
may keep the versions above to match existing vendored manifests. Do not publish
multiple different archives at the same name/version: npm versions are immutable.
Publish the qualified SDK through its source-build workflow before its runtime
peer. The SDK version and the Obsidian runtime's SDK peer/lock follow the
Connect workspace version (`pnpm version:check`); the Obsidian runtime's own
version stays independent. `@mdbase-dev/mdbase@0.5.0` is the first stable helpers release and
uses `latest`. Publish previews,
including the initial `0.0.0` versions, only to `next`. Reserve `latest` for an
explicitly approved stable release with a stable version; the workflow's tag
choice is an owner decision, not inferred from the archive filename.

## Owner setup (once per package)

1. Confirm the npm account has read-write access to the `@mdbase-dev` organization
   scope for `@mdbase-dev/mdbase` and `@mdbase-dev/obsidian-runtime`. An anonymous
   registry 404 does not reserve a name; do not retry the rejected unscoped name.
2. If npm has no package settings page yet, bootstrap the **real reviewed
   archive**, not a placeholder, from a trusted local terminal:

   ```sh
   npm login --registry=https://registry.npmjs.org/
   npm whoami --registry=https://registry.npmjs.org/
   npm publish ./runtime/npm/mdbase-dev-mdbase-0.5.0.tgz --ignore-scripts --access public --tag latest
   ```

   The command above is only for the owner-approved `@mdbase-dev/mdbase@0.5.0`
   release. For Obsidian runtime, use its separately reviewed archive and approved
   tag (`next` for previews).
   This first local publication has no GitHub provenance. Do not pretend OIDC
   can be configured on a nonexistent package. If npm offers creation of a
   trusted publisher before first publication, use that instead and publish
   through the workflow. After a local bootstrap, the next CI publication must
   use a **new version**; the bootstrap version cannot be republished.
3. On the scoped package's npm Settings → Trusted Publisher
   (`@mdbase-dev/mdbase`, and separately `@mdbase-dev/obsidian-runtime`), add GitHub Actions:
   organization/user `mdbase-dev`, repository `mdbase-connect`, workflow filename
   `publish-runtime-npm.yml`, environment `npm-runtime`. Enable the `npm publish`
   allowed action if the UI asks (a stage-only publisher cannot run this workflow).
   Complete a first successful OIDC publication within npm's displayed expiry
   (currently two days), or recreate an expired configuration.
4. In GitHub create environment `npm-runtime`, require owner approval, and limit
   deployments to `main`. No `NPM_TOKEN` secret is needed. Once OIDC works,
   disallow token publishing on npm and remove obsolete automation tokens.

## Dispatch

After the workflow and a reviewed archive are merged to `main`:

```sh
gh workflow run publish-runtime-npm.yml -R mdbase-dev/mdbase-connect --ref main \
  -f tarball=runtime/npm/<reviewed-archive>.tgz -f tag=next -f dry_run=true
```

Inspect the pack listing. For an owner-approved publication, repeat with
`-f dry_run=false` and approve the GitHub environment request. Repeat separately
for each package. This documentation and workflow do not constitute release
approval. Never dispatch publication merely to test OIDC.

References: [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/),
[npm provenance](https://docs.npmjs.com/generating-provenance-statements/).
