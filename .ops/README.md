# .ops

This folder is a markdown-only operations registry backed by `mdbase`.

- `_types/*.md` contains the canonical schemas.
- `items/*.md` stores sidecars for issues, PRs, and local tasks.
- `tasks/*.md` stores local task records.
- `handoffs/*.md` stores structured handoffs between agents or people.

Use markdown bodies for narrative context and keep only queryable state in frontmatter.
