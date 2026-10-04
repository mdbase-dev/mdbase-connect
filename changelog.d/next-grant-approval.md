## Added

- With `MDBASE_NEXT_CONTROL_PLANE=1`, a daemon reports a device's approval of a grant
  on a private synced collection (`POST /v1/next/grants/:grantId/approval`), with the
  capabilities the user approved and the app key's fingerprint. The report is signed by
  the device key and checked against the log. The control plane honours only the
  approved capabilities, keeps the earliest approval in log order, and stops counting
  an approval when the grant's terms change.
