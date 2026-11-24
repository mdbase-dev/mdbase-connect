## Changed

- Bumped the collection mode-switch capability to `collection_mode_switch_v2`
  across Connect server, daemon, hosted/escrow Workers, and `@mdbase-dev/sdk`,
  with a forward migration resetting historical `v1` device advertisements so
  arming a Cloud copy to Private switch requires `v2`-capable clients.
- Refused new collection mode-switch requests with `409 mode_abandoned` while an
  unrekeyed abandoned Private switch exists, aligned `/finish` with the replica
  to accept a qualifying non-adjacent `CloudCopyOff` rekey when it is the first
  rekey after the switch policy, returned `202 publishing_policy` when
  foreground policy publication is deferred, and mounted mode-switch execution
  directly from configuration without a startup Worker HTTP probe.
