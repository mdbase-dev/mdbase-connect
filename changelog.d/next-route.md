## Added

- With `MDBASE_NEXT_CONTROL_PLANE=1`, `GET /v1/next/collections/:id/route` tells an
  app with an access token where to open its mdbase-next Noise session. Each target is
  `{kind, device, noise_pk, url, relay_collection}`; for a local collection that is its
  daemon, through the relay. Grants without a registered Noise key get
  `409 client_key_required`.
- `GET /v1/next/apps/collections` lists the collections the calling app installation
  can switch between, one per active grant, with their state and whether they can be
  routed over Noise.
