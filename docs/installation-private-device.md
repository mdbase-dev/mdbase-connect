# Private collections on an application's installation device (draft)

Status: draft design for branch `feat/obsidian-private-app-host`. Not reviewed, not deployed.
First consumer: the Obsidian plugin (`dev.mdbase.obsidian`), which already hosts its own
`app-runtime` replica for cloud copies through `MdbaseApplication`.

## Goal

An application's installation joins an **existing** Private (`e2e`) collection as an
`app-runtime` device, receives the collection key with the account key (AK1: encryption
password or recovery key), and then syncs with its own replica. No other computer has to
be online. Nothing changes for cloud copies, for app grants (the relay thin client), or
for ordinary connector credentials.

## Not in this change

- Device approval with the six-digit code (needs requester and approver exports in the
  WASM runtime, a browser `ApprovalSecretJournal` and a peer-inbox transport).
- Creating a Private collection from an installation, account-key setup, password
  change, strict mode. Strict accounts stay refused at installation pairing.
- Approving other devices from an installation.
- People (`/v1/authorities/:id/{identity,members}`) for Private device scope.

## Trust decisions that need review

These are the defaults this branch implements. Each is a product and security decision
for Callum and the Connect lane, not something this branch can settle.

1. **Which apps may hold a Private key.** Any registered application whose manifest
   declares `offline.replica` (required or optional) may ask. The person's approval in
   the portal, per collection, is the control. There is no first-party check and no
   list of applications: Connect has no verified publisher identity for installations
   (`docs/native-app-platform.md`), registration is open, and anyone who presents the
   same public manifest gets the same application UUID, which also changes with every
   manifest digest. A list of UUIDs would only have been a label. So the consent
   screen has to say plainly what is handed over, and it does: the named app on this
   device will hold the key, will be able to read the collections, and should be
   allowed only if the person trusts it with the encryption password. The name shown
   is the registered manifest's and is not proof of who published the app.
   The operator's only control is one switch for the whole server,
   `MDBASE_NEXT_PRIVATE_APP_DEVICES`, off by default. It is separate from
   `MDBASE_NEXT_PRIVATE_BOOTSTRAP` because staging and production already run that
   flag, and this must not turn on there by merging.
2. **The sealed account-key bundle reaches the app, and the key is account-wide.**
   `GET /v1/next/account-key` is account-wide and the bundle can be guessed offline.
   Default: admitted only for an installation that holds at least one Private device
   scope, with its own device proof, on the existing per-account fetch budget. Once the
   person types the encryption password or recovery key into the app, the app has had
   the account key, which opens every Private collection the account can reach, not
   only the ones allowed here. Removing the app's access afterwards revokes its device
   and stops the server serving it; it cannot take back a key the app already held.
   Changing the encryption password is the remedy for a password the person no longer
   trusts the app with.
3. **Consent is per collection and explicit.** A cloud-copy scope never turns into
   Private device consent when a collection changes mode.
4. **The app runtime signs one more message.** Until now the WASM app runtime signed
   only the log-token proof, and its comments said "no new signer". Password unlock
   cannot work without the account-key fetch proof, so this branch adds a signer for
   that one digest and nothing else (no put, strict or generic digest signing).

## Server contract

All of this requires `MDBASE_NEXT_PRIVATE_BOOTSTRAP=1` and `MDBASE_NEXT_PRIVATE_APP_DEVICES=1`.
With the switch off, which is the default, every route behaves exactly as today.

