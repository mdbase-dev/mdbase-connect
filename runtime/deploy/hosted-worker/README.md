# Hosted Worker (Cloudflare): one Durable Object per cloud-copy collection

The hosted replica as a **disposable cache of the log**: each collection's DO runs
`mdbn-hosted-worker` (the replica in hosted mode) over the DO's SQLite
(`LogCache<DoIndex>`), appends through the log Worker by unary HTTP RPC (bearer
token + `ls-http` possession proof signed inside the wasm engine), acknowledges app
writes only after the log append, keeps pending/retry state and keys in RAM, and
serves nothing until it has rebuilt from the log (warm wake re-derives keys from the
control prefix; a cache that disagrees with the log is dropped and rebuilt).

Not yet wired (seams default DENY): KMS custody and admission (`src/custody/`,
`src/admission/`, hosted workstream), the verified-admission observer (replica),
Noise in Wasm for app sockets (daemon). LAB builds (`LAB=1`) expose a
token-guarded admin surface instead: `GET /v1/hosted/status?collection=<uuid>` and a
plaintext WebSocket at `/v1/hosted/ws?collection=<uuid>` serving the hosting app's
session (frames as in `replica-client-api.md`).

## Cloud-copy bootstrap (Connect #615/#616)

- `POST /internal/v1/service-devices {collection}`, with `Authorization: Bearer
  <HOSTED_SERVICE_TOKEN>` (the control plane's outbound token; a Worker secret).
  - The engine wasm generates the hosted device's keys from the platform CSPRNG.
  - Custody's `DeviceKeyWrapper` KMS-wraps the 96-byte `signSeed ‖ kemSk ‖ noiseSk`,
    which is then wiped.
  - The answer is `{kind, device_id, sign_pk, kem_pk, noise_pk, wrapped_keys,
    kms_key_arn}`.
  - It is stateless: the control plane's first stored record wins.
  - It answers 503 until hosted installs the wrapper.
- `src/control.ts` is custody's client of the control plane: the service-device
  record and the role-0 log token. The token is cached in RAM and refreshed a minute
  before it expires.
- `src/keygen.ts` `devicePublicKeys` re-derives the public keys after an unwrap.
  Custody uses it to check them against the record and the log's enrolment.

## Trusted bootstrap

Every open requires the bundled signed environment release and the authenticated
CP service-device record's ORIGINAL signed genesis (Connect #651). The exact
record is the existing seven fields plus `genesis:{seq:1,item,hash}`: canonical
base64 complete signed CBOR (≤64 KiB), lowercase hex plain SHA256 checksum,
whole record ≤128 KiB. Missing/malformed/foreign origin refuses before custody
unwrap. Normal native strict policy/certificate verification owns crypto; original
genesis is not current cloud-copy/share-lock/kind eligibility.

Native config keys 8/9/10 carry bundled normalized pins/original bytes/checksum.
Native `expected_genesis` is the existing domain-separated **chain_hash**, derived
from verified bytes, NOT the plain checksum. Warm SQL/log state cannot supply it.
The native config refuses missing pins/origin, additive roots or stripped proof.

`build-release-trust.mjs` reuses SDK's BUILD-only consumer of the ONE shared
`mdbn-trust` verifier. All release context arguments MUST come from an independently
authenticated release manifest/pipeline. It writes create-only
`.generated/release-trust.ts`; Wrangler's fixed alias requires it, so a missing
verified artifact refuses bundling. Source/Node defaults are DENY, with no runtime
asset/pins override. Environment, `CP_URL` and `LOG_URL` must match the signed
release; optional legacy `CP_ROOTS` is equality assertion only. Production escrow
remains DENY; the existing LAB escrow path gets the same public-before-unwrap
checks. Fixture keys also require bundled release pins and per-collection originals.

## Trusted object destinations

Set `OBJECT_STORAGE_ORIGINS` only through trusted deployment tooling: a CSV of
canonical HTTPS storage origins (scheme/hostname/port; no paths, IP literals,
wildcards or local hosts). Missing/empty denies public direct attachment GET/PUT;
invalid config denies all direct routes. Responses/SQL never add providers.
The fixed `https://log.internal` marker is allowed only through an actual `LOG`
service binding, never ordinary fetch or `LOG_URL` alone. Redirects are manual and
refused. Inline reads and dedup/refusal metadata need no destination authority.
Destination admission precedes body allocation, streaming and network effects.

## Build

```sh
npm ci                      # Node 24
./build-wasm.sh             # rcargo; writes hosted.wasm (never builds under /tmp)
# BEFORE any deploy/dry-run bundle: generate public literals from the authenticated
# release context; no network/defaults/overwrite. Replace placeholders, not secrets.
node build-release-trust.mjs --verifier /trusted/mdbn-trust --asset /trusted/environment.asset \
  --sha256 <manifest-sha256> --environment <lab|staging|production> \
  --cp-origin <manifest-https-origin> --log-origin <manifest-https-origin> \
  --source-commit <manifest-commit> --source-version <manifest-version>
npx wrangler types && npx tsc --noEmit
```

## Historical local end-to-end (no Cloudflare account)

The old runner below additionally needs a verified release module and fixture
originals under the new bootstrap contract. It is not trusted-bootstrap/UPLOAD qualification;
no deployment or LAB smoke is authorized by these instructions.

```sh
rcargo run -q -p mdbn-hosted-worker --example lab_fixture > fixture.json
(cd ../../packages/sdk && npm ci && npm run build)   # the harness drives the real SDK client
node --experimental-transform-types e2e/run.mjs fixture.json
```

Runs logsvc's frozen 3809 log Worker bundle and this Worker under `wrangler dev`,
seeds a cloud-copy collection (real signatures and HPKE wraps; the hosted device is
a rekey recipient), and checks: rebuild then serve; a write answered only after the
log append; get/query from the DO cache; warm wake over the persisted cache (keys
re-derived from the log); cache dropped and fully rebuilt.

## LAB (mdbase-lab account)

With `LAB=1`, `GET /health` (or bodyless `HEAD`) returns fixed liveness metadata
without opening a collection. It does not attest readiness: check the token-guarded
`/v1/hosted/status?collection=<uuid>` separately for `serving: true`.

`e2e/lab.mjs deploy|seed|smoke <fixture.json> <private-dir>` deploys
`mdbase-next-log-hosted-e2e` (frozen log bundle, own R2 bucket, fixture root and a
LAB-only stand-in token issuer) and `mdbase-next-hosted-lab`, seeds the fixture and
runs the SDK smoke. Requires R2 enabled on the account.
