## Fixed

- `GET /v1/me` now reports a native account's `subscription.usage.hosted_collections` as the number of collections its hosted-collection limit counts (owned, synced, not deleted and not left sync), instead of the legacy storage provider's count, which was always 0 for native accounts.
