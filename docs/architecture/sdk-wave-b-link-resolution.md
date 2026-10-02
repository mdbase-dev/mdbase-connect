# Wave B B6: One link-resolution specification, explicit policy options

Status: proposed; depends on [B1](sdk-wave-b-capability-negotiation.md) for new
options, not for documenting existing native resolution. Baseline/provenance: B1.
Normative collection semantics must land in mdbase-rs/spec fixtures; this Connect
document is the cross-consumer agreement, not a competing resolver implementation.

## Current behaviour with evidence

- Native shared mdbase-rs `src/links/{linked_files,resolution_keys,resolver}.rs`
  resolves stored links using declared target types, then arbitrary CEL links with
  a snapshot index. `src/cel/host.rs:280–338` registers `asFile()` / source-path
  overload; `src/cel/provenance.rs` retains originating-record provenance.
  `src/runtime/record_resolution.rs::select_resolution_candidate` ranks basenames
  by same directory, shallowest path depth, then lexical path; duplicate IDs are
  ambiguous. This is more precise than “shortest match”.
- Local `crates/connect-core/src/registry/operation_execution.rs` delegates CEL;
  hosted `crates/connect-hosted-provider/src/provider/operation_queries/base_sources.rs`
  uses mdbase runtime resolution/projections. Shared selectors must keep both equal.
  Protocol query projections/select and client `src/collection-client.ts` already
  transport CEL; there is no missing generic authority link predicate endpoint.
- Writer `~/projects/mdbase-writer/apps/writer/src/backend/query-capabilities.test.ts`
  probes installed **JavaScript** `@callumalpass/mdbase`, not Rust: projections are
  additive, CEL asFile is absent, its LinkResolver picks `notes/book.md` and
  `other/duplicate.md`, whereas Writer PathIndex scopes to sources and rejects
  duplicate basenames. Do not extrapolate that JS failure to Rust/hosted capability.
- Reports: Reader `annotation-query.ts` and TaskNotes
  `mdbase-repository.ts:405–456` already use native asFile. Editor
  `apps/editor/src/links.ts` includes title/alias, same-folder/shortest preference;
  binary `file-reference-resolution.ts` requires unique basename. Obsidian
  `src/mdbaseCore.ts::resolveLinkInVault` picks the first basename. Those product
  adapters are not proof that native semantics should silently change.

## Rules (native V1; preserve defaults)

Resolve against one snapshot of eligible collection **records**, not arbitrary OS
files. Source path follows the field value's provenance (including `this` and links
read from a traversed record), not automatically the outer query candidate.

1. Parse with mdbase's link parser/extractor. Wikilink `|label` and `#anchor` are
   display/subtarget syntax, not target aliases; Markdown labels/titles do not name
   a target. Preserve the original syntax for editing. Empty/local-anchor-only,
   external URL and malformed link-intent values do not become file paths. A scalar
   traversal must identify one target; lists use explicit CEL iteration, not first
   element selection. Valid embeds resolve their target by the same path rules.
2. Explicit leading `/` means collection root. Markdown and bare path values resolve
   from the containing directory; `./` and `../` wikilinks do too. Other wikilinks
   containing `/` are root-relative. A simple wikilink is a key lookup, not an
   implicit same-folder path. Bare scalar simple names without extension/path syntax
   follow the native simple-key lookup; extracted bare paths keep their `./` marker.
3. Lexically normalize separators and dot segments through mdbase's portable path
   layer. Root-crossing, NUL/invalid and OS-absolute/drive paths are invalid, never
   opened. Explicit paths are exact canonical path lookups (no fuzzy/case-insensitive
   retargeting). Simple keys use native Unicode lowercase, not UI locale collation.
4. For a path, try exact spelling first, then append `.md` if it ends in neither
   `.md` nor `.mdx`. Do not strip arbitrary extensions: `[[sources/plot.png]]` can
   name exact `sources/plot.png` if it is an eligible record, otherwise
   `sources/plot.png.md`. A simple wikilink `[[book.md]]` uses native `.md` stripping
   for basename lookup; do not generalize that to every extension. Eligibility and
   record-extension config are mdbase-owned. Binary embeds use B4/file descriptors,
   not a fake record asFile result.
5. Simple lookup classes are configured ID, basename, then legacy title. V0.3 IDs
   participate only with explicit `settings.id_field`; title lookup is v0.2 legacy,
   not an unversioned v0.3 alias feature. The first nonempty eligible class wins:
   ambiguity in IDs/titles does not fall through to basename. Display aliases and
   editor fuzzy title suggestions are **not** additional native target keys.
6. Apply declared link target types to the candidate universe. Native arbitrary
   expression links otherwise resolve collection-wide; query `types` filters source
   rows, **not** traversal targets. For paths, an existing exact target outside the
   eligible types is unresolved; do not retarget its `.md` alternative. Type names
   use mdbase canonical matching. Scope is query policy, not authorization.
