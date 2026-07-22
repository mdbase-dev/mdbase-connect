# Hosted MCP gateway

## Purpose and boundary

`services/mcp` is the deployable `mdbase-mcp` service. It gives OAuth-capable
MCP hosts one remote endpoint:

```text
https://mcp.mdbase.dev/mcp
```

It remains in the `mdbase-connect` repository because its upstream grants,
relay cryptography, and request path must stay compatible with Connect. It is a
separate deployment and database because it terminates application-side relay
encryption and can see operation inputs and results in memory. The Connect
control plane remains payload-blind.

The gateway persists only:

- MCP OAuth clients, access tokens, refresh tokens, and connection-set IDs;
- collection IDs, display names, exact operations, and contract scopes;
- encrypted upstream Connect credentials;
- encrypted P-256 private keys and monotonic relay counters.

It does not persist record payloads, operation results, collection-relative
record paths, or local filesystem paths. Local filesystem paths are never sent
to either the gateway or the Connect control plane.

## Authorization flow

The gateway implements Streamable HTTP MCP, OAuth 2.1-style authorization code
with PKCE, Dynamic Client Registration, authorization-server metadata, and
OAuth Protected Resource Metadata.

1. An MCP host connects to `/mcp` and receives an OAuth resource challenge.
2. The host dynamically registers and starts the gateway OAuth flow.
3. The gateway redirects to the existing mdbase connect authorization screen.
4. The user chooses one collection and its exact operations.
5. Connect issues one collection-scoped capability to the gateway.
6. The gateway issues the MCP host a capability for that new connection set.

`add_connection` creates a random, single-use browser link valid for ten
minutes. Following it repeats steps 3–5 and adds one independently approved
collection to the same set. Every tool call still requires the opaque
`connection_id`; there is no implicit cross-collection query or write.

Revoking or narrowing the application grant in mdbase connect remains the final
authorization control. The local connector independently enforces its cached
exact grant before opening a local collection.

## Tools

Read access provides:

- `list_connections`, `add_connection`, and `describe_collection`;
- `list_changes`, `query_records`, `read_record`, and `validate_collection`;
- `read_type`.

When the MCP OAuth grant includes `mdbase:write`, the gateway also advertises:

- `create_record`, `update_record`, `delete_record`, and `rename_record`;
- `create_type` and `update_type`.

The Connect grant may be narrower than the MCP OAuth scope. In that case the
gateway rejects an unavailable operation and tells the user to reconnect with
broader collection access; it never expands the upstream grant itself.

## Local development

Run both TypeScript services directly on the host so each loopback origin can
fetch the other's development manifest:

```bash
MDBASE_CONNECT_DEV_AUTH=1 \
MDBASE_CONNECT_ALLOW_INSECURE_MANIFESTS=1 \
DATABASE_URL=memory \
PUBLIC_URL=http://127.0.0.1:8787 \
pnpm --filter @mdbase/connect-server dev
```

In another terminal:

```bash
MDBASE_MCP_MASTER_KEY=local-development-master-key-change-me \
MDBASE_CONNECT_URL=http://127.0.0.1:8787 \
DATABASE_URL=memory \
PUBLIC_URL=http://127.0.0.1:8790 \
pnpm --filter @mdbase/connect-mcp dev
```

The local connector still points at `http://127.0.0.1:8787`. Generic MCP
clients point at `http://127.0.0.1:8790/mcp`. A hosted Claude or ChatGPT service
cannot reach a loopback development URL; use a secure development tunnel when
testing those hosts.

## Runtime configuration

| Variable | Purpose |
| --- | --- |
| `PUBLIC_URL` | Exact public MCP origin, with no path |
| `DATABASE_URL` | Gateway-only PostgreSQL connection |
| `MDBASE_CONNECT_URL` | Exact Connect control-plane origin |
| `MDBASE_MCP_MASTER_KEY` | Stable random secret, at least 32 characters |
| `MDBASE_MCP_TRUST_PROXY` | `1` only behind the trusted production proxy |
| `HOST`, `PORT` | Listener address; defaults are `127.0.0.1:8790` |

The master key is not recoverable from the database. Back it up in the hosting
provider's secret store. Rotating it without a credential re-encryption
migration requires users to reconnect. Startup verifies a durable encrypted
marker and fails closed when the configured key does not match the database.

## Production finalization

The Render Blueprint already defines the `mdbase-mcp` service, its private
PostgreSQL database, health check, migration command, generated master key, and
`mcp.mdbase.dev` custom domain.

After deploying the branch:

1. In Render, create or update the Blueprint and confirm the MCP service and
   `mdbase-mcp-db` are provisioned in the same region as Connect.
2. Preserve the generated `MDBASE_MCP_MASTER_KEY`; do not regenerate it on
   routine deploys.
3. Add `mcp.mdbase.dev` as the service's custom domain. Render will show the
   exact DNS target for that service.
4. At the authoritative DNS provider, create a CNAME named `mcp` pointing to
   that Render target. Remove any conflicting A, AAAA, or CNAME record first.
5. Wait for Render to verify the domain and issue TLS before testing OAuth.
6. Confirm these endpoints return success over HTTPS:
   `/health`, `/ready`, `/.well-known/oauth-protected-resource/mcp`,
   `/.well-known/oauth-authorization-server`, and
   `/.well-known/mdbase-app.json`.
7. Add `https://mcp.mdbase.dev/mcp` as a Claude custom connector or a ChatGPT
   developer-mode app. Complete OAuth, approve one collection, call
   `list_connections`, then use `add_connection` to approve a second.
8. Revoke one collection grant in mdbase connect and verify its next tool call
   fails while the other collection remains available.

For a public launch, `MDBASE_CONNECT_REGISTRATION` must either be `open` or the
intended users must be present in the configured identity-provider allowlists.
Opening registration also requires the account lifecycle, privacy, support,
monitoring, backup, and abuse-response gates described elsewhere in this
repository.
