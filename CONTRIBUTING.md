# Contributing

Use the checks in [AGENTS.md](AGENTS.md) and the
[maintainability handbook](docs/maintainability.md). Keep change-specific files
out of shared release bookkeeping.

## Release notes

Do not edit `CHANGELOG.md` in ordinary PRs. Add `changelog.d/<pr-or-slug>.md`:

```markdown
## Fixed

- Explain the observable change, compatibility, and any migration or recovery
  steps. Indent continuation lines by two spaces.
```

Use exactly one section: `Breaking`, `Added`, `Changed`, `Fixed`, `Removed`, or
`Security`; use separate fragments for separate sections. Filenames use lowercase
letters, numbers, and hyphens. CI runs `pnpm check:changelog`. Infrastructure-only
changes may omit notes; the format gate does not pretend every PR affects users.
Release prep sorts filenames, groups sections, adds a version heading, and deletes
consumed fragments. The previous Unreleased notes, including the SDK migration
note shipped with beta.124, are preserved verbatim as released beta.124 history;
only changes after that release belong in pending fragments.

`packages/client/README.md` is hand-maintained onboarding, not a running API
inventory or release log. Put SDK change/migration notes in fragments and focused
`docs/sdk-<topic>.md` pages; only edit the README when onboarding itself changes.
This avoids appending every SDK PR to the same shared page.

## Architecture growth

`pnpm check:architecture` compares the working tree to the merge base with
`origin/main` (override with `ARCHITECTURE_BASE=<ref>`). CI supplies the PR base,
merge-group base, or push predecessor SHA and fetches full history. It does not
use labels or PR-body text, which would be lost when multiple PRs enter a group.

First reduce unnecessary growth. If growth is warranted, add a uniquely named
`architecture.d/<pr-or-slug>.json` (create the directory if needed):

```json
{
  "reason": "The new authority adapter owns a separate transport boundary; merging it into the domain module would invert dependencies.",
  "growth": {
    "productionFiles": 1,
    "typeScriptExportDeclarations": 2,
    "packages/client": 1
  }
}
```

The checker reports exact deltas. Declare positive integer **maximum deltas** only
for counters that grow: `productionFiles`, `relativeImports`, `workspacePackages`,
`rustPublicDeclarations`, `typeScriptExportDeclarations`,
`mdbaseCollectionReferences`, `typedCollectionReferences`, and per-package paths
such as `packages/client` or `crates/connect-core`. Review the justification, not
just the numbers. A reason must have at least 20 characters after trimming.
Declarations already in the merge base cannot be edited or spent again; new
ones add across queued PRs. Deleting source does not require a declaration.

Do not adjust shared package/public-surface counters in
`config/architecture-budgets.json` in ordinary PRs. Release prep replaces them
with exact current measurements (down as well as up) and consumes declarations.
`pnpm check:architecture --absolute` checks that release snapshot, including in
npm publication. The 1,000-line cap, exceptional legacy file caps, cycle checks,
dead-code inventory, and runtime/engine semantic guards remain hard gates: a
growth declaration cannot waive them.

## Generated files and rebases

`packages/client/public-api.json` is generated from explicit entry-point exports
(including connect-testing). Review those exports and the typed/packed API tests,
then run `pnpm generate:public-api`. CI regenerates the report in memory and
compares it structurally with the checked-in inventory, via
`pnpm check:generated`; it also verifies the protocol catalogs.

Never resolve generated-file conflicts line by line. Resolve the **source**
conflicts first, discard conflict markers in generated outputs, then regenerate:

```bash
# During a rebase, either side of this derived file is only a temporary seed.
git restore --ours -- packages/client/public-api.json
pnpm generate:public-api
pnpm generate:changes
pnpm generate:problems
pnpm generate:operations
pnpm generate:capabilities
pnpm check:generated
git add packages/client/public-api.json packages/protocol/src crates/connect-protocol/src
```

For other catalog outputs, restore either side before invoking their generator.
`.gitattributes` marks the outputs as generated, but deliberately does not use
`merge=union` (which can produce invalid JSON/duplicate declarations) or a custom
`ours` driver (which requires per-clone Git config and silently drops changes).
Regeneration is the conflict resolution; no manual output merge is needed.

## Prepare a beta

On a clean release-prep branch after ordinary PRs have merged:

```bash
pnpm version:set 0.1.0-beta.N --dry-run
pnpm version:set 0.1.0-beta.N
pnpm version:check
pnpm check:changelog
pnpm check:architecture --absolute
pnpm ci:local
```

Replace `N` with a higher positive beta number. The command validates all inputs
before writing, updates the same 19 version-bearing files as the beta122 prep
commit, assembles notes, refreshes architecture counters, and consumes both kinds
of fragments. It leaves the independently versioned editor and feedback service,
registry dependencies, lock checksums, and engine pins unchanged. Review the
resulting diff, then follow [Releasing](docs/releasing.md). The command does not
commit, open a PR, tag, publish, or deploy. Pending fragments are required; add a
release-specific infrastructure note if a release has no product changes.
