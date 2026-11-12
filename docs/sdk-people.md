# SDK: people and contract inspection

```ts
import { MdbasePeopleClient } from "@mdbase-dev/sdk";
// Inside the trusted owned Worker, after collection adoption and CP transport pinning.
// host is the existing AppWebCloudCopyHost; its session/credential stays private.
const metadata = host.peopleAuthority();
const people = new MdbasePeopleClient(db, metadata);
const directory = await people.directory({ members: "if-approved", signal });
directory.account; // public exact issuer/subject/name/account UUID
directory.me;      // linked, unlinked, ambiguous, or invalid; never name/email inference
directory.people;  // complete native mdbase.person 2.0.0 inventory
// host.close() retires metadata before native/SQL shutdown.
```

The host returns only a frozen read-only metadata view, not a session or bearer
getter. Send only public directory projections over the Worker channel. Other
trusted hosts owning a genuine registered-device session can construct
`AppCpPeopleAuthority` internally; callers must never reconstruct it from receipts.

`current()` and `members()` read fixed CP metadata endpoints; `directory()` uses
Core's canonical resolved mappings, defaults and validation through
`db.queryContract({ id, version }, { pageSize, cursor, signal })`. It does not
recreate contract semantics from raw frontmatter. The directory checks CP/native
collection binding and consumes every native continuation under one session,
`asOf` and contract digest; stale/incomplete/oversized inventories fail as a whole.
A full unindexed window refuses with `contract_query_cursor_required`, not a
fabricated cursor or partial result. A fresh absent registered Person contract
means unlinked; disappearance after any page is an error. Invalid claiming
records take precedence over an otherwise linked match. Optional members are
omitted only for explicit permission decline (or `members: "omit"`), never scope,
revocation, integrity or network errors. Old producers refuse the additive
version-one method, without an SDK projection fallback. No record path/payload
or key is sent to the metadata authority.
