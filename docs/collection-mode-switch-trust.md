# Cloud copy to Private: local switch-set acceptance

The replica implements the device-local switch-set acceptance rule for
Cloud copy → Private transitions. Ordinary policy validity, wire items,
signatures, rekey recipients, and commitments are unchanged.

At the applied `cloud-copy` → `e2e` policy item, a device using its current key
under its local Cloud copy choice records the active keyed user devices and
which of those devices belong to owner accounts. The snapshot, switch position,
chain hash, and epoch commit with the applied prefix. Hosted and escrow are not
members of that set. A mode flag alone changes neither chosen mode nor trust.

Only an owner device in that set with previously persisted local switch intent
may author the `cloud-copy-off` rekey at the slot immediately after the switch.
Its old key is usable for nothing else. Other devices accept that rekey with
that reason, from the frozen epoch, chaining directly to the switch and signed
by a frozen owner. Actual unwrap and commitment verification must succeed.

If the slot after the switch holds a non-rekey item (for example after an
abandoned switch is released), the collection stays Private on the epoch the
services held. The exception survives non-rekey items while policy remains
`e2e` on the frozen epoch, and every frozen owner that is still an active owner
authors the `cloud-copy-off` rekey automatically without local intent. The
first rekey after the switch decides: it is accepted if it qualifies as above
(any position, frozen owner still an active owner); otherwise it consumes the
exception and reports an untrusted state change. Its recipients are ordinary
policy's keyed devices. A late rekey widens nothing that adjacent acceptance
did not already trust: the signer was already a frozen owner, and devices
revoked before it (such as a lost requester) do not receive the new key. Once
no frozen owner is still an active owner, the exception is consumed with the
same untrusted report. No later policy can widen the set or restore a consumed
exception.

**Fleet compatibility and known limits.** The `collection_mode_switch_v2`
capability gates arming and post-floor log-token minting so devices predating
late-rekey acceptance are refused before a mixed fleet can split after an
abandoned switch. A keyed device outside the switch set may author an ordinary
rekey into a released slot first, which consumes the exception. A snapshot
install across a Cloud copy → Private switch is refused like any other
read-ahead, and read-ahead does not see a brief excursion out of `e2e` that
settled replay treats as consuming.

A successful prefix commit records Private, removes Cloud copy consent, and
adds every still-active member of the frozen set to the local trust anchors.
Later revocations remove those members; no later enrolment enlarges the set.
The already accepted epoch remains trusted on its active recipients when its
author is revoked, so they can author an ordinary excluding rekey. Aborted
commits restore the old state; unknown outcomes fence the replica until reopen.
Snapshot/control read-ahead is not an applied prefix and cannot mint a new
switch-set acceptance. Historical control replay covered by an already
committed acceptance does not generate a new unrequested-mode alert.

## Native host contract

`Runtime::private_switch` serializes native-only operations under a live
collection/account guard:

- `Request`: persist intent **before** the control-plane request.
- `ChooseCloud`: persist a new explicit Cloud copy choice before its server
  request, retaining the previous accepted Private witness. Remote flags do not
  set this.
- `Cancel`: only after a known failure before policy commit; never guess from a
  timeout or silently undo a committed switch.
- `Accepted`: read a durably applied, healthy acceptance, not policy metadata.
- `Acknowledge`: only after the native link and registration contain that
  choice.

The daemon projects verified acceptance on a native status observation. An
identity/genesis-bound, owner-only local journal closes the crash window
between `sync.json` and registry updates. Startup replays it before hosts open.
The replica retains a pending native projection until host acknowledgement, so
a crash before projection is also recoverable. The accepted prefix witness
remains after acknowledgement for cold keyring/control-history rebuilds,
including the accepted epoch floor. A later server flag or stale Cloud copy
host configuration cannot undo the local Private choice or make an older,
service-held epoch usable for new Private writes. No remote mode flag creates
this journal.

See [collection-mode-execution.md](collection-mode-execution.md) for the HTTP
controller, policy hold, service cache retirement, and recovery endpoints.
Read-ahead/snapshot install is deliberately not a substitute for replaying the
switch and qualifying rekey on an eligible applied prefix; existing Private
keying remains the only path for devices outside the switch set or catching up
by snapshot.

## Ongoing local trust after acceptance

The entire switch set becomes locally trusted for future ordinary key delivery.
Each accepting device retains its own frozen set in local META, restores active
members as trusted signers, and persists them to the native link on projection.
Revoked members cannot author valid control items and are removed from the
effective local set. Historical introductions and already accepted keys are not
retroactively invalidated: ordinary replay still rejects any new control item
from a revoked signer. Devices added later need normal Private trust; services
cannot bridge a Private introduction chain, even if an existing trusted user
later introduces another service under their own Cloud copy choice.
