# Scoped archive original-H6 transfer

Named recovery profile: `mdbase-recovery-set/scoped-hosted-v1`, LAB/staging only.
The existing trusted ONE-verifier acceptance route accepts the common archive
metadata plus strict `scoped_recovery`: complete inventory/selection/row/native
recovery inventory hashes, original H6 journal hash, and ordered original source
fences with exact run/start/head/counters/watermark and raw-reply hashes.
Each fence requires `in_flight` 0; `unresolved` and `applied_unreceipted` are
retained journal evidence (non-negative safe integers), bound exactly but not
required to be zero (provider H6 settlement, docs/hosted-migration-provider.md).
The parser/SQL guard do not verify signatures or substitute for the ONE verifier.
There is no public pre-fenced flag or unsigned receipt-adoption endpoint.

Acceptance and ordinary current-archive checks require the exact complete frozen
cohort inventory and ordered selected source union. Missing, duplicated, foreign,
reordered or later fences refuse. Original starts must precede archive capture.
The existing 4096-byte acceptance transport bound remains: oversized cohorts
refuse, never truncate. This slice does not qualify the full-population archive.

The existing native Worker driver still calls its ordinary `fence` and `source`
fronts. For a current accepted scoped archive, CP requires the SAME started claim
(which must follow actual archive acceptance), full binding and original source
identity. It freshly reads provider source/watermark, compares every original
field, and passes the unchanged native fence/source DTO back. **No provider fence
POST is made.** Original archive lineage is checked again around provider awaits;
no SQL lock spans them. A stale/missing scoped receipt cannot fall back to a new
physical fence. The original run/start is never taken from latest provider state.

Existing v4/zero/ordinary fixture paths keep their prior behavior. Source/witness
`m.started_at` checks are unchanged; there is no shortcut around native CPP,
MayFence, drain, timers, key custody, external-I/O or readiness. Original Ops
BOOTTIME includes archive/capture/verification/start/native/readbacks and must
never reset. Cross-database atomicity is not claimed.

Migration0082 adds only the named structural profile to the existing acceptance
constraint/elapsed validator; historical migrations/receipts and the immutable
acceptance trigger remain unchanged. Product CP tests use real isolated PG and
provider I/O doubles. Live native-driver/restore qualification still requires
cloud-ops#921's real producer, SAME signer/ONE verifier, native recovered bytes
and original journal custody. No nonempty producer gate is opened by this code.
