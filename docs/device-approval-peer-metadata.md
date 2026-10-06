# Signed device-approval candidate metadata

This CP transport carries the actual Replica453/269 signed canonical envelope without changing its bytes. It is not a USER Noise channel, app-grant pipe, log credential, key delivery or approval/current-applied witness.

The feature inherits the configured NEXT device-route mount and paired connector authentication. Device-origin Ed25519 is checked against the entire independently registered sender tuple, not an embedded key. Both registered USER tuples must have CP-mirrored appended enrolments/current membership and no pending revocation/removal. CP PRIVATE mode and active account/connector/device/credential rows are checked after locks. These routing checks do **not** establish native applied policy, held private epoch, KEYED status, current commitment or approval authority.

## Fixed profile (local source, not runtime-qualified)

Base: `/v1/next/collections/:collection/device-approval`.

- `POST /peer`: `{peer: base64url}`; canonical signed envelope ≤2048 bytes, no padding. Response `{id, outcome:"queued"}` means only accepted candidate metadata, possibly a historical exact retry.
- `POST /inbox`: `{device_id, challenge, sig}` using the existing fresh challenge and Ed25519/H primitives. Digest is `H("mdbase/v1/device-approval-peer-inbox", cbor[challenge32, connector16, device16, collection16])`. Response `{messages:[{id,peer}], acknowledged:0}`.
- `POST /ack`: inbox fields plus `ids` (1..16 unique UUIDs). Digest is `H("mdbase/v1/device-approval-peer-ack", cbor[challenge32, connector16, device16, collection16, [id16...]])`. Response includes the count of newly acknowledged metadata. **Never reuse `sas_commit` for a transport digest.**

POST bodies ≤8192 bytes; 30 requests/minute. Fixed bounded metadata SQL transactions, five-second statement/lock waits and nine-second whole application budget. Per device, at most16 unexpired sent and16 received candidates across collections. Expiry is the signed UTC expiry, future at admission and ≤120 seconds. Expired rows are removed write-side only. Exact same generation/kind/full bytes retain their identity; changed bytes conflict. ACK hides a candidate but retains its identity through expiry, so a lost sender response cannot resurrect an acknowledged exchange under a new ID.

The native receiver must independently validate the bound collection, full current USER/member tuples, private epoch/custody, latest commitment and r_A generation, expiry, source/account incarnation and authenticated applied policy before and after awaits. The requester persists original NewDevice state and the entire selected signed challenge/witness before code or reveal output. ACK only after that required local persistence/current-context check; metadata ACK is never approval success. Missing native dependencies remain DENY.

Current local evidence:16 Node codec/signature cases and6 actual PostgreSQL cases, including loopback HTTP bearer/inbox/exact ACK proof, queue/dedup/ACK/current credential/membership/revocation and expiry/revocation during real collection lock waits. Types, full Node CI and fresh remote CLI/local legacy MVP regression pass. PostgreSQL membership/enrolment fixtures are explicit stand-ins for CP eligibility; no real LS, signed publication, native requester/typed port, applied grant or LAB acceptance is claimed. Ordinary remote CI/security and actual Rust-produced interoperability remain separate requirements.
