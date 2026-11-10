## Removed

- The architecture growth gate, its per-change `architecture.d` justifications and the shared counter budgets are gone, and `pnpm version:set` no longer refreshes architecture counters. `pnpm check:architecture` now only rejects import and workspace-package cycles and the named runtime/engine boundary seams; it has no budgets, baseline or `--absolute` flag.
