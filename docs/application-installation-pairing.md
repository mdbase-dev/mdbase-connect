# Application installation pairing

Installation-device START resolves `installation.app_id` against `applications.id`.
The registry supplies the display name; caller display names never authorize an
application or determine its family. The request must include an exact `Origin`.

Apps self-register their bundled declaration through `/v1/apps/register`; no
operator allowlist is required. A web app may pair from the exact origins of its
registered `homepage` and `redirect_uris`. Opaque redirect origins (`null`) never
authorize pairing. The approval screen shows the registered name and the exact
requested origin, so the user can check where the request came from.

For additional native or loopback locations, an app may include this optional
field in its manifest (both supported contract versions):

```json
{
  "installation_origins": {
    "lab": {"app-runtime": ["http://127.0.0.1:48218"], "mobile": ["capacitor://notes.example"]},
    "production": {"mobile": ["capacitor://notes.example"]}
  }
}
```

Additional origins use only the configured deployment environment and requested
device kind. They must be exact canonical HTTPS origins, loopback HTTP origins,
or mobile `capacitor://` origins: no wildcards, paths, credentials, query or
fragment. Scheme, host and port must match exactly. The field is validated by
the shared manifest validator and persisted in `application_declaration`.
It participates in the canonical digest: changing an origin creates a different
registered application identity rather than widening an existing registration.
A lookalike site submitting the original declaration cannot START from its own
undeclared origin, even if it uses the same display name or declaration ID.

Missing application, deployment environment, device kind or Origin is refused.
Account/device approval and collection consent remain explicit and unchanged.
Declared origins are not a collection grant or publisher authentication.

The existing `applications.installation_origins` column retains extra origins
for older registrations, including TaskNotes migration0066. Manifest upserts
without the optional field preserve that data. It is no longer a prerequisite
for self-registration: the default `{}` permits the app's declared web origins.
No applied migration or persisted pairing/credential identity is rewritten.

Explicit Remove access resolves the request's registered application family and
revokes that family's grants and installation device access for the selected
account/collection. Other families and accounts are not changed. A removal does
not implicitly erase a device's collection-creation consent.

Migration 0066 registers a minimal TaskNotes installation declaration as ordinary
application data. Browser and mobile origins share its record, while the kind
remains part of the immutable pairing/device binding. Contract-rich TaskNotes
OAuth declarations remain separate records in the same family.

Do not rewrite persisted pairing or credential `app_id` values when registering
an application: those values are part of immutable credential derivation. Apps
must supply their registered ID and exact expected display name to the SDK.
The generic SDK path remains browser `app-runtime` custody, not mobile OS custody.
The new registration's ID is `5cdfa020-c201-4da8-845a-f2cc9969eade` on a fresh
registry; its expected name is `TaskNotes`. App registrations return the actual
record ID if the same declaration was already registered.

Old LAB/staging `tasknotes-web` / `tasknotes-mobile` START and reconsent are
refused with `installation_app_not_allowed`; clients show “Sign in again”.
Existing protected stores and immutable credential inputs are not rewritten or
deleted. These aliases were never used in production. This is an explicit
cutover of installation registration, not an alias fallback.

The SDK installation API now requires the app-supplied `appName`. Updating
registration data or SDK configuration does not itself deploy an application.
