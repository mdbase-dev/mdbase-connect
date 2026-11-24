## Changed

- Bumped the collection mode-switch capability to `collection_mode_switch_v2`
  across Connect server, daemon, hosted/escrow Workers, and `@mdbase-dev/sdk`,
  using a dedicated `next_devices.mode_switch_v2_advertised` column so arming a
  Cloud copy to Private switch requires fresh `v2` advertisements that older
  servers cannot populate, and included connector `names` in
  `409 mode_devices_need_update` responses.
- Refused new collection mode-switch requests with `409 mode_abandoned` while an
  unrekeyed abandoned Private switch exists (with cumulative bounded log scan
  progress persisted on the change row), refused `/abandon` when a rekey after
  the switch policy has already been observed, let `/finish` accept the native
  receipt of a rekey that is not adjacent to the switch policy, returned
  `202 publishing_policy` when foreground policy publication is deferred, and
  mounted mode-switch execution directly from configuration without a startup
  Worker HTTP probe.
