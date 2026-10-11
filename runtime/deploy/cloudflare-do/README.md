# Blind log service: Durable Objects + R2

One SQLite-backed `LogCollection` actor per collection, using the platform-neutral
`mdbn-log-service` crate. R2 contains sealed objects only. This is a separate Rust
workspace; `Cargo.lock` is checked in.

## Validation

CI (`.github/workflows/logsvc-do.yml`) pins worker-build 0.8.7 and Wrangler 4.147.0:

```sh
worker-build --release --locked
# From the repository root:
cargo build --locked -p mdbn-log-conformance --bin logsvc-bench
# From this directory:
npm ci --no-audit --no-fund
LOGSVC_BENCH=../../target/debug/logsvc-bench npm test
```

On the designated build machine **compilation must use rcargo**, including worker-build's cargo
subprocess. Build/pull `wasm32-unknown-unknown/release/mdbn_log_do.wasm` remotely and
run worker-build with a cargo shim that delegates `cargo build` to that rcargo
command; metadata queries may run locally. `.cargo/config.toml` preserves
worker-build's `WASM_BINDGEN_USE_JS_SYS` setting remotely. Packaging/wasm-opt and
local runtime tests do not compile Rust. Always pull a fresh conformance binary.

The test harness creates an isolated local-only Wrangler config with no custom
build, local R2/DO/Analytics bindings and unique state under `.wrangler/`. It runs
20 conformance cases plus cross-actor WebSocket routing and HTTPS nonce replay
across a runtime restart. Ports default to 18787/19229; override with
`LOGSVC_TEST_PORT` / `LOGSVC_TEST_INSPECTOR_PORT`. Diagnostics remain on failure.
It never contacts a deployed Worker or uses Cloudflare credentials. Its test-only
entrypoint `tests/ingress-worker.mjs` wraps the real Worker and actor to construct
instrumented native byte streams (including dishonest length headers, which
cannot be expressed with unchanged HTTP framing). This wrapper is never referenced
by deployment config or included in the eight-file artifact. Tests also exercise
real network chunked transfer, error/abort cleanup, concurrent outer/actor reads,
multiple actors, R2-await lifetime accounting and nonce preservation on rejection.

### Local dev-proxy disconnect classification (test harness only)

CORS probes have one narrowly scoped transport replay: only a failed request with
an **exact correlated** new `Error inside ProxyWorker ... Network connection lost.`
log line is retried ONCE. A unique test-only query tag binds the method+URL to this
request (signed pathname/body/headers unchanged); old/other-request/other-error/
missing/unbounded log evidence cannot trigger replay. Log observation is bounded.
The retry uses `node:http` with `agent:false` for a new client socket and forwards
`Connection: close`. It records `local_proxy_disconnect_retry` without tokens or
payloads. Another failure is returned unchanged, not retried recursively.

Worker-generated500s without that exact proxy evidence still fail the original
assertions. No status/signature/nonce assertion changes, global fetch override,
Wrangler/dependency patch or production retry/drain policy. Only replayable CORS
fixture bytes are accepted; WS and mutation/restore/other suites do not use this
helper. A proxy-disconnect replay is not proof the Worker did not execute the first
request: an already-consumed nonce still causes the unchanged replay assertion to
fail. These tests qualify local native behavior, not browser or managed PITR behavior.

## Ingress memory admission

RPC transport bodies are capped at 10 MiB (the 9 MiB import-object maximum plus
CBOR overhead); this is not a relaxation of service/object/certificate/frame or
core codec limits. Direct PUT is capped at its authenticated exact expected size,
never above 9 MiB. Neither path trusts Content-Length. The outer Worker and actor
independently pull bounded 64 KiB BYOB views, accept the inclusive boundary, probe
at most one byte beyond it, and cancel on limit/error. Unsupported byte streams
fail closed; there is no arrayBuffer/default-reader fallback.

A shared nonwaiting 64 MiB ingress credit pool reserves four times the maximum
body size before allocation/read and retains it through decode/dispatch/R2 awaits.
Forwarding drops the Rust buffer and retains two-copy JS credits until fetch
completes; the actor independently acquires its own credits. Overload returns a
static 503 without reading/queuing a partially buffered request. RPC token/header
preflight and signed PUT URL/size/checksum-header checks precede body ingestion.
Pre-authentication ingress/root-budget rejections do not reach dispatch, durable
nonce insertion or R2 PUT. Bounded valid-token requests may forward to the actor
before possession is checked. A verified request rejected during nested dispatch
may already have consumed its nonce; retry with a fresh nonce.

