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
