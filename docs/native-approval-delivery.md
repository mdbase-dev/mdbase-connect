# Private approval delivery

Private consent must reach Native through the existing relay policy push, not
wait for the periodic renewal clock. `createNativeApprovalDelivery` is shared by
ordinary Native approval, unified installation/Native approval, and credential
completion. It only delivers already committed, active grants. It neither
creates consent nor changes the original authorization, PKCE, signing/Noise
keys, installation, account, capabilities or selected collection.

The audience uses the same `nativeDevices` and `nativeGrantStanding` checks as
relay admission: only the consenting account's desktop/CLI devices with exact
appended, nonrevoked enrollment in the current Private collection. Another
member's device, an unenrolled device, an app runtime, and Hosted scopes are not
substitutes. The relay builds current policy and checks the exact session ACK,
including its existing local/cross-instance timeout and generation fences.

## Request publication precedes the feed

Connect, not the SDK, queues the original policy `grant` request. A Native feed
ACK does not append that request to the collection's log. Native waits until its
replica sees the request, then signs and seals its own kind6 approval.

The shared postcommit delivery barrier first calls the existing PolicyEmitter's
`publishCommitted` entry. It uses the same per-collection lock, persisted batch
bytes, signer and conditional append; it does not wait for the global drain's
unrelated service activation. Four deduplicated active wakes are admitted, with
no memory queue; overflow stays in the original durable outbox. Parked or lost
work is not reported as published. An eight-second HTTP courtesy deadline stops
only the caller's wait: the emitter owns late work through shutdown, and unknown
outcomes retain their original batch bytes. Failure is nonfatal and still allows
the existing current-policy relay delivery and reconciliation paths.

A PostgreSQL counterexample holds unrelated global activation work after a
verified Private genesis. Before the fix, delivery pushed the feed with no grant
request in the log; the targeted wake publishes that same request first. This
proves the local missing-wake case, not the missing stage in historical run2156,
whose retained INFO trace did not capture request/application events.

## Commit and completion

- Ordinary approval delivers after its canonical transaction commits/releases.
- Unified approval delivers only after both original Native consent and the
  account-only installation transaction commit. Rollback never publishes an
  uncommitted grant. Original zero-Hosted scope and SDK-owned installation ACK
  remain unchanged.
- A status poll can see committed approval before its push finishes. Initial
  code/device-code issuance and refresh therefore use the same delivery barrier
  **after token COMMIT and connection release**, before returning the original
  credentials. No transaction lock or pool connection is held waiting for ACK.

Delivery failure is nonfatal: keep the committed consent, consumed code/refresh,
issued tokens and original key binding. Emit only a fixed diagnostic and retain
the existing 20-second policy renewal fallback. Do not retry approval, issue
replacement credentials, add a queue, or alter the durable log producer.

A policy ACK is not physical Native grant materialization, sealed kind6,
`Effective`, FIRSTREADY, or read/write acceptance. Native retains its existing
original-key checks, account/session/runtime/lease fences and activation wait.
Live functional qualification remains separate from these delivery tests.
