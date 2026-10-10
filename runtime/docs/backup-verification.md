# Offline native backup verification

```sh
mdbn-backup-verify --cut-dir DIR --completion FILE --trust FILE
```

This native tool verifies an authenticated historical capture without a network,
provider, collection key, signing operation or import. Success does **not** verify
current deletion floors, credentials, serving permission, key custody or erasure.
The library accepts exact byte feeds; only the CLI accesses local files.

## Inputs

The caller must independently authenticate and freeze the trust input: the archive
signer's purpose and environment/collection scope, original policy roots and genesis,
and authenticated capture context. Never derive these pins from the archive itself.
The completion attests a successful source finish and binds exact header/FINISH,
all six page sections, original inventory roots/accounting and every committed object.

Use a private immutable local stage. DIR contains **only** `header.cbor`, `finish.cbor`,
`pages/0000000001.cbor` onward, and `objects/<64-lowercase-hex-address>.cbor`.
Completion and trust are distinct sibling files outside DIR. Symlinks, nonregular
files, missing/extra inventory, identity drift and byte mutation refuse verification.
Bulk file handles are closed between passes; each reopen checks the original identity.
These checks do not isolate the tool from an adversarial filesystem. Unsupported OS
identity checks refuse with `io`; the current CLI identity implementation is Linux-only.

## Bounds

There is no override: small inputs <=64KiB, each page <=4MiB, each object <=9MiB;
<=65536 pages/objects, <=64 snapshots, <=32768 expanded refs per snapshot,
<=2097152 retained items and <=4096 entries in each private replay map.
Raw pages <=4GiB, object bytes <=64GiB. All passes share cumulative read/decode-work
limits of 256GiB and a hard 96MiB owned-allocation allowance. Existing local decode
node/depth/work limits remain in force. A combination of individually valid maximum
counts may exceed a shared limit and refuse; nothing is silently truncated.
Memory allowances are conservative and include simultaneous parser/index lifetimes.
Actual allocator and process RSS measurements are separate from these allowances.

## Output

Stdout is exactly one bounded JSON line; handled outcomes have empty stderr.
Success exits 0 and always includes `"current_authority_verified":false`.
Semantic/authenticity refusal exits 1; invocation, I/O and resource refusal exit 2.
Refusals contain only `{"verified":false,"code":"CODE"}`: never paths, collection
IDs, digests, keys, capabilities or content. Treat any refusal as an unverified cut.
