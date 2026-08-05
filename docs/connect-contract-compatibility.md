# Connect beta contract compatibility matrix

Status: Phase 0 frozen contract matrix.

Connect versions independent contracts independently. An npm/package version
is release identity, not proof of wire compatibility. Each operation declares
the contracts it requires, and a peer rejects only when one of those required
contracts is unsupported.

## Candidate release axes

| Axis | beta.31 | Next candidate | Why it changes | Typed mismatch |
| --- | ---: | ---: | --- | --- |
| Package release | `0.1.0-beta.31` | `0.1.0-beta.32` | Coordinated breaking SDK release. | None by itself. |
| Authority operation transport/wire | encrypted relay/operation v1 | operation v2 | Adds authenticated request creation/expiry, operation input schema version, and explicit feature advertisement required by durable recovery. | `transport_protocol_incompatible` |
| Signed application authorization binding | v2 | v3 | Signs the required operation transport, semantic capability, and durable-mutation contract versions into the authorization ceiling. | `authorization_binding_incompatible` |
| Semantic application capability contract | v1 | v1 | Capability names and their meaning do not change in this program. | `capability_contract_incompatible` when a future/unsupported value is requested. |
| Durable mutation feature set | absent | v1 | Introduces fenced claims, recovery handles, canonical fingerprints, retention, and tombstones. | `durable_mutation_unsupported` |

Local admin control, sync wire, file frame, relay file-frame, manifest, mdbase
spec, and Connect problem versions remain at their current values unless their
own payload contract changes during implementation. They are not bumped merely
because beta.32 ships. Grant encryption profile v1 also remains unchanged: it
describes the key agreement and AEAD binding, while operation transport v2
independently versions the encrypted request and response envelope.

## Mismatch details

Every mismatch is a typed compatibility problem with safe details:

```ts
interface ConnectContractMismatchDetails {
  contract:
    | "operation_transport"
    | "authorization_binding"
    | "semantic_capabilities"
    | "durable_mutation";
  required: number[];
  supported: number[];
  peer: "application" | "connector" | "hosted_provider" | "control_plane";
  operation?: string;
}
```

The response is produced before the affected authorization, read, or mutation.
Mutation mismatches carry `operation_outcome: not_sent`. Peers never negotiate
durable mutation v1 down to the beta.31 receipt behavior. A package version
difference succeeds when every contract required by the operation intersects.

An authority mismatch pauses only authority-backed access and sync. It does not
prevent a consumer from reading its independent local replica, and it never
prevents direct reading of canonical Markdown outside an incompatible Connect
call.

## Operation requirements

| Operation class | Required axes |
| --- | --- |
| Manifest discovery/validation | Manifest contract only; package version is diagnostic. |
| Authorization | authorization binding v3, semantic capability v1, and the operation transport/features being granted. |
| Authority read | operation transport v2 plus the granted authorization binding. Durable-mutation v1 is not required. |
| Authority mutation | operation transport v2, authorization binding v3, semantic capability v1 where a manifest capability produced the operation, and durable mutation v1. |
| Independent local replica read | No live authority contract until refresh/sync is requested. |

## Coordinated deployment switch

1. Deploy the new control plane and hosted provider dark behind a versioned
   route/service identity. They advertise the candidate axes but receive no
   beta.31 traffic.
2. Publish the candidate SDK artifacts and desktop connector from one immutable
   Connect commit. Record package hashes, image digests, and source revision.
3. Upgrade each staged consumer and connector without activating the new route.
   Preflight the matrix and prove every incompatible pair returns the named
   mismatch before authority work.
4. Atomically switch discovery/routing to the candidate service identity and
   activate the matching desktop connector/consumers as one train. Do not run a
   reduced-semantics bridge.
5. Canary packaged consumers in rollout order: Workouts, Editor, Pickle,
   TaskNotes. Hold and observe after each.
6. Rollback restores the previous service identity and consumer artifact set as
   one operation, then restores verified pre-migration databases where beta.31
   cannot open the candidate schema.

Mixed-version test fixtures remain mandatory even though mixed-version
operation is intentionally unsupported. They prove fail-before-write behavior
and the accuracy of mismatch details.
