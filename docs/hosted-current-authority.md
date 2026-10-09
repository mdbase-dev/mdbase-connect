# Hosted current authority reads

The existing service-token-authenticated directory, service-device and log-token
routes remain the control-plane surfaces for hosted and escrow deployments. They
now return `Cache-Control: no-store`.

A permanent collection deletion fact makes the directory state `unknown`, even
when retained collection rows still describe a cloud copy. Wrapped-record reads
and token mints use the existing bounded transaction and collection lock, check
permanent deletion before loading a record, then check the existing policy outbox
for device revocation before returning that record or minting a credential.
Queued revocations already deny; they need not have reached the log. Neither
check deletes or rewrites retained rows. Database/authority failure is an error,
not absence or a successful credential.

Considered the existing deletion helper, device-revocation helper, bounded
transaction and collection lock; reused those instead of adding another registry,
snapshot, receipt or authentication surface.

## Restore composition

A restore must contact the configured authenticated **live** control plane, not a
restored control-plane copy. Read current state before any key import, then obtain
only the current deployment kind's original service-device record. Keep original
collection/device identity and verify the original signed genesis using existing
policy pins before unwrapping keys. An absent, unknown, revoked, malformed or
unreachable authority refuses the operation.

These responses do not certify an empty destination or authorize a later import
or serving transition. The restore owner must bind the actual source and genuinely
empty target, preserve current deletion/revocation authority, and perform current
checks at its existing import/publication boundaries. No caller-supplied boolean,
archived authority, old response or successful parser substitutes for that binding.
Actual end-to-end restore qualification and live operations remain separate.
