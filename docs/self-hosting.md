# Production self-hosting

mdbase connect is open-source software whose primary distribution is the
managed service at `connect.mdbase.dev`. Advanced operators can run the same
control plane themselves. This guide describes a single-host production
deployment with PostgreSQL, Core NATS, and an existing TLS reverse proxy.

The deployment is suitable for a small trusted installation. The operator owns
availability, upgrades, authentication configuration, backups, monitoring,
abuse response, and incident recovery.

## Choose an immutable release

Production deployments must use a signed or annotated release tag, never
`main`. Beta releases are for testing and may require manual migrations.

```bash
git clone https://github.com/mdbase-dev/mdbase-connect.git
cd mdbase-connect
git checkout v0.1.0-beta.9
test "$(git describe --tags --exact-match)" = "v0.1.0-beta.9"
```

Copy the production environment template:

```bash
cp deploy/self-host/.env.example deploy/self-host/.env
chmod 600 deploy/self-host/.env
```

Keep the checkout and its `.env` file outside a web root. The populated file is
ignored by Git and must not be copied into images or backups.

## DNS, TLS, and authentication

Choose a public HTTPS origin such as `https://connect.example.com`.
Authentication may use GitHub, invited email/password accounts, or both.

For GitHub, create an OAuth application with:

- homepage: the exact Connect origin;
- callback: `<Connect origin>/auth/github/callback`;
- device flow disabled.

Fill `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and
`ALLOWED_GITHUB_USER_IDS`. The allowlist contains immutable numeric GitHub user
IDs.

For password authentication, generate `AUTH_RATE_LIMIT_SECRET` and configure
the HTTPS `TERMS_URL` and `PRIVACY_URL` published by the operator. The secret
must be stable and identical across every Connect instance. Leave registration
`closed` and password authentication disabled in the database until deployment
and migration checks pass. Then use the audited operator CLI described in
[`account-authentication.md`](./account-authentication.md) to configure document
versions, enable invite mode, and create invitations.

The optional `auth-admin` Compose profile runs the same CLI as a hardened
one-shot container without exposing an administration endpoint. For example:

```bash
docker compose --env-file deploy/self-host/.env \
  -f deploy/self-host/compose.yml \
  --profile admin run --rm auth-admin policy show
```

Populate `RESEND_API_KEY` and `EMAIL_FROM` to deliver invitations with
`invite create --send-email enabled` and to offer password recovery in the
Connect portal. The same restricted sending credential is passed to the
one-shot operator CLI and the Connect runtime. Without it, the CLI returns the
sensitive invitation URL for delivery through another trusted process and the
portal does not advertise password recovery.

The Compose stack binds application ports to host loopback. Terminate TLS in a
reverse proxy on the same host and forward to `127.0.0.1:8787`. An example
Caddy configuration is in
[`deploy/self-host/Caddyfile.example`](../deploy/self-host/Caddyfile.example).
Do not publish port 8787 directly.

## Generate deployment secrets

Generate independent values for every password or token:

```bash
openssl rand -hex 32
openssl rand -base64 32
```

Use URL-safe hexadecimal values for database passwords and the NATS/internal
tokens. `HOSTED_PROVIDER_MASTER_KEY` must be the base64 encoding of 32 random
bytes. Never replace the hosted-provider or MCP master key after data has been
written: doing so makes existing encrypted key material unreadable.

## Start the control plane

The default stack connects applications to collections whose authority remains
on a paired computer:

```bash
docker compose \
  --env-file deploy/self-host/.env \
  -f deploy/self-host/compose.yml \
  build --pull

docker compose \
  --env-file deploy/self-host/.env \
  -f deploy/self-host/compose.yml \
  up -d
```

The stack runs the database migration as a one-shot service before starting
Connect. Confirm that the service and its dependencies are healthy:

```bash
docker compose \
  --env-file deploy/self-host/.env \
  -f deploy/self-host/compose.yml \
  ps

curl --fail https://connect.example.com/ready
```

Pair the desktop app through the public HTTPS origin and verify an encrypted
create, read, query, update, rename, and delete path before inviting another
account.

## Optional hosted collections

Hosted collections add a separately encrypted PostgreSQL authority. Set
`HOSTED_COLLECTIONS=1`, configure the hosted-provider values, add the provider
hostname to the reverse proxy, and start the profile:

```bash
docker compose \
  --env-file deploy/self-host/.env \
  -f deploy/self-host/compose.yml \
  --profile hosted \
  up -d --build

curl --fail https://sync.example.com/ready
curl --fail https://connect.example.com/ready
```

Record payloads travel directly between authorized clients and the provider.
Keep the control-plane and hosted databases in different volumes and backup
sets. The provider master key must be available to a restore but must not be
stored beside the database backup.

## Optional remote MCP gateway

The MCP gateway has its own PostgreSQL database and stable master key. Configure
the MCP values, add its hostname to the reverse proxy, then run:

```bash
docker compose \
  --env-file deploy/self-host/.env \
  -f deploy/self-host/compose.yml \
  --profile mcp \
  up -d --build

curl --fail https://mcp.example.com/ready
```

Its MCP resource URL is `https://mcp.example.com/mcp`.

## Backups and restore drills

Back up each enabled database independently:

```bash
docker compose --env-file deploy/self-host/.env \
  -f deploy/self-host/compose.yml \
  exec -T control-db pg_dump -U mdbase_connect -Fc mdbase_connect \
  > mdbase-connect-control.dump
```

Repeat for `hosted-db/mdbase_connect_hosted` and `mcp-db/mdbase_mcp` when those
profiles are enabled. Encrypt backups, retain copies outside the host, and
periodically restore them into an isolated deployment. A backup that has not
completed a restore drill is not a recovery plan.

For hosted collections, restore the database together with the same provider
master key. For MCP, restore its database with the same MCP master key. Verify
complete snapshots and current heads before changing production database URLs.

## Upgrades and rollback

Review the release notes, take verified backups, fetch the next immutable tag,
and update `MDBASE_CONNECT_VERSION` to match it:

```bash
git fetch --tags
git checkout v0.1.0-beta.9
docker compose --env-file deploy/self-host/.env \
  -f deploy/self-host/compose.yml \
  --profile hosted --profile mcp \
  build --pull
docker compose --env-file deploy/self-host/.env \
  -f deploy/self-host/compose.yml \
  --profile hosted --profile mcp \
  up -d
```

Only include profiles actually in use. Database migrations run before the
corresponding service starts. Do not roll application code back across an
irreversible migration; restore the pre-upgrade database into an isolated
environment and verify it first.

## Production checklist

- Public origins use HTTPS and resolve only to the TLS proxy.
- Application, database, NATS, and monitoring ports are not publicly exposed.
- Development and Tailscale authentication are disabled.
- Registration is closed, invitation-only, or intentionally open with abuse
  controls.
- Password authentication has a stable shared rate-limit secret and current
  legal-document URLs before it is enabled.
- Every secret is unique, stable where required, and stored outside Git.
- Databases have encrypted off-host backups and a tested restore procedure.
- `/ready`, resource exhaustion, certificate expiry, and backup failures alert
  an operator.
- Logs exclude authorization headers, request bodies, decrypted Markdown,
  private keys, and database credentials.
- Deployments use immutable release tags and record the exact Git commit.

For architecture and data boundaries, read
[`architecture.md`](./architecture.md), [`encryption.md`](./encryption.md), and
[`hosted-provider.md`](./hosted-provider.md).
