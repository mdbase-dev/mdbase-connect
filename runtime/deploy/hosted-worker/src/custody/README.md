# Hosted custody/admission components

Core installs these components; importing them does not activate a Worker.

- `HostedAwsKms`: pinned `aws4fetch@1.0.20`, hosted-only Encrypt/Decrypt, exact
  configured ARN/context/collection allowlist, bounded MDBK v1/96-byte device keys.
- `HostedCustody`: one collection, injected ControlClient and Rust/WASM public-key
  derivation. Config roots/signers come from verified deployment trust, never CP
  record data. One outstanding key lease; `zeroize()` after handoff even on error.
  Extra `noiseSk` is for the trusted Noise adapter; it must be consumed before
  zeroization, never serialized. CP/derived tuple checks are NOT log enrollment or
  app-serving proof. Replaced identities require a fresh instance, not cache reuse.
- `LiveAdmission` in `../admission/`: trusted live observer/Noise/app-authorizer
  injection, default Deny. Structural evidence types are internal bridge values,
  not request JSON. Core must use synchronous `recheck(ctx)` after any await and
  immediately before effects/output/ACK, with no intervening await. Async `check()`
  compatibility alone does not enforce that final boundary. Bootstrap Eligible is
  NOT accepted as serving evidence; specific method/path/record authorization
  remains the engine's responsibility.

With the Worker package dependency installed:

```sh
node --experimental-strip-types --test src/custody/*.test.ts src/admission/*.test.ts
```

Unit fixtures/mock ports test component behavior, not actual KMS, Rust/WASM bridge,
Noise/PoP, signed trust deployment or hosted/shared-isolate memory qualification.
The core owns its package/lock, production factories and runtime integration tests.
