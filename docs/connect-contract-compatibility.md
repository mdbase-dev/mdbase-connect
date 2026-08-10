# Connect beta contract compatibility matrix

Status: beta.57 expand phase. See ADR 0008.

Connect versions independent contract axes independently. An npm or desktop
package version is release identity and telemetry, not proof that a wire
operation is authorized.

## Supported axes

| Axis | Legacy | Current | Compatibility rule |
| --- | ---: | ---: | --- |
| Operation transport | v2 (beta.55) | v3 (beta.56+) | v3 is primary. v2 is accepted as a v4 primary or a v5 mutation-only recovery transport. |
| Signed application authorization | v4 | v5 | The frozen v4 transcript remains byte-compatible. v5 signs the recovery list under a new domain. |
| Semantic capabilities | v1 | v1 | No compatibility change. |
| Durable mutation | v1 | v1 | Required for every mutation and every v2 recovery authorization. |
| Grant encryption | v1 | v1 | Key agreement remains stable; transport-specific derivation and AAD distinguish v2 from v3. |

The server and beta.57 connector advertise support arrays rather than inferring
wire behavior from a release number. Beta.55 advertises transport v2/binding
v4; beta.56 advertises transport v3/binding v4; beta.57 advertises both
supported versions and creates transport v3/binding v5 grants.

## Authorization contracts

A new binding-v5 grant normally signs:

```json
{
  "operation_transport": 3,
  "authorization_binding": 5,
  "semantic_capabilities": 1,
  "durable_mutation": 1
}
```

When the SDK has a durable pending v2 mutation for the requested operation and
collection, it additionally signs:

```json
{ "operation_transport_recovery": [2] }
```

The recovery list is invalid on binding v4, on a read-only authorization, when
it duplicates the primary transport, or when it names an unsupported version.
It never changes the primary transport and is never selected by automatic
negotiation.

## Runtime rules

| Request | Result |
| --- | --- |
| New v3 read or mutation under a v5 grant | Normal current path. |
| Exact pending v2 mutation under a v4 grant | Normal legacy-primary path during expansion. |
| Exact pending v2 local mutation after v5 reauthorization | Recovery path only when the new grant signs v2 recovery and the old envelope matches the same installation, collection, connector, operation, and encryption binding. |
| v2 read under v4 | Exact encrypted response is retained in the bounded legacy-read receipt store. |
| v2 request under v5 without recovery | Rejected before authority work. |
| v2 read or new v2 envelope presented as recovery | Rejected; recovery is mutation-only and historical-grant-bound. |
| v3 duplicate read after cache loss | `fresh_request_required`; the SDK creates a fresh request and counter. |
| Unsupported axis | Typed mismatch with `operation_outcome: not_sent` for mutations. |

Relayed encrypted bodies remain opaque to the control plane. Hosted replicas
use the same signed primary/recovery policy, with a temporary unbound state
only for rows that predate the expansion migration.

## Deployment and sunset

Deploy in expand, migrate, contract order:

1. Deploy beta.57-compatible server and hosted provider to staging.
2. Publish and deploy the beta.57 connector and SDK consumers.
3. Let retained beta.55/v4 work complete, then reauthorize applications without
   recovery where necessary.
4. Run `auth-admin compatibility report --days N` for at least one complete
   observation window.
5. Remove v2/v4 only after every report gate passes, and retain that report as
   the release evidence.

The privacy-safe report aggregates only internal user counts, surface,
protocol version, sample count, and first/last seen timestamps. It contains no
application, collection, grant, request, operation, path, input, payload, or
record content.
