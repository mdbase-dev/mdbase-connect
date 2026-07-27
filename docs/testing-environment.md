# Development and ecosystem testing

The development environment runs the same Connect server image used by the
managed deployment, with disposable or explicitly development-only state. It
supports black-box server tests, native Electron tests, and application tests
from sibling repositories without reading the operator's normal Connect
profile or credentials.

## Trust and isolation

Development authentication replaces the external GitHub or Google identity
provider. It does not replace Connect credentials: pairing, connector tokens,
application access tokens, refresh rotation, grants, and revocation still use
the production protocol.

The environment has four isolation boundaries:

- Compose publishes Connect and NATS on host loopback only.
- Automated tests use a unique Compose project, database volume, random ports,
  passwords, and relay token for every run.
- Electron tests set `MDBASE_CONNECT_USER_DATA_DIR` to a temporary directory,
  so `cloud.json`, agent state, mirrors, sockets, and collection registration
  never overlap the normal desktop profile.
- The connector loopback API receives a separately allocated port.

Automated cleanup removes the containers, network, database volume, Electron
profile, connector state, and fixture collection even when an assertion fails.

## Interactive environment

Start the persistent development stack:

```bash
pnpm dev:environment:up
```

The portal is available at `http://127.0.0.1:8787`. Its development sign-in
accepts a test name and email without contacting an external identity provider.
Inspect or stop the stack with:

```bash
pnpm dev:environment:status
pnpm dev:environment:logs
pnpm dev:environment:down
```

`pnpm dev:environment:reset` deletes only the named development database volume
and starts a clean stack.

Launch Electron with a persistent development-only profile:

```bash
pnpm dev:desktop:isolated
```

Enter `http://127.0.0.1:8787` in the pairing screen and approve the computer in
the portal. This command uses `.tmp/desktop-development-profile`, not the
platform's normal Electron profile. To delete only that development profile
before launching:

```bash
pnpm dev:desktop:fresh
```

Set `MDBASE_CONNECT_DEV_USER_DATA` when a named profile is useful for a
particular application or scenario.

## Automated black-box suites

Run the packaged control-plane contract:

```bash
pnpm e2e:container
```

This builds `deploy/docker/Dockerfile.server`, starts real PostgreSQL and NATS,
checks health and portal assets, creates a development identity, completes
pairing, rejects an invalid connector credential, restarts the server, and
proves the genuine credential remains valid.

Run the native desktop against that packaged server:

```bash
pnpm e2e:desktop:container
```

On headless Linux:

```bash
xvfb-run -a pnpm e2e:desktop:container
```

The desktop suite launches Electron, Chromium, and the real Rust agent outside
Docker. It uses a temporary profile, signs into the packaged portal, approves
the computer there, checks the connected account, creates a real fixture
collection through Electron, and authorizes a consumer through the portal. It
then routes an operation through the Docker relay, verifies application access
in both Electron and the portal, revokes it in the portal, exercises the local
pause boundary, restarts the Docker server, and verifies recovery.

Run both boundaries with:

```bash
pnpm e2e:ecosystem
```

The existing `pnpm e2e:provider` suite remains the production hosted-authority
boundary. Render staging remains responsible for real external OAuth, HTTPS,
proxy, deployment, and multi-service release acceptance.

## Consumer repository tests

Consumer tests should start Connect as an external system and keep
application-specific assertions in the consumer repository. During local
multi-repository development they can import the lifecycle helper from the
adjacent Connect checkout:

```js
import { startConnectTestEnvironment } from
  "../mdbase-connect/scripts/lib/connect-test-environment.mjs";

const connect = await startConnectTestEnvironment({
  // Accept a development manifest served by the application under test.
  allowLocalApps: true
});
try {
  // Start the application with connect.serverUrl, then drive its real
  // authorization and collection workflow.
} finally {
  await connect.close();
}
```

The helper accepts `build: false`, `serverImage`, and `natsImage` when CI has
already built or pulled immutable images. `compose(arguments)` is available for
restart, stop, log, and fault-injection scenarios. Tests must still create a
development session and complete the normal pairing or OAuth flow rather than
seeding bearer tokens directly.

A consumer that needs hosted collections can supply a disposable provider:

```js
const connect = await startConnectTestEnvironment({
  allowLocalApps: true,
  hostedProvider: {
    // Reachable from the Connect container.
    url: `http://host.docker.internal:${provider.port}`,
    // Returned to the browser or application.
    publicUrl: `http://127.0.0.1:${provider.port}`,
    internalToken: provider.internalToken
  }
});
```

This mode is restricted to loopback development authentication. The Compose
stack does not reuse a production provider token or expose the fake provider as
a production configuration. TaskNotes uses this interface in
`scripts/cloud-e2e.mjs`, so its browser vertical slice runs against the packaged
Connect server rather than importing an in-process control plane.

Recommended consumer assertions are:

- the bundled manifest and callback identity are accepted;
- the consent screen shows the exact requested contracts and operations;
- normal create, read, query, update, change, and renewal behavior works;
- records outside the declared contract remain inaccessible;
- reload and server restart preserve the expected application state;
- pause, revocation, stale credentials, and reconnection fail or recover
  visibly and safely.

Keep fast component tests on `@mdbase/connect-dev`'s in-memory sandbox. Use the
container environment for protocol, persistence, networking, packaging, and
cross-process behavior that an in-memory transport cannot represent.
