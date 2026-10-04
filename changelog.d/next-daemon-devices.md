## Added

- With `MDBASE_NEXT_CONTROL_PLANE=1`, a connector can register an mdbase-next device
  with proof of possession of its signing key (`POST /v1/next/devices/challenge`,
  `POST /v1/next/devices`), and bind it to its relay socket with `device_bind`.
  Connectors that negotiate `next_device_v1` receive each grant's capability groups,
  Noise client key and fingerprint in their policy snapshots. Existing connectors see
  no change.
