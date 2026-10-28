# Private to Cloud copy: owner handover primitive

This is the runtime key-delivery portion of the existing-collection conversion,
not a complete switching feature. It does not add a server transition executor,
readiness/completion response, SDK/daemon operation, or interface control.

After an owner-authorized policy item consistently enrols hosted/escrow and
selects Cloud copy, an existing active keyed owner device may wrap its current
epoch to the unkeyed services. It does so only when its own host has persisted
the user's Cloud copy choice (`chosen_state` and opt-in), its key is trusted,
and it actually holds the current epoch. A server-written policy flag alone
cannot cause this handover. Editors and services cannot use this owner path.

The ordinary signed `key_grant` format is used. Hosted receives the existing
epoch; older epochs are recovered through their already authenticated rekey
history boxes and commitments. There is no new epoch, log, genesis, wire format,
or service-created bootstrap. Existing service-to-user-device grants and escrow
fallback scheduling are unchanged.

Real-signature/HPKE tests cover two existing Private epochs, unrequested mode
changes, owner-role loss, lost replies, both source and recipient restarts, and
subsequent cloud-copy writes. They are not yet SDK/daemon conversion E2E or
hosted app-serving admission tests. A collection with an already accepted Private switch also needs a new durable
local Cloud copy intent that supersedes that local choice without discarding its
accepted-prefix witness; this draft does not connect that native transition yet.
Receiver devices select Cloud reading automatically after a valid current-epoch
grant to an active hosted/escrow device by a currently trusted, non-revoked Private
owner. This selection is local and separate from source consent: no prompt, no
new wire payload, and no handover permission on later promotion to owner. The
passive notice identifies the owner device. Ordinary Private delivery/introduction
trust must authorize that signer; its own self-delivery is not another device's
anchor. The selection commits with the exact applied prefix, not read-ahead.

The eventual controller must separately verify admission/readiness before recording success, and must persist the local
choice from explicit user intent rather than infer it from remote metadata.
