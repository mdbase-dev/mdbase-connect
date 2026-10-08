# Hosted Noise route discovery

`MDBASE_NEXT_HOSTED_CLIENT_URL` is an optional, operator-configured HTTPS/WSS
origin (no credentials, path, query or fragment). With the next control plane
enabled, Connect app route discovery prepends a direct target at
`wss://<origin>/v1/hosted/app?collection=<lowercase UUID>`.

The target uses the cloud-copy collection's `next_service_devices` hosted ID and
nonzero 32-byte Noise public key. The latest appended, non-lost device policy op
must enrol that exact key as hosted. Pending/revoked/mismatched keys produce no
hosted target. Discovery checks current token, activated grant, caller/owner,
collection authority, and exact active member-policy binding under the collection
share lock. Private, shadow and left-sync collections have no hosted target.

Hosted `online` is always false. Enrolment, metadata and activation ACKs do not
prove live readiness; the Worker independently admits the Noise session and
checks current policy and key custody. A route target does not turn on hosted
serving or uploads. Existing daemon ordering and fallbacks are preserved.
Without this setting, discovery remains daemon-only.

Real Postgres tests qualify discovery and transition locking, not hosted serving.