| Change | Detail |
| --- | --- |
| Scope | `installation_collection_scopes` gains `private_device boolean NOT NULL DEFAULT false` (new migration; never edit applied ones). A row with `private_device = true` is consent for this installation to be a keyed device of that collection while it is `sync = 'private'`. |
| Request | The installation START object adds optional `requested_private_device: boolean` (default false). An app sends it on every sign-in without knowing what the server will grant, so START never refuses it: with the switch on, the ask is granted only to an app whose registered manifest declares `offline.replica`, for its own `app-runtime` device (never on a file-access request), and is otherwise recorded as not requested, with sign-in going on as for any other app. A recovery sign-in is the one exception: see "Request access again" below. The decision is made once, when the request's window is first created, and a replay or renewal keeps it whatever the switch says by then. Only a granted ask that the client itself drops is `409 installation_original_binding_changed`; a request that was not granted is accepted with either value and stays not granted. |
| Consent | When requested, the portal chooser offers eligible Private collections for device access with distinct copy. Approval sends them in a new explicit list `private_device_collection_ids` (lowercase non-zero UUIDs, disjoint from `collection_ids`). The existing `selected_collection_kind: "private"` grant path is unchanged and is what apps that did not request device access still get. Additive re-consent mirrors this. |
| Receipt | When the request was granted, the exchange receipt adds `private_device_collection_ids` (`added_private_device_collection_ids` after a re-consent). A request that was not granted gets today's receipt. If the switch was turned off between approval and exchange, the exchange still succeeds and the key is present with an empty list: no device access was granted, and cloud copies approved in the same request still work. |
| List | `GET /v1/next/collections` returns Private rows that have a `private_device` scope and current membership, and every row carries `mode: "cloud_copy" \| "private"`. |
| Enrol | `POST /v1/next/collections/:id/private/devices` admits the installation bearer with that scope, current membership, the exact approved device, and the existing revoke and deletion checks, rechecked after awaits. Body and response are unchanged. |
| Log token | `POST /v1/next/collections/:id/log-token` accepts a `private_device` scope for a `private` collection. |
| Account key | `GET /v1/next/account-key/status` and `GET /v1/next/account-key` admit the installation bearer when it holds at least one current `private_device` scope. `PUT`, strict, strict-witness, account-key-device, create (`POST /v1/next/collections/private`), approval-request and the approval-peer routes keep refusing it. |
| Remove access | Removing a Private device scope queues the device revoke as for cloud copies. Confirm a keyed device then rekeys the installation out. |
| Request access again | A recovery sign-in for a collection the installation held as Private device access asks for device access again and is offered only that collection, with the same per-collection consent. See "Request access again" below. |

### Server implementation notes

The server half is implemented as the table says, with these differences. Each one is
there because the code made the table's wording unsafe or incompatible. The operator and
route details are in `docs/installation-collection-scope.md` under "Private device scope".

- **Who may ask is read from the registered manifest.** The server reads
  `requirements.capabilities.required` and `.optional` of the registered application
  row (`applications.requirements`) and grants the ask only when either lists
  `offline.replica`. Nothing the caller sends at START stands in for it. This only
  decides whether the choice is offered; it says nothing about who published the app.
- **The switch is checked at every use.** Approval, exchange, enrol, the log token,
  the list and the account-key routes check `MDBASE_NEXT_PRIVATE_APP_DEVICES` (with
  `MDBASE_NEXT_PRIVATE_BOOTSTRAP`) and nothing about the application. With the switch
  off the enrol and account-key routes do not admit the installation bearer at all and
  answer `401 invalid_connector`, as they do today. Scope rows are kept, so the
  person's consent stands if the operator turns the switch on again.
- **`mode` is opt-in on the list route.** Deployed SDKs reject list rows with unknown
  keys, so rows gain `mode` and Private rows appear only for
  `GET /v1/next/collections?include=mode` (or `include=file_actions,mode`). Without it
  the response is exactly today's.
- **Receipt keys are conditional.** Deployed SDKs also check receipt key sets, so only
  a request whose ask was granted gets `private_device_collection_ids` on `paired`, or
  `added_private_device_collection_ids` on `scope_updated`.
- **Scope rows are written at exchange.** That is where cloud-copy scope rows are
  written today. Approval records the approved ids on the pairing; exchange rechecks the
  switch, the collection's mode, membership and revocation before writing them. With
  the switch off the request gets no Private device rows and the approved ids are
  cleared from the pairing, so they do not return if the switch is turned on again; the
  credential and any cloud-copy rows are written as usual.
