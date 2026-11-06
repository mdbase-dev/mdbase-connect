# Operator usage report

`usage report` answers product questions — does setup work, do people approve
applications, which applications are used — from records the control plane
keeps. Almost all of them exist to operate the service; the two activity tables
exist for this report because native sync leaves no other trace. It runs as one
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
| `accounts` | `users`; `sessions.last_seen_at` for `signed_in_in_window` | Growth after public signup. Signing in shows a person, not use, so it does not count as active. |
| `activation` | ever-paired computer (app installations excluded), any local, hosted, or current native collection, any activated grant, activity in the window | Which setup step loses people. `created_in_window` isolates the recent cohort. |
| `beta` | `beta_access_requests` matched to accounts by normalized email, `invitations` | Request-to-signup conversion; replaces the paginated client-side report. |
| `pairing` | `pairing_requests` created in the window, without an installation pairing | Whether computer pairing fails before approval. |
| `app_pairing` | the same requests with an `installation_device_pairings` row | Whether app installations fail before approval. |
| `consent` | `authorization_requests` expiring in the window | Whether the approval screen loses people. `abandoned_before_sign_in` counts requests that never reached a signed-in account. |
| `consent_by_flow` | the same requests split by `authorization_code` and `device_code` | Which authorization flow loses people. |
| `collections` | `collections`, `hosted_collections`, `next_collections` | Local, hosted, and native adoption. |
| `transport_users_in_window` | `protocol_usage_telemetry` for direct and relay; the hosted provider's protocol usage, mapped through `account_storage_accounts`, for hosted; `device_activity_days` by device kind for `native` | Direct, relay, hosted, and native reliance. `hosted` is `null` when no provider is configured. |
| `retention` | `users.created_at`, `access_tokens` issuance days, and `device_activity_days` | Whether people come back after setup. |
| `applications` | `grants`, `applications`, `authorization_requests`, `access_tokens`, `device_activity_days` through `installation_device_credentials` | Which applications are connected and in use, and which lose people at consent. |

## Native collections

`collections.native` counts current collections on the next runtime: not left
sync, and with no deletion fact.

- `total`, `private`, `cloud_copy`: current collections and their sync mode.
- `migrated_from_hosted`: collections the migration moved. They keep their ID and
  their `hosted_collections` row, so they count under `hosted` too. Do not add
  the two totals.
- `created_in_window`: collections created here, excluding migrated ones, whose
  `created_at` is the migration time.
- `active_in_window`: collections a device refreshed a log token for.

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
with an access token issued, or a native device active, in the cohort's week
`n`. Week 0 includes setup, so week 1 onwards shows people returning. The most
recent week in every row is the current, partial week. Accounts that only work
directly on the same computer are not counted. Days are database days, which is
UTC on the managed service.

Applications are grouped by `family_identity`, so every declaration digest of
one application counts together; the newest registered name is shown. Legacy
rows without a family identity fall back to their canonical identity.

## What "active" means

An account or application is active in the window when either:

- an access token was issued for one of its grants — tokens last one hour, so
  any application using the relay or a hosted collection refreshes at least
  hourly; or
- the account's connector or provider reported protocol usage; or
- one of its native devices refreshed a log token. Every synced runtime renews
  its log credential every 15 minutes while it runs, on one route, so the first
  successful refresh of a day records a `device_activity_days` row and moves the
  collection's `next_collection_activity.last_active_on`. These write after the
  token commits and failures are ignored, so sync never depends on them. They
  are not joined: there is no history of which account used which collection.
  A desktop app left running counts as active, as an idle application with a
  token always has. Hosted service devices use another route and do not count.
  The window is whole days here, so it can start up to a day early.

An application is active through a device only when the device is one of its
installations. Desktops and the CLI serve every application, so their activity
is attributed to accounts.

Direct same-computer use does not refresh tokens. It is visible only through
the connector's per-account protocol counts, so direct activity is attributed
to accounts, not applications. This is deliberate: the connector does not
report which application used a local collection.

## Known limits

- Native sync recorded nothing before migration `0097_device_activity`. From the
  October migration until that release, `active_in_window`, the transport
  figures, and retention undercount everyone on the new runtime, and that
  history cannot be recovered. `collections.native` and `signed_in_in_window`
  are not affected.
- `paired_computer` counted app installations before this distinction was made
  and now reads lower; nothing about the accounts changed.
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
- `device_activity_days` rows older than the cutoff;
- access and refresh tokens that expired before the cutoff;
- pairing requests, and authorization requests that never produced a grant,
  that expired before the cutoff.

An authorization request that produced a grant is kept with that grant.
Account deletion continues to cascade immediately.
