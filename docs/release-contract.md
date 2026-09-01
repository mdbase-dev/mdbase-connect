# Product release contract

`config/release-components.json` is the public, non-secret inventory of every
product artifact promoted together as an mdbase Connect server release. It owns
component IDs, GHCR repositories, Dockerfiles, build contexts, runtime
platforms, and release-attestation types. It intentionally contains no Render
resource IDs, deployment order, capacity, credentials, or private topology.

`node scripts/release-components.mjs --check` validates the contract and its
repository inputs. Server CI runs this check. Both normal and isolated-staging
image publishers obtain their GitHub matrix from
`node scripts/release-components.mjs --github-matrix`; adding an image only to a
workflow or only to the contract therefore cannot silently produce a partial
release. The required release set is currently `connect`, `hosted-provider`,
`mcp`, and `client`.

After every successful normal publication, `publish-images.yml` downloads the
four exact component records and creates `release-bundle.json`. The bundle is
bound to:

- the full product commit and workspace version;
- the pinned `mdbase-rs` revision;
- the exact successful Server CI run and attempt;
- the exact publication run and attempt; and
- each component's digest-only image, platform, and attestation type.

The workflow signs the JSON blob keylessly and publishes it with its Sigstore
bundle as the `release-bundle` workflow artifact. The signature is an index of
release evidence, not a replacement for it. Private release preparation must
verify the workflow identity and GitHub run identities, then independently
verify every image signature, release-image attestation, source commit, and
registry digest.

## Changing the contract

1. Update `config/release-components.json` and, if the format changes, both
   checked-in schemas.
2. Add or update the Dockerfile and narrow validator tests.
3. Run:

   ```sh
   node scripts/release-components.mjs --check
   node --test scripts/lib/release-components.test.mjs
   ```

4. Review the private mapping in `mdbase-cloud-ops` separately. Public contract
   changes never authorize or identify a private deployment target.

Schema versions are monotonic. Readers fail closed on unknown versions and
unknown, missing, duplicated, mutable, wrong-platform, or wrong-repository
components.

## Local LAB experiments

`pnpm deploy:lab --confirm LAB` builds the current checkout, pushes immutable
LAB-only images, and delegates mutation and rollback state to the adjacent
private `mdbase-cloud-ops` checkout. The resulting state is disposable and
cannot authorize promotion.

When testing unreleased ops changes from a worktree, select that checkout
explicitly with an absolute canonical path:

```sh
MDBASE_CLOUD_OPS_CHECKOUT=/absolute/path/to/mdbase-cloud-ops \
  pnpm deploy:lab --confirm LAB
```

The command still verifies the checkout's Git top level, private repository
origin, and fixed executable. Omit the variable for ordinary use. Roll back with
the exact state path printed by deployment:

```sh
MDBASE_CLOUD_OPS_CHECKOUT=/absolute/path/to/mdbase-cloud-ops \
  pnpm deploy:lab --rollback /absolute/path/to/state.json --confirm LAB
```
