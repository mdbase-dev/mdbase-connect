# First-party installation device sign-in

This extends the daemon's `/v1/pairing-requests` and `/pair/:id` consent channel when the next control plane is enabled. It does not extend OAuth application grants, controller credentials or relay authority. Desktop requests retain their existing response and one-shot exchange behavior.

## Original request and account selection

`POST /v1/pairing-requests` accepts an additive strict `installation` object:

```json
{"installation":{"app_id":"tasknotes-web","request_id":"<original UUID>","pairing_secret":"<pair_ plus 43 base64url characters>","installation_id":"<original UUID>","device_id":"<original UUID>","kind":"app-runtime"}}
```

Mobile uses `app_id: "tasknotes-mobile", kind: "mobile"`. START requires an exact allowed `Origin`: `MDBASE_CONNECT_ENVIRONMENT=lab` admits web `https://lab.tasknotes-app.pages.dev`, staging admits `https://staging.tasknotes-app.pages.dev`, and production admits `https://app.tasknotes.dev`. TaskNotes native uses its declared `https://app.tasknotes.dev` or `capacitor://app.tasknotes.dev` origin. No unknown environment/origin, absent or null Origin, arbitrary URL configuration, unknown app ID or kind mismatch is admitted. These are fixed server maps, not caller-declared trusted origins. The portal shows the map's **TaskNotes** name and recorded origin; optional `connector_name` never supplies installation app identity. Third-party apps continue to use thin application grants.

The first-party client generates a cryptographically random 32-byte secret and persists it in protected installation storage, with the original public operation, before this POST. Request/installation/device/kind/app/origin are immutable. The returned verification URI is the existing `/pair/:id` portal. A request ID alone does not retrieve an outcome.

The signed-in user explicitly selects their account with `POST /v1/pairing-requests/:id/select-account`. This is not approval. Authenticated session currentness is rechecked inside the bounded transaction; account replacement refuses. Secret-authenticated `POST .../exchange` returns `202 {status:"pending"}` until selection, then `202 {status:"account_selected", request_id, account_id, connector_id, device_id, installation_id, kind, challenge, approval_mode:"password-ak1"}`. Only now may the host acquire account-scoped custody; no placeholder account namespace.

## Attestation, approval and outcome

`POST .../attest` uses the **original pairing secret** as explicit bearer and exact lowercase-hex `{sign_pk,kem_pk,noise_pk,sig}`. The existing fixed native cp-enrol proof applies to the server's original challenge/connector/device tuple. The server binds kind/installation/request independently; weak keys, invalid signatures or changed original keys refuse. Identical attestation is idempotent.

The portal displays the canonical grouped device fingerprint and asks the user to **approve this app/browser as a device**. `POST .../approve` carries `{fingerprint}` exactly as displayed and compares it against the attested signing key under the request lock, with selection, attestation and a current signed-in session. Approval extends a nearly-expired window to ten minutes from approval for the first exchange. `POST .../deny` irrevocably closes that unconsumed window. Strict-mode accounts refuse addition with the explicit desktop-approval message.

Secret-authenticated exchange returns `awaiting_approval` until approval. The first approved exchange atomically stores the dedicated connector, exact device and hashed installation credential, and marks the original request consumed. It returns `200 {status:"paired", ...original selection, connector:{id,name}, token, registration:{device_id,sign_pk,kem_pk,noise_pk}}`. Concurrent/repeated exchanges return the same credential and exact public outcome. A committed outcome may reconcile after the ten-minute approval window expires; an unconsumed expired/denied request may not resume. Revoked connectors, removed/substituted devices and suspended accounts refuse.

No plaintext bearer or pairing secret is stored in the server database. The original secret capability plus immutable committed tuple reproduce the same scoped credential after a lost committed response. The pairing secret is therefore a long-lived recovery capability and needs the same protected storage as the bearer; rotation requires explicit device revocation, not a fresh request. Clients must protect both, preserve partial/uncertain outcomes and restore the original native key owner rather than generate another actor.

Credential lifetime belongs to the connector/device, not pairing-window retention. Credentials have no cascading foreign key to either pairing table and authentication reads their exact approved public tuple independently. The daily 395-day cleanup excludes consumed installation windows. Administrative deletion of a window alone cannot revoke the credential; connector revocation or account suspension can.

An explicitly expired/denied **unconsumed** window may be renewed with a new request ID and secret plus `installation.renewal: {request_id:<previous window>, pairing_secret:<previous protected secret>}`. It requires the original authenticated capability and exact installation/device/kind/app/origin. It preserves the previous account, connector, attested key tuple, original challenge and signature, but resets approval and creates a new ten-minute consent window. No native re-sign/rebind or new device is needed. An active window, registered actor, wrong prior capability/binding or parallel second successor refuses. The expired/denied window itself remains closed. This is explicit renewal, never a blind new-actor retry.

## Explicit credential scope

The installation bearer is admitted only by:

- `/v1/next/devices/challenge`;
- device-owned cloud-copy creation and owner-device join;
- collection log-token minting (the ordinary fixed device proof and membership checks remain required).

It is not a desktop/controller bearer and is not admitted by ordinary connector management, inventory, relay, grant approval, device re-registration, private bootstrap or account-key routes. CP/log requests omit cookies. Log calls receive only the log token, never the installation credential. The public registration receipt must be protected before native acknowledgement/adoption. Device approval does not establish keyed/readable/Saved state.

## Qualification

The focused real-PostgreSQL suite covers original-request replay/concurrent exchange/lost response, original binding and key drift, wrong secret/account, denial/expiry/session revocation/suspension, strict refusal, fixed first-party Origin identity, displayed-fingerprint approval, nearly-expired approval extension, explicit same-actor expired/denied renewal, concurrent renewal, daily retention and independent window deletion, credential scoping/revocation and unchanged daemon behavior. Browser/SDK protected installation lifecycle, authenticated immutable release intake, complete TaskNotes task/view flow and LAB deployment remain separate work.
