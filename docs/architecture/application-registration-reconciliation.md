# Application registration and reconciliation

## Decision

An application's immutable identity is its normalized effective manifest digest. The canonical identity therefore includes that digest. A changed effective manifest creates a new application UUID; normalization-equivalent manifests reuse the existing UUID. Grants, access tokens, refresh tokens, provider capabilities, and notification authorization remain pinned to the exact UUID and signed digest they authorized. There is no application-family grant continuity or automatic version migration.

Registration is discovery plus durable scheduling, not a repair barrier. It validates and upserts the exact application, coalesces one reconciliation job keyed by `application_id`, and returns after that transactionally durable work exists. It does not call a provider or relay and does not wait for the number of grants attached to an application.

## Reconciliation owner

A bounded worker leases one exact-application job and scans active grants in stable UUID pages. The job records its cursor, attempts, aggregate failure count and safe error class. It catches failures per grant, so one account or authority cannot block another. A crash leaves a resumable lease; an expired lease can be reclaimed. Failed scans retry with bounded exponential backoff. Successful scans receive a quiet periodic next-scan time, and startup/periodic scheduling creates missing jobs and wakes due scans. Repeated registration uses `ON CONFLICT DO NOTHING`, preserving a lease, cursor, attempts, and completed scan schedule.

Notification reconciliation is subtractive only. Provider synchronization derives declaration identity and digest from the grant's signed application authorization proof, not mutable discovery data or family identity. Exact typed provider 404 responses retain the existing fail-closed collection quarantine or replica revocation behavior.

## Observability

Operational diagnostics are aggregate and identifier-free: job state, attempts, failure count, safe error class, completion time, and next scan time. Logs must not include application, grant, collection, connector, or account identifiers. Provider and relay failures are never recorded as success, but do not turn registration into a generic 502 response.

## Consequences

A new application version requires explicit authorization and starts with zero grants. Obsolete versions remain independent rows until separately retired. Portal version labeling may be added later, but is not required to preserve this authorization boundary.
