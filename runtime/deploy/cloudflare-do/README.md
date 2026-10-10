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
