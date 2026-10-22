# Staging and LAB password-signup IP limit

`MDBASE_CONNECT_PASSWORD_SIGNUP_IP_MAX_ATTEMPTS` optionally sets the maximum
attempt count for the existing `password.signup.ip` bucket. It applies to ordinary
invitation previews and password signup routes, including public signup routes
which already share that bucket. The rolling window remains one hour; blocking
and recovery schedules, per-token/per-email limits, login/recovery limits and the
global authentication limit are unchanged. Existing buckets are not cleared.

When unset, the existing default is **10** in every environment. When set, the
value must be a canonical decimal integer from **1 to 10000**, and the validated
`MDBASE_CONNECT_ENVIRONMENT` must be exactly `staging` or `lab`. An override set
in production, an unspecified/other environment, or a malformed override refuses
server startup. Setting an empty value is not the same as removing the variable.

This is a deployment setting, not a request header, public API or credential.
Normal authentication, legal acceptance, invitation, quota and authorization
checks remain required. A source change does not authorize an environment
operation: staging application belongs to the separately approved release
configuration operation. Account seeding still requires its own operation GO.
