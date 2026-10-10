# Policy: devices, members, grants and revocation in the log

Status: draft for review.

Authorization lives in the log (FEASIBILITY §5: "signed writer entries and policy
entries evaluated at replay"):
- the control plane appends **policy items** saying who may do what;
- every item names its signer;
- every replica decides, deterministically and from the log alone, whether each item
  was authorized at its position.

The log service enforces the same policy at its transport as defence in depth. Its
verdict is never authoritative.

Policy applies to **synced** collections. A local-only collection has no log and no
control plane involvement. Its replica keeps local app grants in its own store, in the
`grant` shape of §5. Turning sync on appends them as policy items.

## 1. The policy item

A policy item is a log item of kind `policy` (`sealed-envelope.md` §2).
- **In clear.** The control plane authors it and holds no collection key in end-to-end
  collections. The log service must read it to enforce it.
- **Signed** by a control-plane policy key whose certificate it embeds.
- **Holds no collection content.**

```cddl
; ---- policy items (policy.md §1) ----
policy-payload = {
  0: 1,                    ; fmt
  1: cp-cert,              ; certificate of the signing policy key (§3)
  2: time-ms,              ; issued_at: control-plane time, monotonic per collection
  3: [+ policy-op],        ; ops: applied atomically, in order
}

policy-op = genesis / device-enrol / device-revoke / member-set / member-remove
          / grant / grant-revoke / collection-state / cp-key-revoke
          / migration-cutover / freeze / root-handover / approval-request

genesis = {
  0: 1,
  1: uuid,                 ; owner: the account that owns the collection
  2: bstr .size 16,        ; root: key ID of the control-plane root key governing this collection
  3: cstate,               ; initial collection state
}

device-enrol = {
  0: 2,
  1: uuid,                 ; device ID
  2: uuid,                 ; account: the member it belongs to (all-zero UUID for mdbase service devices)
  3: device-kind,
  4: bstr .size 32,        ; sign_pk: Ed25519
  5: bstr .size 32,        ; kem_pk: X25519 (HPKE key wraps)
  6: bstr .size 32,        ; noise_pk: X25519 (client sessions); 32 zero bytes for `recovery`
  ? 7: hash,               ; sas_commit: the new device's SAS commitment (sealed-envelope.md §5.3)
  ? 8: bstr .size 32,      ; local_root: the Ed25519 root key this device would govern a device-located log with (§2.1)
}
device-kind = &( desktop: 0, mobile: 1, app-runtime: 2, cli: 3, hosted: 4, escrow: 5,
                 recovery: 6 )

device-revoke = { 0: 3, 1: uuid }                              ; device ID

member-set = { 0: 4, 1: uuid, 2: role }                         ; account, role (add or change)
member-remove = { 0: 5, 1: uuid }                               ; account
role = &( viewer: 0, editor: 1, owner: 2 )

grant = {
  0: 6,
  1: uuid,                 ; grant ID
  2: uuid,                 ; app installation ID
  3: tstr,                 ; app ID (registry identifier; informational)
  4: uuid,                 ; account: the member who granted it
  5: [+ capability],       ; capabilities (§5)
  6: bstr .size 32,        ; client_pk: the installation's Noise static key
  ? 7: [+ path],           ; file_folders: restrict file access to these folders (file namespace only).
                           ;   cloud-copy only: in e2e the scope travels sealed in the grant approval (§5.1)
  ? 8: bool,               ; folder_scoped: e2e only; the approval carries file_folders
}
grant-revoke = { 0: 7, 1: uuid }                                ; grant ID
capability = tstr          ; versioned capability group identifier, e.g. "collection.read"

collection-state = {
  0: 8,
  1: cstate,
  ? 2: bool,               ; compress: default true (sealed-envelope.md §8)
  ? 3: uint,               ; min_sem_major: raises the semantics ratchet (00-overview.md §6.3)
}
cstate = &( e2e: 0, cloud-copy: 1 )

cp-key-revoke = {
  0: 9,
  1: bstr .size 16,        ; key ID of the revoked policy key
  2: time-ms,              ; revoked_from: items issued at or after this are invalid
  3: signature,            ; root signature over H("mdbase/v1/cp-key-revoke", canonical([key ID, revoked_from]))
}

migration-cutover = {
  0: 10,
  1: uuid,                 ; legacy_collection: the Connect collection this one replaces
  2: [* uuid],             ; revoked: legacy mirror replica credential IDs revoked server-side
  3: time-ms,              ; cutover_at
}

freeze = { 0: 11, 1: bool, ? 2: tstr }                          ; frozen, reason

approval-request = { 0: 13, 1: uuid, 2: hash }                  ; device, sas_commit (sealed-envelope.md §5.3)

root-handover = {
  0: 12,
  1: bstr .size 32,        ; new_root: Ed25519 public key of the root governing items after this one
  2: uuid,                 ; owner_device: a keyed device of the owner, consenting to the move
  3: uuid,                 ; move ID (control plane)
  4: signature,            ; owner_device's signature over
                           ;   H("mdbase/v1/root-handover", collection ‖ u64be(seq of this item) ‖ new_root ‖ move ID)
}
```

## 2. Genesis and the root of trust

A synced collection's log starts with a `policy` item at position 1, containing a
`genesis` op. It is created when the control plane registers the collection, either
because sync was turned on for a local collection or because one was created on the
web. Genesis names:
- the owner account;
- the initial state;
- **the root key** that governs this collection.

The runtime ships a pinned set of control-plane root public keys: production, staging,
LAB. A replica accepts a genesis only if its `root` is in that set, or in roots the user
added explicitly. Explicit roots make a self-hosted control plane possible later. The
root changes only by a co-signed `root-handover` (§2.1), when the log moves between a device and the hosted service.

The items after genesis enrol the owner's membership and the creating replica,
followed by the `initial` rekey (`sealed-envelope.md` §5.2) and possibly a `base`
(`snapshot.md` §7). A service-created cloud-copy collection needs no user device:
hosted is the first keyed replica and wraps the initial epoch for hosted and escrow.
Private collections never enrol either service kind.

### 2.1 Root handover (log moves)

A log moves between a device (embedded log service) and the hosted log service.
Its policy root moves with it, by a `root-handover` op. A device-located log
is governed by that device's local root, a key generated per collection and stored like
the device's other secrets. A hosted log is governed by a pinned control-plane root.

A `root-handover` in the item at `p` is valid only when all of these hold:
1. **Signed under the current root.** The item is validly signed (§3) under the root in
   force at `p − 1`. That is the device's local root directly, or a control-plane policy
   key certified by the control-plane root.
2. **The owner consents.** `owner_device` is an active, keyed device of the owner at
   `p − 1`, and its signature over
   `H("mdbase/v1/root-handover", collection ‖ u64be(p) ‖ new_root ‖ move ID)` verifies.
   A stolen policy key alone can therefore never move a log's root.
3. **Allowed target.** `new_root` is one of:
   - a pinned control-plane root;
   - the `local_root` in `owner_device`'s own `device-enrol`.

   Replicas reject any other target.
4. **The policy key wasn't revoked.** When a policy key signed the item, no earlier
   `cp-key-revoke` names that key with `revoked_from ≤ issued_at` (§3 rule 5).

Verdicts are never revised after the fact (§3, "Revocation is not retroactive"). A
handover is protected by the owner device's signature (rule 2), not by a later
revocation. A stolen policy key alone can't produce one. A `cp-key-revoke` signed by
a control-plane root stays appendable and valid for the life of the log, whatever the
current root is. It then governs any later item that still claims a control-plane
policy key.

Items after a valid handover are signed under `new_root`. When the new root is a
device's local root, the items carry a certificate for it in the `cp-cert` shape:
`policy_pk = root`, signed by itself, with `root = key ID(new_root)`.

`genesis.root` names the first root. The root changes **only** by handover. Fixing
how `cp-cert` and the genesis `root` key ID are read under a local root is part of this
change: `cert.root` must equal the root in force, not only the genesis `root`.

## 3. Control-plane keys

The control plane's keys form a two-level hierarchy:
- an **offline root key** (Ed25519) per environment;
- **online policy keys** (Ed25519), each certified by the root for a validity window.

The policy keys sign policy items. Compromising the online control plane exposes a
policy key, never the root.

```cddl
; ---- control-plane certificate (policy.md §3) ----
cp-cert = {
  0: bstr .size 32,        ; policy_pk
  1: time-ms,              ; not_before
  2: time-ms,              ; not_after
  3: bstr .size 16,        ; root: key ID of the certifying root
  4: signature,            ; root signature over H("mdbase/v1/cp-cert", canonical(cert without key 4))
}
```

A policy item at `p` is **validly signed** when all of these hold:
1. `cert.root` equals the genesis `root`, and the certificate's signature verifies
   under that root key.
2. The item's envelope `signer` equals the key ID of `cert.policy_pk`, and the item
   signature (`sealed-envelope.md` §2.2) verifies under `cert.policy_pk`.
3. `not_before ≤ issued_at ≤ not_after`.
4. `issued_at` is not less than the previous valid policy item's `issued_at`. Issue
   times are monotonic, so a stolen key cannot backdate an item behind newer policy.
5. No earlier valid `cp-key-revoke` names this key with `revoked_from ≤ issued_at`.
   The root's signature in that op is verified against the genesis root, or against a
   control-plane root in force since a handover.

**Revocation is not retroactive.** A `cp-key-revoke` at `p` voids items *after* `p`
that were signed by the revoked key with `issued_at ≥ revoked_from`. Items before `p`
stay applied, because replicas never revise a verdict. Otherwise replicas that had
compacted or bootstrapped differently would diverge. So the control plane appends the
revocation **together with compensating ops, in the same item**. Those ops revoke every
device, grant and membership, and reverse every state or freeze change, that items
signed by the revoked key at or after `revoked_from` introduced. Replicas help the
operator check this: on applying a `cp-key-revoke`, a replica records a
`policy_key_compromised` incident listing the earlier positions that the key signed
with `issued_at ≥ revoked_from`.

In `e2e` collections, a stolen policy key never yields content or keys. Approval of
devices (SAS) and of grants, and the owner co-signature on handovers, do not depend
on it. Compensation restores authorization state; it does not need to recover
secrets.

`issued_at` is the control plane's assertion, so validity never depends on a
replica's clock.

## 4. Devices and members

### 4.1 Members

A collection has members (accounts) with roles:

| Role | May |
|---|---|
| `viewer` | read: its devices are keyed and receive every item |
| `editor` | read and write content (`entry`, `base`); approve new devices in end-to-end collections |
| `owner` | as editor; the control plane accepts sharing, grant and state changes only from owners |

- **Role changes** take effect at the next position.
- **`member-remove`** revokes all of that account's devices and grants, and puts the
  log into rekey-required.
- **Viewers' devices are read-only replicas.** A local edit on a viewer's folder is
  never appended. It would be void: the viewer has no write role. So the replica
  holds such a file with reason `read_only` (`replica-client-api.md` §8).

### 4.2 Devices

`device-enrol` gives a device its transport identity and its three public keys. A
device is **active** from its enrolment until a `device-revoke`, or the removal of its
account. It is **keyed** once it receives a key (`sealed-envelope.md` §5.3).

| Device kind | Typical holder | Account | May write `entry` | Notes |
|---|---|---|---|---|
| `desktop` | the desktop daemon | a member | if role ≥ editor | |
| `mobile` | the Obsidian runtime on mobile | a member | if role ≥ editor | |
| `app-runtime` | a first-party app hosting a replica (shared runtime, web app with offline replica) | a member | if role ≥ editor | requires the app to hold `offline.replica` (§5) |
| `cli` | a headless replica | a member | if role ≥ editor | |
| `hosted` | the hosted replica | service (all-zero) | yes, in cloud-copy state; for itself and for grants | only while the state is `cloud-copy` |
| `escrow` | the escrow service | service (all-zero) | **no** | cloud-copy only; may append `rekey` and `key_grant` only; approved-account device delivery when hosted is unavailable |
| `recovery` | the account key: the user's recovery key, also held by the control plane sealed under the user's encryption password (`sealed-envelope.md` §5.4; AK1) | a member (the account that set it up) | **no** | may append `key_grant` only (never `rekey`; it is a rekey **recipient**), and grants only to its own account's active user devices, in `e2e`; no Noise key, never a routing target |

### 4.3 Revocation

`device-revoke` and `member-remove` take effect at the next position:
- from then on, the device's items are void;
- its grants' entries are void;
- the log is in rekey-required until a `rekey` (`sealed-envelope.md` §5.2).

The log service drops the device's transport credentials in the same atomic step
(§6.3). A revoked device keeps whatever it already decrypted. That is inherent, and the
rekey keeps it out of everything after.

### 4.4 Device approval in end-to-end collections

The control plane enrols devices, but in an end-to-end collection it is not trusted to
decide who gets the key. An enrolled device stays unkeyed until an existing keyed
device of an owner or editor appends a `key_grant` for it. That needs the user's
approval with a short authentication string (`sealed-envelope.md` §5.3,
`replica-client-api.md` §8.3).

**Cloud-copy account approval.** An account can create a
cloud-copy collection without a desktop. Hosted generates the initial epoch and
wraps it for hosted and escrow. A new account device is approved through the
authenticated account and control-signed membership/enrolment. Hosted, or escrow
if hosted is unavailable, wraps the current epoch to it; no other user device must
be online. Approval must bind the collection, account and enrolled device identity;
a role-0 transport token is not key approval (`sealed-envelope.md` §7.1).

**Private remains separate.** No active hosted/escrow identity exists in committed
private policy, and neither may send or receive private epoch keys. Private device approval
and trust rules above are unchanged. Converting private to cloud copy still needs
an owner device to key hosted; changing a policy mode alone supplies no existing
private epoch key. An unrequested state change is reported on user devices.

### 4.5 Collection state

`collection-state` records the state the user chose:
- `e2e` is "synced, end-to-end encrypted";
- `cloud-copy` is "synced with a cloud copy".

Local-only collections have no log and remain hidden migration/advanced
**Sync: off** state. The two visible collection options are **Cloud copy**
(signup default) and **Private** (end-to-end synced); local-only has no pricing
tier or signup/main-UI option. See `../collection-states-and-pricing.md`.

- **Switching private to `cloud-copy`** is owner-initiated. The mode transition and
  service enrolment must commit consistently as cloud-copy policy, never as private
  policy with service devices. An owner device keys hosted with the existing epoch
  history; service-created bootstrap cannot substitute a new key for private data
  (`sealed-envelope.md` §7.1).
- **Switching to `e2e`** is valid only if no `escrow` or `hosted` device remains
  active after the item's ops. The control plane therefore revokes them in the same
  item, and the log enters rekey-required. A user device performs the subsequent
  rekey with no hosted or escrow recipient; services cannot perform this private
  rekey.
- **`compress: false`** makes writers seal with compression algorithm 0.
- **`min_sem_major`** raises the semantics ratchet explicitly, for a planned breaking
  semantics release.

## 5. Grants: thin clients and third-party apps

A grant authorizes **one app installation, on one collection, for explicit
capabilities**. The collection is the minimum visibility boundary: there is no
type-scoped or record-scoped grant (Connect ADR 0012). Capabilities are the versioned
groups of Connect ADR 0013, contract version 2. Each expands to fixed operations in
these contracts:

| Capability | Client API calls (`replica-client-api.md`) | Mutation operations |
|---|---|---|
| `collection.read` | `describe`, `get`, `query`, `subscribe`, `changes`, `list_views`, `execute_view`, `validate`, `list_files`, `read_file`, presence | — |
| `records.create` | `submit`, `open_upload` | `create`; `file_put` creating a file |
| `records.edit` | `submit`, `open_upload` | `update`; `document` (api); `rename`; `file_put` replacing content; `file_move`; `conflict_dismiss` |
| `records.delete` | `submit` | `delete`; `file_delete` |
| `views.manage` | `submit` | operations on saved-view sources: records of a view type, or files in a view source format (spec 12 saved views) |
| `definitions.manage` | `submit` | `resource_put`, `resource_delete`, `sync_settings` |
| `background.schedule` | none on a replica: the control plane's timer service (`timer-service-api.md`) and push channel registration check it | — |
| `offline.replica` | — | permits enrolling an `app-runtime` device for the app; **first-party apps only** |

- **Grants in `e2e` need a device approval** (§5.1). The control plane authors the
  `grant` op. In an end-to-end collection that alone authorizes nothing.
- **Folder-scoped file access** (`file_folders`) is the one narrowing below the
  collection, kept from Connect's file capability (`docs/files.md`, "selected
  folders"):
  - it restricts only the **file** namespace: listing, reading and every file
    operation. A file outside the folders is invisible to the grant;
  - records stay collection-wide;
  - folders compare by path key;
  - a `file_move` out of the scope is `forbidden`;
  - replicas apply the same check at replay (§6.2, V6).
- **A grant never carries a key** (non-negotiable 5). The app reaches a replica over
  the client API, and the replica enforces the grant.
- **`offline.replica` is the one exception that turns an app into a device**, and only
  first-party runtimes may hold it. A third-party app that wants offline work talks to
  the local daemon.
- **A grant is bounded by its granting member's role.** If the member is removed or
  becomes a viewer, write capabilities stop at that position.
- **No time expiry in the log.** Expiry would need a clock at replay. The control plane
  appends `grant-revoke` when a grant expires or the user revokes it. Session lifetimes
  are bounded separately, in the client API.
- **Who needs a grant.** First-party apps that *host* the runtime (TaskNotes and
  mdbase-obsidian sharing a runtime, the desktop app over its own daemon) act as the
  device and need none. Every other client of a replica (local IPC apps, plugins
  attached as clients, remote thin clients, MCP) needs one.

### 5.1 Grant approval in end-to-end collections

In an `e2e` collection, the control plane could otherwise grant itself (or any key it
holds) `collection.read`, and read the collection through the relay without ever
holding the collection key. So a grant becomes **effective** only once a keyed device of
the granting member approves it. The approval is a sealed, device-signed log item of kind
`grant_approval` (`sealed-envelope.md` §2):

```cddl
; ---- grant approval (policy.md §5.1) ----
grant-approval-payload = {
  0: 1,                    ; fmt
  1: uuid,                 ; grant ID
  2: bstr .size 32,        ; client_pk: must equal the grant op's
  3: [+ capability],       ; capabilities: a subset of the grant op's; the effective set
  ? 4: [+ path],           ; file_folders: the folder scope (sealed, so paths stay private)
}
```

- **The approval UI** is offered to the hosting app only (`replica-client-api.md` §8.3).
  It shows the app ID, the capabilities, the folder scope, and a fingerprint of
  `client_pk`: the first 8 bytes of `H("mdbase/v1/client-fp", client_pk)` as 16 hex
  digits. The app shows the same fingerprint on its consent screen.
- **The folder scope.** The app chose its folders at consent. The control plane passes
  them to the approving device out of band (the relay message that announces the
  pending grant), never in the log.
- **A control item.** `grant_approval` is never compacted (`log-entry.md` §1), so policy
  state can always be computed from position 1.
- **Validity** of a `grant_approval` at `p`: the signer is an active, keyed device of the
  grant's account, and that account is still a member; the grant is active; `client_pk`
  matches; the capabilities are a subset; not rekey-required (it is sealed under the
  current epoch, V2).
- **Effective grant** where approval is required (`e2e`, or `cloud-copy` without a keyed
  escrow) = the grant op ∩ its first valid approval. A grant with no
  valid approval authorizes no session and no `on_behalf` entry (V6). `grant-revoke`
  still needs only the control plane: revoking is always safe.
- **Device-located logs** (logs whose policy root is a device's local root) follow the
  same rule whatever their `cstate`. A grant the control plane relays to the device is
  appended only after the user approves it on that device.
- **`cloud-copy` collections whose escrow device is keyed** need no device-side
  grant approval: cloud-copy trust includes hosted plaintext and escrowed keys.
  A service-created initial epoch may key escrow without any user device; this is
  not evidence of an owner-desktop handover (`sealed-envelope.md` §7.1). Without
  keyed escrow, the existing grant-approval requirement remains. This concerns
  app grants, not approval of new devices, and is evaluated at each log position.

**Residual risk, documented.** A thin client learns its target's `noise_pk` from the
control plane's routing (`replica-client-api.md` §12.3). A malicious control plane could
therefore intercept the client's *own* session and see what that client reads and
writes. It cannot open sessions to the collection by itself. Web apps served from
mdbase's origin are trusted with what they display.

## 6. Deterministic evaluation at replay

### 6.1 Policy state

Every replica maintains `P(p)`, the policy state after applying items `1..p`:

```text
P = { root, owner, cstate, compress, min_sem_major, frozen,
      last_issued_at, revoked_cp_keys,
      members:  account → role,
      devices:  device → { account, kind, sign_pk, kem_pk, noise_pk, active, keyed },
      grants:   grant → { installation, account, capabilities, client_pk, file_folders, active },
      epoch, rekey_required,
      sem_ratchet,                        ; max sem.major of applied entries, or min_sem_major if higher
      log_time }                          ; snapshot.md §6
```

`P(p)` is a pure function of the items. Policy and key items are never compacted
(`snapshot.md` §5), so every replica can compute `P` from position 1, and two replicas
at the same position always agree.

### 6.2 Who may append what

An item at `p` is authorized under `P(p − 1)` as follows. Otherwise it is void
(`log-entry.md` §4.3, V1).

| Kind | Signer | Further conditions |
|---|---|---|
| `policy` | a control-plane policy key, validly signed (§3) | each op valid in order (§6.4); the first item is a `genesis` and no later item is |
| `entry` | an active, keyed device whose account has role ≥ editor, or a `hosted` device in `cloud-copy` state | not frozen; not rekey-required; epoch current; `sem.major ≥ sem_ratchet`; if `on_behalf` is present, the signer is an active device of that grant's account, or an active `hosted` device while the collection is in `cloud-copy`; that grant is active, its member's role still allows the ops, its effective capabilities cover every op, and every file op's paths are within its `file_folders` (§5, V6) |
| `rekey` | an active, keyed authorized device; hosted may rekey in cloud-copy. For `initial`, an active owner/editor user device, or hosted as the first keyed replica of a service-created cloud-copy collection | `sealed-envelope.md` §5.2 validity; no hosted/escrow signer or recipient in private mode |
| `key_grant` | `e2e`: an active, keyed device of an owner or editor, or a member account's `recovery` device granting to an active user device (`desktop`/`mobile`/`app-runtime`/`cli`) of the **same account**. `cloud-copy`: existing user-device authority, or hosted (escrow if hosted is unavailable) for approved account-device delivery | `sealed-envelope.md` §5.3 validity; verified account approval, current collection mode and active recipient; no service signer or recipient in private mode |
| `grant_approval` | an active, keyed device of the grant's account | §5.1; not rekey-required; epoch current |
| `base` | an active, keyed device whose account has role ≥ editor; for `hosted-import`, a keyed hosted device in cloud-copy | `snapshot.md` §7 validity; not frozen; not rekey-required; hosted migration uses ordinary cloud-copy authority, not a one-time waiver |

For an `on_behalf` entry, another member's device does not satisfy the signer-account
predicate, even if both members may write. An `escrow` device is not a hosted replica;
an unknown or revoked device, or a hosted device in `e2e`, also fails the predicate.
In `e2e`, coverage still requires the first valid grant approval (§5.1). Without
`on_behalf`, this V6 predicate does not apply; the entry's other checks still apply.
The nine-case payload-predicate vector is
`conformance/policy/on-behalf-signer.json`, exercised by the existing policy evaluator.
It assumes an otherwise effective, capability-covering grant and does not replace
header, signature, epoch or other entry validation.

### 6.3 The log service enforces the same policy

The log service parses each policy item it is asked to append. If the item is validly
signed, it applies the item's transport effects **in the same atomic step as the
append**:
- the device and signing-key ACL;
- revoked device credentials;
- the frozen flag.

There is therefore no position at which the service's ACL and the log disagree. A
revoked device's next append is refused at the transport (`forbidden`), and its open
subscriptions are closed.

If the service is wrong, or malicious, and accepts an unauthorized item anyway,
replicas void it. Voids are counted and reported. The service-side check exists to
stop garbage, not to decide.

### 6.4 Policy op validity

Ops apply in order within one item. One invalid op voids the whole item.
Private-mode service exclusion concerns active identities and key authority.
Revoked/inactive service rows and their signed history remain after conversion;
retain them for deterministic replay, never reactivate them or purge the history.

| Op | Valid when |
|---|---|
| `genesis` | only in the item at position 1 |
| `device-enrol` | the device ID is new (never enrolled before). Hosted/escrow require committed cloud-copy mode and the all-zero service account; no policy item may leave either kind active in private mode. For every other kind, the account is a member. Cloud-copy account-device joins require authenticated-account approval and control-signed enrolment. A `recovery` device has an all-zero `noise_pk`; no other kind may. |
| `device-revoke` | the device is active |
| `member-set` | the account is not the owner being demoted below owner while it is the only owner |
| `member-remove` | the account is a member and not the only owner |
| `grant` | the grant ID is new; the account is a member with role ≥ editor, or viewer when the grant is read-only; in `e2e`, `file_folders` is absent |
| `grant-revoke` | the grant is active |
| `collection-state` | as in §4.5 |
| `cp-key-revoke` | the root signature verifies |
| `migration-cutover` | at most once per log |
| `freeze` | always |
| `root-handover` | §2.1 |
| `approval-request` | the device is active and not keyed. Its commitment replaces any earlier one (the `device-enrol` key 7, or a previous request) |

## 7. How replicas enforce thin-client grants

A replica serving a client:
1. **At session start** authenticates the client's Noise static key against an active
   grant's `client_pk` (`replica-client-api.md` §12), and binds the session to that
   grant. In `e2e`, the grant must also have a valid approval (§5.1), and the session gets
   the approval's capabilities and folder scope.
2. **On every call** checks the call against the grant's capabilities in its current
   confirmed policy state. A missing capability is `forbidden`.
3. **On every mutation** sets `on_behalf` to the grant. Its local optimistic plan uses
   the same capability check. At head, the writer re-checks against `P(head)`. A grant
   revoked meanwhile rejects the mutation with `forbidden`, and it is never appended.
4. **When it applies a `grant-revoke`**, or a removal of the granting member, closes
   that grant's sessions with `unauthenticated`. Each pending mutation of the grant is
   rejected with `forbidden` at its next planning.
5. **Filters nothing by type.** Grants are collection-wide. Visibility is all or
   nothing, so query results need no per-record authorization and stay cheap.

Revocation is deterministic across replicas: whether an entry made on behalf of a
grant counts depends only on the grant's state at the entry's position.

## 8. Migration: the cutover policy and server-side mirror revocation

The migration assumes no connector or mirror has been updated. Safety comes from the
server and the new runtime only. For a hosted Connect collection moving to mdbase-next,
the control plane does this, in order:

1. **Shadow.** The hosted replica imports the legacy rows into a new log: a `base` item
   with `hosted-import` and the legacy record IDs (`snapshot.md` §7). It keeps
   verifying against the old rows while the old system serves writes. The new log is
   **frozen** (`freeze true`): it rejects content entries, so nothing writes to both
   systems.
2. **Stop the old writes.** The legacy collection is put into maintenance, so the old
   server refuses mutations. A final shadow sync imports the last changes.
3. **Revoke every legacy mirror replica credential** for the collection, server-side.
   This works for every connector version: old mirrors report only protocol versions,
   so they cannot be gated by software version. An old mirror then stops
   syncing, and its folder keeps the user's files.
4. **Append one policy item** containing `migration-cutover` (the legacy collection,
   the revoked credential IDs, the time) and `freeze false`.
5. **Route apps to the new replica.** The old SDK protocol is accepted for one release
   through the compatibility shim.

The cutover position is the **sync point** for every old mirror folder
(`snapshot.md` §9). When such a device later runs the new runtime, it joins the folder.
Any edit the old mirror never uploaded is on a record unchanged since cutover in the
log, so it is ingested as an ordinary external edit: delayed, not lost. Records changed
on both sides are held.

**Rollback** before step 4 is "unfreeze the legacy collection and discard the new log".
After step 4, the legacy rows are retained until verified, but writes
continue only in the new log.

Local collections are taken over by the new runtime on the device itself:
- it stops the old daemon and settles its journal;
- it writes the v2 role marker.

No policy item is needed for that. The takeover is a local adoption, and appears in a
`base` item only when sync is turned on.

## 9. Flows

Required cloud-copy/private conformance coverage:
- service-created hosted initial epoch wraps hosted + escrow without a user device;
- authenticated-account-approved device joins work through hosted and through
  escrow fallback without another user device online;
- hosted cloud-copy rekeys obey ordinary epoch, revocation and recipient-set rules;
- wrong-account/collection, stale or revoked approval, and unkeyed service delivery
  are rejected;
- private mode rejects hosted/escrow enrolment, service-signed initial and ordinary
  rekeys, and service key-grant signers or recipients;
- private conversion requires an owner-device handover; conversion back requires
  a user-signed rekey excluding both services;
- hosted migration uses ordinary cloud-copy authority and preserves existing
  source/base/cutover fences, rather than a one-time keying exception.

These are implementation/review obligations, not a claim that this docs-only
change has qualified any runtime.

These workflows describe the cloud-copy model in `sealed-envelope.md` §7.1,
superseding the earlier owner-desktop-only restriction.
Service creation, approved-account device keying and hosted rekeys are cloud-copy
only. Private mode structurally excludes active service identities and key delivery;
existing private trust rules remain unchanged. All flows still require valid
signed policy, epoch/recipient checks and admission before serving.

| Flow | Items appended | Who |
|---|---|---|
| Turn sync on for a local folder | `policy[genesis, member-set owner, device-enrol this device]` → `rekey initial` → `base folder` | control plane, then the device |
| Create cloud copy through an app, no user device | `policy[genesis cloud-copy, member-set owner, device-enrol hosted, device-enrol escrow]` → hosted-signed `rekey initial` wrapping hosted + escrow | authenticated account/control plane, then hosted; valid bootstrap before Ready/content producers |
| Add a device, e2e | `policy[device-enrol]` → user approves on an existing device → `key_grant` | control plane, then the device |
| Add an account device, cloud copy | authenticated-account approval → control-signed membership/enrolment → `key_grant` to that device | control plane, then hosted; escrow if hosted is unavailable; no other user device must be online |
| Remove a lost device | `policy[device-revoke]` → `rekey device-revoked` | control plane, then any keyed device |
| Share with a person | `policy[member-set]`, then their devices enrol as above | control plane |
| Stop sharing | `policy[member-remove]` → `rekey member-removed` | control plane, then any keyed device |
| Authorize an app | `policy[grant]` | control plane, after consent |
| Revoke an app | `policy[grant-revoke]` | control plane |
| Private → cloud copy | owner-initiated atomic mode/service-enrolment transition → owner-device key delivery to hosted | control plane, then the keyed owner device; existing private key history is preserved |
| Cloud-copy rekey | valid `rekey` with the required active/keyed recipient set | hosted or an authorized user device; never a service signer for private mode |
| Hosted migration | ordinary cloud-copy bootstrap/key delivery → validated `base hosted-import` and cutover | control plane and hosted; same service mechanism, no separate one-time exception; migration fences remain |
| Cloud copy off | `policy[device-revoke hosted, device-revoke escrow, collection-state e2e]` → `rekey cloud-copy-off` | control plane, then a device |
| Hosted migration cutover | `policy[freeze true]` … `policy[migration-cutover, freeze false]` | control plane |
