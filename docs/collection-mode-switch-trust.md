# Cloud copy to Private: local switch-set acceptance

The replica implements the approved device-local switch-set rule. Ordinary
policy validity, wire items, signatures, rekey recipients and commitments are
unchanged. The contract amendment is tracked separately in
https://github.com/mdbase-dev/mdbase-next/pull/995.

At the actual applied cloud-copy-to-e2e policy item, a device using its current
key under its local Cloud copy choice records the active keyed user devices and
which of those devices belong to owner accounts. The snapshot, switch position,
chain hash and epoch commit with the applied prefix. Hosted and escrow are not
members of that set. A mode flag alone changes neither chosen mode nor trust.

Only an owner device in that set with previously persisted local switch intent
may author the exceptional `cloud-copy-off` rekey. Its old key is usable for
nothing else. Other devices accept only a valid rekey immediately following the
switch, chaining directly to it, with that reason and a frozen owner signer.
Actual unwrap/commitment verification must succeed. Any intervening item or
non-qualifying rekey consumes the exception and reports an untrusted state change.
No later policy can widen the set or restore the consumed exception.

A successful prefix commit records Private, removes Cloud copy consent, and adds
every still-active member of the frozen set to the local trust anchors. Later
revocations remove those members; no later enrolment enlarges the set. The already
accepted epoch remains trusted on its active recipients when its author is revoked,
so they can author the ordinary excluding rekey. Aborted commits restore the old state;
unknown outcomes fence the replica until reopen. Snapshot/control read-ahead is
not an applied prefix and cannot mint a new switch-set acceptance. Historical
control replay covered by an already committed acceptance does not generate a
new unrequested-mode alert.

## Native host contract

`Runtime::private_switch` serializes native-only operations under a live
collection/account guard:

- `Request`: persist intent **before** the control-plane request.
- `ChooseCloud`: persist a new explicit Cloud copy choice before its server request,
  retaining the previous accepted Private witness. Remote flags do not set this.
- `Cancel`: only after a known failure before policy commit; never guess from a
  timeout or silently undo a committed switch.
- `Accepted`: read a durably applied, healthy acceptance, not policy metadata.
- `Acknowledge`: only after the native link and registration contain that choice.

The daemon projects verified acceptance on a native status observation. An
identity/genesis-bound, owner-only local journal closes the crash window between
`sync.json` and registry updates. Startup replays it before hosts open. The
replica retains a pending native projection until host acknowledgement, so a
crash before projection is also recoverable. The accepted prefix witness remains
after acknowledgement for cold keyring/control-history rebuilds, including the
accepted epoch floor. A later server flag or stale Cloud copy host configuration
cannot undo the local Private choice or make an older, service-held epoch usable
for new Private writes. No remote mode flag creates this journal.

This PR does **not** connect the HTTP transition executor, service cache/key
cleanup, SDK/UI controls, or a mode-switch completion response. The eventual
controller must serialize policy publication so no unrelated item is appended
between the switch and its owner rekey. Read-ahead/snapshot install is deliberately
not a substitute for replaying the switch and adjacent rekey on an eligible
applied prefix; that acceptance path needs separate qualification before a
snapshot-only conversion path can be offered. Existing Private keying remains
the only path for devices outside the switch set.

## Ongoing local trust after acceptance

Co clarified on 2026-10-28 that the entire switch set becomes locally trusted for
future ordinary key delivery. Each accepting device retains its own frozen set in
local META, restores active members as trusted signers, and persists them to the
native link on projection. Revoked members cannot author valid control items and
are removed from the effective local set. Devices added later need normal Private
trust; services cannot bridge a Private introduction chain, even if an existing
trusted user later introduces another service under their own Cloud copy choice.

Real-key regressions exercise a later Private rekey from another set member and
an untrusted post-switch hosted introduction through a later server mode cycle.
The latter unwraps successfully but remains untrusted on the device that never
opted back into Cloud copy. Ordinary policy validity and introduction history are
unchanged; no rekey vouching payload, wire field or additional ceremony exists.