- **No selection for a Private device collection.** `selected_collection_id` stays a
  cloud copy. An approval may consist only of `private_device_collection_ids`; the app
  opens one from that list or from its own chooser.
- **START never refuses the ask on a first sign-in.** The SDK sends
  `requested_private_device: true` whenever the app declares `offline.replica`. The
  server grants it only when the switch is on, the registered manifest declares
  `offline.replica`, the device is `app-runtime`, and the request is not a file-access
  request. Otherwise it stores false: no `private_device` choices at inspect, no
  receipt key, and the rest of sign-in is unchanged. A value that is not a boolean is
  `400 invalid_request`, as for every other START field. A recovery sign-in asks only
  to get back a collection it held as device access, so there an ask the server cannot
  grant is refused (see "Request access again").
- **The decision is made once.** It is taken when a request's window is first created
  and stored on the pairing. A replay or a renewal of that window keeps the stored
  decision and does not consult the switch again, so an operator's change never makes
  an app's unchanged request look like a changed one. The only
  `409 installation_original_binding_changed` for this field is a granted ask that the
  client itself drops (sent `true`, then `false` or absent). A request that was not
  granted is accepted with either value and stays not granted. The app gets the
  current decision on its next fresh sign-in or re-consent. A granted request still
  replays and renews after the switch is turned off; approval, exchange and use each
  check the switch themselves.
- **Device access replaces the app-grant choice for a granted request.** Such a
  request is offered private collections as `kind: "private_device"` only; it cannot
  also take the `selected_collection_kind: "private"` grant path in the same approval.
- **Refusal codes.** `403 installation_private_device_not_allowed` is returned at
  approval for one that names `private_device_collection_ids` on a request that was
  not granted, or made after the switch was turned off. On a recovery sign-in it is
  also returned at START (an ask the server does not grant) and at exchange (the switch
  turned off after approval); see "Request access again". Otherwise exchange never
  returns it: if the switch was turned off between approval and exchange, the
  exchange succeeds, writes no Private device scope rows, and the receipt carries an
  empty `private_device_collection_ids` (`added_private_device_collection_ids` after a
  re-consent), so the app can see it got no device access. Use of a route without
  consent is `403 installation_collection_not_approved`. With the switch off, the log
  token for a Private collection is that same 403, the list omits Private rows, and the
  enrol and account-key routes are `401 invalid_connector`.
- **Startup.** `MDBASE_NEXT_PRIVATE_APP_DEVICES` is `0` or `1`; any other value is a
  startup error, as is `1` without `MDBASE_NEXT_PRIVATE_BOOTSTRAP=1` or without
  `MDBASE_CONNECT_AUTH_RATE_LIMIT_SECRET`. The
  account-key routes are mounted only with that secret; without them consent and enrol
  would succeed and the collection could never open.
  The LAB-only Connect build (`pnpm deploy:lab`) sets the build argument to `1`;
  ordinary server images default to `0`.
- **Known limitation: enrolled as a cloud copy first.** Enrol is idempotent only when
  the device's earlier enrol op carries this request's `sasCommit`. An enrolment made
  while the collection was a cloud copy has none. An installation that joined a
  collection as a cloud copy therefore cannot enrol after the collection becomes
  Private and the person grants device access: enrol is
  `409 device_enrolled_differently`, although the log-token route succeeds. Reaching
  this needs the collection-mode change to execute, which is off by default. Enrol
  semantics are shared with daemons and are not changed here.
- **Strict accounts.** Pairing is refused as before. For an installation,
  `GET /v1/next/account-key/status` omits the strict-completion inventory and
  `GET /v1/next/account-key` returns `{mode: "strict", version}` with no bundle.
