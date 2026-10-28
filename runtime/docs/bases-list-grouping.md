# Bases list grouping

Bases groups a list-valued property by the **whole ordered list**, not by each
member. A row with projects `[Alpha, Beta]` belongs to one group; `[Beta, Alpha]`
and `["Alpha, Beta"]` are different keys. Repeated identical lists share a group.
The TaskNotes Projects source therefore needs no rewrite or per-element expansion.

## Evidence

- [Obsidian Bases syntax](https://github.com/obsidianmd/obsidian-help/blob/578f73ccb32a0eb52e955dd59e241a6c7123b755/en/Bases/Bases%20syntax.md#views):
  “The value of the specified property for each row is used to place the row into groups.”
- [Obsidian API declarations](https://github.com/obsidianmd/obsidian-api/blob/9abd9605ce081383674aae1ed111c456edde0688/obsidian.d.ts):
  `BasesEntryGroup.key` is a `Value`; `ListValue` wraps an ordered array of values.
- Checked the published [Obsidian 1.12.7 bundle](https://github.com/obsidianmd/obsidian-releases/releases/download/v1.12.7/obsidian-1.12.7.asar.gz),
  without opening a vault or running Obsidian. `BasesQueryResult.groupedData`
  retrieves one property value per entry and adds the entry to one matching
  group using `Value.looseEquals`. `ListValue.compare` checks equal lengths and
  corresponding positions, rather than iterating entries into multiple groups.
  SHA-256 of extracted `app.js`:
  `cc6d0c363cba3935207fb70e7d78736c9f0c2024545787871095288a1b185851`.

## Runtime policy

The runtime preserves the whole typed list as the group key. Equality is
structural, retaining scalar type distinctions, order and duplicates; signed
zeros retain the existing numeric equality. It does not stringify lists, join
members into collision-prone labels, normalize their order, or duplicate rows.

Lists sort lexicographically using the existing explicit string/null comparison
capture, with a shorter equal prefix first; descending reverses the result.
This is deterministic native/WASM ordering, not a claim to reproduce Obsidian's
ambient locale collator. Unsupported mixed element types still visibly refuse,
just as mixed scalar ordering does. Obsidian's broader loose scalar coercions
(including singleton-list/scalar equality) are not newly qualified here.

Objects, durations and errors remain unsupported keys, even nested in a list.
Existing depth, text, work, row/group and retained-output limits still apply.
Indexed ownership and the shared native/SDK codec accept the same bounded list
keys, rather than making execution succeed only to reject its response.

## Fixtures

`conformance/views/tasknotes-projects.base` is the unchanged stock Projects
source for the default field mapping. It matches the source generator in
[TaskNotes](https://github.com/callumalpass/tasknotes-app/blob/21f389743c5cdd27f4e2298e2b5f384238234351/src/domain/default-view-source.ts).
Tests compare captured and indexed execution for one/multiple projects, repeated
lists, reversed lists and comma-containing names, and exclude empty projects,
completed and archived tasks.

`bases-ordering` replay deliberately promotes its old empty-list comparison and
empty-list grouping refusals to values, and adds whole-list membership, ascending
and descending order, signed-zero equality, and nested-object/error refusals.
The shared `bases-list-group-codec.json` pins exact tagged list-key bytes in Rust
and TypeScript; the pre-existing scalar codec fixture stays unchanged.
