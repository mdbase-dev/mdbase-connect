# Pre-acceptance migration capture inventory

The dedicated migration-token route
`GET /internal/v1/next/migration/cohorts/{name}/archive-binding?view=capture-v1`
returns bounded inventory metadata for LAB and staging before archive acceptance.
The existing no-query frozen binding and `receiving-v1` responses are unchanged.
All variants require ordinary dedicated-token authentication, strict queries,
empty bodies and no caller resource selectors; responses are `no-store`.

The exact root is `{schema,binding,frozen_at,observed_at,members}`, with schema
`mdbase-migration-capture/1`. `binding` is the canonical four-field complete
membership binding. `frozen_at` is null before topology freeze; `observed_at`
comes from the trusted PostgreSQL clock. Members are complete and account-sorted:

- `view` is the existing account view, including the full held hosted inventory,
  backend, release/start, pause and terminal state.
- `suspended` is preserved metadata, never permission to restore ordinary access.
- `terminal_excluded_at` is the recorded exclusion timestamp or null.
- `export_collections` is the full held set for nonterminal members and **empty**
  for terminal members. Complete membership/binding is retained even when no
  payload may be selected for a member. Transferred collections are not held.

The snapshot shares one repeatable-read transaction and the existing cohort lock.
No user/hosted row locks are acquired afterward, avoiding effect lock inversion.
Concurrent changes to the locked batch fail closed. More than850 members,
1000 held hosted collections or1MiB encoded JSON refuses without truncation.
A zero-member cohort refuses. Suspended, collectionless and terminal members
are not removed from complete metadata. No account/session payload is returned.

This is **inventory DATA, not an export/fence/restore permission**. It does not
start accounts, freeze topology, accept an archive, authenticate original effect
receipts or authorize native migration. Account start still needs the existing
fresh accepted archive; receiving-v1 still needs its accepted frozen snapshot.
A supported scoped producer must additionally qualify content fencing, writer/
timer drain, currentness, original custody and deleted-source exclusion at its
actual read/effect boundary. The dedicated [prearchive source endpoints](migration-prearchive.md)
provide scoped source authorization before archive/account start; capture-v1 alone
still supplies no effect permission. Do not use a later snapshot to adopt an UNKNOWN.

The live rehearsal also needs the original inclusive window from first H6 content
fence, through topology freeze/capture/acceptance/native migration/flip and final
readability. This view supplies no timed-run or backup/restore verdict.
