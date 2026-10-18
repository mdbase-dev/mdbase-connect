## Added

- Add migration-service-only, idempotent AppendBase abort-barrier and receipt
  endpoints. A signed freeze fences publication on the original uncutover
  shadow log; metadata alone cannot authorize native cancellation or rollback.
  Requires the separately qualified native publication-exclusion consumer and
  receipt-qualified rollback. Never unfreezes or renews an expired backup hold.