- **Account-key status has no device proof.** As for a daemon today, it takes the
  bearer only; for an installation it additionally needs a current Private device scope.
  `GET /v1/next/account-key/status` answers an installation with exactly one of
  `{mode: "none", version: 0}` (no account key), `{mode: "password", version, key_id}`
  or `{mode: "strict", version}`. A daemon's strict reply also carries `complete` and
  `pending`; an installation's never does.
- **Browser origins.** The server's CORS policy reflects any origin and the headers a
  preflight names, without credentials, so an app origin such as `app://obsidian.md`
  may send `authorization`, `x-mdbase-device-id`, `x-mdbase-challenge` and
  `x-mdbase-signature`. `POST /v1/next/devices/challenge` already admits the
  installation bearer.
- **Optional file actions.** A file-access request works on a Private device scope as
  on a cloud copy. When a later approval changes a row's kind, its file actions are
  cleared and must be asked for again.

### Request access again

Removing an app's access to a collection in the portal
(`POST /v1/account/applications/:id/remove-installation-access`) removes it from every
installation of that app and permanently revokes their devices for that collection.
The app then shows `installation_scope_removed` for the collection, with the action
"Request access again" (`application.approve(collectionId)`). That starts a recovery
sign-in: a fresh scoped installation and device for that one collection
(`recovery_collection_id`), as for a cloud copy.

- **The SDK asks again for what was removed.** If the original installation held the
  collection as Private device access and the app declares `offline.replica`, the
  recovery START carries `requested_private_device: true`. A collection that was a cloud
  copy recovers as before, without the ask.
