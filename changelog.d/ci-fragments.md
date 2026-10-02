## Changed

- Release notes and architecture-growth justifications now use per-change
  fragments so queued PRs do not edit shared release counters. `pnpm version:set`
  prepares beta versions, assembles notes, and refreshes architecture snapshots;
  generated inventories are verified in CI and regenerated after source rebases.
