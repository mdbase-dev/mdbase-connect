# Scoped native recovered-file bytes

`runtime/crates/legacy` adds `hosted::recovery::recover_inventory` and the native
`mdbn-scoped-recovery-bytes` stdin component. This is a component INSIDE the SAME
archive verifier, not another verifier, source reader, importer or serving path.
There are no database/URL/path selectors, credential argv or ambient-key fallbacks.

The caller must first verify the selected archive signature/retention/closure,
reconstruct its databases, compare ALL restored rows to the signed row digest,
and establish protected original key custody. Current/retained revision, row
size and original object key are bound by those signed rows, not by a claim that
legacy metadata AEAD covers columns it never covered. Caller-supplied KMS reply
JSON is DATA: the verifier's fixed authenticated KMS adapter owns actual decrypt
custody. Native `Unwrapper` still checks original ciphertext hash/context/KeyId.

The component uses the EXISTING native `Unwrapper`, `decode_file`,
`decode_file_version`, and `verify_object`. All selected keys and complete
metadata/reference closure are checked before the first native object read.
Current+retained membership of the same version merges, never duplicates.
Foreign/orphan/duplicated/reordered/missing rows, wrong keys/AAD/digests, unsafe
sizes, truncated/extra/corrupt bytes refuse. References sharing an object must
have the same owner/size/authenticated digest; each object is hashed once.

Legacy R2 files have **no application encryption**, while their metadata is
AES-GCM sealed. Only AFTER authenticating native metadata and checking the actual
original bytes can their byte count/digest be used as SDK plaintext history
proof. Therefore the returned opaque-capture and plaintext tuples coincide for
this format; simply copying an opaque SHA without the native checks is invalid.

## Private framed stdin (no arguments)

- Four-byte big-endian header length, then <=64MiB JSON.
- Header schema `mdbase-scoped-native-recovery-input/1`: LAB/staging environment,
  signed `source_rows_sha256`, sorted selected `collections`, protected `keys`,
  and complete sorted `objects` (original key, size_bytes, sha256).
- Each collection: account_id, collection_id, original PG-hex wrapped_data_key,
  current and retained rows (file_id, decimal-string sequence, original revision,
  size, original object_key, PG-hex payload_ciphertext). Each current version must
  have its surviving retained row; retained IDs require a current parent.
- Keys: original key environment, optional private base64 legacy_master_key,
  authenticated KMS replies (ciphertext_sha256, key_id, base64 plaintext, exact
  five-field context). No credential/network configuration is selected here.
- Concatenated original object bytes, exactly the declared sizes/order, then EOF.
  <=1GiB per object, <=100000 current and retained rows each, <=1000 collections.
- Output ONLY `mdbase-scoped-recovery-inventory/1`: signed source-row hash plus
  ordered account/collection/file/revision/sequence/current/retained/logical-size/
  original-key/opaque-and-plaintext size/digest tuples. No metadata paths/keys or
  file contents. Errors are generic; private keys/buffers are wiped in native code.

No source re-fencing, original H6 timer reset, archive acceptance, signing or
trust-root substitution occurs. Ops#921 must supply the SAME complete pipeline,
original H6 custody/window and ONE verification. This does not qualify a live
nonempty archive or the full population.

Tests use real native provider-format AES-GCM and object checks. KMS TRANSPORT
is an explicit test double; no cloud KMS/source credentials are used. The paired
Ops isolated-PG test reconstructs/dumps/restores all three genuine schema profiles
before executing the actual compiled native component on restored rows/objects.
