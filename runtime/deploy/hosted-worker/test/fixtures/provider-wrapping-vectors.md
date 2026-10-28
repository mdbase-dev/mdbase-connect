# Real provider → Worker wrapping known answers

`provider-wrapping-vectors.json` is captured output from the real Rust provider
at `8a014fe2abd2d9c6a8b1ed3e77c35cfda3392d3e`, not a JavaScript reimplementation.
All keys, ARNs and payloads are public synthetic test values. `realAws:false`
means the managed service is a deterministic opaque-ciphertext stub. The real
provider runtime invokes its original MDBK encoder; no AWS crypto/IAM is proven.
The adjacent `.provenance.json` records exact capture/generator/log hashes and
separately identifies the actual Rust test producer commit (test-only module)
versus the original provider crypto commit. Do not relabel one as the other.

The unit module `provider-wrapping-vectors.rs` calls original `ProviderCrypto`
for local DEK wrapping and payload encryption, and the existing private managed
test constructor for MDBK encoding. It also checks original-provider unwrap,
AAD/payload parity and refusal cases. There is no production provider change,
fixture-only CP authority, new deployment or fixture Encrypt principal.

Local wrap and payload nonces come from the real provider's OsRng. The emitted
bytes are captured once as immutable known answers; regenerating will yield
new nonce/ciphertext bytes. Do not replace provider randomness, silently bless a
difference, or claim byte-deterministic regeneration. Test KMS ciphertext is
deterministic. The `kmsContext` descriptor is included for every case, but local
AES-GCM still authenticates only its historical collection-key JSON AAD.

## Reproduction

1. Make an **owned** checkout of the exact provider commit and a compatible,
   independently pinned sibling `mdbase-rs` dependency. Do not alter a canonical
   checkout. Original capture uses dependency
   `056db7334a0f49f10373225ae54c1abaedc14e37`.
2. Copy this `.rs` byte-for-byte into
   `crates/connect-hosted-provider/src/key_wrapping/worker_vectors.rs`.
   Append only `#[cfg(test)] mod worker_vectors;` to its parent `mod.rs`.
   Do not alter production crypto, context, encoder or RNG behavior.
3. Freeze all source for the remote lease, and run from that provider checkout:

   ```sh
   rcargo test --locked -p mdbase-connect-hosted-provider --lib \
     key_wrapping::worker_vectors::emit_worker_wrapping_known_answers \
     -- --exact --nocapture
   ```

4. Only after successful completion and a nonzero executed-test count, capture
   the single `MDBASE_PROVIDER_WRAPPING_VECTOR_JSON=` JSON line. Retain original
   log/exit, provider/dependency pins, source/test hashes and fixture SHA256.
   Failure, filtering every test, missing prerequisites or queue interruption is
   not successful vector production. Never manufacture substitute output.
5. Validate the captured document and run the Worker consumer:

   ```sh
   node --experimental-transform-types --test \
     src/legacy-source/provider-vectors.test.ts
   ```

These are cross-language **unwrap** known answers/refusals. Authorized full
end-to-end runs report whichever mode the actual tier's provider genuinely
writes, using header-only source facts and no key material. They do not require
two live modes, and this test does not authorize production observation or infer
live provider-written-record, TLS, grant, native migration or memory acceptance.