## Whole-request decoder accounting

One explicit `decode::Budget` is shared by frame/token parsing, dispatch, every
nested Item/policy/rekey/keygrant/import/upload decode, backend projection parsing,
R2 envelope verification and ephemeral envelopes. Clones share counters, including
across awaits: 4096 total CBOR value heads (map keys included), 64 MiB total encoded
bytes entering decoders, 16 MiB per decode boundary and depth 128 per boundary.
Allocation-free preflight precedes materialization. Failed scans/schema checks do
not refund admitted work. Ciphertext byte strings are opaque, not recursively
interpreted; legitimate nested decodes charge the same remaining budget.

The Worker forwards bounded spent counters to the actor in private resource
headers, overwriting client values; receivers validate them against fresh caps.
They restrict resources only and never authenticate a request. Generic wire CBOR
has no new global profile cap: array/map/byte/text reservations fail with `TooLong`.
Transport lifetime memory credits remain separate from decoder work accounting.

An export page can exceed the import request's aggregate decoder budget. Restore
clients must split it into smaller ordered import requests, preserving every item,
position, snapshot ref and final retention marker. No truncated inventory or
budget reset inside one import request is permitted. The maintenance drill uses
32-item requests and still verifies the complete restored head/items/objects/refs.

`tests/sec061-cases.mjs` adds 13 actual outer/actor/direct-PUT aggregate rejection
cases, two bad-possession controls and five resource-carry controls (malformed
counters, spent allowances, client overwrite, genuine cross-hop spend and no
counter-based authority). Native `sec061_budget.rs` adds 21 cases,
including concurrent retained clones, failed-scan charges, boundary caps, valid
extensions, opaque ciphertext and no partial append/import effects. Node/work
refusal during commit preserves valid staged bytes for a fresh minimal retry;
actual canonical/protocol corruption still triggers authorized stage cleanup. Debug counters
require both test keys and debug hooks. The test-only wrapper is excluded from
deployment artifacts; real environment configs enable neither test flag.

## Browser CORS

`LOGSVC_CORS_ORIGINS` is a comma-separated list of exact canonical HTTP(S)
origins (no paths, credentials, wildcard or `null`). Absent/empty disables CORS;
malformed, duplicate or oversized configuration refuses. It is transport
visibility only, never authentication, possession, grant or nonce authority.

Environment-specific values to configure through the guarded release path:

- LAB: `http://127.0.0.1:48218,https://lab.tasknotes-app.pages.dev`
- Production, **set later; not deployed by this change**: `https://app.tasknotes.dev`

Only allowlisted origins may get empty unauthenticated OPTIONS responses. The
requested method must be GET/POST/PUT and requested headers must be in the fixed
list: authorization, content-type, x-mdbase-nonce, x-mdbase-sig, range,
x-amz-checksum-sha256. Preflight does not read bodies/auth keys, generate or consume
nonces, look up an actor, or call R2. Denied preflight has no CORS allow headers.
Real responses retain their original status/body stream/WebSocket and existing
RPC auth; allowlisted responses get exact ACAO and exposed object metadata.
Vary preserves existing tokens and adds Origin, including on denied/no-origin
responses. Credentials/cookie access is not enabled. Unhandled platform exceptions
are not converted into successful CORS responses.

Targeted local check after building the real Worker: `LOGSVC_CORS_ONLY=1 node
tests/runtime.mjs`. The CORS cases also run in the ordinary runtime suite. They
use actual WASM/Worker/actor/SQLite paths with synthetic signers and isolated
local bindings; poisoned getters/instrumented bodies verify empty preflight with
no auth/binding/body side effects. They test missing/invalid bearer, invalid
possession, successful signed dispatch and nonce replay. No real deployment or
browser acceptance follows from these tests.

Reuse considered: Connect uses `@fastify/cors` with reflective `origin: true` and
credentials enabled; that Node plugin/policy cannot be reused in this Rust
exact-allowlist Worker. No CORS helper exists in the hosted Worker or Rust log
server. The small adapter uses existing Workers SDK Headers/Url APIs and no new
dependency. It decorates the unchanged authenticated handler, not its auth logic.

## CLOSED native pre-key constructor

