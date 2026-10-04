## Added

- With `MDBASE_NEXT_CONTROL_PLANE=1`, a daemon reports a device's approval of a grant
  on a private synced collection (`POST /v1/next/grants/:grantId/approval`). The
  report is signed by the device key and checked against the log. The control plane
  then counts the grant as usable for its own services, such as timers and
  notifications.
