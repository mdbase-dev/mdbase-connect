## Added

- With `MDBASE_NEXT_CONTROL_PLANE=1`, the server keeps an outbox of mdbase-next
  policy ops, written in the same transaction as the change that implies them, and
  appends them as signed policy items to each collection's hosted log. Lost responses
  are retried with the same bytes, a moved head rebuilds the item, and refusals park
  the collection's queue. Private-sync collections can never enrol a hosted or escrow
  device. Requires `MDBASE_NEXT_LOG_SERVICE_URL`, `MDBASE_NEXT_LOG_TOKEN_SIGNING_KEY`
  and `MDBASE_NEXT_LOG_TRANSPORT_KEY`.
