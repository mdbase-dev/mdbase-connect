# Development self-hosting

The Docker Compose deployment is for local development. The repository also
contains a hardened single-user Render configuration; see
[Private Render deployment](./deploying-render.md).

```bash
cp .env.example .env
docker compose up --build
```

Open `http://localhost:8787`. Development authentication is enabled by
default, so the portal accepts an email address without proving ownership.
Never expose that mode to the public internet.

The stack consists of:

- one long-running Connect server serving the portal, HTTP API, OAuth
  endpoints, and WebSocket relay;
- PostgreSQL for accounts, connector metadata, discovered applications,
  grants, tokens, and audit metadata;
- no storage for collection paths or record contents.

The server applies security headers, a global request limit, a 2 MiB request
body limit, and public-address checks for application manifest discovery.
`MDBASE_CONNECT_ALLOW_INSECURE_MANIFESTS=1` also allows private-network
manifest hosts and is intended only for local or tailnet staging.

The process refuses development authentication on a non-loopback public URL and
refuses to start unless exactly one authentication mode is enabled. An external
provider mode may offer GitHub and Google together. Registration is closed by
default and uses immutable provider-subject allowlists; public account creation
must be enabled explicitly. See [Google authentication](./google-auth.md). TLS,
secret storage, backups, monitoring, scaling, and incident response remain
deployment responsibilities.

## Connect the desktop app

Start mdbase connect, use `http://localhost:8787` as the service address, and
choose **Pair this computer**. The app opens the portal in the system browser.
Sign in with the development form and approve the named computer. The browser
then returns to mdbase connect, which exchanges a short-lived secret and stores
the resulting connector credential securely. The credential is never rendered
in the portal or copied through the clipboard.

Once paired, use the local app to create or register collections, inspect app
manifests, approve pending requests, edit or revoke grants, pause all remote
access, and review local activity. The portal remains available for account
state, computer naming and revocation, remote grant review, narrowing, and
revocation.

For headless development, the agent still accepts an explicitly provisioned
connector token:

```bash
mdbase-connect-agent \
  --server-url http://localhost:8787 \
  --connector-token con_REPLACE_ME
```

The agent sends collection IDs, display names, spec versions, availability
metadata, and its relay public key. Local filesystem paths are not included in
the sync payload. SDK-created grants use encrypted relay protocol 3 by default,
so the service routes operation ciphertext without receiving record content.
