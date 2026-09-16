# Default lossless opaque-document sync

## Contract

Readable UTF-8 Markdown is replicated exactly even when its leading YAML is
malformed, duplicated, null, scalar, or a sequence. Structural diagnostics are
nonblocking; validation does not repair or normalize documents. No option,
public TypeScript shape, protocol field, or persisted-state layout is added.

Unreadable files and invalid UTF-8 still fence work. Conflicts and receive-only
local divergence still require an explicit decision. A readable malformed local
edit is no longer mistaken for corrupt bytes that a receive-only mirror may
replace automatically. Existing authority scope/configuration checks remain.

Both Node and embedding adapters must preserve a UTF-8 BOM. Node's decoder now
retains it; the new real-filesystem regression caught the previous BOM loss.
The YAML parser's default duplicate-key rejection is retained and tested.
Structural diagnostics and projection parsing now share Rust-compatible
leading-fence recognition, including BOM-prefixed mappings/body-only records,
non-leading fences, and the authority's closing-delimiter/body boundary.

## Consumer audit

- Portable and Node directory mirrors share the inspector. Exact `document`
  bytes were already separate from the structured projection; opaque records
  already have a valid representation without changing generic/public types.
- CLI synchronization executes the engine plan, not `local_issues.length`.
  Diagnostic `attention` can remain after successful synchronization.
- Server/reference-authority consumers and every Connect TypeScript workspace
  typecheck with this change. Application SDK, editor, devkit, testing and other
  non-desktop workspace tests pass.
- Obsidian's apply button already uses the plan's blocking count, but its
  diagnostic prose incorrectly described every warning as a pause. A separate
  consumer branch updates that prose, tests nonblocking reviews, and preserves
  BOMs in its Vault adapter. Its release pin must not move to an unpublished
  npm version. Immutable artifacts from commit `87e28391233c` pass all 96
  Obsidian unit tests, TypeScript/build and unchanged mobile budgets, plus ten
  strict exact round trips through the Obsidian adapter and reference authority.
  The same strict check fails against released beta.91 with seven YAML blockers.
  Its released dependencies and generated bundle were restored afterward.
- `tasknotes-app` only pins `connect-sync` as an immutable SDK override; no direct
  directory-mirror or `local_issues` consumer was found in its application code.
- Desktop renderer status is owned by the Rust mirror, not this JavaScript SDK
  inspector. This change does not claim to update that separate implementation.

There is no persisted local-issue gate to migrate. Existing plan-only checkpoints
are reused; unsupported older engine layouts remain rejected as before.

## Automated evidence

Node 24.19.0 / pnpm 11.15.1:

- `pnpm typecheck`: all workspaces pass. The guarded consumer-artifact packaging
  command also completed a full `pnpm -r build`.
- `pnpm --filter @mdbase-dev/connect-sync test`: 196 tests pass.
- `pnpm --filter '!@mdbase/connect-desktop' -r test`: passes, including server
  (582 passed, 35 intentionally skipped) and editor (473 passed).
- `pnpm check:mirror:mobile`: passes unchanged budgets, 187,664 raw / 55,970
  gzip bytes; no Node-only references in the portable bundle.

New/updated regressions cover exact uploads and second-mirror downloads,
BOM/CRLF/no-final-newline preservation, updates/moves/deletes, both conflict
choices, lost-reply replay after restart, existing checkpoint reuse, stale
reviews, receive-only divergence, invalid UTF-8 and failed rereads.

The canonical Rust runtime's five `frontmatter::parser` tests and
`schema_invalid_record_remains_semantically_projectable` test also pass with
`cargo test --locked --lib`; these are source/runtime evidence, not a hosted
round trip or full Connect Rust-workspace qualification.

Authorities in these SDK tests are `MemoryAuthority`, not deployed hosted
infrastructure. The Node round-trip uses real temporary filesystem directories;
the portable fixtures use in-memory adapters.

## Remaining qualification

- Full `pnpm test` reached the desktop tests, where 124 passed and one failed
  while importing Electron: its binary installation could not create an
  already-existing `dist/locales` directory. Non-desktop suites were run
  separately rather than represented as a full-workspace pass.
- `cargo fmt --all --check` and `cargo test --locked --workspace` cannot resolve
  the required sibling `../mdbase-rs` in this isolated workspace. Rust/system
  end-to-end qualification remains outstanding; no Rust sources changed.
- This is not a published SDK or deployed-hosted acceptance result. The prior
  LAB loopback-port ownership failure and disposable-Obsidian-vault prerequisite
  have not been bypassed. A real Obsidian → hosted → second-mirror round trip
  remains required before claiming live acceptance.
