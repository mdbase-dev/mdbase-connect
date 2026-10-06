## Added

- Let a device enrolled in a synced next collection renew its role-0 log
  token (`POST /v1/next/collections/:id/log-token`, signed with a fresh
  device challenge). The token covers that one collection, lasts 15
  minutes, and is issued only while the device's exact enrolment has been
  acknowledged by the log and not revoked. It grants no membership or key.
