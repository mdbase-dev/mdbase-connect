# Candidate beta SDK public surface

Status: implemented beta candidate. The compile-only candidate path is an
unexported alias of the real root entry point, so consumer fixtures cannot drift
onto a parallel handwritten interface.

## Golden path and lifecycle hierarchy

The ordinary hierarchy has three public lifecycle owners:

```text
MdbaseConnect -> MdbaseApplicationSession -> MdbaseConnection
```

- `MdbaseConnect` owns configuration, durable application identity, manifest
  loading, storage, request defaults, and the saved grant registry.
- `MdbaseApplicationSession` owns one application lifecycle: selection,
  authorization/callback, application-declared collection setup verification, and one subscribable
  snapshot.
- `MdbaseConnection` owns a selected grant/authority route and exposes typed
  collection, file, sync, notification, watch, and mutation-recovery methods.

The current fourth conceptual layer, `MdbaseCollectionClient`, remains a
provider-neutral advanced/testing seam but is not part of the golden path and
does not own state. Ordinary applications do not construct or navigate to it.

The factory is `connect.application(options)`. The beta.28
`createApplicationSession` name is removed in the candidate release.
Raw register/authorize/token/transport helpers move to `/advanced`; they do not
remain root aliases.

```ts
const connect = new MdbaseConnect({
  serverUrl: "https://connect.mdbase.dev",
  manifest: new URL("/.well-known/mdbase-app.json", location.href),
  redirectUri: new URL("/auth/mdbase/callback", location.href),
  timeouts: {
    requestMs: 15_000,
    watchStartMs: 20_000,
    uploadMs: 120_000,
    syncMs: 60_000
  }
});

const session = connect.application({
  selection: new MdbaseBrowserSelection()
});

const started = await session.start();
if (!started.ok) return renderProblem(started.problem);

const unsubscribe = session.subscribe(render);
const snapshot = session.getSnapshot();
if (snapshot.status === "unselected") await session.authorize("choose");

const connection = session.connection();
if (connection) {
  const result = await connection.query(
    { types: ["workout"] },
    { timeoutMs: 8_000 }
  );
  if (!result.ok) renderProblem(result.problem);
}
```

## Uniform request options

Every public asynchronous request accepts the same final options parameter:

```ts
export interface ConnectRequestOptions {
  signal?: AbortSignal;
  /** Relative budget. null explicitly disables the applicable SDK default. */
  timeoutMs?: number | null;
}
```

Omission uses the client default for that workload. `0`, negative, non-finite,
and unsafe-integer values are programming errors. Internally the SDK converts
the relative timeout to one monotonic absolute deadline and passes only the
remaining budget through refresh, retry, routing, and decode stages. Each layer
must not restart the clock. Caller cancellation and deadline cancellation are
composed without leaked listeners.

Client defaults are independently configurable for ordinary requests, watch
startup/long-poll, uploads, and sync. `null` is deliberate and documented for
intentional long-lived work; it is not the default for ordinary requests.

Session start, authorization, callback completion, describe/query/read, every
record/type/type-pack/view/timer operation, sync/refresh, notification binding,
files, direct access, token refresh, and management operations all accept this
shape.

## Authorization callbacks

Browser and native shells use one result shape:

```ts
session.completeAuthorization(
  callbackUrl?: string | URL,
  options?: ConnectRequestOptions
): Promise<ConnectOutcome<MdbaseConnection, AuthorizationProblemCode>>;
```

Browsers may omit the URL to use the current location. Native shells pass the
deep-link URL received from the OS. Navigation injection remains a client
option, but callback completion, cancellation, replay, invalid response, and
timeout are the same typed outcomes on both platforms.

## Snapshot adapter

`MdbaseApplicationSession` remains the sole state owner and exposes
`subscribe()` plus `getSnapshot()`. The root package includes a framework-neutral
`externalStore(session)` adapter. A documented React helper is a thin
`useSyncExternalStore` call over that adapter; it introduces no SDK React state
or second client.

## Watch contract

A watch is a bounded startup request returning an explicitly abortable
subscription, not an ordinary promise that intentionally stays pending:

