# First-party installation device sign-in

This extends the daemon's `/v1/pairing-requests` and `/pair/:id` consent channel when the next control plane is enabled. It does not extend OAuth application grants, controller credentials or relay authority. Desktop requests retain their existing response and one-shot exchange behavior.

## Original request and account selection

`POST /v1/pairing-requests` accepts an additive strict `installation` object:

```json
{"connector_name":"TaskNotes browser","installation":{"request_id":"<original UUID>","pairing_secret":"<pair_ plus 43 base64url characters>","installation_id":"<original UUID>","device_id":"<original UUID>","kind":"app-runtime"}}
```

Mobile uses `kind: "mobile"`. The first-party client generates a cryptographically random 32-byte secret and persists it in protected installation storage, with the original public operation, before this POST. Request/installation/device/kind/name are immutable. The returned verification URI is the existing `/pair/:id` portal. A request ID alone does not retrieve an outcome.

The signed-in user explicitly selects their account with `POST /v1/pairing-requests/:id/select-account`. This is not approval. Authenticated session currentness is rechecked inside the bounded transaction; account replacement refuses. Secret-authenticated `POST .../exchange` returns `202 {status:"pending"}` until selection, then `202 {status:"account_selected", request_id, account_id, connector_id, device_id, installation_id, kind, challenge, approval_mode:"password-ak1"}`. Only now may the host acquire account-scoped custody; no placeholder account namespace.

## Attestation, approval and outcome

`POST .../attest` uses the **original pairing secret** as explicit bearer and exact lowercase-hex `{sign_pk,kem_pk,noise_pk,sig}`. The existing fixed native cp-enrol proof applies to the server's original challenge/connector/device tuple. The server binds kind/installation/request independently; weak keys, invalid signatures or changed original keys refuse. Identical attestation is idempotent.

The portal displays the canonical grouped device fingerprint and asks the user to **approve this app/browser as a device**. `POST .../approve` requires selection, attestation and a current signed-in session. `POST .../deny` irrevocably closes an unconsumed request. Strict-mode accounts refuse addition with the explicit desktop-approval message.

Secret-authenticated exchange returns `awaiting_approval` until approval. The first approved exchange atomically stores the dedicated connector, exact device and hashed installation credential, and marks the original request consumed. It returns `200 {status:"paired", ...original selection, connector:{id,name}, token, registration:{device_id,sign_pk,kem_pk,noise_pk}}`. Concurrent/repeated exchanges return the same credential and exact public outcome. A committed outcome may reconcile after the ten-minute approval window expires; an unconsumed expired/denied request may not resume. Revoked connectors, removed/substituted devices and suspended accounts refuse.

No plaintext bearer or pairing secret is stored in the server database. The original secret capability plus immutable committed tuple reproduce the same scoped credential after a lost committed response. Clients must protect that secret and credential, preserve partial/uncertain outcomes and restore the original native key owner rather than generate another actor.

## Explicit credential scope

The installation bearer is admitted only by:

- `/v1/next/devices/challenge`;
- device-owned cloud-copy creation and owner-device join;
- collection log-token minting (the ordinary fixed device proof and membership checks remain required).

It is not a desktop/controller bearer and is not admitted by ordinary connector management, inventory, relay, grant approval, device re-registration, private bootstrap or account-key routes. CP/log requests omit cookies. Log calls receive only the log token, never the installation credential. The public registration receipt must be protected before native acknowledgement/adoption. Device approval does not establish keyed/readable/Saved state.

## Qualification

The focused real-PostgreSQL suite covers original-request replay/concurrent exchange/lost response, original binding and key drift, wrong secret/account, denial/expiry/session revocation/suspension, strict refusal, credential scoping/revocation and unchanged daemon behavior. Browser/SDK protected installation lifecycle, authenticated immutable release intake, complete TaskNotes task/view flow and LAB deployment remain separate work.
