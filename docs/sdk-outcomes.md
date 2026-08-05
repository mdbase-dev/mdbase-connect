# SDK outcomes and recovery

`@mdbase-dev/connect` returns expected failures as typed data. Network outages,
authorization changes, invalid collection setup, incompatible versions, user
cancellation, validation failures, and uncertain writes do not need exception
handling.

```ts
type ConnectOutcome<Value, Code> =
  | { ok: true; value: Value; diagnostics: MdbaseDiagnostic[] }
  | { ok: false; problem: ConnectProblem<Code> };
```

Exceptions are reserved for programming errors and broken SDK invariants.
Application code handles the discriminated outcome directly; the root package
does not expose a throwing outcome adapter.

## Handling a problem

Every public problem has stable fields:

- `code` identifies the exact condition;
- `category` supports grouping and telemetry;
- `recovery` tells the UI which next action to offer;
- `message` is safe as a fallback explanation;
- `details` carries code-specific structured context;
- `operation_outcome` distinguishes `not_sent`, `rejected`, and `unknown` for
  operations where delivery matters;
- `trace_id` may identify a server-side request without exposing collection
  data.

The recovery action should drive the primary UI. The exact code can refine the
copy and details:

```ts
import type { ConnectProblem } from "@mdbase-dev/connect";

function presentProblem(problem: ConnectProblem) {
  switch (problem.recovery) {
    case "retry":
      return showRetry(problem.message);
    case "reauthorize":
      return showReconnect(problem.message);
    case "upgrade_collection":
      return showCollectionUpgrade(problem.message, problem.details);
    case "repair_collection":
      return showCollectionDiagnostics(problem.message, problem.details);
    case "resolve_outcome":
      return showReconciliation(problem.message);
    case "resume_connector_access":
      return showResumeConnector(problem.message);
    default:
      return showExplanation(problem.message);
  }
}
```

Each SDK method exposes only the known codes it can return. For example,
collection mutations include conflict, validation, setup, availability, and
uncertain-outcome problems, while notification registration exposes its own
narrow union. This lets application code handle a method exhaustively without
depending on an unbounded global error enum.

## Forward compatibility

A newer server or connector may report a code that an older SDK does not know.
The SDK preserves it without lying about its semantics:

```ts
{
  code: "unknown",
  server_code: "future_connector_state",
  category: "unknown",
  recovery: "none",
  message: "…"
}
```

Always render the fallback message for `unknown`. Do not treat an unfamiliar
problem as retryable or assume that authorization will fix it. Updating the
canonical problem catalogue generates the TypeScript types, JSON Schema, and
Rust metadata together when a future known code is introduced.

## Collection setup

Connect deliberately distinguishes setup conditions because they need
different user actions:

| Problem code | Meaning | Recovery |
| --- | --- | --- |
| `collection_version_unsupported` | The operation needs a newer collection profile, including writes to a v0.2.x collection | Offer an explicit collection upgrade |
| `collection_configuration_invalid` | `mdbase.yaml` is malformed or unsupported | Show configuration diagnostics and repair guidance |
| `collection_type_registry_invalid` | One or more type or contract files are invalid | Show file-level diagnostics and repair guidance |
| `collection_invalid` | The collection cannot be opened or validated for another reason | Show collection diagnostics and repair guidance |

A v0.2.x collection remains available for supported compatibility reads. A
write is rejected before mutation and includes `current_version` and
`required_version` details. Connect never silently upgrades the collection.

Configuration and type-registry problems carry the original mdbase
`diagnostics` array, including stable diagnostic code and any available path,
field, type, and schema location. UI copy should summarize the problem first
and put raw diagnostics behind a details or repair view.

Ordinary invalid operation input remains `operation_invalid`; it is not
misrepresented as broken collection setup.

## Mutation uncertainty

`operation_outcome` is independent of the problem category:

- `not_sent` means the authority did not receive the mutation;
- `rejected` means the authority definitively did not apply it;
- `unknown` means the SDK cannot safely say whether it applied.

Never automatically repeat a mutation with an `unknown` outcome as a new
request. Inspect `connection.pendingMutations()`, reconcile visible collection
state, and call the matching handle's `recover()` method. Connect persists the
exact request and the authority keeps a durable receipt, so recovery reuses the
original request ID and cannot apply the same logical mutation twice.

`isRetryableConnectError()` exists for internal throwing boundaries, but public
outcome code should use `problem.recovery === "retry"` and still avoid retrying
when `operation_outcome === "unknown"`.

## Testing application UX

Application tests should cover at least:

- one retryable availability problem;
- authorization expiry or insufficient access;
- an unknown future problem code;
- v0.2.x write rejection;
- malformed configuration and invalid type-file diagnostics;
- an uncertain mutation that must be reconciled rather than repeated.

Use problem/outcome builders from `@mdbase-dev/connect-testing` for application
fixtures. Protocol-author tests can import `MdbaseCollectionClient` from
`@mdbase-dev/connect/advanced` with a small fake transport.
Keep connector/server integration fixtures for the wire boundary, where the
canonical problem object is schema-validated before the SDK accepts it.
