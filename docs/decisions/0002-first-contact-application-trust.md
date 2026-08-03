# ADR 0002: First-contact application trust

- Status: superseded by ADR 0004
- Date: 2026-08-02

## Context

Encrypted local grants currently bind a fresh application agreement key to the
connector's long-lived agreement key. This protects request contents and lets
an application detect a later connector-key change when it reuses the same
grant key. It does not authenticate the first key exchange: a compromised
control plane could substitute keys on both sides of the first authorization.

The connector is the final authorization boundary for computer-owned
collections. The portal should remain the normal place to select a collection,
review operations and scope, and approve an application. A headless connector
must provide the same security properties without a desktop process.

## Decision

Establish a durable trust relationship between one application installation
and one connector installation before activating their first local grant.
First contact requires a short authentication string computed independently by
the application and connector. The control plane transports public material
and state, but never supplies or confirms the authentication string.

### Identities

An application installation owns a stable, non-extractable P-256 agreement key
and a separate P-256 signing key. These keys are distinct from the fresh keys
used by an individual grant. Authorization requests carry both installation
public keys, the grant public keys, and an installation-key signature over the
canonical request. Packaged applications must provide a durable secure key
store. An opaque downloaded HTML file without host-provided storage is treated
as a new application installation for each process and must repeat first
contact; an ephemeral identity is never allowed to inherit an earlier trust
record.

A connector installation continues to use its long-lived P-256 agreement key
from the operating-system secret store. Its local registry stores trusted
application installation keys and pending first-contact requests. The control
plane is not an authority for either trust store.

### Authentication string

Both endpoints derive the same secret with P-256 ECDH using their stable
installation agreement keys. A domain-separated HKDF-SHA-256 transcript binds:

- the first-contact protocol version;
- the registered application ID and application installation ID;
- both application installation public keys;
- the connector ID and connector agreement public key.

The display value is 40 derived bits encoded as eight unambiguous Crockford
Base32 characters in two groups. Rust and TypeScript use a shared canonical
fixture. Public-key fingerprints and the human-readable application and
computer names accompany the short value, but are not substitutes for it.

### Authorization state machine

1. The application creates or loads its stable installation identity, creates
   fresh grant keys, signs the authorization request, and starts the normal
   authorization flow.
2. The portal remains responsible for collection selection, operation and
   contract review, and the user's grant approval.
3. Before first activation, the connector verifies the application signature.
   If the exact application installation is not trusted, it records a bounded,
   expiring pending trust request and refuses activation with `trust_required`.
4. The application and connector each compute and display the authentication
   string. The application never accepts a string received from the control
   plane.
5. The user confirms the application-displayed string locally. The desktop can
   present this action, while the canonical headless interface is the daemon
   control protocol and `mdbase connect trust` CLI. Scripted acceptance must
   provide the exact displayed string; a bare `--yes` is insufficient.
6. The connector records the exact application installation keys as trusted.
   The pending portal authorization then resumes and the connector rechecks the
   trust record before persisting the grant.
7. Later grants for the same application/connector identity are approved in
   the portal without another local action. A changed application or connector
   identity always returns to first contact.

The connector validates trust again for every grant activation, including
activations initiated through a live portal offer. A cloud-side status flag
cannot bypass this check. Existing active grants also retain their exact local
grant and connector-key checks.

### Local operation and revocation

The control protocol and CLI expose machine-readable list, show, accept,
reject, and revoke operations. Pending records survive daemon restarts, expire
closed, and contain no collection path or record payload. Revoking application
trust immediately disables all matching local grants and durably queues any
necessary control-plane reconciliation.

The desktop is a presentation client for this daemon API, not a separate trust
implementation. A headless operator can inspect and confirm a request over SSH
without installing or launching Electron.

### Scope

This first-contact exchange applies whenever an application connects to a
computer-owned collection, whether the data path will be direct loopback or
relay. It does not apply to hosted-only collection grants, because there is no
local connector in that authorization boundary. Computer-to-account login is a
separate pairing protocol.

## Consequences

- A compromised control plane can delay, replay, or deny first contact, but it
  cannot make both honest endpoints display the same authentication string for
  substituted keys.
- First use requires one deliberate local action. Routine grant administration
  remains in the portal.
- Application integrations need a durable installation identity in addition
  to per-grant keys.
- Authorization, relay, local-control, Rust, and TypeScript protocol versions
  change together. Pre-release callers must adopt the new flow; no legacy
  first-contact bypass is retained.
- Losing or deliberately rotating either installation identity requires a new
  first-contact confirmation and does not silently inherit old trust.