`prekey_original.rs` captures only the required profile's bounded public inputs
and actual SDK State/LOG namespace. Missing/malformed public roots, canonical
CP_URL or binding refuse before request-body/private-key/SQL access. The four
private native SDK callbacks are currently denial-only: no genuine CLOSED nonce
producer is wired, so no challenge handle or authenticated witness is issued.
Required serving remains503; ordinary behavior is unchanged. Configuration
capture/export availability is not migration or H0 permission.

The private v2 source pipeline reserves one exact slot before body await, bounds
raw original genesis to64KiB, independently preflights current/next public issuers,
and composes the unchanged native HTTP nonce/MAC/PoP verifier and OriginalCaller
binder. Minimal native verification buffers are wiped on drop. Local Begin DATA
is `[2,handle,challenge32,nonce32,digest32]` (max113bytes); committed CP envelopes
require exact19claims/outer2/domainv2, independent root certificate validation and
actual issuer/transport/original/N/T/challenge binding. V1 cannot satisfy it.

These primitives are behind the existing unavailable producer guard: actual SDK
Begin still refuses before reading body/secret; Accept and Current never release a
positive witness. Signed PG-time checks are non-consuming and never reset RAM
first-use state. External receive/current clock, durable handoff floor, both-way
old-writer/issuer drain and CP continuity remain unqualified. Neither codec/crypto
unit tests nor a public synthetic envelope proves those facts. `/v1/nonce` remains
503; this source change does not enable issuance or change ordinary authentication.

After a fresh remote native build/package, run the isolated checks:

```sh
node tests/prekey-constructor-runtime.mjs
node tests/pitr-closed-runtime.mjs
```

The first uses actual native SDK exports and native opaque IDs in three local
namespaces, with public synthetic configuration and poisoned private getters.
It covers A/D, nil, foreign namespace/object, malformed/missing public inputs,
immutable capture and all503/no-body/no-private-read/no-service-SQL denial. It
does not authenticate a live caller or call CP/provider/LAB services.

## Deployment gates

The checked-in `wrangler.jsonc` is an **evaluation example, not production**.
Environment-specific config, resources, artifact attestation and rollout are managed separately.
Production deployment requires designated owner approval and applicable security clearance.
Authorized isolated LAB integration follows the programme's fast-path process;
LAB execution does not clear a production security blocker.

Before LAB/staging traffic:

- Worker secrets: `LOGSVC_ROOT_KEYS`, `LOGSVC_TOKEN_ISSUERS`, `LOGSVC_URL_SECRET`;
- `PUBLIC_BASE` is the HTTPS service origin;
- no `INSECURE_TEST_KEYS` or `DEBUG_HOOKS` in a real environment;
- R2 staging prefix lifecycle: 24 hours;
- `METRICS` Analytics Engine binding, Workers Logs and traces;
- scheduled log/snapshot/blob export and a restore drill.

Production config refuses missing keys/secrets. HTTPS consumed nonces and the
actor's route identity persist in SQLite. Final R2 writes are conditional,
write-once; direct uploads use staging keys.

`GET /ready` checks the registry actor's SQL, R2 metadata reachability and the
METRICS binding; it never reads collection/object data. `GET /health` is liveness.

The CI artifact `logsvc-do-worker-<run_id>-<run_attempt>` contains the tested bundle,
`SHA256SUMS`, `SOURCE_REVISION`, `BUILD.json` with exact source/run/attempt/producer,
and the evaluation `wrangler.jsonc` (not a deployable production config).
`BUILD.json` uses schema `mdbase-next-log-worker-build/1`; SHA256SUMS hashes
all seven other artifact files exactly once. No extra generated files are uploaded.
It is **unsigned**: ops must attest it and promote it through
its guarded release process. A green local test is not deployment approval.

Backup/restore RPCs are implemented by the log service and its DO backend.
Restartable cut exports retain a fixed source cut across pages and retries.
`backup_begin/page/finish/abort` are CP-only HTTPS RPCs. Ordinary appends continue
past cut H; a 30-minute durable lease fences deletion/settings/snapshot changes.
Security changes and deletion invalidate the export and proceed. The local runtime
suite exercises multi-page inventory, source objects/snapshot refs, interrupted
export/retry, GC/quota/snapshot fencing, append-through and expiry/deletion.
This is not a full portable restore or gate-4 qualification: independent archive
completion, registry/deletion recovery, nonce rotation, exact auxiliary import,
hosted rebuild and the authorized restore drill remain required.
Runtime metrics describe operations and resource use, not collection plaintext.
