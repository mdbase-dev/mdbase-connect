# Authenticated NEXT trust release extension (LAB)

An image release stays immutable. `release-trust-bundle.json` is a **supplemental
signed inventory**, not a replacement image manifest or a new signing anchor.
Its exact image-inventory bytes/length/SHA-256/publication run and attempt bind the
existing schema-1 release. Its `trustAssets` bind path, byte length, SHA-256,
environment, CP/log origins and the original release repository/commit/version.
The separately recorded `publication.publisherCommit` identifies the reviewed
main-branch producer, which may be newer than the original image release.

## Protected publication

After owner/security review, ordinary merge queue and successful full Server CI,
dispatch **the existing `publish-images.yml` on `main`** with:

- `operation: lab-trust`;
- the existing signed image release's exact `source_commit`, `image_publication_run_id`;
- `release_tag: v<the existing image bundle version>` (a version selector; this
  does not create a tag or authorize production promotion);
- the normal audit `reason`.

The job independently checks the main producer's exact qualification, authenticates
the old image manifest, verifies its successful publication run/attempt and exact
full source qualification, and checks the version/source binding. The fixed,
reviewed `config/next-trust/lab.json` is passed through the existing reference
encoder: closed shape, legal signing points, key IDs, certificate signature/window,
canonical bytes and size limit. No dispatch input supplies roots, URLs, certificates,
asset contents or an arbitrary asset path. The existing image-build/publication jobs
are skipped in this mode. Ordinary image publication is unchanged.

The resulting `release-trust-bundle` artifact contains exactly:

```
release-trust-bundle.json
release-trust-bundle.sigstore.json
image-release-bundle.json
image-release-bundle.sigstore.json
next-trust/lab.json
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
reference payload/certificate validation.

Daemon release packaging embeds **those verified bytes** and records original image
and supplemental trust publication IDs/attempts plus asset SHA-256. It must not
substitute a runtime override, self-derived digest, server response, unsigned LAB
file or arbitrary Cosign identity. Engineering explicit-root tests are not ordinary
acceptance. Staging/production publication is deliberately disabled until their
public pins, authority and review gates exist; there is no unsigned exception.

See [payload contract](next-trust-payload.md) and
[inventory schema](../config/release-trust-bundle.schema.json).
