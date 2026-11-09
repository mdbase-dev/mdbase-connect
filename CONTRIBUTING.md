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

## Architecture check

`pnpm check:architecture` rejects relative import cycles, workspace package
cycles, and the runtime/engine boundary seams it names (typed local runtime
outcomes, canonical operation construction, the mdbase manifest features, and
the semantic projection format assertion). Fix the structure; the check has no
waivers.

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
pnpm ci:local
```

Replace `N` with a higher positive beta number. The command validates all inputs
before writing, updates the release cohort including the SDK manifest, npm lock
and Obsidian SDK peer/local lock, assembles notes,
and consumes the changelog fragments. It leaves the independently versioned
editor, feedback service and Obsidian runtime's own version, registry dependencies,
lock checksums, and engine pins unchanged. Review the
resulting diff, then follow [Releasing](docs/releasing.md). The command does not
commit, open a PR, tag, publish, or deploy. Pending fragments are required; add a
release-specific infrastructure note if a release has no product changes.
