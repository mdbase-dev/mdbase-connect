## Fixed

- Preserve pagination completeness for bounded link-following, projected and other fallback queries, so source-filtered annotation discovery continues past the first page while exhausted query budgets still fail explicitly. Native cursor-only SDK iterators now reject a nonterminal page without a continuation instead of silently ending short.
- Refresh source-built SDK runtime integrity pins through an explicit reviewed command, and qualify terminal versus uncontinuable contract pages against the real WASM runtime.
