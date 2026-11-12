# SDK: collection setup, deletion and type packs

## Collection setup

`mdbase.setup` sets up the open collection from the app's declaration
with one review screen. `plan(options)` changes no collection data: native Core plans the
declared types into the collection's configured definition folders (an
installed pack stays where it is) and the SDK words the result for a
first-run user. Show `summary`, then `changes[].message` as a list,
`conflicts[].message` and `refusal.message` as is. No message contains a code.

Before planning, `plan` first settles any earlier setup still in progress
(for example, records that an interrupted apply was confirmed or finally
rejected), so it can write the SDK's own local setup journal. It never
prepares, submits or retries a collection change.

```ts
let plan = await app.setup.plan({ records: [{ path: "Welcome.md", document: welcome }] });
if (Object.keys(plan.adoptable).length && userChoseAppVersions) {
  plan = await app.setup.plan({ adopt: plan.adoptable, records: [{ path: "Welcome.md", document: welcome }] });
}
if (plan.canApply) await app.setup.apply(plan);
```

`status` is `current` (nothing to do), `setup` or `conflict`. A conflict that
`adoptable` lists is an existing definition with different content, or a type
the app seeded that was edited in a way no published version can be combined
with: if the user chooses the app's version, plan again with `adopt` and that
definition is replaced over exactly the reviewed revision. `staged` holds the definition
documents setup would write, for a details view.

Starter `records` (at most 32, 256 KiB in total) are created once, in the
same mutation as the setup, and only if setup has something to do. A path
that is already occupied is listed with action `skip` and left alone.
Creating them needs `records.create`. After apply, each starter record is
checked by its identity, path and confirmation, not by its exact bytes: Core
may canonicalize frontmatter on create, and a later edit to that note does not
make setup fail.

`apply(plan)` takes a plan from `plan` unchanged and writes everything as one
guarded mutation, all or nothing. If the collection changed since review,
including a definition or starter path taken in the meantime, it resolves
`outcome: "changed"`, nothing is applied, and the next `plan` starts
afresh. If another Private setup plan only retired Native's review ticket,
the SDK re-plans once and continues only when the fresh assessment and file
impact match the original consent. Different changes resolve
`outcome: "changed"`; show a fresh plan and ask
for consent again. Lost or uncertain mutation outcomes are never retried.
Refusal codes: `setup_forbidden` (no `definitions.manage`),
`setup_conflict`, `setup_unresolved`, `installed_newer` (a newer app version
set it up; `setup_downgrade` is its former name) and `setup_records_forbidden`.
`setup_unresolved` means the collection still lacks what the app needs but
setup has nothing it may write: a type the app seeded was removed. The person
restores it in the collection; readiness re-checks and the next `plan` reflects it.

`configure()` is plan and apply in one step, for collections with nothing to
review. A conflict leaves the configuration facet `incompatible`; use
`setup.plan()` to show it.

## Deleting a collection

Owners can delete a collection for everyone with `application.deleteCollection(id, {confirmName})`.
Show it only when the collection's `role` in `snapshot.collections` is `"owner"`, and only after a
confirmation where the person types the collection's name. `confirmName` must equal the current name after trimming (`New collection` for an unnamed one);
the control plane checks ownership and the name, and refuses while an account upgrade is in progress.

Deletion revokes access on every device and app right away and cannot be undone. On success the
collection leaves `collections` (and closes if it was open). A refusal rejects with a
`collection_delete_*` code and changes nothing; pass the error to `describeError()` for the copy.
`collection_delete_outcome_unknown` means the reply was lost: refresh the collections before retrying.

## Type packs

`client.typePacks.plan(pack, options)` asks the replica's Core to plan a type
pack against the local collection and writes nothing. The plan has `status`
(`install`, `upgrade`, `downgrade`, `reconfigure`, `current`, `conflict`),
`canApply`, a `summary` of targets by action for a diff, per-target
`resources`, `conflicts` with display-ready messages, and `refusal` (`code`,
`message`) when it cannot be applied. Show `refusal.message` as is.

```ts
let plan = await client.typePacks.plan(pack, { installedBy: "app.example.notes" });
if (Object.keys(plan.adoptable).length) {
  // The user reviewed the existing types: let the pack manage them.
  plan = await client.typePacks.plan(pack, { installedBy: "app.example.notes", adopt: plan.adoptable });
}
if (plan.canApply) {
  const result = await client.typePacks.apply(plan);
  // "pending" is accepted locally; wait for the original mutation to confirm.
  if (result.outcome === "pending") await result.write!.confirmed;
}
```

`apply(plan)` re-plans against the reviewed `digest` and submits every write
as one mutation, so the collection gets all of it or none. Each write,
including the lock and every adopted unchanged target, is bound to the
revision the plan reviewed. If anything changed since review, apply refuses
with `conflict`/`concurrent_modification`; plan again. A pack that is already
current returns `{ outcome: "already_current" }` and writes nothing.
Otherwise the outcome is `applied` (confirmed) or `pending` (accepted; await
`write.confirmed`, which rejects with the original mutation's problem). A
mutation the replica rejects or cannot settle throws its problem with the
original `mutationId` and is never reported as applied. `dryRun` returns
`preview` and installs nothing. Upgrades
use the pack's seed baselines. An older version is refused
(`type_pack_downgrade`) unless `allowDowngrade` is set.

Refusal codes: `forbidden` (no `definitions.manage`, reported by `plan`),
`type_pack_conflict`, `type_pack_downgrade`, `invalid_type_pack`,
`type_pack_contract_setups_unsupported`, and from apply
`concurrent_modification`. Older replicas return
`upgrade_required`/`type_packs_unsupported`.
