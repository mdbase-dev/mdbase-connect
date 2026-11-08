## Fixed

- Show the native 1 MiB document limit on the Account page for accounts on the
  native runtime, instead of the legacy hosted provider's 2 MB entitlement.
  `/v1/me` now reports the replica's record source cap as `max_document_bytes`
  for those accounts, pinned to the runtime constant by a test.
