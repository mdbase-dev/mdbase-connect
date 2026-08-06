---
title: Cross-runtime Obsidian Bases view conformance
status: planned
priority: high
owner: unassigned
tags:
  - testing
  - obsidian-bases
  - conformance
  - mdbase-rs
  - tasknotes
  - datetime
  - hosted
  - developer-experience
created_at: 2026-08-06T23:01:31+10:00
updated_at: 2026-08-06T23:01:31+10:00
type: task
---

# Cross-runtime Obsidian Bases view conformance

## Outcome

Make editable Obsidian `.base` execution a fixture-driven compatibility
boundary from raw YAML through selected records. A change to YAML decoding,
structured-filter semantics, expression evaluation, formulas, sorting, date
handling, timezone propagation, or authority routing should fail a focused test
before it can reach TaskNotes.

Keep the canonical mdbase v0.3 CEL query path and the Obsidian Bases
compatibility path visibly separate. Both need conformance tests, but a Bases
fixture must exercise the Bases path rather than being translated into CEL and
thereby testing different semantics.

## Incident and current coverage

Beta.38 fixed a regression in which the Rust `.base` compatibility decoder
interpreted a YAML filter sequence as positional fields of one logical-filter
struct. A nested `or: [A, B]` in TaskNotes' Today view therefore behaved like
`A && B`; the expression parser and timezone-aware date evaluator never saw the
intended filter tree.

The existing expression coverage is strong:

- `obsidian-bases-expression` has 447 tests, including 281 expression/context/
  expected-value cases generated from a live Obsidian instance and 13 native
  parser/diagnostic cases.
- `mdbase-rs` vendors the compact 281-case oracle byte-for-byte and runs the
  Rust Bases evaluator against every non-divergent case.
- The beta.38 fix adds a model regression for logical sequences and a complete
  TaskNotes Today execution regression using a dynamically computed Melbourne
  date.

The missing layer is a shared corpus whose input begins with raw `.base` YAML.
The expression oracle starts after YAML decoding, while TypeScript structured-
filter tests start with already-formed JavaScript objects. Neither could detect
the corrupt YAML-to-filter-AST binding.

## Design

### 1. Define a portable raw-view fixture format

Add a versioned fixture corpus with these inputs and outputs:

- raw `.base` source, including global filters, per-view filters, formulas,
  properties, ordering, sorting, grouping, limits, and renderer metadata;
- candidate files with frontmatter, file metadata, links, embeds, backlinks,
  property types, and optional invocation context;
- an explicit IANA timezone and frozen instant;
- requested view name, pagination inputs, and rendering mode; and
- expected selected paths, projected values, order/groups, and structured
  diagnostics.

The fixture format must preserve raw YAML text. Do not normalize it into JSON
before handing it to the implementation under test, because sequence-versus-
mapping decoding is part of the contract.

### 2. Capture an Obsidian view oracle

Extend the existing live-Obsidian oracle tooling in
`obsidian-bases-expression` to create fixture notes and `.base` files, execute
named views in Obsidian, and record observable membership, ordering, formula
values, and diagnostics. Record Obsidian build metadata and explicit known
divergences just as the expression oracle does.

Keep generated fixtures reviewable and deterministic. Dynamic functions such
as `today()` and `now()` need either a captured instant with normalization or
assertion forms that remain valid when the oracle cannot freeze Obsidian's
clock.

### 3. Consume one corpus in TypeScript and Rust

- `obsidian-bases-expression` should test raw-source adaptation plus structured
  filter/expression evaluation against the oracle outputs.
- `mdbase-rs` should consume the same compact fixtures and execute the complete
  `.base` view path, not call its expression evaluator directly.
- Add a checked fixture-sync command or content hash so copied compact fixtures
  cannot drift silently from their generated source.
- Treat documented divergences as explicit data with a reason; never skip a
  mismatch merely by case name.

### 4. Make filter-tree decoding explicit

