## Changed

- The portal no longer reads native storage usage on its 15-second background
  refresh. It reads it when the account page opens, when the tab gains focus
  or becomes visible (unless it read it in the last 30 seconds), and at most
  every 5 minutes otherwise; a failed read is retried on the next refresh, and
  other refreshes keep the last figure. `GET /v1/me?native_storage=omit` leaves out
  `subscription.native_storage_bytes` and asks no collection log; without the
  parameter the response is unchanged, including `null` when a log can't answer.
