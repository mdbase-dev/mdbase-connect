# Core product flows

Status: interaction specification

These flows turn the product principles into a consistent sequence across the
desktop connector and account portal. They do not change the authorization or
collection model described in the architecture documents.

## Shared decision pattern

Every consequential flow should answer five questions in this order:

1. **Who is acting?**
2. **Which collection is affected?**
3. **What exact actions are possible?**
4. **Where does the authority live?**
5. **How can the user stop or reverse this later?**

The final action uses a concrete verb and object. Prefer `Allow TaskNotes`,
`Pause remote access`, or `Revoke from this computer` over `Continue`,
`Confirm`, or `Manage`.

## Add a local collection

Goal: register an existing mdbase collection or create one without implying
that files are uploaded.

1. The Collections view offers `Add existing folder` and `Create collection`.
2. The native folder chooser establishes the local path.
3. The connector validates `mdbase.yaml` and shows the collection name.
4. The collection appears in the list with `On this computer`.
5. Success copy states that registration does not move or copy the files.

If validation fails, keep the selected path visible locally and explain the
specific repair. Never send that path to the portal or control plane.

Removing a collection is not deletion. The confirmation and completion message
must both say that its files remain on disk.

## Connect this computer

Goal: pair the connector to an account without making account infrastructure
feel like a storage migration.

1. Desktop explains that the portal supplies identity and routing.
2. The browser opens a signed-in pairing decision.
3. The portal names the computer and account.
4. The user approves the computer.
5. Desktop updates automatically and reports `Connected securely`.

No token is copied. Pairing copy explicitly states that collection paths remain
local. If the browser cannot complete the flow, preserve the pending state and
offer a retry rather than restarting silently.

## Authorize an application

Goal: let the user make one informed decision about one application and one
collection.

The decision reads from identity to consequence:

1. Application name, origin, and request expiry.
2. Compatible collection and its authority.
3. Requested operations, grouped in plain language.
4. Contract-derived scope and any setup that approval will add.
5. Optional content-free notification rules.
6. A sentence stating what the application will use and how long access lasts.
7. `Deny` and `Allow [application]`.

Start with all requested operations selected, then let the user narrow them.
The collapsed state still shows `n of n selected`. An unavailable collection
stays explainable, but cannot be selected.

Approval returns the user to the requesting application. Denial is a complete
outcome, not an error.

## Review and revoke access

Goal: make continuing access legible and revocation immediate.

Group grants by application, then list each collection separately. Each row
shows:

- collection name;
- application origin;
- connection date;
- contract scope, when present;
- allowed operations;
- `Save` and `Revoke`.

An application-level action may revoke every grant on the current computer.
The confirmation names both the application and the boundary. Once confirmed,
the local connector enforces revocation immediately, even if cloud policy is
temporarily stale.

## Pause remote access

Goal: provide an immediate, reversible safety control without implying that
grants were deleted.

- The control lives in desktop, where local authority is enforced.
- The label is `Pause remote access`.
- Paused state uses amber plus the text `Remote access paused`.
- Existing grants remain visible and unchanged.
- Resume is available from the same control.
- The activity log records requests denied by the paused policy.

Do not describe pause as offline, disconnected, or revoked.

## Online and offline behavior

Users should understand availability without choosing a transport.

| Context | Label | Product behavior |
| --- | --- | --- |
| Computer has no portal configured | `Local only` | Local collection work remains available |
| Connector has portal configuration but no route | `Connector offline` | Remote requests cannot currently reach it |
| Connector has a secure route | `Connected securely` | Authorized remote requests can reach the authority |
| User disabled remote access | `Remote access paused` | Connector rejects remote requests locally |
| Browser uses loopback | `Connected directly` | Same-computer requests use the local connector |
| Browser uses relay | `Connected through mdbase` | Encrypted requests use the relay |
| Managed authority | `Hosted by mdbase` | The hosted provider is authoritative |

Direct and relay routes are automatic. Never present them as storage modes or
ask the user to select one. If direct access is unavailable, fallback should be
quiet unless the route explains a failure or materially affects the task.

## Hosted collection

Goal: create a managed collection without making the application contract the
storage model.

1. The portal offers a plain mdbase collection or a compatible starting
   template when a request needs one.
2. The user names the collection.
3. The interface labels its authority as `Hosted by mdbase`.
4. Optional types or contracts are described as setup added to the collection.
5. The collection remains an mdbase collection that other compatible apps may
   use.

Avoid language such as `TaskNotes database`. Prefer `mdbase collection with
TaskNotes fields`.

## Failure and recovery

Errors stay attached to the action that failed and preserve the user's work.

- Pairing failure keeps the desktop's pending context.
- Authorization failure keeps the chosen collection and narrowed permissions.
- Offline state explains what is unavailable and what still works.
- A stale or incompatible collection explains the missing capability.
- Retry actions use the same authorization boundary as the original action.

Never expose raw relay, OAuth, encryption, or provider errors as the primary
message. Expert detail may follow a plain-language summary.

## Product writing

Use:

- `collection`, not `workspace` or `vault`, unless quoting another product;
- `application access`, not `integration`;
- `on this computer`, not `local instance`;
- `hosted by mdbase`, not `in the cloud`;
- `through mdbase`, not `via relay`;
- `allow`, `deny`, `pause`, `resume`, `remove`, and `revoke`.

Keep local, hosted, online, offline, paused, and revoked distinct. These words
describe different boundaries and should never be used interchangeably.