7. One candidate resolves. Multiple basename candidates use same-source-directory
   preference, then fewest path segments, then UTF-8 lexical canonical path. This
   is deterministic native ranking, not first inventory order or shortest characters.
   Multiple ID/title candidates remain ambiguous. Missing/ambiguous asFile is null;
   invalid input/internal inconsistencies/budget exhaustion are errors, not null.
   Reuse mdbase resolution evidence for diagnostics, without inventing a public endpoint.

These rules retain v0.2/v0.3 profile differences explicitly; they are not a proposal
to port Obsidian/editor UI fuzzy lookup into the authority. Any parser/edge-case
mismatch exposed by the fixture campaign must be fixed/versioned in mdbase-rs,
not silently “reconciled” by a Connect fallback.

## Proposed options/API and compatibility

**Yes**, asFile should gain explicit uniqueness/type options:

```text
source.asFile({"ambiguity":"unique","types":["source"]}).file.path
source.asFile("annotations/a.md", {"ambiguity":"unique","types":["source"]})
```

Existing no-argument and source-path forms retain native ranking. New map accepts
only `ambiguity:"native"|"unique"` and nonempty optional `types`; unknown keys or
invalid type names fail validation. Unique rejects >1 eligible candidate in the
winning key class **before ranking**, even if one is in the source directory.
Explicit paths retain rule 6. Requested types intersect declared target types; they
cannot widen schema constraints. No aliases/extension override options in this wave.

Advertise `link-resolution-options-v1` only after both native and hosted plans support
these rules. Existing query wire carries the expression, so no new operation,
entitlement, transport or grant version. mdbase-rs extends CEL registration,
provenance rewriting, compiled plans and shared resolution selector/index. In
particular, stored resolved-target shortcuts cannot bypass unique/type options;
keep candidate evidence or re-resolve using the same index. Hosted outgoing/backlink
indexes must not be rewritten to the requesting app's unique policy: default graph
semantics remain native; option queries use their eligible candidate universe.

SDK typed predicate/projection builders escape values and emit the chosen expression;
they do not implement remote collection semantics. On an old authority, Reader and
TaskNotes keep today's default asFile recipes. Writer retains its source-scoped
PathIndex/JS capability test; **never** send unsupported options or drop them and
claim equivalent uniqueness. Editor/Obsidian retain explicitly named UI/Vault legacy
policies for offline drafts, aliases and suggestions. Remove Writer's remote-policy
fallback only after B1's minimum-authority gate and source-scoped ambiguity parity;
keep local compiler/draft resolution as a real boundary. Obsidian legacy mode retires
only with plugin adoption and explicit product migration/fixtures, not a Connect
release. A future portable offline helper must share fixture outputs and identify its
policy; no general SDK resolver is required by this design.

## Security and per-consumer migration

Every traversal stays inside the approved collection; no filesystem path can escape
the root. Current read/query action checks precede evaluation and revocation fences
cursor use/delivery. Type options cannot grant file bytes or transform a legacy scoped
grant into full access (B5). B5 V1 contract filters explicitly exclude traversal;
this feature is native-query only there. Candidate identities, absolute roots and
unapproved file metadata never enter control-plane telemetry. Enforce existing
candidate/traversal/expression budgets; a type filter is not a security boundary.

Writer can replace **remote** annotation source grouping with unique/source-type
queries, retaining unsaved compiler PathIndex. Reader keeps native resolved source
and explicit legacy SourceId fallback; adding unique mode is a deliberate behaviour
change. TaskNotes keeps declared-link type semantics and model configuration, opting
into unique mode only with ambiguous-assignee tests. Editor can use native/unique
backlink queries while retaining UI alias/suggestion policy and dirty overlays. MCP
publishes native recipes/options, not a private resolver or automatic ambiguity fix.
Obsidian is offline sync, with no mandatory public-client migration.

## Tests and size

M–L, 5–9 engineer-days plus consumer acceptance. One mdbase-rs fixture corpus runs
against native cache/no-cache, hosted, CEL provenance and default/unique modes:
root/relative/dot traversal; bare/Markdown/wiki/embeds; aliases vs title vs ID;
anchors/external/malformed; `.md`, `.mdx`, `plot.png.md`; exact out-of-type target;
same-folder duplicates; shallow-vs-character-short paths; Unicode/case; duplicate
IDs; explicit and declared type intersection; stored-link fast paths vs expressions;
rename/catalog changes and budgets. Port Writer's probe expectations with producer
labels (JS unsupported is not native success), retain Reader/TaskNotes recipes and
editor/Obsidian legacy fixture expectations. Benchmark indexed lookups at 50k records;
no per-link full collection scans or silent ambiguous selection in unique mode.
