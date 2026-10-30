# Runtime npm publication

The runtime packages are independent of the legacy Connect release train:

| Package | Initial manifest version | Source |
| --- | --- | --- |
| `@mdbase-dev/sdk` | `0.0.1-next.0` (held candidate) | `runtime/packages/sdk` |
| `@mdbase-dev/obsidian-runtime` | `0.0.0` | `runtime/packages/obsidian-runtime` |
| `mdbase` | `0.5.0-rc.1` | `runtime/packages/mdbase` |

The existing `publish-npm.yml` does not publish these packages. The SDK now uses
the separate source-build `publish-sdk-npm.yml` workflow and is blocked pending
the runtime port; see [SDK publication](sdk-publication.md). This includes its
staging and LAB package identities. **Do not use the archive preparation,
local-bootstrap or dispatch instructions below for any SDK package.**

For `mdbase` and `@mdbase-dev/obsidian-runtime` only, use the separate
`publish-runtime-npm.yml` manual workflow. It publishes one reviewed, committed
archive unchanged, using GitHub-hosted runners and npm OIDC, without a token.
It does not build runtime assets and rejects SDK archive identities.
Provenance identifies the public repository and publishing workflow, **not** a
claim that this job rebuilt the archive from source.

## Prepare an archive

Build using the existing package build paths. The `mdbase` package needs both
`mdbase-core.wasm` and the native addons for the platforms the release supports,
not a browser-only pack.
Build Rust release assets with `--remap-path-prefix` for the checkout and Cargo
home so compiler paths do not expose the builder's private directories.

Use the package metadata from this repository. Pack the complete Obsidian
runtime, not an app-storage-only subset. Review `npm pack
--dry-run --json`, README, LICENSE, exports, declarations and actual archive
contents (including nested archives and binaries) before committing the `.tgz`
under `runtime/npm/`. No `.npmrc`, environment files, credentials, private build
paths or local-only artifacts belong in a published archive. Run the existing
consumer tests against the exact archive. Source-only packs are not sufficient.

Archive filenames may contain source hashes; npm identity comes from the
**embedded package.json version**, not that filename. The first full archives
may keep the versions above to match existing vendored manifests. Do not publish
multiple different archives at the same name/version: npm versions are immutable.
Publish the qualified SDK through its source-build workflow before its runtime
peer. For subsequent SDK/runtime releases use `0.0.1-next.0`, `0.0.1-next.1`,
etc., updating the runtime peer and lockfiles
together. Keep `mdbase` on its documented `0.5.0-rc.N` line. Publish previews,
including the initial `0.0.0` versions, only to `next`. Reserve `latest` for an
explicitly approved stable release with a stable version; the workflow's tag
choice is an owner decision, not inferred from the archive filename.

## Owner setup (once per package)

1. Confirm npm account ownership of the `mdbase-dev` scope and availability of
   unscoped `mdbase`. An anonymous registry 404 does not reserve a name.
2. If npm has no package settings page yet, bootstrap the **real reviewed
   archive**, not a placeholder, from a trusted local terminal:

   ```sh
   npm login --registry=https://registry.npmjs.org/
   npm whoami --registry=https://registry.npmjs.org/
   npm publish ./runtime/npm/<reviewed-archive>.tgz --ignore-scripts --access public --tag next
   ```

   This first local publication has no GitHub provenance. Do not pretend OIDC
   can be configured on a nonexistent package. If npm offers creation of a
   trusted publisher before first publication, use that instead and publish
   through the workflow. After a local bootstrap, the next CI publication must
   use a **new version**; the bootstrap version cannot be republished.
3. On each npm package's Settings → Trusted Publisher, add GitHub Actions:
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
