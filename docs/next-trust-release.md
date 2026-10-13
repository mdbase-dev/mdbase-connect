# Authenticated NEXT trust release extension

An image release stays immutable. `release-trust-bundle.json` is a **supplemental
signed inventory**, not a replacement image manifest or a new signing anchor.
Its exact image-inventory bytes/length/SHA-256/publication run and attempt bind the
existing schema-1 release. Its `trustAssets` bind path, byte length, SHA-256,
environment, CP/log origins and the original release repository/commit/version.
The separately recorded `publication.publisherCommit` identifies the reviewed
main-branch producer, which may be newer than the original image release.

The shared inventory validator/schema and reference consumer support LAB and
staging as separate exact environment/path pairs. Production inventory is still
refused. This is verification support, not staging signing authority or a staged
candidate. The fixed publisher below accepts LAB/staging, but refuses until the
matching independently reviewed canonical asset exists.

## Protected publication (LAB/staging only)

After owner/security review, ordinary merge queue and successful full Server CI,
dispatch **the existing `publish-images.yml` on `main`** with:

- `operation: lab-trust` or `operation: staging-trust`;
- the existing signed image release's exact `source_commit`, `image_publication_run_id`;
- `release_tag: v<the existing image bundle version>` (a version selector; this
  does not create a tag or authorize production promotion);
- the normal audit `reason`.

The job independently checks the main producer's exact qualification, authenticates
the old image manifest, verifies its successful publication run/attempt and exact
full source qualification, and checks the version/source binding. The fixed,
reviewed `config/next-trust/lab.json` or `config/next-trust/staging.json` is passed through the existing reference
encoder: closed shape, legal signing points, key IDs, certificate signature/window,
canonical bytes and size limit. No dispatch input supplies roots, URLs, certificates,
asset contents or an arbitrary asset path. The fixed operation derives exactly
one environment/path pair; the job refuses absent, symlink or mismatched assets
before fetching/signing release inputs. There is no LAB fallback for staging.
The existing image-build/publication jobs
are skipped in this mode. Ordinary image publication is unchanged.

The resulting `release-trust-bundle` artifact contains exactly:

```
release-trust-bundle.json
release-trust-bundle.sigstore.json
image-release-bundle.json
image-release-bundle.sigstore.json
next-trust/lab.json OR next-trust/staging.json (exactly one)
```

Cosign signs the inventory with the unchanged anchor:

- certificate identity `https://github.com/mdbase-dev/mdbase-connect/.github/workflows/publish-images.yml@refs/heads/main`;
- OIDC issuer `https://token.actions.githubusercontent.com`.

A candidate in Git, its own digest, the encoder, an explicit root, or an artifact
name **is not authentication**. The public LAB candidate commits no private key,
service token, fixture/device identifier or provider credential. Its source tuple
is a proposed release binding, not a claim that the CP currently runs that source.

## Verification and consumer embedding

The private cloud-ops `release lab verify-trust` front door authenticates the
supplemental signature and calls the existing image-bundle verifier unchanged
(including all image signatures, source/publication, full CI and merge-queue gates).
It checks exact copied image bytes, independently supplied LAB origins and release
source, the producer's own qualified main commit/tree/input fingerprints, and uses
`verify-release-trust-asset.mts` from that exact clean qualified checkout for the
reference payload/certificate validation. The same reference consumer also
accepts independently supplied staging context and `next-trust/staging.json`
through the private staging verifier. A LAB asset/context cannot be substituted
for staging; mixed environment assets and paths are refused. The qualified
publisher checkout used by ops must contain this staging consumer support.

Daemon release packaging embeds **those verified bytes** and records original image
and supplemental trust publication IDs/attempts plus asset SHA-256. It must not
substitute a runtime override, self-derived digest, server response, unsigned LAB
file or arbitrary Cosign identity. Engineering explicit-root tests are not ordinary
acceptance. Production publication remains disabled. Staging publication has a
fixed selector but is BLOCKED until its independently authenticated public pins,
canonical asset and qualified main publisher exist. No staging asset is added by
this change. Shared staging manifest/reference-consumer support must be merged
before an independently approved staging asset can be published; no unsigned
exception or runtime override exists.

## Staging signing operation (Callum only, not authorization)

After a separately approved immutable operation packet binds the real source,
image publication run, version, reviewed asset SHA-256 and exact qualified main
publisher, the fixed dispatch syntax is:

```bash
gh workflow run publish-images.yml --repo mdbase-dev/mdbase-connect --ref main \
  -f operation=staging-trust \
  -f source_commit="$APPROVED_IMAGE_SOURCE_COMMIT" \
  -f image_publication_run_id="$APPROVED_IMAGE_PUBLICATION_RUN_ID" \
  -f release_tag="$APPROVED_IMAGE_RELEASE_TAG" \
  -f reason="$APPROVED_OPERATION_REASON"
```

These are independently frozen packet values, not values learned from an
unauthenticated payload. A recipe with variables is not a concrete approved
invocation. Recheck the qualified main publisher and canonical staging asset
immediately before the separately approved dispatch. Signing/publication is a
Callum operation; agents only prepare/test source. Do not dispatch to probe a
missing asset, republish on an uncertain outcome, tag a new release, or treat a
signed trust extension as an integrated staging candidate/deployment/recovery
pair. Observe the exact new run/attempt before retrying any ambiguous dispatch.
The original image manifest and image signatures are unchanged.

The private `release staging verify-trust` front door authenticates the retained
artifact using the SAME verifier/identity and exact qualified consumer checkout.
Only those verified staging bytes may be embedded by native/Worker/client
packaging. Runtime CP equality, grant/Noise admission and actual app-origin/log
acceptance remain separate gates.

Run the bounded offline inventory/reference CLI suite with
`pnpm test:release-trust`. These tests use public synthetic context only and do
not authenticate a release or qualify staging. Before any staging dispatch,
obtain independently reviewed staging pins, canonical asset,
origins and full publisher qualification; there is no dispatch override to
relocate or relabel the fixed LAB asset.

See [payload contract](next-trust-payload.md) and
[inventory schema](../config/release-trust-bundle.schema.json).
