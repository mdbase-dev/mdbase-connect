# Exact recovery and truthful health

Recovery uses the existing owner of each operation. A response timeout is not a
new mutation, a reachable process is not initialized, and server-side revocation
is not proof that a local authority received it.

## Daemon readiness and desktop admission

The daemon owns the additive `readiness` object returned by `ping` and `status`:

```json
{"schema_version":1,"ready":true,"binary_version":"<daemon version>"}
```

When not ready, `safe_reason` is one of `starting`, `initialization_failed`,
`critical_worker_failed`, or `credential_store_unavailable`. These are safe
classification values, not raw exception strings. The legacy `ping.ready` is a
projection of this same state. Initialization is not committed after registry
loading fails. Readiness checks the existing watcher, runtime-notification,
mirror, and configured relay task handles; a dead critical task cannot leave a
ready result behind. This detects failure; it does **not** add an automatic
worker supervisor or prove that a platform service manager will restart it.

CLI startup/doctor and desktop startup, tray, renderer, and updater consume this
contract. A missing/unknown readiness schema, an incompatible binary version,
or a terminal readiness reason is attention, never inferred success from PID
existence. Polling and individual startup probes have bounded deadlines.
Account reachability, remote access pause, and individual hosted resources remain
separate from local process readiness.

`BootGate` serializes update recovery, ordinary daemon startup, and installation
admission. A daemon-backed request cannot initiate a second startup path while
boot recovery or installation owns that boundary. The CLI's resolved `connect
paths.target`, not whether Electron is packaged, selects `installed_service` or
`isolated_profile`. No isolated-profile action controls the default service.

An unhealthy or thrown updater recovery retains the same transaction and its
last-known-good runtime in `recovering`. Update checks/reinstallation and ordinary
startup remain blocked until recovery verifies readiness and the expected binary
version. The next app process resumes the same transaction. No additional update
journal or repair owner is introduced.

## Editor continuation

The editor obtains pending note mutations from the existing SDK handles and
recovers by the original request ID. **Resume rename** never issues another
rename with reconstructed inputs. Unknown autosave completion retains the exact
original draft snapshot; that continuation must finish before a changed draft
can be sent. A watcher observation matching the recovered revision is not a
second conflicting mutation.

Pending SDK inputs may exist only as ciphertext. The editor does not add a
plaintext path/draft index or another durable journal. After reload, pending
handles are listed by operation/time for explicit recovery. New note updates,
property/document edits, and renames are blocked while a pending note mutation
remains. The editor does not claim **Saved** while that work is unresolved.
Collection epochs prevent recovery from publishing into a subsequently selected
collection. Failure preserves the original identity and the local draft.

## Revocation has an authority-specific completion point

For a local grant, server admission and tokens are revoked transactionally with
an immutable barrier in the existing connector policy sequence. The response is
`revoking` until the local connector acknowledges an exact current-generation
policy snapshot at or above that barrier. Lease expiry, relay disconnect, an old
sequence, a retired/wrong connector generation, a mismatched digest/acknowledgement,
or a legacy snapshot does not establish confirmation.

Migration `0031_local_revocation_confirmation` adds the barrier and confirmation
timestamp to grants. Historical unbound revocations receive a barrier under the
same connector lock used to build policy snapshots. Concurrent snapshots cannot
accidentally acknowledge a later revocation. Repeated single/batch revocations
reuse their existing barrier. Pending rows remain visible in account/connector
inventories. `revocation_status` is presentation-only, never an authorization
input. Hosted grants continue to complete at their own hosted authority; the UI
must not describe them as waiting for a local computer.

## Resource-scoped desktop refresh

Each resource refresh publishes independently. A failed/offline refresh retains
that resource's last known inventory rather than inventing a successful empty
list. Successful unrelated refreshes do not clear action errors; those have an
explicit dismissal. Cascading local-connector failures collapse into one message.
Update status uses its existing push subscription, not a second polling owner.
A configured account's credential-store failure is cached and rethrown during
cooldown; an explicitly unconfigured account can clear hosted inventory.

## Relay and credential recovery

The existing relay owner uses capped equal jitter (1–30 second exponential
ceilings), resets only after 30 seconds of policy-authorized healthy uptime, and
honours bounded server pacing (seconds or HTTP-date, capped at 300 seconds).
Transient transport failures retry without changing credentials or identity.
Authentication/protocol rejection parks the owner with a stable `relay_problem`
until a controlled restart after repair; it does not spin or mint credentials.
Handshake and inventory HTTP/WebSocket boundaries have timeouts.

A running mirror whose previously usable credential store becomes unavailable
retries through its existing bounded mirror scheduler. Immutable bootstrap
credential failure remains blocked: unlock/repair the store and explicitly
restart the correct daemon target. CLI `whoami`/access snapshots propagate the
credential failure instead of claiming that the account is unconfigured. No unconditional retry or credential issuance
replay is added. Test-file-store recovery is not native OS-keyring qualification.

## Qualification boundaries

Local unit, PostgreSQL, component, and hermetic process tests establish their
specific boundaries, not signed updater or service-manager certification. Before
release, qualify real installed-service ownership and restart behaviour on each
supported platform, native keyring lock/unlock, and signed interrupted updates.
In particular, older preserved daemons lacking canonical readiness cannot be
silently accepted as healthy rollback targets. Exercise that first-adoption
boundary before enabling automatic rollout.

See [CLI/daemon architecture](cli-daemon.md), [desktop updates](desktop-updates.md),
and [code-quality requirements](code-quality.md). Merge, release, and deployment
remain separate approval gates.
