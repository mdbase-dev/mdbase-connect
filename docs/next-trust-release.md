# Authenticated NEXT trust release extension

An image release stays immutable. `release-trust-bundle.json` is a supplemental
signed inventory, not a replacement image manifest or a new signing anchor.
It binds the original image inventory's exact bytes/length/SHA-256/publication
run and attempt, plus one trust asset's path, length, SHA-256, environment,
CP/log origins and original release repository/commit/version.
`publication.publisherCommit` identifies the separately qualified main-branch
producer, which may be newer than the original image release.

## Protected publication

After ordinary review, merge queue and full Server CI, dispatch the existing
`publish-images.yml` on `main` with a fixed operation:

| Operation | Fixed reviewed input |
| --- | --- |
| `lab-trust` | `config/next-trust/lab.json` |
| `staging-trust` | `config/next-trust/staging.json` |
| `production-trust` | `config/next-trust/production.json` |

The image-build/publication jobs are skipped for all trust operations. Missing,
symlinked, wrong-environment or noncanonical assets refuse; no LAB fallback,
caller-supplied roots/URLs/certificates/asset paths or generation at dispatch.
Production additionally requires CP origin `https://connect.mdbase.dev`.
A supported selector does not mean its asset exists or publication is approved.

Staging and production use identical independent publisher/asset approval pins:

```bash
gh workflow run publish-images.yml --repo mdbase-dev/mdbase-connect --ref main \
  -f operation="$APPROVED_ENVIRONMENT-trust" \
  -f expected_publisher_commit="$APPROVED_PUBLISHER_COMMIT" \
  -f expected_trust_asset_sha256="$APPROVED_ASSET_SHA256" \
  -f source_commit="$APPROVED_IMAGE_SOURCE_COMMIT" \
  -f image_publication_run_id="$APPROVED_IMAGE_PUBLICATION_RUN_ID" \
  -f release_tag="$APPROVED_IMAGE_RELEASE_TAG" \
  -f reason="$APPROVED_OPERATION_REASON"
```

This template is **not authorization**. `APPROVED_ENVIRONMENT` is exactly
`staging` or `production`. The independently approved lowercase 40-hex publisher
commit and 64-hex asset digest must match the actual main checkout and bytes
before qualification, release fetch or signing. LAB retains its original inputs.
Hash pins bind bytes, not approval or a new signing key. The release tag selects
the existing image bundle version; this command neither creates a tag nor deploys.

The job qualifies the main producer, authenticates the original image manifest,
checks its successful run/attempt and exact full source qualification, and enforces
source/version binding. The reference encoder checks the closed payload shape,
legal signing points, key IDs, certificate signature/window, canonical bytes and
size. Existing image signatures and original manifest remain unchanged.

The `release-trust-bundle` artifact contains exactly:

```text
release-trust-bundle.json
release-trust-bundle.sigstore.json
image-release-bundle.json
image-release-bundle.sigstore.json
next-trust/<environment>.json
```

Cosign signs with the unchanged exact identity
`https://github.com/mdbase-dev/mdbase-connect/.github/workflows/publish-images.yml@refs/heads/main`
and OIDC issuer `https://token.actions.githubusercontent.com`.
No new release-signing key or arbitrary Cosign certificate is accepted.
Observe the exact new run/attempt after publication; reconcile uncertain outcomes
instead of blindly redispatching.

## Prepared beta.136 staging asset

`config/next-trust/staging.json` is prepared for image release
`v0.1.0-beta.136`, source `6c3bf8eb391dae81028b07d8a7996e1272c34d87`.
The selected original image publication is run `39700623297`, with source
Server CI run `39700585485`.
Successful publication, its actual attempt, and all original signed evidence
must still be independently verified before trust publication.
Its fixed origins remain `https://connect-staging.mdbase.dev` and
`https://log-staging.mdbase.dev`. The canonical asset is **853 bytes**, SHA-256
`8cc3f87e9b220c827464a566b0ef2860c9010edf4b1346a9f52551dbf9a27971`.
Only issue time and image source/version changed. Existing independent staging
roots and certified policy keys are preserved byte-for-byte, not LAB material.

These are preparation pins, **not published trust, deployment evidence or
publication authorization**. The protected main publisher must still qualify
itself and authenticate the original image release before signing the exact
asset. No production asset or production log origin is inferred from staging.

## Prepared beta.134 production asset

`config/next-trust/production.json` is prepared for the **same immutable image
release** `v0.1.0-beta.134`, source
`f45df4598a5bff891de68eec3431ec7744885067`, image run `39368946447`.
This binding does not claim that those image bytes are the current production CP.
The canonical asset is **840 bytes**, SHA-256
`928bee179b7ab0510a17ae80ce39e8e58101a31a17711bdc37b2ae72408208d2`.
Its fixed origins are `https://connect.mdbase.dev` and `https://log.mdbase.dev`.
It preserves the existing production root `70a2bd532b5544dfb77617d4040ca6a2`,
policy `c580fb092af10eb030605bd6e478e6f1` and original root-signed certificate;
no private key, new signature, key generation, rotation or staging/LAB pin is used
in preparation. The certificate remains valid at the asset's issue time.

This is **not published trust or production authorization**. Callum's explicit
trust-publication GO must independently approve the actual post-merge publisher
SHA and exact asset digest before Co dispatches `production-trust`. The protected
workflow then qualifies that publisher and authenticates the original image
release before signing the supplemental inventory with its unchanged identity.
No dispatch, deployment, CP flag or route change is performed by this source PR.

## Verification and embedding

The private cloud-ops `release lab|staging|production verify-trust` front doors
use ONE verifier: supplemental/original signatures, original image/source/run,
full CI/merge queue, exact copied image bytes, independently supplied environment
and origins, main publisher commit/tree/input fingerprints, and canonical payload
validation from that exact clean qualified publisher checkout. A signed asset's
source is the image release, not a claim about currently deployed CP bytes.

After success, packaging receives the unchanged asset/proofs plus the existing
`next-trust/<environment>-context.json` compile-time handoff. That context is not
standalone authentication. Packaging binds the completed verified output and its
qualified verifier/build identity in its own receipt, then embeds those exact
bytes. No runtime root file, self-derived expectation, server fetch, TOFU or
unsigned environment exception exists. Mixed/cross-environment assets refuse.

The SDK release pipeline does this once for mdbase production. The published SDK
already contains production trust: third-party developers install the SDK and
build normally, with no trust step or signing-key configuration. End users never
see trust machinery. Native/Worker/SDK embedding does not itself prove current
membership, CP equality, grant/Noise admission, readiness or recovery acceptance.

Trust publication authenticates the trust asset, **not** an integrated Worker
byte inventory. That inventory requires separately qualified protected production
of its exact bytes; never use the trust operation as an arbitrary blob signer.
Production publication still requires approval of the reviewed production asset,
its final log origin and exact publisher; prepared keys/bytes alone authorize nothing.

Bounded offline tests: `pnpm test:release-trust`. Synthetic fixture keys and tests
are not publication or staging/production authority. See the
[payload contract](next-trust-payload.md) and
[inventory schema](../config/release-trust-bundle.schema.json).