Replace implicit untagged-Serde variant-order behavior with shape-based
decoding that distinguishes scalar expressions, mappings, and sequences before
constructing the filter AST. Validate logical objects and return path-aware
diagnostics for unsupported keys or ambiguous operator shapes.

Cover scalar and list operands, empty lists, deep nesting, multiple logical
keys, unknown keys, non-string expressions, YAML anchors/aliases if supported,
and adversarial sequences that Serde can otherwise coerce into structs.

### 5. Add TaskNotes-owned golden views

Run the exact committed TaskNotes default `.base` sources as compatibility
fixtures. The Today matrix must include at least:

- undated open, overdue date-only, today date-only, tomorrow date-only, and
  completed tasks;
- scheduled instants immediately before and after local midnight;
- positive and negative UTC offsets;
- DST transition days in `Australia/Melbourne`, `America/New_York`, and a
  non-DST zone; and
- nested `and`/`or`/`not` combinations where each individual branch can be
  independently true or false.

Also cover the other TaskNotes default saved views so changing shared global
filters or formulas cannot regress a view that is not the immediate focus of a
patch.

### 6. Prove authority and SDK parity

Exercise the same raw-view fixtures through:

1. direct `mdbase-rs` execution;
2. the local Connect authority;
3. relay-backed filesystem authority; and
4. hosted-provider authority.

Assert that the SDK sends the caller's IANA timezone unchanged and that all
authorities return the same paths, ordering, values, pagination, and diagnostic
shape. Include an application-level TaskNotes acceptance test that provisions
its real Today source, writes dated tasks, reloads the session, and queries the
view through the public SDK.

### 7. Put the right tests on the release path

- Fast raw-YAML model and fixture tests run in every `mdbase-rs` PR.
- The compact cross-runtime corpus runs in `mdbase-rs` and Connect hosted-
  provider CI whenever the Rust pin, view adapter, SDK view operation, or
  timezone plumbing changes.
- TaskNotes runs its exact default-view fixture against candidate Connect
  artifacts before its generated application manifest is promoted.
- Release checks verify the tested `mdbase-rs` revision is the revision pinned
  into the published server image.

## Acceptance criteria

1. One reviewed fixture demonstrates raw `or: [A, B]` YAML becoming an OR node
   in both TypeScript and Rust and fails against the pre-beta.38 Rust decoder.
2. The exact TaskNotes Today source selects undated, overdue, and today tasks
   and excludes tomorrow/completed tasks across the timezone/DST matrix.
3. The shared live-Obsidian view oracle records source, context, expected
   output, Obsidian build metadata, and explicit known divergences.
4. Rust and TypeScript consume the same fixture semantics with an automated
   drift check.
5. Malformed filter trees return stable, path-aware diagnostics rather than
   silently changing boolean semantics.
6. Direct Rust, local, relay, hosted, and TaskNotes SDK tests agree on results
   and timezone behavior.
7. A deliberate mutation of sequence decoding, `today()` timezone handling,
   or nested OR evaluation causes the appropriate PR/release gate to fail.
8. Contributor documentation explains which suite to extend for expression
   grammar, filter-tree/YAML shape, datetime behavior, authority routing, and
   application-owned saved views.

## References

- mdbase-rs PR #44: saved-view logical-array fix
- mdbase-connect PR #194: beta.38 release pin
- mdbase-cloud-ops PR #102: beta.38 production promotion
- `obsidian-bases-expression/test/fixtures/oracle.compact.json`
- `mdbase-rs/tests/fixtures/obsidian-bases-oracle.json`

## Handoff

Start by specifying three to five raw `.base` fixtures around structured
logical filters and making both runtimes consume them. Then add the live
Obsidian generator and TaskNotes default-view matrix. Do not begin by adding
more evaluator-only cases: the evaluator oracle already has broad coverage,
and the highest-value missing seam is raw YAML through complete view execution.
