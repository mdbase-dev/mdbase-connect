# Frozen confidentiality inventory

Status: benchmark contract. “Database/backup reader” means an actor able to read a
logical PostgreSQL database, physical replica, snapshot, or backup but lacking the
provider master key and collection DEK. The hosted service itself remains trusted to
process plaintext in all candidates.

This inventory describes the disposable schemas, not a public security-claim
change. Network metadata, process memory while serving an operation, PostgreSQL
statistics, and access timing remain observable in every candidate.

| Information | Candidate A | Candidate B | Candidate C |
| --- | --- | --- | --- |
| Exact current Markdown | encrypted; length visible | encrypted; length visible | readable |
| Body text | encrypted; length correlated | encrypted unless deliberately copied into a projected field; length correlated | readable |
| Canonical path | keyed token only; equality within a collection is visible | readable in the semantic projection | readable as record identity and projection |
| Raw/persisted frontmatter | encrypted | readable for fields present in `persisted_frontmatter` projection | readable in exact Markdown and projection |
| Effective/defaulted/computed frontmatter | computed after decryption, not stored | readable in `effective_frontmatter` projection | readable in projection; raw source also readable |
| Canonical types | computed after decryption, not stored as authority | readable, revision-bound projection data | readable, revision-bound projection data |
| Relationships/links | encrypted except traffic/size | readable when included in projection for frozen relationship workloads | readable from exact Markdown and projection |
| Validation diagnostics | not persisted by prototype | readable only when included in projection | readable when included; exact invalid source also readable |
| Equality/frequency | record IDs, revision equality, path-token equality, ciphertext sizes, timing | all A leakage plus equality/frequency of every projected value and GIN posting frequency | equality/frequency of exact and projected content |
| Structural resources | encrypted | encrypted; their derived effects are inferable from projection shape/values | readable JSON/documents |
| Retained record versions | encrypted exact payload | encrypted exact payload; prototype does not retain historical projections | readable exact Markdown/path and projection when present |
| Change rows | encrypted before/after records; identity/sequence visible | encrypted before/after records; identity/sequence visible | readable before/after record JSON |
| Mutation receipts/journal | unchanged existing application-layer encryption; request identity/state/timing visible | same | same; Candidate C does not require receipt plaintext |
| Query source/parameters | not persisted by benchmark; visible transiently to service/DB statement observation | same; projected predicate values may appear in SQL parameters/statements | same |
| Query result pages | no durable result pages in benchmark | no durable result pages in benchmark | no durable result pages in benchmark |
| Binary file bytes | unchanged opaque R2/application-encrypted file model | unchanged | unchanged; Candidate C concerns record Markdown, not binary objects |
| File names/metadata referenced by records | encrypted inside record | readable if projected for Reader/attachment workloads | readable |
| Record/document byte length | readable `content_bytes` and ciphertext length | readable exact length plus projection size | readable exact and projection sizes |
| Record IDs, sequence, timestamps, write/access pattern | readable | readable | readable |
| GIN index | none | B-no-GIN: none; B-GIN: projected containment keys/values and frequency are recoverable through database access | C-no-GIN: none; C-GIN: same index leakage, while source is already readable |

## Frozen projection exposure for B and C

Projection format `hosted-benchmark-projection-v1` contains only:

- canonical path and file facts needed by current SDK envelopes;
- canonical type names;
- persisted frontmatter;
- effective frontmatter after defaults/computed values;
- canonical outgoing relationship targets and relationship kinds required by the
  Reader, TaskNotes, Editor, and Pickle workloads;
- bounded validation diagnostics needed by the response contract; and
- the file-size/mtime envelope needed by current query responses, but not body text.

Arbitrary unknown frontmatter is intentionally retained in both persisted/effective objects
because current Editor and SDK `frontmatterMode: both` behavior requires it. This
is a broad disclosure: Candidate B protects exact Markdown and bodies, not metadata
confidentiality. A production design could narrow projections only by changing or
negotiating those response contracts; that is outside this benchmark.

The serialized projection envelope is capped at 256 KiB by the prototype. Oversize
frontmatter returns the typed `projection_too_large` generation error rather than
inventing a new execution-budget kind. A query treats an existing oversize record
as projection-absent and may use bounded exact canonical fallback; a B/C write that
cannot atomically persist a current projection fails. Unknown fields can themselves
contain sensitive or body-like user text; that disclosure is recorded rather than
hidden by the cap.

The generator and projector create no fields derived from body text: no body tokens,
n-grams, full-text vectors, excerpts, or hashes. Sortable ciphertext, per-field
material indexes, and query/result persistence are also prohibited.

## Irreversibility

Deleting a Candidate B/C prototype database restores the disposable environment,
but a future production write of projection or exact plaintext would remain present
in any replica, snapshot, backup, log, forensic image, or exported evidence until
that copy is destroyed or expires. Code or schema rollback is not confidentiality
restoration. No benchmark result authorizes such a production write.
