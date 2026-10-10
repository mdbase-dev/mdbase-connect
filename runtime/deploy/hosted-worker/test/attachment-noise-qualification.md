# Local hosted attachment Noise qualification

Test-only, loopback workerd + real SQLite + production `HostedCollection` handlers,
Engine/WASM, live admission and object reader. A deterministic signed synthetic
CloudCopy fixture uses actual X25519 device/app identities. The SDK initiator has
only its app Noise secret, **no collection CK/signing/KEM key**.

Covered:
- Whole16,778,450-byte READ,19 frames, plaintext SHA-256 and independent byte pattern.
- Exactly8MiB unacknowledged; no additional output or object fetch while paused.
  Offset-zero ACKs drive the one-frame-per-poll bridge without returning byte credit.
- EOF releases resource; same-session range read; cancel then same-session new read.
- Actual native log retirement rejects a subsequent call without plaintext output.
- Native retirement during a held object await prevents plaintext and subsequent
  chunk fetch after the response resumes.
- Old wake attachment gets1012/rehandshake, no plaintext or ciphertext fetch.
- Native HTTP possession signatures verified with the enrolled synthetic Ed25519
  public key and exact `ls-http` transcript; direct206/Range/checksum/BYOB used.

The local LS nonce and token are synthetic; this is not real CP/LOG provider or
issuer/replay qualification. It is not a memory measurement: see the separate
500MB/two-engine conservative live-memory guard. No forced GC here. No production
code hook or activation is added; the test subclass can only retire native
transport authority or mark a socket as belonging to an ended wake.

## Run from `deploy/hosted-worker`

Install the existing SDK/Worker lockfile dependencies. Rust builds use `rcargo`.
Generate the fixture exactly once in a new owned worktree target directory:

```
(cd ../.. && rcargo --pull debug/noise-fixture-v1 run -p mdbn-hosted-worker \
  --example attachment-stream-fixture -- target/debug/noise-fixture-v1 16778450)
```

Set explicit new owned `HARNESS_DIR` and `ATTACHMENT_FIXTURE`, then:

```
node --experimental-transform-types test/build-attachment-noise-workerd.mjs
node_modules/@cloudflare/workerd-linux-64/bin/workerd serve "$HARNESS_DIR/config.capnp"
# In another shell; stop only that owned workerd process afterward:
node "$HARNESS_DIR/client.mjs" "$HARNESS_DIR/client-plan.json"
node_modules/.bin/tsc --project test/tsconfig.attachment-noise.json
```

Fresh output directories preserve failures; the builder refuses an existing
HARNESS_DIR. Workerd listens only on127.0.0.1:19679 and its default outbound is a
local synthetic service, not the internet. Generated config contains only test
seeds. Do not deploy it or point it at LAB/provider data.
