# Application installation pairing

Installation-device START resolves `installation.app_id` against `applications.id`.
The registry supplies the display name; caller display names never authorize an
application or determine its family. The request must include an exact `Origin`.

`applications.installation_origins` is operator-owned JSON configuration:

```json
{
  "lab": {"app-runtime": ["https://lab.notes.example"], "mobile": ["capacitor://notes.example"]},
  "production": {"app-runtime": ["https://notes.example"]}
}
```

Only the configured deployment environment and requested device kind are used.
Missing application, environment, kind or Origin is refused. The default `{}`
does not authorize installations. Ordinary manifest registrations/upserts do not
change this field; registered names/declaration families retain their existing
registry semantics. Applications still need explicit account/device and
collection consent. This configuration is not an application grant.

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
