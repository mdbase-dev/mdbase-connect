# ADR 0008: Bounded transport-v2 compatibility and protocol sunset evidence

- Status: accepted
- Date: 2026-08-10

## Context

Beta.56 introduced operation transport v3. Unlike v2, a repeated read whose
response is no longer cached must be retried as a fresh request so that changed
plaintext is never encrypted under a reused AES-GCM nonce. The initially
planned coordinated cutover rejected transport v2 entirely.

Staging exposed a legitimate migration case before production deployment. An
SDK can hold a durable beta.55 mutation request across a server or application
upgrade. Rewriting or discarding that request would destroy its exactly-once
recovery identity; rejecting it forever would strand an outcome the authority
may already have accepted. The same condition exists for direct, relayed, and
hosted collections.

## Decision

Beta.57 uses an expand, migrate, contract sequence. Compatibility is a bounded
recovery service, not general version negotiation or a silent downgrade.

### Expand

The server and connector advertise operation transports `[3, 2]` and
authorization bindings `[5, 4]`. The frozen beta.55 v4 transcript and v2
ciphertext remain byte-compatible and have cross-runtime fixtures. New
authorizations use binding v5 and transport v3.

Binding v5 may sign `operation_transport_recovery: [2]` only when the requested
authority includes mutations. Recovery transport is distinct from the primary
transport. Reads, ordinary new mutations, and grants without that signed field
cannot use it.

For local collections, entering recovery creates one exclusive live recovery
grant per application installation and collection. The old grants and their
tokens are revoked for ordinary access. Leaving recovery likewise revokes the
recovery grant as the v3-only grant becomes active. Ordinary repeat
authorizations outside a recovery transition keep their independent lifecycle
and do not invalidate another browser or refresh token. The daemon archives
the old authenticated grant, key, counter, and receipt material. A v2 mutation
can pass only when:

1. the current token's v5 grant signs v2 recovery;
2. the envelope names an activated historical grant for the same user,
   application installation, collection, and connector;
3. that historical grant's exact encryption binding and operation allow it;
4. the operation catalogue classifies the request as a mutation.

For hosted collections, pre-beta.57 application replicas initially enter an
unbound expansion state that accepts v2 or v3. The control plane patches each
replica to the exact signed primary and recovery contract during
reconciliation. New API writes cannot create unbound replicas. Hosted recovery
is mutation-only.

Transport-v2 reads cannot use v3's fresh-request response. To keep the legacy
wire safe, the local authority stores their exact encrypted responses as
immutable, content-addressed receipts. This separate store is bounded to 256
receipts, 256 MiB, and seven days. Expiry is durable and fail closed; it never
causes a legacy read to execute again under the old nonce. Transport-v3 reads
retain the fresh-request contract from ADR 0007.

### Observe

Protocol telemetry records only:

- the internal account identity needed to count affected users;
- surface (`direct`, `relay`, or `hosted`);
- protocol axis and numeric version;
- aggregate count and first/last observation timestamps.

It never records application, collection, grant, request, operation, path,
input, payload, or record content. Hosted-provider telemetry is account-scoped
and is mapped to users only inside the control plane. Connector reports are
bounded and rate-limited.

The operator compatibility report fails closed when provider telemetry is
unavailable or hosted usage cannot be mapped. It also reports active connector
and authorization generations without exposing their identities.

### Contract

Compatibility may be removed only when one observation window is complete and
every report gate passes:

- no v2 samples on any surface;
- no active beta.56-or-earlier or unknown connector version;
- no active binding-v4 or unknown authorization;
- no active v5 grant that still signs v2 recovery;
- hosted-provider telemetry is available and all accounts map to users;
- no unbound hosted application replica; and
- no hosted application replica that still permits v2 recovery.

After the gates pass, applications reauthorize without recovery, the report is
retained as release evidence, and a later release removes v2/v4 code and
fixtures. Package version alone never authorizes a downgrade.

## Consequences

The release can be deployed in compatibility order without a maintenance
window: expand the server/provider first, then connectors and applications,
observe migration, and contract only from measured evidence. Beta.55 and
beta.56 users continue operating while beta.57 rolls out.

The bridge adds temporary code and a bounded legacy receipt store. Its narrow
signed recovery contract and explicit sunset gates prevent it from becoming a
permanent second protocol or a general downgrade path.

## Required proof

- frozen beta.55 v4 signing and v2 encryption fixtures pass in Rust and
  TypeScript;
- beta.55, beta.56, and beta.57 relay handshakes are accepted only on their
  declared axes;
- v2 recovery succeeds for exact pending mutations and fails for reads, new
  envelopes, different installations, collections, operations, or grants;
- v2 reads replay the exact receipt across restart and fail closed after
  receipt expiry;
- hosted unbound expansion and exact reconciliation are tested;
- entering and leaving recovery each leave one current live grant, ordinary
  repeat authorization preserves unrelated sessions, and only bounded recovery
  material is retained;
- telemetry bounds, rate limits, privacy shape, aggregation, and every sunset
  gate are tested; and
- deployed staging exercises direct, relay, hosted, large-vault, crash,
  contention, and persisted beta.55 mutation migration paths.