```ts
const opened = await connection.watch(input, options);
if (opened.ok) {
  opened.value.subscribe(onChange);
  opened.value.close();
}
```

The startup and each reconnect use the watch-start budget. The subscription
lifetime continues until `close()` or its lifetime signal aborts. Status and
terminal typed problems are delivered through the subscription contract.

## Durable mutation recovery

The SDK persists the exact encrypted request before dispatch and exposes a
handle that never requires the caller to reconstruct input:

```ts
export interface PendingMutation<Result = unknown> {
  requestId: string;
  operation: MutationOperationIdentifier;
  fingerprint: string;
  status: "pending" | "recovering" | "outcome_unknown";
  createdAt: string;
  recover(options?: ConnectRequestOptions): Promise<ConnectOutcome<Result>>;
}

connection.pendingMutations(): readonly PendingMutation[];
connection.pendingMutation(requestId: string): PendingMutation | null;
```

`recover()` resends the original request identity and bytes. A generic Retry
button may call `recover()`; it may not call the original mutation method with a
new ID. Multiple pending mutations are supported. A handle remains available
after restart until completed/acknowledged, deliberately abandoned before
apply, or expired under the documented recovery horizon.

## Outcome taxonomy

All expected public failures are `ConnectOutcome` data. Raw JSON parse errors,
fetch errors, database waits, and transport implementation errors do not cross
the boundary.

The complete taxonomy is the generated Connect problem catalogue, partitioned
for method-specific unions. Categories remain authorization, availability,
cancellation, compatibility, conflict, integrity, internal, selection, and
validation. Recovery actions remain typed and gain no implicit retry semantics.

`operation_outcome` has only these meanings:

- `not_sent`: the authority durably proves it never accepted the mutation;
- `rejected`: the authority durably proves it accepted but did not apply it;
- `unknown`: the ADR 0005 evidence test is satisfied.

Timeout/cancellation after acceptance returns a `PendingMutation`, either in the
success value where the method contract calls for one or in typed problem
details. Unknown future server codes normalize to the documented unknown
problem, never a thrown decoder exception.

Contract mismatches use the four typed codes and details in
`connect-contract-compatibility.md`. Package-version differences have no error
code.

## Supported exports

The candidate package exports are:

- `@mdbase-dev/connect`: golden path, outcomes, manifests/capabilities needed by
  ordinary apps, connection operations, files, session external store, and
  durable recovery handles;
- `@mdbase-dev/connect/advanced`: low-level collection transport/client,
  token/PKCE plumbing, custom storage interfaces, and test-oriented construction
  seams. The browser and memory selection adapters and the custom selection
  interface remain at the root because every application session needs one;
- `@mdbase-dev/connect/crypto`: key stores, application identity/signing,
  relay/file encryption, and cryptographic binding types;
- `@mdbase-dev/connect-sync`: optional offline replica/sync runtime;
- notification runtime remains independently adoptable and must not become a
  mandatory root dependency.

The compile-only export fixture positively enforces these imports and
negatively enforces removal of beta.28 root crypto/transport aliases. The Phase
4 package build must retain that negative check against the emitted package.

## Compile-spike findings incorporated

The four Phase 0 fixtures live under
`packages/client/test/consumer-spikes/` and compile against the unexported
`packages/client/api-candidate/` declarations. They forced these decisions into
the frozen shape:

- selection adapters stay on the root surface because browser and native
  sessions cannot be constructed without them;
- file operations return typed outcomes, and paged file listing yields typed
  outcomes rather than leaking iterator exceptions;
- sync transport calls receive the same final request-options budget;
- native callback completion accepts `URL` directly;
- watch startup and subscription lifetime are separate; and
- recovery owns its encrypted input, so no `resumePendingMutation(input)`
  compatibility method exists.

The fixtures cover Editor CRUD/types/type packs/views/watch, Workouts session and
small CRUD, Pickle native callback/respond/watch, TaskNotes sync/files/recovery,
and positive/negative root, `/advanced`, and `/crypto` export placement.
