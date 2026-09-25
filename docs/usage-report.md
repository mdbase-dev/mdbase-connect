# Operator usage report

`usage report` answers product questions — does setup work, do people approve
applications, which applications are used — from records the control plane
already keeps to operate. It adds no instrumentation and runs as one
instance-administration command:

```bash
pnpm --filter @mdbase/connect-server instance:admin -- usage report --days 30
```

The window defaults to 30 days and accepts 1–365. Output is JSON with counts
and application names only: no account, collection, grant, or request
identifier, email address, path, query, or record content.

## Figures and sources

| Figure | Source | Decision it informs |
| --- | --- | --- |
| `accounts` | `users` | Growth after public signup. |
| `activation` | ever-paired connector, any local or hosted collection, any activated grant, activity in the window | Which setup step loses people. `created_in_window` isolates the recent cohort. |
| `beta` | `beta_access_requests` matched to accounts by normalized email, `invitations` | Request-to-signup conversion; replaces the paginated client-side report. |
| `pairing` | `pairing_requests` created in the window | Whether computer pairing fails before approval. |
| `consent` | `authorization_requests` expiring in the window | Whether the approval screen loses people. `abandoned_before_sign_in` counts requests that never reached a signed-in account. |
| `consent_by_flow` | the same requests split by `authorization_code` and `device_code` | Which authorization flow loses people. |
| `collections` | `collections`, `hosted_collections` | Local versus hosted adoption. |
| `transport_users_in_window` | `protocol_usage_telemetry` for direct and relay; the hosted provider's protocol usage, mapped through `account_storage_accounts`, for hosted | Direct, relay, and hosted reliance. `hosted` is `null` when no provider is configured. |
| `retention` | `users.created_at` and `access_tokens` issuance days | Whether people come back after setup. |
| `applications` | `grants`, `applications`, `authorization_requests`, `access_tokens` | Which applications are connected and in use, and which lose people at consent. |

## Consent installations

Each consent figure also counts distinct application installations. An
installation ID derives from a per-browser application signing key, so it
separates one browser retrying from many browsers giving up. IDs are counted,
never returned.

- `installations`: distinct installations that started a request.
- `installations_approved`: installations with at least one approval.
- `installations_abandoned_only`: installations whose abandoned requests were
  never followed by an approval in the window, which is closer to real
  drop-off.
- `abandoned_from_installations_that_approved`: abandoned requests from
  installations that did approve: retries, or a signup detour that eventually
  succeeded.

## Retention

`retention.cohorts` splits the window into whole UTC weeks ending today, and
there are `floor(days / 7)` of them (at least 1, at most 52). Each cohort holds
the accounts created in that week. `active_by_week[n]` counts those accounts
with an access token issued in the cohort's week `n`. Week 0 includes setup, so
week 1 onwards shows people returning. The most recent week in every row is
the current, partial week. Retention uses token issuance only, so accounts
that only work directly on the same computer are not counted. Days are
database days, which is UTC on the managed service.

Applications are grouped by `family_identity`, so every declaration digest of
one application counts together; the newest registered name is shown. Legacy
rows without a family identity fall back to their canonical identity.

## What "active" means

An account or application is active in the window when either:

- an access token was issued for one of its grants — tokens last one hour, so
  any application using the relay or a hosted collection refreshes at least
  hourly; or
- the account's connector or provider reported protocol usage.

Direct same-computer use does not refresh tokens. It is visible only through
the connector's per-account protocol counts, so direct activity is attributed
to accounts, not applications. This is deliberate: the connector does not
report which application used a local collection.

## Known limits

- Authorization requests carry no creation time. Their lifetime is capped at
  15 minutes, so `expires_at` stands in for it.
- Local collections registered before migration
  `0033_collection_created_at` have no registration time and are counted in
  `registration_time_unknown`.
- Migrations 0013, 0015, and 0016 deleted incompatible pending authorization
  requests, so consent history before those releases is incomplete.
- MCP client names (Claude, ChatGPT, …) live in the MCP gateway's own database
  and are not part of this report; MCP use appears as the gateway application.

## Retention

The Connect server deletes, once a day, rows that are no longer needed for
authorization and are older than 395 days (about 13 months):

- `protocol_usage_telemetry` rows last updated before the cutoff;
- access and refresh tokens that expired before the cutoff;
- pairing requests, and authorization requests that never produced a grant,
  that expired before the cutoff.

An authorization request that produced a grant is kept with that grant.
Account deletion continues to cascade immediately.
