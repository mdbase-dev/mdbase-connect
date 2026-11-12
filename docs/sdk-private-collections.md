# SDK: Private collections

## Private collections from web apps

`@mdbase-dev/sdk/app-grant` lets a signed-in web app open a Private collection
through the relay to one of the account's online computers. It is a separate
entry so apps that only use cloud copies don't load it.

- `new MdbaseAppGrants({declaration, redirectUri})`; `authorize({popup})` from the
  user gesture asks for a grant (OAuth PKCE, popup, at most 30 minutes). The
  redirect page calls `deliverAppGrantCallback(location.href)`.
- `collections()` lists granted Private collections with `availability`;
  `mergeCollectionEntries(cloud, privates)` merges them with cloud copies.
- `waitForAvailable(id, {timeoutMs})` polls (default 60 s, at most 10 minutes)
  and returns the last availability; it never waits on `sync_required` or
  `access_removed`. `connector(id)` opens; an unavailable collection fails with
  `collectionUnavailableError(reason)`, and `describeError` gives the copy.

Storage: the installation signing key and each grant's Noise static key are
non-extractable WebCrypto keys structured-cloned into IndexedDB. The refresh
token is stored only as AES-256-GCM ciphertext under a per-grant
non-extractable key, and access tokens stay in memory. Script can use but not
read these secrets, so it cannot copy them elsewhere; same-origin script running
while the app is open can still use them, so apps still need a strict CSP.
The default store belongs to the app's own manifest family (`bundle:<manifest
id>` from its declaration), never the id Connect assigns: the database name,
every record and the refresh ciphertext carry it, and records for another owner
are refused. Grants stored before this labelling are not adopted; the app asks
for access again and the old records are left in place.

### Listing and opening Private collections in an app

Every launch app follows the same pattern (the Editor's `private-collections.ts`
and `SdkEditorRoot.tsx` are the reference):

1. **Load it lazily.** Construct one `MdbaseAppGrants` per app, behind
   `import("@mdbase-dev/sdk/app-grant")` on first use, so the relay and grant code
   stay out of the initial bundle. `redirectUri` is the manifest redirect URI on
   the app's own origin.
2. **Handle the callback page.** When the app loads with `state` and `code` or
   `error` in its URL, call `deliverAppGrantCallback(location.href)`, then
   `window.close()`. Don't start the application SDK in that window.
3. **List.** Once signed in, merge `grants.collections()` into the chooser with
   `mergeCollectionEntries(snapshot.collections, privates)`. `collections()` is
   empty until this browser holds a grant, so always offer **Add a Private
   collection**. It calls `authorize({popup})`; reserve the popup with
   `window.open` inside the click, before any `await`.
4. **Show availability.** Every merged entry has one `availability` shape:
   cloud copies take theirs from `snapshot.collections` (absent there means
   available), Private ones from `collections()`.
   `describeError(entry.availability)` gives the title and message for each
   reason. Actions:

   | Availability | Action |
   |---|---|
   | `available` | Open |
   | `opening`, `device_offline`, `approval_required`, `desktop_update_required`, `old_connector_running`, `no_device_registered` | Open: `waitForAvailable(id, {onAvailability})` (bounded), then open when it reports `available` |
   | `sync_required` | **Give access again**: `authorize({popup, collection: id})` |
   | `access_removed` | No open. For a Private entry, offer `forget(id)` to remove it from this browser |
   | `collection_migrating` | Wait; the collection reopens when the upgrade is done |
   | `collection_deleted` | No open |

5. **Open.** `connect({connector: grants.connector(id), app})` returns an
   `MdbaseClient` that the app owns. Check `client.collection === id`, and close
   the client when the person leaves the collection. A failure carries its
   availability reason, so pass it to `describeError`.

6. **People.** `grants.people(id, client)` returns the same `MdbasePeopleClient`
   as cloud copies (`current()`, `members()`, `directory()`), reading Person
   records over `client` and identity and members from Connect with the grant.
   Until a computer approves the app, identity and members fail with
   availability `approval_required`; members also need the person's people
   approval (`people_permission_declined` otherwise). Needs a Connect server
   that serves people metadata for Private grants; older ones answer
   `people_unsupported` or refuse the token.

7. **Setup.** `grants.setup(client)` gives the same plan and review wording as
   a cloud copy's `setup`. `assess()` answers `ready`, `setup_required` or
   `incompatible`. `plan({adopt?, records?})` returns an `MdbaseSetupPlan`:
   show its `summary`, then each `changes[].message` (for example "Add the
   "task" record type."), and offer `adoptable` conflicts as a choice.
   `apply(plan)` writes everything in one guarded mutation that the person's
   computer checks. If anything changed since the review it refuses
   `setup_changed` and writes nothing, so plan again. The original Native session
   must negotiate `declared-collection-setup-v1`; Native verifies the signed
   declaration and plans the complete batch. This does not require or grant
   arbitrary `definitions.manage`. Starter notes independently need `records.create`.
   Before apply, the SDK durably retains an encrypted original mutation ID under
   existing grant custody. Lost/unknown outcomes reconcile that receipt only;
   they never replay setup or fall back to Hosted. Custom grant stores must
   implement the optional setup-attempt register to support setup.

Not covered yet for Private collections:

- The `Mdbase` readiness flow (`configure`) doesn't apply; use
  `grants.setup(client)` and `grants.availability(id)`.
- Merged entries carry `role` (`owner`, `editor`, `viewer` or `null`). Cloud
  copies always have one. A Private entry's is `null` when Connect doesn't
  report it: older servers, or an account whose access needs renewing. Gate
  owner actions on `role === "owner"`; Connect still checks each action.

## Private collections on the app's own replica

An app that hosts its own replica through `createMdbase`
can open an existing Private collection with that replica, as a device of the
collection, instead of through the relay. The person unlocks it once with the
account's encryption password or recovery key. Connect only offers this to
apps it allows to hold a Private key.

- **Ask for it.** List `offline.replica` in the declaration's capabilities,
  under `requirements.capabilities.optional` or `required`. Prefer `optional`:
  the app then still signs in and syncs cloud copies where device access is not
  offered, and consent for an app grant on a current account refuses an app
  that lists it as required. The sign-in request asks for device access
  (`requested_private_device`), and the person chooses which Private
  collections to share. A server that does not know the request is asked again
  without it, and one that does not offer device access to this app answers
  with no Private collections; both leave an ordinary cloud-copy sign-in. An
  installation paired before this needs to ask for access again.
- **List.** Entries in `snapshot.collections` carry `mode: "private"`; absent
  means a cloud copy. A server from before this feature (after a rollback)
  answers the list without modes; the SDK then asks once more with the earlier
  request, so file actions are kept and no Private entry is listed.
- **Open.** `select(id)` as usual. An approval that shares only Private
  collections names no selected collection, so the app arrives in its chooser;
  when exactly one collection is approved the application opens it by itself,
  as it does a sole cloud copy. A device that already holds the key goes
  straight to `ready`. One that doesn't reads
  `{kind: "needs_unlock", collectionId, displayName, mode, unlocking, problem}`.
  There is no `connection` while locked.
- **Unlock.** For `mode: "password"`, call
  `mdbase.unlock(collectionId, {password})` or `{recoveryKey}` with what the
  person typed, and keep no copy. It resolves when the attempt has settled: the
  collection continues to `ready` (or `needs_setup`) without a reload, or the
  phase is still `needs_unlock` with `problem` set. `problem` is an
  `MdbaseProblem` with its copy already described; its `key` is one of
  `wrong_secret`, `invalid_recovery_key`, `rate_limited`, `unavailable`,
  `unlock_unavailable` or `unlock_failed`. `mode: "strict"`
  and `mode: "none"` cannot be unlocked here: explain that this collection has
  to be opened on a computer running the mdbase app.
- **Retries.** Connect limits how often an account's sealed key can be fetched
  (10 an hour, shared by all of the account's devices; `rate_limited` carries
  the wait). A mistyped recovery key (`invalid_recovery_key`) and a password
  shorter than the 12-character minimum (`wrong_secret`) are refused in the
  Worker without any request. After a wrong secret the Worker keeps the sealed
  bundle in memory for the next attempt on the same locked collection, and
  uses it only while Connect's status still reports the same account key
  version; it is dropped when the collection unlocks or closes.
- **Afterwards.** Once the unlock has applied, reopening needs no secret. A
  restart before it applied returns to `needs_unlock`.

The password or recovery key is sent to the Worker as bytes that are wiped in
the tab as soon as they are posted and in the Worker when the call settles. The
key it unlocks is used once and wiped; neither is stored. One installation can
be a device of one Private collection (`private_device_limit` for a second),
and People is not available for these collections yet: `connection.people`
is present, and its reads reject with `upgrade_required`
(`people_unsupported`).

To fetch the sealed account key, the app runtime signs one fixed request: the
account-key fetch proof for its own connector and device, over the server's
challenge and the signed-in account. It signs nothing else for the account key
(no change, no strict approval, no caller-chosen digest), and the fetched
bundle is still sealed under the person's password or recovery key, which both
kinds of unlock need. An older app runtime without this signer answers
`unlock_unavailable`, and the collection stays `needs_unlock`.
