# ADR 0004: Signed TOFU application identity

- Status: accepted
- Date: 2026-08-03
- Supersedes: ADR 0002

## Context

ADR 0002 introduced two valuable boundaries together with a first-contact
ceremony: a durable application-installation identity and a signature over the
exact authorization request. The ceremony additionally asked the user to
compare an eight-character value in the application and on the computer that
owns a local collection.

That comparison is a second permission-like decision after the portal has
already shown the application, collection, and exact requested authority. It
adds pending trust records, a local trust-management API, a second UI, retry
states, and application callbacks. A short unauthenticated comparison value
also does not justify the product claiming general protection from a malicious
control plane. A stronger first-use authentication design would require an
authenticated out-of-band channel, a PAKE, key transparency, or publisher
identity. None is currently part of the product.

Stable installation identity and signed request binding are independently
useful. They prevent the control plane from broadening or rebinding an honest
application's request, bind fresh grant keys to the requesting installation,
give grants a durable application-instance identity, and support correct
application lifecycle and hosted-replica accounting.

## Decision

### One stable application signing key

Each application installation owns one persistent, non-extractable P-256
signing key. Its installation ID is a domain-separated SHA-256 digest of the
canonical uncompressed public key, truncated to a variant-8 UUID. Browser
installations persist the key in IndexedDB. A portable downloaded application
without injected durable storage deliberately has a process-local identity.

The stable agreement key introduced by ADR 0002 is removed. Each authorization
still creates fresh per-grant agreement and signing keys. The installation key
signs a canonical request containing those keys and the complete authorization
ceiling: application and manifest identity, flow, nonce and lifetime, redirect,
state and PKCE values, collection restriction, operations, and file access.

### One authorization decision

The portal is the single user-facing authorization decision. After approval,
the local connector verifies the application signature, request lifetime,
authorization ID, exact grant and connector bindings, collection, operations,
file capability, and flow before activating the grant. It does not maintain a
separate application-trust registry or return a `trust_required` state.

Grant revocation remains the immediate way to remove access. A stable
installation ID may be used to group grants, but it is not a second source of
authority.

### Trust on first use and continuity

The first successful local authorization trusts the control plane to introduce
the connector ID and public key. The SDK pins the connector key by server origin
and connector ID. A later response for the same connector ID with a different
key fails with `connector_identity_changed` until the application explicitly
forgets that public pin and authorizes again.

This continuity check detects unexpected later key substitution. A new
connector ID is a new TOFU relationship. It does not stop a malicious control
plane from substituting an identity on first use or from presenting a new
connector identity. The signed application request prevents mutation or
rebinding of the honest application's proof, but the control plane can deny the
request or replace the entire first-use exchange. Product and security copy
must state this limitation directly.

### Protocol break

The application-authorization subprotocol advances to version 2. Version 1
proofs and first-contact grants are not accepted. Pre-release server and local
registry migrations remove ceremony state and invalidate grants that cannot
meet the new binding. Applications receive an actionable reconnect outcome
rather than a compatibility shim.

Web authorization uses normal browser redirect completion after posting the
signed request. Device authorization retains its standards-based token polling.
Web SDK polling that existed only to wait for local trust is removed.

## Verification

The implementation must prove:

- cross-runtime agreement for installation IDs and signed transcripts;
- signature failure after mutation of every material request field;
- persistent browser identity and process-local portable identity;
- immediate local activation after one portal approval;
- exact connector, collection, grant-key, operation, file, flow, redirect,
  state, PKCE, expiry, and replay checks;
- connector-key continuity and explicit pin reset;
- direct, relay, device, recovery, revocation, and setup-error behaviour; and
- absence of first-contact protocol, trust registry, CLI, SDK callback, server
  state, and UI surfaces.

## Consequences

The authorization path has fewer states and one fewer long-lived private key.
The user makes one concrete, reversible decision. Application installations
remain stable enough for grant grouping and replica deduplication, and every
grant remains bound to keys held by that installation.

The system deliberately accepts the control plane as a first-use identity
introducer. If the product later needs protection against that actor, it must
add a genuinely authenticated mechanism and a new ADR rather than restore a
short-code ceremony under stronger claims.
