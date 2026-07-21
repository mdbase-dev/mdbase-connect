# Google authentication

mdbase connect supports Google Identity Services alongside GitHub OAuth. The
portal uses Google's rendered button, receives a signed ID token in the browser,
and sends it to the Connect server. The server validates the signature, issuer,
audience, expiry, and a one-time nonce before creating its own session. Google
access and refresh tokens are neither requested nor stored.

## Create the Google projects

Use separate Google Cloud projects for development and production. In each
project, configure Google Auth Platform branding and create a **Web
application** client.

For the production client, add this authorized JavaScript origin:

```text
https://connect.mdbase.dev
```

For local development, add the exact loopback origins in use, such as:

```text
http://localhost:8787
http://127.0.0.1:8787
```

The integration uses the popup callback from Google Identity Services, so it
does not require a Google authorization redirect URI. Keep the production
client ID in deployment configuration:

```text
MDBASE_CONNECT_GOOGLE_CLIENT_ID=…apps.googleusercontent.com
```

Do not add a client secret. ID-token verification uses the public web client ID
as its audience.

## Choose registration policy

Registration is closed by default. In that mode, only immutable subjects on a
provider's allowlist may create or open an account. Google identifies accounts
with the ID token's `sub` claim:

```text
MDBASE_CONNECT_REGISTRATION=closed
MDBASE_CONNECT_ALLOWED_GOOGLE_SUBJECTS=109876543210
```

For public account creation, explicitly select open registration:

```text
MDBASE_CONNECT_REGISTRATION=open
```

Open registration applies to every configured external provider. Do not enable
it on the public service until the homepage, privacy policy, support contact,
account lifecycle, monitoring, and abuse response are ready.

To bootstrap the first preview user, configure the client ID while leaving the
Google allowlist empty. Closed registration rejects every Google account in
that state. Attempt a sign-in, find the verified `google_subject` field in the
server warning log, add that value to the allowlist, and restart the service.
The subject is used only for authorization and is not shown in the portal.

## Branding and verification

Configure the production project's application name, homepage, privacy policy,
support email, and verified `mdbase.dev` domain before submitting brand
verification. Request only the basic identity data supplied by Sign in with
Google. Access to Google products such as Drive or Gmail is a separate
authorization concern and is not part of Connect account sign-in.

## Verify the integration

1. Open `/login` and confirm Google's rendered button appears.
2. Sign in with an allowed test account.
3. Confirm `/v1/me` reports `authentication.provider` as `google`.
4. Pair a computer and complete one application authorization.
5. Sign out, then confirm the old session no longer opens the account.
6. Confirm a non-allowlisted account is rejected while registration is closed.
