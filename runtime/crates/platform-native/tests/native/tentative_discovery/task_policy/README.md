# Exact bundled TaskNotes Task policy fixture

These four publisher resource documents are copied byte-for-byte from the
`provisions.type_packs[0]` sources in TaskNotes' generated application manifest.
`provenance.json` records the source checkout/manifest and each source, target,
byte count and SHA256. The native test asserts all four resource hashes before
installing them with Core's guarded pack assessment/application and its actual
pack lock in an isolated SQL replica, using the source manifest's exact
`installed_by: dev.tasknotes.app`. Raw schema resource puts without that lock
would not be a faithful pack install. `pack-manifest.json` preserves the actual
publisher declaration, parsed by Core rather than manually synthesized.
Do not replace these bytes with a helper-generated or synthetic lifecycle type.

The declaration's source is `types/tasknotes-task/5.md`; its declared version is
**4**, despite the publisher source path's `5`. Its contract is
`tasknotes.task@0.3.0-rc.5`. The unguarded `on_create.set.id.uuid` changes logical
IDs; explicit native record IDs remain original.

The representative parent/two occurrence documents use the rc15 model's ordinary
`recurrence_parent: '[[tasks/parent]]'` path link. They test native preservation of
that link alongside lifecycle-owned logical IDs, not the application's rolling
materialization/date/deduplication algorithm. The model's parent link is not a
logical-ID reference; don't classify it as one from its name.

This qualifies these bundled policy bytes on the test's current native engine,
actual disposable SQLite pending restoration, signed sync and current record
reads. It does not identify current policy in an existing LAB collection, qualify
Scratchpad's different pack, execute browser/WASM or custody/grant flows, or prove
physical durability under power loss.