- **START.** The ask is granted under the same rules as on a first sign-in (switch on,
  `offline.replica` in the registered manifest, `app-runtime`). When it cannot be
  granted, START is `403 installation_private_device_not_allowed` and no request is
  created. The SDK reports it as the problem `private_device_not_allowed` ("This app
  can't keep this collection"), not as "needs an update". A recovery without the ask,
  from an older SDK, is unchanged.
- **Consent.** Inspect offers only the recovered collection, as
  `kind: "private_device"`, with the same per-collection copy as a first sign-in. The
  only approval that completes it is `private_device_collection_ids` naming that
  collection, with no `collection_ids`, selection, creation or Native choice. Anything
  else is `409 installation_recovery_target_changed`, and the database constraints
  (migration 0103) allow nothing wider. Declining in the portal leaves the collection
  awaiting approval, marked declined (phase `needs_approval`, `declined: true`), and
  nothing is granted. Requesting again renews that window; Connect then waits for the
  same account to be chosen again (the exchange reads `pending`) before the person
  can approve.
- **Exchange.** The receipt carries `recovery_collection_id`, `collection_ids: []` and
  `private_device_collection_ids: [collection]`, and the new installation gets that one
  `private_device` scope row. The SDK accepts no other recovery receipt. If the switch
  was turned off after approval, the exchange is
  `403 installation_private_device_not_allowed` and no credential is issued, because a
  recovery with no device access would have nothing to sync.
- **Sync resumes with a fresh device.** The new installation's device has no key yet.
  The app reaches `needs_unlock` and the encryption password (or the recovery key)
  unlocks it once, as on another computer. The SDK erases the removed installation's
  local copy of the collection before the recovery, so changes the app had not sent
  when access was removed are not kept. Changes made elsewhere meanwhile, on the
  desktop for example, arrive with the next sync.

## SDK contract (`runtime/packages/sdk`)

- **Declaration.** An app asks for device access by listing `offline.replica` in its
  native capabilities, under `optional` or `required`. The SDK then sends
  `requested_private_device: true`. An app that must keep working where device access
  is not offered lists it under `optional`: a `required` entry makes app-grant consent
  refuse the app with "needs an update" (`packages/protocol/src/next-authorization.ts`).
- **Older servers.** A server without this change rejects the unknown START field with
  `400 invalid_request`. On exactly that refusal the SDK repeats START once without the
  field. Receipts without the device keys mean no device access, with no error.
- **Listing.** `AppInstallationCollection` gains `mode?: "private"` (absent means cloud
  copy), parsed from the list route. The SDK asks for `include=file_actions,mode` only
  when the app declares `offline.replica` and the installation holds a Private device
  scope; every other request is byte-identical to before.
- **Fetch proof.** `GET /v1/next/account-key` needs a device signature. The app runtime
  gains one fixed-purpose export, `rt_app_account_key_fetch_sign`, modelled on the
  log-token signer: it signs only the `mdbase/v1/account-key-fetch` digest, with the
  connector and device taken from the runtime's pinned state, never from the caller.
  Both the encryption password and the recovery key need this fetch. **This widens what
  the app runtime will sign and needs a custody review** (see trust decision 4).
- **Recovery.** After a Private device collection's access is removed,
  `approve(collectionId)` asks for device access again (see "Request access again"). A
  server that cannot grant it is reported as `private_device_not_allowed`.
- **One Private collection per installation.** The app custody holds a single enrol
  marker; a second Private collection is refused with `private_device_limit`.
- **Opening.** Selecting a Private entry runs a private host path instead of the
  cloud-copy bootstrap: `preparePrivateCollection` → `AppCpPrivateBootstrap` (purpose
  `enrol`) with `AppWebPrivateBootstrapPersistence` → `adoptDevice({state: "e2e"})` → log
  authority → pump. An enrolled, unkeyed device must not wait on a verified read.
- **Phase.** New `MdbasePhase`:
  `{ kind: "needs_unlock", collectionId, displayName, mode: "password" | "strict" | "none", unlocking: boolean, problem: MdbaseProblem | null }`.
  `mode` is the account-key mode from the status route. `strict` and `none` cannot be
  unlocked in this change; the UI explains that.
- **Action.** `application.unlock(collectionId, { password } | { recoveryKey })`. It runs
  `PrivateAccount.unlock` in the worker with a control port over the installation bearer
  and device proof, a replica port over `unlockAccountKeyConsuming` and
  `accountKeyStatus`, and a memory-only secret store. `R` and the password are never
  persisted and are wiped when the call settles. A wrong secret returns to
  `needs_unlock` with `problem` set. Once the self-grant applies, opening continues to
  `ready`.
- **Restart.** After the grant has applied, reopening needs no secret. A restart before
  it applies returns to `needs_unlock`.

## Plugin contract (mdbase-obsidian)

- The declaration adds `offline.replica` under `optional`, so cloud-copy sign-in is
  unchanged on servers and accounts where device access is not offered.
- The collection chooser labels Private entries.
- `needs_unlock` shows an unlock form in the Sync tab (encryption password, with
  "Use your recovery key instead"), and the status bar reads "Locked". Strict and
  no-account-key modes explain what to do on a computer running the mdbase app.
- The mirror code is unchanged: it talks to the local replica either way.

## Verification

- Server: PostgreSQL tests for scope required, wrong device, non-member, revoked,
  strict account, the switch off (never on, and turned off after enrolment), an app
  that does not declare `offline.replica`, scope removal denying the token, and the bearer
  still refused on every route listed as unchanged; app-runtime Private enrol; a
  recovery sign-in restoring exactly the removed collection as device access, and
  refused with the switch off, for an undeclared app, or for any wider approval.
- SDK: unit tests for the host path, the phase, the action and secret wiping; a Chromium
  smoke with the real WASM runtime for enrol, unlock, and reopen after the grant.
- Runtime: account-key unlock on the app store (rebuild-on-open) is an untested
  combination today. A test must cover unlock, apply, and reopen.
- End to end: a local stack or LAB, with a desktop app creating the Private collection
  and setting the encryption password, and the plugin joining on another machine.
  `runtime/packages/sdk/scripts/app-private-device-local-e2e.mjs` covers this on a
  local stack, including step 9: access removed in the portal, an edit on the desktop
  meanwhile, a refusal with the switch off, a decline, and then "Request access again"
  restoring sync in the same app.
