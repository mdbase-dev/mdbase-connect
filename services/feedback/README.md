# mdbase feedback Worker

This stateless Cloudflare Worker accepts bounded feedback from configured mdbase editor origins and forwards it to a private support inbox through Resend. It does not store feedback or screenshots.

Product code and request validation live here. Managed Worker names, routes, recipients, secrets, deployment, and verification belong in the private `mdbase-cloud-ops` repository.

## Runtime contract

Route: `POST /v1/feedback` with `Content-Type: application/json`.

Required variables:

- `ALLOWED_ORIGINS`: comma-separated exact editor origins;
- `FEEDBACK_FROM`: verified sender mailbox or `Name <mailbox>`;
- `FEEDBACK_TO`: one support mailbox;
- `RESEND_API_KEY`: secret Resend credential.

Optional variables:

- `TURNSTILE_REQUIRED`: set to `1` to fail readiness unless the secret is present;
- `TURNSTILE_SECRET`: when present, every submission must carry a valid `turnstile_token`;
- `MDBASE_REVISION`: exact 40-character product source commit exposed by `GET /health`.

The browser schema is defined in `apps/editor/src/feedback.ts`. The Worker independently rejects unknown fields, oversized bodies, unapproved origins, arbitrary diagnostics, invalid reply addresses, and screenshots that are not bounded PNG/JPEG data. It sends plain text only and never reflects provider response bodies.

## Local checks

```sh
pnpm --filter @mdbase/feedback-worker typecheck
pnpm --filter @mdbase/feedback-worker test
```

Deploy through `mdbase-cloud-ops`; do not add production credentials or deployment topology here.
