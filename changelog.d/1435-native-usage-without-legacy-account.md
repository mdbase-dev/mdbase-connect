## Fixed

- `GET /v1/me` reports `subscription.usage.hosted_collections` for every native account, including the usual case with no legacy storage account, where `usage` was `null`. A native account's usage no longer asks the legacy storage provider, and its byte figures are `null` (native storage is `native_storage_bytes`).
